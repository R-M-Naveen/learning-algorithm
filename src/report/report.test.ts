import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.ts";
import { openStore, type Store } from "../store/db.ts";
import { generateTrajectory } from "../synth/generator.ts";
import { scoreTrajectory } from "../core/rewards.ts";
import { distillLessons } from "../core/lessons.ts";
import { runJudge } from "../judge/judge.ts";
import { MockJudgeBackend } from "../judge/backend.ts";

async function corpus(): Promise<Store> {
  const store = openStore(":memory:");
  for (const [archetype, seeds] of [
    ["focused-fix-success", [1, 2]],
    ["flailing-loop", [1]],
    ["test-deletion-hack", [1]],
  ] as const) {
    for (const seed of seeds) {
      const t = generateTrajectory(archetype, seed);
      store.upsertTask(t.task);
      store.appendEvents(t.events);
      const score = scoreTrajectory(t.events);
      store.recordScore(t.task.id, score);
      store.absorbLessons(distillLessons(t.task, t.events, score), score.total);
      await runJudge(store, t.task.id, new MockJudgeBackend());
    }
  }
  return store;
}

test("the report carries every section the observe-only evaluation needs", async () => {
  const store = await corpus();
  const md = buildReport(store);
  for (const heading of [
    "## Corpus", "## Score distribution", "## Signal frequencies",
    "## Judge vs deterministic", "## Lessons", "## Retrieval dry run", "## Caveats",
  ]) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
  store.close();
});

test("corpus counts and score stats are real numbers from the store", async () => {
  const store = await corpus();
  const md = buildReport(store);
  assert.match(md, /4 tasks/);
  assert.match(md, /synthetic: 4/);
  assert.ok(md.includes("test_deletion"), "signal table must include the safety signal");
  store.close();
});

test("judge/deterministic disagreements are surfaced, agreement is quantified", async () => {
  const store = await corpus();
  const md = buildReport(store);
  assert.match(md, /judged tasks: 4/i);
  // hack: det -0.8 vs judge 0.0 → agree; success: det 1.0 vs judge 1.0 → agree.
  // The section must exist with a computed count either way.
  assert.match(md, /disagreements?: \d/i);
  store.close();
});

test("the retrieval dry run reports a hit rate over tasks with a recorded goal", async () => {
  const store = await corpus();
  const md = buildReport(store);
  assert.match(md, /tasks with a goal: \d+ of 4/i);
  assert.match(md, /returned lessons for \d+/i);
  store.close();
});

test("an empty store produces a report that says so instead of dividing by zero", () => {
  const store = openStore(":memory:");
  const md = buildReport(store);
  assert.match(md, /0 tasks/);
  assert.ok(!md.includes("NaN"));
  store.close();
});
