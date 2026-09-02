import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATION_SHARE, ESTIMATED_JUDGE_COST_USD, selectForJudging, type JudgeCandidate } from "./sampling.ts";

const cand = (id: string, score: number, projectKey: string | null = "/p", projectJudged = 0): JudgeCandidate => ({
  taskId: id,
  score,
  projectKey,
  projectJudged,
});

test("the judge goes where the scorer has no discrimination, not where it is already sure", () => {
  // After per-turn scoring, 28 of 35 real tasks still read exactly 1.00. Within
  // that band the deterministic score cannot tell a good session from a
  // useless one that happened to finish every turn — which is exactly where a
  // second opinion buys information. A task at -0.65 with an interrupt and a
  // test deletion is already characterised; paying to confirm it buys little.
  const crowded = Array.from({ length: 10 }, (_, i) => cand(`ceiling-${i}`, 1.0));
  const lonely = [cand("outlier", -0.65)];
  const picked = selectForJudging([...crowded, ...lonely], { limit: 3, budgetUsd: 10 });
  assert.ok(
    picked.filter((p) => p.taskId.startsWith("ceiling")).length >= 2,
    `expected the crowded band to dominate, got ${JSON.stringify(picked.map((p) => p.taskId))}`,
  );
});

test("a project nobody has judged outranks the twentieth task of a well-covered one", () => {
  // Judge lessons are the only project-SCOPED ones, so the first judgement in
  // a project is worth more than another in a project already understood.
  const covered = Array.from({ length: 6 }, (_, i) => cand(`covered-${i}`, 1.0, "/covered", 20));
  const fresh = [cand("fresh-1", 1.0, "/fresh", 0)];
  // Note both carry a real projectKey: the milestone reason is only claimed
  // when there is a project to be a milestone for.
  const picked = selectForJudging([...covered, ...fresh], { limit: 1, budgetUsd: 10 });
  assert.equal(picked[0]!.taskId, "fresh-1");
  assert.match(picked[0]!.reason, /project/i);
});

test("a calibration slice is always reserved, or the judged set is systematically biased", () => {
  // Sampling only the crowded band means the judge is never compared against
  // the scorer anywhere else, so a disagreement outside that band can never be
  // discovered. Same lesson as the holdout arm: leave a channel for evidence
  // that contradicts the policy.
  const crowded = Array.from({ length: 40 }, (_, i) => cand(`ceiling-${i}`, 1.0));
  const spread = [cand("low", -0.6), cand("mid", 0.25), cand("high", 0.68)];
  const picked = selectForJudging([...crowded, ...spread], { limit: 8, budgetUsd: 10 });
  assert.ok(
    picked.some((p) => p.reason.includes("calibration")),
    `expected a calibration pick among ${JSON.stringify(picked.map((p) => [p.taskId, p.reason]))}`,
  );
  assert.ok(CALIBRATION_SHARE > 0 && CALIBRATION_SHARE < 1);
});

test("the plan never exceeds what the budget can pay for", () => {
  const many = Array.from({ length: 50 }, (_, i) => cand(`t-${i}`, 1.0));
  const affordable = Math.floor(0.05 / ESTIMATED_JUDGE_COST_USD);
  const picked = selectForJudging(many, { limit: 50, budgetUsd: 0.05 });
  assert.ok(picked.length <= affordable, `${picked.length} picks exceeds ${affordable} affordable`);
  assert.equal(selectForJudging(many, { limit: 10, budgetUsd: 0 }).length, 0, "no budget, no plan");
});

test("the plan is deterministic, so it can be reviewed before it is paid for", () => {
  const c = Array.from({ length: 20 }, (_, i) => cand(`t-${i}`, i % 2 ? 1.0 : 0.5));
  const a = selectForJudging(c, { limit: 5, budgetUsd: 10 });
  const b = selectForJudging(c, { limit: 5, budgetUsd: 10 });
  assert.deepEqual(a, b);
});

test("every pick carries a reason and an estimated cost", () => {
  const picked = selectForJudging([cand("t-1", 1.0)], { limit: 1, budgetUsd: 10 });
  assert.equal(picked.length, 1);
  assert.ok(picked[0]!.reason.length > 0);
  assert.equal(picked[0]!.estimatedCostUsd, ESTIMATED_JUDGE_COST_USD);
});

test("an empty candidate set is an empty plan, not an error", () => {
  assert.deepEqual(selectForJudging([], { limit: 5, budgetUsd: 10 }), []);
});
