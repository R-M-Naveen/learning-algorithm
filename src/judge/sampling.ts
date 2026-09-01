// Which trajectories are worth paying a judge for.
//
// The judge costs real money against a per-org concurrency gauge shared with
// the user's own chat, runs one at a time, and only while the app is idle. So
// judging everything is not merely expensive, it is slow enough that the
// backlog never clears. The question is where the spend buys the most.
//
// The principle: **spend the judge where the deterministic scorer is blind.**
// After per-turn scoring, 28 of 35 real tasks still read exactly 1.00; inside
// that band the score cannot tell a good session from a useless one that
// happened to finish every turn, so a second opinion is pure information.
// A task at -0.65 carrying an interrupt and a test deletion is already
// characterised — confirming it buys almost nothing.
//
// Everything here is pure and deterministic, so a plan can be printed and
// read BEFORE any money is spent. A sampler that silently decides to spend is
// exactly the thing not to build.

/** What a judgement is expected to cost, from measurement rather than
 *  extrapolation: three real Pareto judgements on 2026-09-01 cost $0.0066,
 *  $0.0071 and $0.0048 — mean $0.0062, over packets at the 6,000-char cap.
 *  Rounded up, because a plan that promises to fit a budget and then overruns
 *  it is worse than a conservative one. */
export const ESTIMATED_JUDGE_COST_USD = 0.008;

/** The share of a plan reserved for a spread-out sample rather than for the
 *  crowded band. Without it the judged set only ever covers the band the
 *  policy already prefers, so a disagreement anywhere else can never be
 *  discovered — the same reasoning as the holdout arm. */
export const CALIBRATION_SHARE = 0.25;

/** How wide a score band counts as "the same" for crowding. Coarse on
 *  purpose: 0.98 and 1.00 are the same lack of discrimination. */
const BAND = 0.1;

export type JudgeCandidate = {
  taskId: string;
  /** The deterministic total, or null when the task was never scored. */
  score: number | null;
  projectKey: string | null;
  /** How many tasks in this candidate's project already carry a verdict. */
  projectJudged: number;
};

export type JudgePick = {
  taskId: string;
  reason: string;
  priority: number;
  estimatedCostUsd: number;
};

/** Stable hash for the calibration draw — the same task is always either in
 *  or out, so a plan is reproducible and reviewable. FNV-1a plus a MurmurHash
 *  avalanche; the avalanche matters because near-identical ids otherwise leave
 *  structure in the high bits (measured: a 28.5% split for a requested 25%). */
function stableFraction(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const bandOf = (score: number | null) => (score === null ? "unscored" : String(Math.round(score / BAND)));

export function selectForJudging(
  candidates: JudgeCandidate[],
  opts: { limit: number; budgetUsd: number },
): JudgePick[] {
  const affordable = Math.floor(Math.max(0, opts.budgetUsd) / ESTIMATED_JUDGE_COST_USD);
  const room = Math.max(0, Math.min(opts.limit, affordable));
  if (!room || !candidates.length) return [];

  // How crowded each score band is. A band holding half the corpus is a band
  // the scorer is not discriminating within.
  const bandSize = new Map<string, number>();
  for (const c of candidates) bandSize.set(bandOf(c.score), (bandSize.get(bandOf(c.score)) ?? 0) + 1);
  const maxBand = Math.max(...bandSize.values());

  const scored = candidates.map((c) => {
    const crowding = (bandSize.get(bandOf(c.score)) ?? 1) / maxBand;
    // A project with no verdict yet is where a project-scoped lesson can first
    // exist at all, so it outranks another sample from a well-covered one.
    const projectNeed = 1 / (1 + c.projectJudged);
    const priority = 0.6 * crowding + 0.4 * projectNeed;
    // The reason is what a human reads before agreeing to spend, so it has to
    // be the true reason. "First judgement for project X" is only meaningful
    // when there IS a project: replayed rollouts carry no projectKey (only the
    // app declares one), and claiming a project milestone for every one of
    // them would be noise dressed as insight.
    const reason =
      c.projectKey && c.projectJudged === 0
        ? `first judgement for project ${c.projectKey}`
        : `crowded score band ${bandOf(c.score)} (${bandSize.get(bandOf(c.score))} of ${candidates.length} tasks share it)`;
    return { taskId: c.taskId, reason, priority, estimatedCostUsd: ESTIMATED_JUDGE_COST_USD, fraction: stableFraction(c.taskId) };
  });

  // Ties break on the stable fraction, then the id, so the plan is total and
  // reproducible rather than dependent on input order.
  const byPriority = [...scored].sort(
    (a, b) => b.priority - a.priority || a.fraction - b.fraction || a.taskId.localeCompare(b.taskId),
  );

  const calibrationSlots = room > 1 ? Math.max(1, Math.round(room * CALIBRATION_SHARE)) : 0;
  const policySlots = room - calibrationSlots;

  const picked: JudgePick[] = [];
  const taken = new Set<string>();
  const take = (p: (typeof scored)[number], reason: string) => {
    if (taken.has(p.taskId) || picked.length >= room) return;
    taken.add(p.taskId);
    picked.push({ taskId: p.taskId, reason, priority: p.priority, estimatedCostUsd: p.estimatedCostUsd });
  };

  for (const p of byPriority.slice(0, policySlots)) take(p, p.reason);

  // The calibration draw: whichever candidates the stable hash puts first,
  // regardless of band. Deliberately blind to priority.
  if (calibrationSlots > 0) {
    const byDraw = [...scored].sort((a, b) => a.fraction - b.fraction || a.taskId.localeCompare(b.taskId));
    for (const p of byDraw) {
      if (picked.length >= room) break;
      take(p, `calibration sample (band ${bandOf(candidates.find((c) => c.taskId === p.taskId)!.score)})`);
    }
  }

  // If calibration had nothing new to add, spend the remainder on policy.
  for (const p of byPriority) {
    if (picked.length >= room) break;
    take(p, p.reason);
  }
  return picked;
}
