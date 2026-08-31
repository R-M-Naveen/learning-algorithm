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

  return lines.join("\n");
}
