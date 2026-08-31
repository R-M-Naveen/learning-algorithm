import { test } from "node:test";
import assert from "node:assert/strict";
import { JudgeGovernor, runJudgeGated } from "./governor.ts";
import { JudgeTransportError } from "./pareto.ts";
import { MockJudgeBackend } from "./backend.ts";
import { openStore } from "../store/db.ts";
import { generateTrajectory } from "../synth/generator.ts";

const gov = (over: Partial<ConstructorParameters<typeof JudgeGovernor>[0]> = {}) =>
  new JudgeGovernor({ enabled: true, maxInFlight: 1, onlyWhenIdle: true, budgetUsd: 1, spentUsd: 0, ...over });

test("disabled is the default posture and refuses everything", () => {
  const g = new JudgeGovernor({ budgetUsd: 1, spentUsd: 0 });
  assert.deepEqual(g.admit(), { ok: false, reason: "disabled" });
});

test("idle gating: refuses while the app is busy, admits when idle", () => {
  const g = gov();
  assert.deepEqual(g.admit(), { ok: false, reason: "not_idle" }); // idleness must be reported, not assumed
  g.setIdle(true);
  assert.equal(g.admit().ok, true);
  g.setIdle(false);
  assert.deepEqual(g.admit(), { ok: false, reason: "not_idle" });
});

test("one in flight, hard: second admit refused until release", () => {
  const g = gov();
  g.setIdle(true);
  assert.equal(g.admit().ok, true);
  assert.deepEqual(g.admit(), { ok: false, reason: "busy" });
  g.release();
  assert.equal(g.admit().ok, true);
});

test("budget is a ceiling across sessions: prior spend counts, and crossing it shuts the door", () => {
  const g = gov({ budgetUsd: 0.1, spentUsd: 0.08 });
  g.setIdle(true);
  assert.equal(g.admit().ok, true);
  g.addSpend(0.03); // now 0.11 > 0.10
  g.release();
  assert.deepEqual(g.admit(), { ok: false, reason: "budget_exhausted" });
});

test("a payment failure suspends the governor until explicitly re-enabled", () => {
  const g = gov();
  g.setIdle(true);
  g.notePayment();
  assert.deepEqual(g.admit(), { ok: false, reason: "payment_required" });
});

test("runJudgeGated: refusal returns the reason without touching the store", async () => {
  const store = openStore(":memory:");
  const t = generateTrajectory("focused-fix-success", 1);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  const g = gov(); // not idle
  const r = await runJudgeGated(store, t.task.id, new MockJudgeBackend(), g);
  assert.deepEqual(r, { ok: false, reason: "not_idle" });
  assert.equal(store.judgeJobForTask(t.task.id), null);
  store.close();
});

test("runJudgeGated: success accounts spend and releases the slot", async () => {
  const store = openStore(":memory:");
  const t = generateTrajectory("focused-fix-success", 2);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  const g = gov();
  g.setIdle(true);
  const r = await runJudgeGated(store, t.task.id, new MockJudgeBackend(), g);
  assert.equal(r.ok, true);
  assert.equal(g.admit().ok, true, "slot must be released after success");
  store.close();
});

test("runJudgeGated: a transport drop marks the job dropped, releases the slot, never throws", async () => {
  const store = openStore(":memory:");
  const t = generateTrajectory("focused-fix-success", 3);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  const g = gov();
  g.setIdle(true);
  const dropping = {
    mode: "pareto" as const,
    complete: async () => { throw new JudgeTransportError("backpressure", "429"); },
  };
  const r = await runJudgeGated(store, t.task.id, dropping, g);
  assert.deepEqual(r, { ok: false, reason: "backpressure" });
  assert.equal(store.judgeJobForTask(t.task.id)?.state, "dropped");
  assert.equal(g.admit().ok, true, "slot released after drop");
  store.close();
});

test("runJudgeGated: a 402 drop also suspends the governor", async () => {
  const store = openStore(":memory:");
  const t = generateTrajectory("focused-fix-success", 4);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  const g = gov();
  g.setIdle(true);
  const broke = {
    mode: "pareto" as const,
    complete: async () => { throw new JudgeTransportError("payment", "402"); },
  };
  await runJudgeGated(store, t.task.id, broke, g);
  assert.deepEqual(g.admit(), { ok: false, reason: "payment_required" });
  store.close();
});
