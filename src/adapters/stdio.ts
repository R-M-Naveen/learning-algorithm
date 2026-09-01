// The stdio server: the sidecar the desktop app will spawn. Newline-
// delimited JSON on stdin/stdout, the same framing EngineClient already
// speaks — docs/PROTOCOL.md is the contract, conformance/ is its executable
// spec, and this file is deliberately thin: every decision it makes is a
// call into core/store/judge code that already has its own tests.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { openStore, type Store } from "../store/db.ts";
import { validateEvent, type LearningEvent } from "../core/events.ts";
import { scoreTrajectory } from "../core/rewards.ts";
import { distillLessons, repoKeyOf } from "../core/lessons.ts";
import { classifyOutcome } from "../core/evaluation.ts";
import { MockJudgeBackend, type JudgeBackend, type JudgeMode } from "../judge/backend.ts";
import { paretoBackendFromEnv } from "../judge/key.ts";
import { JudgeGovernor, runJudgeGated } from "../judge/governor.ts";

export const PROTOCOL_VERSION = 1;
const SERVER_INFO = { name: "learning-algorithm", version: "0.1.0" };
/** Reported to clients so they can plan their drop policy. Ingestion today
 *  is a synchronous SQLite write, so the queue never actually fills — the
 *  capacity is contract, not aspiration. */
const QUEUE_CAPACITY = 1000;

type JudgeConfig = {
  mode: JudgeMode;
  enabled: boolean;
  maxInFlight: number;
  onlyWhenIdle: boolean;
  monthlyBudgetUsd: number;
};

const err = (id: number | string | null, code: number, message: string) =>
  JSON.stringify({ id, error: { code, message } });
const ok = (id: number | string, result: unknown) => JSON.stringify({ id, result });

export class LearningServer {
  store: Store | null = null;
  private governor: JudgeGovernor | null = null;
  private judgeCfg: JudgeConfig | null = null;
  /** What fraction of tasks are WITHHELD so the effect of injecting can be
   *  measured against a control. 0 (all tasks get lessons) unless the client
   *  asks for an evaluation, because withholding costs the user something and
   *  should be a deliberate choice. */
  private holdoutFraction = 0;

  /** One line in, one line out (or null for notifications). */
  async handleLine(line: string): Promise<string | null> {
    const text = line.trim();
    if (!text) return null;
    let msg: { method?: unknown; id?: number | string; params?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return err(null, -32700, "parse error");
    }
    const { method, id, params } = msg;
    if (typeof method !== "string") {
      return id !== undefined ? err(id, -32600, "invalid request: no method") : null;
    }
    const isRequest = id !== undefined;
    try {
      const result = await this.dispatch(method, params);
      if (result === UNKNOWN_METHOD) {
        return isRequest ? err(id!, -32601, `unknown method ${method}`) : null;
      }
      return isRequest ? ok(id!, result) : null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return isRequest ? err(id!, message.startsWith("not initialized") ? -32002 : -32000, message) : null;
    }
  }

  private need(): Store {
    if (!this.store) throw new Error("not initialized — send learning/initialize first");
    return this.store;
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "learning/initialize") {
      if ((p.protocolVersion as number) !== PROTOCOL_VERSION) {
        throw new Error(`protocol version mismatch: server speaks ${PROTOCOL_VERSION}`);
      }
      this.store = openStore(typeof p.dbPath === "string" && p.dbPath ? p.dbPath : ":memory:");
      const j = (p.judge ?? {}) as Partial<JudgeConfig>;
      this.judgeCfg = {
        mode: j.mode === "pareto" || j.mode === "local" ? j.mode : "mock",
        enabled: j.enabled === true,
        maxInFlight: typeof j.maxInFlight === "number" ? j.maxInFlight : 1,
        onlyWhenIdle: j.onlyWhenIdle !== false,
        monthlyBudgetUsd: typeof j.monthlyBudgetUsd === "number" ? j.monthlyBudgetUsd : 0,
      };
      const evaluation = (p.evaluation ?? {}) as { holdoutFraction?: unknown };
      this.holdoutFraction =
        typeof evaluation.holdoutFraction === "number"
          ? Math.max(0, Math.min(1, evaluation.holdoutFraction))
          : 0;
      this.governor = new JudgeGovernor({
        enabled: this.judgeCfg.enabled,
        maxInFlight: this.judgeCfg.maxInFlight,
        onlyWhenIdle: this.judgeCfg.onlyWhenIdle,
        budgetUsd: this.judgeCfg.monthlyBudgetUsd,
        spentUsd: this.store.judgeSpendTotal(),
      });
      return { protocolVersion: PROTOCOL_VERSION, server: SERVER_INFO };
    }

    switch (method) {
      case "event/append": {
        const store = this.need();
        const checked = validateEvent(p);
        if (!checked.ok) return { accepted: false, reason: "invalid", detail: checked.error };
        this.ensureTask(checked.event);
        const r = store.appendEvents([checked.event]);
        if (r.dropped) return { accepted: false, reason: "invalid", detail: r.reasons[0] };
        this.onIngested([checked.event]);
        return { accepted: true };
      }
      case "event/batchAppend": {
        const store = this.need();
        const events = Array.isArray(p.events) ? (p.events as LearningEvent[]) : [];
        for (const e of events) if (e && typeof e === "object") this.ensureTask(e);
        const r = store.appendEvents(events);
        this.onIngested(events);
        return r.reasons.length
          ? { accepted: r.accepted, dropped: r.dropped, reasons: r.reasons }
          : { accepted: r.accepted, dropped: r.dropped };
      }
      case "queue/status":
        this.need();
        return { depth: 0, capacity: QUEUE_CAPACITY, dropping: false };
      case "health/get": {
        const store = this.need();
        return {
          ok: true,
          db: "open",
          // An evaluation running invisibly is a trap: a user wondering why
          // the agent seems worse today deserves to be able to find out that
          // a fifth of their tasks are deliberately unassisted.
          evaluation: { holdoutFraction: this.holdoutFraction },
          judge: {
            mode: this.judgeCfg!.mode,
            inFlight: 0,
            spentUsd: this.governor!.spent(),
            enabled: this.judgeCfg!.enabled,
          },
          store: store.stats(),
        };
      }
      case "health/idle":
        this.governor?.setIdle((p as { idle?: boolean }).idle === true);
        return null;
      case "lessons/query": {
        const store = this.need();
        // With a taskId, retrieval runs an ARM: a deterministic fraction of
        // tasks are withheld so the effect of injecting can be measured
        // against a control instead of asserted. Without one (CLI, report),
        // it is a plain query.
        if (typeof p.taskId === "string" && p.taskId) {
          const r = store.queryLessonsForTask(String(p.taskText ?? ""), {
            taskId: p.taskId,
            projectKey: typeof p.projectKey === "string" ? p.projectKey : null,
            holdoutFraction: this.holdoutFraction,
            limit: typeof p.limit === "number" ? p.limit : 5,
          });
          return {
            arm: r.arm,
            lessons: r.lessons.map((l) => ({
              id: l.id,
              text: l.lesson,
              contextKey: l.contextKey,
              projectKey: l.projectKey ?? null,
              confidence: l.confidence,
              supportCount: l.supportCount,
              score: l.finalScore,
            })),
          };
        }
        const ranked = store.queryLessons(String(p.taskText ?? ""), {
          repoKey: typeof p.cwd === "string" ? repoKeyOf(p.cwd) : ((p.repoKey as string | undefined) ?? null),
          // Scope, when the client declares one: this project's lessons plus
          // universal advice, never another project's.
          projectKey: typeof p.projectKey === "string" ? p.projectKey : null,
          limit: typeof p.limit === "number" ? p.limit : 5,
        });
        return {
          lessons: ranked.map((l) => ({
            id: l.id,
            text: l.lesson,
            contextKey: l.contextKey,
            projectKey: l.projectKey ?? null,
            confidence: l.confidence,
            supportCount: l.supportCount,
            score: l.finalScore,
          })),
        };
      }
      // The other half of the feedback loop. The app calls this when the user
      // rejects what a lesson became — deleting the memory it was proposed
      // as, or declining it. Refusals are results, not errors: an unknown id
      // is a stale client, not a protocol violation.
      case "lessons/refute": {
        const store = this.need();
        const id = typeof p.lessonId === "string" ? p.lessonId : "";
        if (!id) return { ok: false, reason: "missing_lesson_id" };
        const r = store.refuteLesson(id, typeof p.reason === "string" ? p.reason : null);
        if ("error" in r) return { ok: false, reason: "unknown_lesson" };
        return { ok: true, confidence: r.confidence };
      }
      // Staleness on the caller's clock. Ranking stays time-independent; the
      // app decides when a lesson has gone quiet for long enough.
      case "lessons/decay": {
        const store = this.need();
        const unusedSince = typeof p.unusedSince === "string" ? p.unusedSince : null;
        if (!unusedSince) return { ok: false, reason: "missing_unused_since" };
        const factor = typeof p.factor === "number" ? p.factor : 0.9;
        return { ok: true, decayed: store.decayUnusedLessons(unusedSince, factor) };
      }
      case "lessons/used": {
        const store = this.need();
        const ids = Array.isArray(p.lessonIds) ? (p.lessonIds as string[]) : [];
        if (ids.length && typeof p.taskId === "string") {
          store.recordLessonUse(ids, p.taskId, (p.turnId as string | undefined) ?? null);
        }
        return null;
      }
      case "judge/run": {
        const store = this.need();
        const taskId = String(p.taskId ?? "");
        return runJudgeGated(store, taskId, this.judgeBackend(), this.governor!);
      }
      case "stats/get": {
        const store = this.need();
        return { ...store.stats(), judgeSpendUsd: store.judgeSpendTotal() };
      }
      default:
        return UNKNOWN_METHOD;
    }
  }

  /** Tasks materialize from their events — the client never sends a
   *  separate "create task" call. */
  private ensureTask(e: LearningEvent): void {
    if (typeof e.taskId !== "string" || !e.taskId) return;
    const cwd = e.kind === "task_meta" && typeof e.data?.cwd === "string" ? (e.data.cwd as string) : null;
    // The scope the CLIENT declares. The app resolves a worktree to its
    // parent project before sending; the sidecar must not re-derive it from
    // cwd, which cannot tell `/a/api` from `/b/api` or a worktree from its
    // project.
    const projectKey =
      e.kind === "task_meta" && typeof e.data?.projectKey === "string" ? (e.data.projectKey as string) : null;
    this.store!.upsertTask({
      id: e.taskId,
      createdAt: e.at ?? new Date(0).toISOString(),
      cwd,
      projectKey,
      source: e.source,
    });
  }

  /** The sidecar's own reflexes: when a turn completes, score the task,
   *  distill template lessons, and resolve the injection audit trail. */
  private onIngested(events: LearningEvent[]): void {
    const store = this.store!;
    const done = new Map<string, string>();
    for (const e of events) {
      if (e?.kind === "turn_completed" && typeof e.taskId === "string") {
        done.set(e.taskId, String((e.data as { status?: string })?.status ?? "completed"));
      }
    }
    for (const [taskId, status] of done) {
      const all = store.eventsForTask(taskId);
      if (!all.length) continue;
      const score = scoreTrajectory(all);
      store.recordScore(taskId, score);
      const meta = all.find((e) => e.kind === "task_meta");
      const cwd = typeof meta?.data.cwd === "string" ? (meta.data.cwd as string) : null;
      store.absorbLessons(
        distillLessons(
          { id: taskId, createdAt: all[0]!.at, cwd, projectKey: store.taskProjectKey(taskId), source: all[0]!.source, taskType: null },
          all,
          score,
        ),
        score.total,
      );
      // The outcome a lesson is judged by. NOT the raw turn status: an
      // interrupt or a declined approval is the user correcting the agent,
      // and a bare completion at a mediocre score is not evidence that
      // anything helped.
      store.resolveLessonUseWithOutcome(taskId, classifyOutcome(all, score.total));
    }
  }

  private judgeBackend(): JudgeBackend {
    if (this.judgeCfg!.mode === "pareto") return paretoBackendFromEnv();
    return new MockJudgeBackend(); // "local" falls back to mock until an Ollama backend lands
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}

const UNKNOWN_METHOD = Symbol("unknown-method");

export function startStdioServer(): void {
  const server = new LearningServer();
  const lines = createInterface({ input: process.stdin });
  // Handled concurrently, NOT chained. Chaining kept responses in request
  // order, which JSON-RPC never asked for — the client matches on id, and
  // both clients here do. What it bought instead was head-of-line blocking:
  // every handler is a synchronous SQLite write except judge/run, which
  // awaits the gateway with a 620s timeout, so one background judgement
  // could stall the app's next lessons/query — and every event/append behind
  // it — for ten minutes. "The UI must never stall on learning" is the whole
  // point of this process, so the ordering guarantee is the thing that goes.
  const inFlight = new Set<Promise<void>>();
  lines.on("line", (line) => {
    const p = (async () => {
      const out = await server.handleLine(line);
      // One write per line: process.stdout.write of a single string is
      // atomic enough here, so interleaved responses stay whole lines.
      if (out !== null) process.stdout.write(out + "\n");
    })().finally(() => inFlight.delete(p));
    inFlight.add(p);
  });
  const shutdown = () => {
    // In-flight work is allowed to finish: an aborted judge call bills
    // anyway. The client owns the grace timer.
    void Promise.allSettled([...inFlight]).finally(() => {
      server.close();
      process.exit(0);
    });
  };
  lines.on("close", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdioServer();
}
