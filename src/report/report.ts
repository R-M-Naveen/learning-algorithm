// The observe-only evaluation: everything the store knows, summarized into
// one markdown report. Pure — reads the store, returns a string — so the
// numbers in it are testable. This is the artifact that gates app
// integration: lessons only start riding real prompts once this report says
// they would have been available and sane.
import { repoKeyOf } from "../core/lessons.ts";
import type { Store } from "../store/db.ts";

const pct = (n: number, of: number) => (of === 0 ? "0%" : `${Math.round((100 * n) / of)}%`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Deterministic total ([-1,1]) and judge reward ([0,1]) live on different
 *  scales; compare on [0,1] and call >0.4 apart a disagreement. */
const DISAGREE_GAP = 0.4;

export function buildReport(store: Store): string {
  const tasks = store.taskSummaries();
  const lines: string[] = ["# Learning replay report", ""];

  // ── Corpus ──
  const bySource = new Map<string, number>();
  for (const t of tasks) bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
  const stats = store.stats();
  lines.push(
    "## Corpus",
    "",
    `${tasks.length} tasks, ${stats.events} events, ${stats.lessons} distinct lessons, ${stats.rewards} reward rows.`,
    ...[...bySource].map(([s, n]) => `- ${s}: ${n}`),
    "",
  );

  // ── Score distribution ──
  const scored = tasks.filter((t) => t.totalReward !== null);
  lines.push("## Score distribution", "");
  if (!scored.length) {
    lines.push("No scored tasks.", "");
  } else {
    const buckets: [string, (n: number) => boolean][] = [
      ["strong negative (≤ -0.5)", (n) => n <= -0.5],
      ["negative (-0.5, 0)", (n) => n > -0.5 && n < 0],
      ["zero-ish [0, 0.5)", (n) => n >= 0 && n < 0.5],
      ["positive [0.5, 1]", (n) => n >= 0.5],
    ];
    for (const [label, fits] of buckets) {
      const n = scored.filter((t) => fits(t.totalReward!)).length;
      lines.push(`- ${label}: ${n} (${pct(n, scored.length)})`);
    }
    lines.push(`- mean: ${mean(scored.map((t) => t.totalReward!)).toFixed(2)} over ${scored.length} scored tasks`, "");
  }

  // ── Signal frequencies ──
  lines.push("## Signal frequencies", "");
  const signals = store.signalFrequencies();
  lines.push(...(signals.length ? signals.map((s) => `- ${s.key}: ${s.count}`) : ["No deterministic rewards recorded."]), "");

  // ── Judge vs deterministic ──
  const pairs = store.judgePairs();
  lines.push("## Judge vs deterministic", "", `Judged tasks: ${pairs.length}.`);
  if (pairs.length) {
    const disagreements = pairs.filter((p) => Math.abs((p.det + 1) / 2 - p.judge) > DISAGREE_GAP);
    lines.push(`Disagreements: ${disagreements.length} of ${pairs.length} (gap > ${DISAGREE_GAP} on [0,1]).`);
    for (const d of disagreements.slice(0, 10)) {
      lines.push(`- ${d.taskId}: det ${d.det.toFixed(2)} vs judge ${d.judge.toFixed(2)} (${d.mode ?? "?"})`);
    }
    const timed = pairs.filter((p) => p.durationMs !== null);
    if (timed.length) {
      lines.push(
        `Judge latency: mean ${Math.round(mean(timed.map((p) => p.durationMs!)))}ms over ${timed.length} timed calls; ` +
          `spend $${pairs.reduce((s, p) => s + (p.costUsd ?? 0), 0).toFixed(4)}.`,
      );
    }
  } else {
    lines.push("Disagreements: 0 (nothing judged yet).");
  }
  lines.push("");

  // ── Lessons ──
  const lessons = store.lessonSummaries();
  lines.push("## Lessons", "");
  for (const l of lessons.slice(0, 15)) {
    lines.push(`- [${l.polarity ?? "?"}] conf ${l.confidence.toFixed(2)} ×${l.supportCount}: ${l.lesson}`);
  }
  if (!lessons.length) lines.push("No lessons distilled.");
  lines.push("");

  // ── Retrieval dry run ──
  // For every task whose goal was recorded, ask the store what it would have
  // injected. This is availability, not effectiveness — effectiveness needs
  // live injection plus lesson_usage outcomes (M8+).
  lines.push("## Retrieval dry run", "");
  let withGoal = 0;
  let hits = 0;
  for (const t of tasks) {
    const goal = store.eventsForTask(t.id).find((e) => e.kind === "user_message")?.summary;
    if (!goal) continue;
    withGoal++;
    if (store.queryLessons(goal, { repoKey: repoKeyOf(t.cwd), limit: 3 }).length > 0) hits++;
  }
  lines.push(
    `Tasks with a goal: ${withGoal} of ${tasks.length} (sub-agent and scheduled threads record none).`,
    `Retrieval returned lessons for ${hits} of ${withGoal} (${pct(hits, withGoal)}).`,
    "",
  );

  // ── Caveats ──
  lines.push(
    "## Caveats",
    "",
    "- Observe-only: no lesson was actually injected into any of these runs.",
    "- Rollout-sourced tasks carry no approval or interruption signals — those exist only app-side.",
    "- Availability ≠ effectiveness: whether injected lessons improve outcomes needs lesson_usage data from live injection.",
    "- Lessons here were distilled from this same corpus; retrieval hit rates are therefore optimistic (in-sample).",
    "",
  );

  // ── The arm comparison ──
  // The whole point of the holdout: an effect claimed without a control is a
  // correlation with task familiarity, because retrieval succeeds on the
  // tasks that resemble work already seen. Silence about a lesson is NOT
  // evidence for it, so nothing here is credited to survival.
  const arms = store.armOutcomes();
  const inject = arms.filter((a) => a.arm === "inject");
  const holdout = arms.filter((a) => a.arm === "holdout");
  lines.push("## Injection effect (arm comparison)", "");
  if (!holdout.length) {
    lines.push(
      `No holdout arm in this corpus (${inject.length} injected task(s)). Any apparent effect here is`,
      "uncontrolled: set `evaluation.holdoutFraction` at initialize to withhold a fraction of tasks,",
      "or this section can only report activity, not effect.",
      "",
    );
  } else {
    const rate = (rows: typeof arms, want: string) =>
      rows.length ? pct(rows.filter((r) => r.outcome === want).length, rows.length) : "n/a";
    const avg = (rows: typeof arms) => mean(rows.filter((r) => r.score !== null).map((r) => r.score as number));
    lines.push(
      `| arm | tasks | positive | negative | mean score |`,
      `|---|---|---|---|---|`,
      `| inject | ${inject.length} | ${rate(inject, "positive")} | ${rate(inject, "negative")} | ${avg(inject).toFixed(2)} |`,
      `| holdout | ${holdout.length} | ${rate(holdout, "positive")} | ${rate(holdout, "negative")} | ${avg(holdout).toFixed(2)} |`,
      "",
      "A difference is only worth reading once both arms hold enough tasks; with a handful either way",
      "this table is noise, and reporting it as a win would be the same error as counting silence as",
      "approval.",
      "",
    );
  }

  // ── Trust: what has been shown, and what it earned ──
  const lessonRows = store.allLessons();
  const judged = lessonRows
    .map((l) => ({ l, t: store.trustFor(l.id), imp: store.impressionsFor(l.id) }))
    .filter((x) => x.imp.inject + x.imp.holdout > 0);
  lines.push("## Lesson trust", "");
  if (!judged.length) {
    lines.push("No lesson has been retrieved yet, so none has earned or lost trust.", "");
  } else {
    lines.push("| lesson | injected | withheld | trust | verdict |", "|---|---|---|---|---|");
    for (const { l, t, imp } of judged.slice(0, 20)) {
      const verdict = !t.judged ? "unproven" : (t.trust ?? 0) >= 0.2 ? "keeping" : "failing";
      lines.push(
        `| ${l.lesson.slice(0, 60)} | ${imp.inject} | ${imp.holdout} | ${t.trust === null ? "—" : t.trust.toFixed(2)} | ${verdict} |`,
      );
    }
    lines.push("", "`unproven` means too few impressions to judge — not distrusted, just untested.", "");
  }

  return lines.join("\n");
}
