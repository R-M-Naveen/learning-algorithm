// Did surfacing a lesson actually help? Pure functions only — the store
// applies them, the report reads them.
//
// The rule this file exists to enforce: **a user not objecting is not
// approval.** A lesson that survives because nobody bothered to delete it has
// earned nothing, and a metric built on survival rises as users disengage.
// So trust here is an estimate over evidence with an explicit negative side:
//   - being shown and not helping LOWERS trust (silence erodes it),
//   - a refutation, an interrupt or a declined approval is a hard negative,
//   - and none of it is credited without a control arm to compare against.
import type { LearningEvent } from "./events.ts";

// ── Trust: a lower bound, not a running total ─────────────────────────────

/** 95% — z for a two-sided normal interval. Not tunable: the point of the
 *  bound is that it is conservative, and a caller who lowers it is asking to
 *  be flattered. */
const Z = 1.959963985;

/** Wilson score interval, lower bound, over `successes` of `impressions`.
 *
 *  Chosen over a raw ratio because the ratio cannot tell 1-of-1 from
 *  50-of-50, and over a reinforcement counter because a counter can only rise.
 *  Here more impressions at the same success count means LESS trust, which is
 *  exactly "shown many times and never helped" expressed as arithmetic. */
export function wilsonLowerBound(successes: number, impressions: number): number {
  if (impressions <= 0) return 0;
  const s = Math.max(0, Math.min(successes, impressions));
  const n = impressions;
  const p = s / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / denom));
}

/** How many times a lesson must have ridden a prompt before its trust is
 *  allowed to count against it. Below this it is unproven, not distrusted —
 *  burying a lesson before it has had a chance is how a corpus never learns
 *  anything new. */
export const MIN_IMPRESSIONS_TO_JUDGE = 5;

/** Below this, a judged lesson is not worth the tokens it costs. */
export const HOLDOUT_TRUST_FLOOR = 0.2;

export type Trust = { trust: number | null; judged: boolean; impressions: number; successes: number };

export function trustScore(input: { successes: number; impressions: number }): Trust {
  const judged = input.impressions >= MIN_IMPRESSIONS_TO_JUDGE;
  return {
    judged,
    trust: judged ? wilsonLowerBound(input.successes, input.impressions) : null,
    impressions: input.impressions,
    successes: input.successes,
  };
}

// ── Arms: you cannot measure an effect without withholding it ─────────────

export type Arm = "inject" | "holdout";

/** Which arm a task belongs to. Deterministic in the task id so the same task
 *  always gets the same treatment (a task that flipped arms mid-flight would
 *  be in neither), and uniform enough that the two arms are comparable.
 *
 *  Without this, "tasks that retrieved lessons went better" is confounded:
 *  retrieval succeeds when the task text resembles work already seen, which
 *  correlates with the task being easier. The confound flatters the feature,
 *  so the control is not optional. */
export function armFor(taskId: string, holdoutFraction: number): Arm {
  const f = Math.max(0, Math.min(1, holdoutFraction));
  if (f <= 0) return "inject";
  if (f >= 1) return "holdout";
  // FNV-1a for the accumulation, then a MurmurHash3 avalanche to spread the
  // result. The avalanche is not decoration: FNV alone over near-identical
  // short keys leaves structure in the high bits, and sampling those gave a
  // 28.5% split for a requested 25% — a bias big enough to swamp the effect
  // this arm exists to measure.
  let h = 0x811c9dc5;
  for (let i = 0; i < taskId.length; i++) {
    h ^= taskId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 < f ? "holdout" : "inject";
}

// ── Outcomes: what counts as "it went well" ──────────────────────────────

export type Outcome = "positive" | "negative" | "neutral";

/** A score alone is not enough to call a task a success, because the
 *  deterministic scorer cannot see the user: it puts most real tasks at the
 *  ceiling and knows nothing about an interrupt or a refused approval. Those
 *  two ARE the user correcting the agent, so they veto a success outright. */
export function classifyOutcome(events: LearningEvent[], score: number): Outcome {
  let completed = false;
  let vetoed = false;
  for (const e of events) {
    if (e.kind === "turn_completed") {
      const status = String((e.data as { status?: string }).status ?? "completed");
      if (status === "completed") completed = true;
      // An interrupt is the user pulling the handbrake; a failure is a
      // failure. Neither is a success at any score.
      else vetoed = true;
    }
    if (e.kind === "approval_decision" && String((e.data as { decision?: string }).decision ?? "") === "decline") {
      vetoed = true;
    }
  }
  if (vetoed) return "negative";
  if (!completed) return "neutral";
  // A bare completion is not evidence of help — it is the modal outcome. Only
  // a genuinely positive score counts.
  return score > 0.25 ? "positive" : "neutral";
}
