// CLI adapter: the standalone way in, until the stdio server lands (M6).
//   gen     --archetype <name> --seed <n> [--db <path>]   synthesize + ingest
//   replay  <rollout.jsonl> [--db <path>] [--dry-run]     map a real rollout
//   stats   [--db <path>]                                 rollup counts
// Thin by design: everything it does is a core/store call the tests already
// cover; this file only parses argv and prints.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRollout } from "./replay.ts";
import { generateTrajectory, ARCHETYPES, type Archetype } from "../synth/generator.ts";
import { openStore } from "../store/db.ts";
import { scoreTrajectory } from "../core/rewards.ts";
import { distillLessons, repoKeyOf } from "../core/lessons.ts";
import { ESTIMATED_JUDGE_COST_USD, selectForJudging } from "../judge/sampling.ts";
import { runJudge } from "../judge/judge.ts";
import { MockJudgeBackend, type JudgeBackend } from "../judge/backend.ts";
import { ParetoJudgeBackend } from "../judge/pareto.ts";
import { JudgeGovernor, runJudgeGated } from "../judge/governor.ts";
import { resolveUnbiasedKey } from "../judge/key.ts";
import { buildReport } from "../report/report.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = flag(args, "db") ?? "data/learning.db";

  switch (cmd) {
    case "gen": {
      const archetype = (flag(args, "archetype") ?? "focused-fix-success") as Archetype;
      if (!ARCHETYPES.includes(archetype)) {
        console.error(`unknown archetype ${archetype}; have: ${ARCHETYPES.join(", ")}`);
        return 1;
      }
      const seed = Number(flag(args, "seed") ?? 1);
      const t = generateTrajectory(archetype, seed);
      const store = openStore(dbPath);
      store.upsertTask(t.task);
      const r = store.appendEvents(t.events);
      console.log(
        `${t.task.id}: ${r.accepted} events ingested (${r.dropped} dropped), ground truth: ${
          t.groundTruth.succeeded ? "success" : "failure"
        } [${t.groundTruth.traits.join(", ")}]`,
      );
      store.close();
      return r.dropped === 0 ? 0 : 1;
    }
    case "replay": {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) {
        console.error("usage: replay <rollout.jsonl> [--db <path>] [--dry-run]");
        return 1;
      }
      const { task, events, skipped } = parseRollout(readFileSync(file, "utf8"));
      const kinds = new Map<string, number>();
      for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
      console.log(`task ${task.id} (cwd ${task.cwd ?? "?"}): ${events.length} events, ${skipped} skipped`);
      console.log([...kinds].map(([k, n]) => `  ${k} × ${n}`).join("\n"));
      if (!args.includes("--dry-run")) {
        const store = openStore(dbPath);
        store.upsertTask(task);
        const r = store.appendEvents(events);
        console.log(`ingested ${r.accepted}, dropped ${r.dropped}${r.reasons.length ? ` (${r.reasons[0]})` : ""}`);
        store.close();
      }
      return 0;
    }
    case "score": {
      const store = openStore(dbPath);
      const only = flag(args, "task");
      const ids = only ? [only] : store.taskIds();
      for (const id of ids) {
        const events = store.eventsForTask(id);
        if (!events.length) continue;
        const s = scoreTrajectory(events);
        store.recordScore(id, s);
        const top = [...s.signals].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3);
        console.log(
          `${id}: ${s.total.toFixed(2)} (raw ${s.raw.toFixed(2)}) — ${top.map((t) => `${t.key} ${t.value > 0 ? "+" : ""}${t.value}`).join(", ")}`,
        );
      }
      store.close();
      return 0;
    }
    case "distill": {
      const store = openStore(dbPath);
      let absorbed = 0;
      for (const id of store.taskIds()) {
        const events = store.eventsForTask(id);
        if (!events.length) continue;
        const score = scoreTrajectory(events);
        store.recordScore(id, score);
        const meta = events.find((e) => e.kind === "task_meta");
        const cwd = typeof meta?.data.cwd === "string" ? (meta.data.cwd as string) : null;
        const task = { id, createdAt: events[0]!.at, cwd, source: events[0]!.source, taskType: null };
        const candidates = distillLessons(task, events, score);
        store.absorbLessons(candidates, score.total);
        absorbed += candidates.length;
        for (const c of candidates) console.log(`  [${c.polarity}] ${c.contextKey}/${c.repoKey ?? "-"}: ${c.lesson}`);
      }
      console.log(`${absorbed} lesson sightings absorbed; ${store.stats().lessons} distinct lessons`);
      store.close();
      return 0;
    }
    case "query": {
      const text = args.find((a) => !a.startsWith("--"));
      if (!text) {
        console.error("usage: query \"task text\" [--repo <key>] [--project <key>] [--limit <n>] [--db <path>]");
        return 1;
      }
      const store = openStore(dbPath);
      const ranked = store.queryLessons(text, {
        repoKey: flag(args, "repo") ?? repoKeyOf(flag(args, "cwd")),
        projectKey: flag(args, "project") ?? null,
        limit: Number(flag(args, "limit") ?? 5),
      });
      for (const l of ranked) {
        console.log(
          `${l.finalScore.toFixed(2)}  [conf ${l.confidence.toFixed(2)} ×${l.supportCount}${l.repoKey ? ` @${l.repoKey}` : ""}] ${l.lesson}`,
        );
      }
      if (!ranked.length) console.log("(no lessons matched — inject nothing)");
      store.close();
      return 0;
    }
    case "judge-plan": {
      const store = openStore(dbPath);
      const picks = selectForJudging(store.judgeCandidates(), {
        limit: Number(flag(args, "limit") ?? 5),
        budgetUsd: Number(flag(args, "budget") ?? 0.25),
      });
      const candidates = store.judgeCandidates().length;
      console.log(`${candidates} unjudged task(s); plan spends ~$${(picks.length * ESTIMATED_JUDGE_COST_USD).toFixed(3)}:`);
      for (const p of picks) console.log(`  ${p.priority.toFixed(2)}  ${p.taskId}  — ${p.reason}`);
      if (!picks.length) console.log("  (nothing worth judging, or no budget)");
      store.close();
      return 0;
    }
    case "judge": {
      const mode = flag(args, "judge-mode") ?? "mock";
      if (mode !== "mock" && mode !== "pareto") {
        console.error(`unknown judge mode ${mode} (mock | pareto; local arrives later)`);
        return 1;
      }
      const store = openStore(dbPath);
      let backend: JudgeBackend;
      let governor: JudgeGovernor | null = null;
      if (mode === "pareto") {
        const key = resolveUnbiasedKey();
        if (!key) {
          console.error("no API key: set UNBIASED_API_KEY or run `unbiased login`");
          store.close();
          return 1;
        }
        backend = new ParetoJudgeBackend({
          baseUrl: process.env.UNBIASED_BASE_URL?.trim() || "https://api.unbiased.ai/v1",
          apiKey: key,
        });
        // Explicitly invoking `judge --judge-mode pareto` is the opt-in; the
        // CLI is single-user-foreground so idle gating is moot here. The
        // budget still binds, seeded with spend already on the books.
        governor = new JudgeGovernor({
          enabled: true,
          onlyWhenIdle: false,
          budgetUsd: Number(flag(args, "limit-usd") ?? 0.25),
          spentUsd: store.judgeSpendTotal(),
        });
        console.log(`pareto judge: budget $${Number(flag(args, "limit-usd") ?? 0.25).toFixed(2)}, already spent $${store.judgeSpendTotal().toFixed(4)}`);
      } else {
        backend = new MockJudgeBackend();
      }
      const only = flag(args, "task");
      const ids = only ? [only] : store.taskIds();
      for (const id of ids) {
        if (!store.eventsForTask(id).length) continue;
        let result;
        if (governor) {
          const gated = await runJudgeGated(store, id, backend, governor);
          if (!gated.ok) {
            console.log(`${id}: dropped (${gated.reason})`);
            if (gated.reason === "budget_exhausted" || gated.reason === "payment_required") break;
            continue;
          }
          result = gated.result;
        } else {
          result = await runJudge(store, id, backend);
        }
        const triggered = result.verdicts.filter((v) => v.met).map((v) => v.id);
        console.log(
          `${id}: judge ${result.normalized.toFixed(2)}${result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : ""} — ${
            triggered.join(", ") || "nothing met"
          }${result.lessonsAbsorbed ? ` (+${result.lessonsAbsorbed} lesson${result.lessonsAbsorbed > 1 ? "s" : ""})` : ""}`,
        );
      }
      if (governor) console.log(`total judge spend now $${store.judgeSpendTotal().toFixed(4)}`);
      store.close();
      return 0;
    }
    case "replay-all": {
      const dir = flag(args, "sessions") ?? join(homedir(), ".unbiased", "app-engine", "home", "sessions");
      let files: string[];
      try {
        files = readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((f) => /rollout-.*\.jsonl$/.test(f))
          .map((f) => join(dir, f))
          .sort();
      } catch (err) {
        console.error(`cannot read sessions dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const store = openStore(dbPath);
      const taskIds = new Set<string>();
      let events = 0;
      let skippedFiles = 0;
      for (const file of files) {
        try {
          const parsed = parseRollout(readFileSync(file, "utf8"));
          if (!parsed.events.length) { skippedFiles++; continue; }
          store.upsertTask(parsed.task);
          const r = store.appendEvents(parsed.events);
          taskIds.add(parsed.task.id);
          events += r.accepted;
        } catch (err) {
          skippedFiles++;
          console.error(`  skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Score AFTER ingesting everything, from the store's union — resumed
      // sessions span multiple files, and scoring any single file's slice
      // let the last partial view overwrite the full trajectory's score
      // (found on real data: a test-deletion task scored det 1.00).
      for (const id of taskIds) {
        const all = store.eventsForTask(id);
        if (!all.length) continue;
        const score = scoreTrajectory(all);
        store.recordScore(id, score);
        const meta = all.find((e) => e.kind === "task_meta");
        const cwd = typeof meta?.data.cwd === "string" ? (meta.data.cwd as string) : null;
        store.absorbLessons(
          distillLessons({ id, createdAt: all[0]!.at, cwd, source: all[0]!.source, taskType: null }, all, score),
          score.total,
        );
      }
      console.log(`replayed ${taskIds.size} conversations (${events} events) from ${files.length} files; ${skippedFiles} skipped/empty`);
      store.close();
      return 0;
    }
    case "report": {
      const store = openStore(dbPath);
      const md = buildReport(store);
      const out = flag(args, "out");
      if (out) {
        writeFileSync(out, md);
        console.log(`report written to ${out}`);
      } else {
        console.log(md);
      }
      store.close();
      return 0;
    }
    case "stats": {
      const store = openStore(dbPath);
      console.log(JSON.stringify(store.stats(), null, 2));
      store.close();
      return 0;
    }
    default:
      console.error("usage: cli.ts <gen|replay|replay-all|score|distill|query|judge|report|stats> …");
      return 1;
  }
}

process.exit(await main());
