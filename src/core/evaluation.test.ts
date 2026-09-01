import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOLDOUT_TRUST_FLOOR,
  MIN_IMPRESSIONS_TO_JUDGE,
  armFor,
  classifyOutcome,
  trustScore,
  wilsonLowerBound,
} from "./evaluation.ts";
import type { LearningEvent } from "./events.ts";

// ── Wilson: few observations must not look confident ──────────────────────

test("no evidence earns no trust, however you slice it", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(0, 5), 0 < wilsonLowerBound(0, 5) ? wilsonLowerBound(0, 5) : 0);
  assert.ok(wilsonLowerBound(0, 5) === 0, "five impressions and no successes is zero trust");
});

test("one success out of one is not as trusted as fifty out of fifty", () => {
  assert.ok(wilsonLowerBound(1, 1) < wilsonLowerBound(50, 50));
  assert.ok(wilsonLowerBound(1, 1) < 0.6, "a single observation must stay modest");
  assert.ok(wilsonLowerBound(50, 50) > 0.9);
});

test("silence erodes trust: impressions without successes push the bound down", () => {
  // This is the property the old confidence scalar could not express — it
  // only ever rose. Here, being shown and not helping is itself evidence.
  const early = wilsonLowerBound(3, 4);
  const later = wilsonLowerBound(3, 20);
  const muchLater = wilsonLowerBound(3, 60);
  assert.ok(later < early, "more impressions at the same success count = less trust");
  assert.ok(muchLater < later);
});

test("the bound is a probability and never escapes [0,1]", () => {
  for (const [s, n] of [
    [0, 0],
    [0, 1],
    [1, 1],
    [7, 7],
    [3, 9],
    [999, 1000],
  ] as const) {
    const v = wilsonLowerBound(s, n);
    assert.ok(v >= 0 && v <= 1, `${s}/${n} → ${v}`);
  }
});

test("trustScore withholds judgement until there are enough impressions", () => {
  // Below the threshold a lesson is unproven, not distrusted: it ranks on its
  // other merits rather than being buried before it has had a chance.
  const unproven = trustScore({ successes: 0, impressions: MIN_IMPRESSIONS_TO_JUDGE - 1 });
  assert.equal(unproven.judged, false);
  assert.equal(unproven.trust, null);

  const judged = trustScore({ successes: 0, impressions: MIN_IMPRESSIONS_TO_JUDGE });
  assert.equal(judged.judged, true);
  assert.ok((judged.trust ?? 1) < HOLDOUT_TRUST_FLOOR, "shown that often and never helping is a failing grade");
});

// ── Arms: deterministic, stable, and roughly the requested split ──────────

test("a task's arm is deterministic and stable across calls", () => {
  const a = armFor("task-abc", 0.2);
  assert.equal(a, armFor("task-abc", 0.2));
  assert.ok(a === "inject" || a === "holdout");
});

test("a holdout fraction of 0 never withholds and 1 always does", () => {
  for (const id of ["a", "b", "c", "d", "e"]) {
    assert.equal(armFor(id, 0), "inject");
    assert.equal(armFor(id, 1), "holdout");
  }
});

test("the split lands near the requested fraction over many tasks", () => {
  const n = 4000;
  let held = 0;
  for (let i = 0; i < n; i++) if (armFor(`task-${i}`, 0.25) === "holdout") held++;
  const frac = held / n;
  assert.ok(Math.abs(frac - 0.25) < 0.03, `expected ~0.25, got ${frac}`);
});

// ── Outcomes: an interrupt or a decline is not a success ──────────────────

const ev = (kind: LearningEvent["kind"], data: Record<string, unknown> = {}): LearningEvent => ({
  id: `e-${Math.trunc(Math.abs(Math.sin(kind.length) * 1e6))}-${kind}-${JSON.stringify(data).length}`,
  taskId: "t",
  turnId: "turn-1",
  seq: 0,
  at: "2026-09-01T00:00:00.000Z",
  kind,
  source: "app",
  summary: kind,
  data,
});

test("a clean completion with a positive score is a success", () => {
  const out = classifyOutcome([ev("turn_completed", { status: "completed" })], 0.8);
  assert.equal(out, "positive");
});

test("an interrupted turn is never a success, whatever the score says", () => {
  // The user stopping the agent is a correction, and the deterministic score
  // cannot see it — 21 of 25 real tasks scored 1.00 regardless.
  assert.equal(classifyOutcome([ev("turn_completed", { status: "interrupted" })], 1.0), "negative");
});

test("a declined approval in the turn counts against it", () => {
  const out = classifyOutcome(
    [ev("approval_decision", { decision: "decline" }), ev("turn_completed", { status: "completed" })],
    1.0,
  );
  assert.equal(out, "negative", "the user refused what the agent proposed");
});

test("an accepted approval does not spoil a success", () => {
  const out = classifyOutcome(
    [ev("approval_decision", { decision: "accept" }), ev("turn_completed", { status: "completed" })],
    0.9,
  );
  assert.equal(out, "positive");
});

test("a failed turn is negative; an unfinished one is neither", () => {
  assert.equal(classifyOutcome([ev("turn_completed", { status: "failed" })], 0.5), "negative");
  assert.equal(classifyOutcome([ev("user_message")], 0.5), "neutral");
});

test("a mediocre score is neutral rather than a success", () => {
  assert.equal(classifyOutcome([ev("turn_completed", { status: "completed" })], 0.05), "neutral");
});
