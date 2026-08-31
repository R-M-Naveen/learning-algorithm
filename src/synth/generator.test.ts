import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTrajectory, ARCHETYPES } from "./generator.ts";
import { validateEvent } from "../core/events.ts";

test("same archetype + seed generates byte-identical trajectories", () => {
  const a = generateTrajectory("focused-fix-success", 42);
  const b = generateTrajectory("focused-fix-success", 42);
  assert.deepEqual(a, b);
});

test("different seeds differ, so a corpus is not one trajectory repeated", () => {
  const a = generateTrajectory("focused-fix-success", 1);
  const b = generateTrajectory("focused-fix-success", 2);
  assert.notDeepEqual(a.events, b.events);
  assert.notEqual(a.task.id, b.task.id);
});

test("every generated event validates and seq is contiguous from 0", () => {
  for (const archetype of ARCHETYPES) {
    const t = generateTrajectory(archetype, 7);
    t.events.forEach((e, i) => {
      const r = validateEvent(e);
      assert.equal(r.ok, true, `${archetype}[${i}]: ${r.ok ? "" : r.error}`);
      assert.equal(e.seq, i);
      assert.equal(e.source, "synthetic");
      assert.equal(e.taskId, t.task.id);
    });
  }
});

test("ground truth carries the archetype and a success label", () => {
  assert.equal(generateTrajectory("focused-fix-success", 3).groundTruth.succeeded, true);
  assert.equal(generateTrajectory("flailing-loop", 3).groundTruth.succeeded, false);
});

test("focused-fix-success ends completed with passing tests; flailing-loop repeats failures", () => {
  const good = generateTrajectory("focused-fix-success", 11);
  const last = good.events.at(-1)!;
  assert.equal(last.kind, "turn_completed");
  assert.equal((last.data as { status: string }).status, "completed");
  const failsIn = (evs: typeof good.events) =>
    evs.filter((e) => e.kind === "tool_output" && (e.data as { exitCode?: number }).exitCode === 1).length;
  const bad = generateTrajectory("flailing-loop", 11);
  assert.ok(failsIn(bad.events) >= 3, "flail should repeat failing commands");
  assert.ok(failsIn(bad.events) > failsIn(good.events));
});

test("flailing-loop fabricates an approval decline, provenance-labeled synthetic", () => {
  const bad = generateTrajectory("flailing-loop", 5);
  const decision = bad.events.find((e) => e.kind === "approval_decision");
  assert.ok(decision, "expected a fabricated approval_decision");
  assert.equal((decision!.data as { decision: string }).decision, "decline");
});

test("test-deletion-hack completes its turn yet is labeled a failure with the test_deletion trait", () => {
  const t = generateTrajectory("test-deletion-hack", 9);
  const last = t.events.at(-1)!;
  assert.equal(last.kind, "turn_completed");
  assert.equal((last.data as { status: string }).status, "completed");
  assert.equal(t.groundTruth.succeeded, false);
  assert.ok(t.groundTruth.traits.includes("test_deletion"));
  const del = t.events.find(
    (e) => e.kind === "file_change" && /delet/i.test(e.summary) && /test/i.test(e.summary),
  );
  assert.ok(del, "expected a file_change that deletes a test");
});
