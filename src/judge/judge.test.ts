import { test } from "node:test";
import assert from "node:assert/strict";
import { MockJudgeBackend } from "./backend.ts";
import { runJudge } from "./judge.ts";
import { JUDGE_PROMPT_VERSION } from "./rubric.ts";
import { openStore } from "../store/db.ts";
import { generateTrajectory, type Archetype } from "../synth/generator.ts";

function storeWith(archetype: Archetype, seed: number) {
  const store = openStore(":memory:");
  const t = generateTrajectory(archetype, seed);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  return { store, taskId: t.task.id };
}

test("judging a good trajectory: high normalized reward, job recorded with mode + prompt version", async () => {
  const { store, taskId } = storeWith("focused-fix-success", 1);
  const result = await runJudge(store, taskId, new MockJudgeBackend());
  assert.ok(result.normalized > 0.5, `expected >0.5, got ${result.normalized}`);
  const job = store.judgeJobForTask(taskId);
  assert.equal(job?.state, "done");
  assert.equal(job?.judgeMode, "mock");
  assert.equal(job?.promptVersion, JUDGE_PROMPT_VERSION);
  assert.equal(store.judgeReward(taskId), result.normalized);
  store.close();
});

test("judging the test-deletion hack: destructive_shortcut triggers and the reward collapses", async () => {
  const { store, taskId } = storeWith("test-deletion-hack", 2);
  const result = await runJudge(store, taskId, new MockJudgeBackend());
  assert.ok(result.verdicts.find((v) => v.id === "destructive_shortcut")?.met);
  assert.ok(result.normalized < 0.3, `expected <0.3, got ${result.normalized}`);
  store.close();
});

test("judge lessons are absorbed into the lesson store with reinforcement", async () => {
  const { store, taskId } = storeWith("test-deletion-hack", 3);
  const before = store.stats().lessons;
  await runJudge(store, taskId, new MockJudgeBackend());
  assert.ok(store.stats().lessons > before, "expected at least one judge lesson");
  const hits = store.searchLessons("delete tests", 5);
  assert.ok(hits.length > 0);
  store.close();
});

test("re-judging replaces the job and the reward — never duplicates", async () => {
  const { store, taskId } = storeWith("focused-fix-success", 4);
  await runJudge(store, taskId, new MockJudgeBackend());
  await runJudge(store, taskId, new MockJudgeBackend());
  assert.equal(store.judgeJobCount(taskId), 1);
  const rewards = store.stats().rewards;
  await runJudge(store, taskId, new MockJudgeBackend());
  assert.equal(store.stats().rewards, rewards, "reward rows must not accumulate");
  store.close();
});

test("the mock is deterministic and speaks the real wire shape (fenced JSON)", async () => {
  const mock = new MockJudgeBackend();
  const t = generateTrajectory("flailing-loop", 5);
  const a = await mock.complete("sys", `DETERMINISTIC SIGNALS: repeated_failed_command -0.5 TOTAL: -1.00\nGOAL: x`);
  const b = await mock.complete("sys", `DETERMINISTIC SIGNALS: repeated_failed_command -0.5 TOTAL: -1.00\nGOAL: x`);
  assert.equal(a.text, b.text);
  assert.ok(a.text.includes("```json"), "mock must exercise the fence-stripping path");
  assert.equal(a.costUsd, 0);
});

test("a backend failure marks the job failed and leaves no judge reward", async () => {
  const { store, taskId } = storeWith("focused-fix-success", 6);
  const broken = { mode: "mock" as const, complete: async () => { throw new Error("boom"); } };
  await assert.rejects(() => runJudge(store, taskId, broken));
  assert.equal(store.judgeJobForTask(taskId)?.state, "failed");
  assert.equal(store.judgeReward(taskId), null);
  store.close();
});

test("judge jobs record wall-clock duration in milliseconds, not second-resolution timestamps", async () => {
  const { store, taskId } = storeWith("focused-fix-success", 7);
  const slow = {
    mode: "mock" as const,
    complete: async (s: string, u: string) => {
      await new Promise((r) => setTimeout(r, 25));
      return new MockJudgeBackend().complete(s, u);
    },
  };
  await runJudge(store, taskId, slow);
  const job = store.judgeJobForTask(taskId);
  assert.ok(typeof job?.durationMs === "number" && job.durationMs >= 25, `got ${job?.durationMs}`);
  store.close();
});
