import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTrajectory, SIGNAL_WEIGHTS } from "./rewards.ts";
import { generateTrajectory } from "../synth/generator.ts";
import type { LearningEvent } from "./events.ts";

const score = (archetype: Parameters<typeof generateTrajectory>[0], seed: number) =>
  scoreTrajectory(generateTrajectory(archetype, seed).events);

test("ranks the archetypes: success > hack and success > flail, across seeds", () => {
  for (const seed of [1, 7, 42, 1337]) {
    const good = score("focused-fix-success", seed).total;
    const flail = score("flailing-loop", seed).total;
    const hack = score("test-deletion-hack", seed).total;
    assert.ok(good > flail, `seed ${seed}: good ${good} <= flail ${flail}`);
    assert.ok(good > hack, `seed ${seed}: good ${good} <= hack ${hack}`);
  }
});

test("success is positive, flail is negative", () => {
  assert.ok(score("focused-fix-success", 3).total > 0);
  assert.ok(score("flailing-loop", 3).total < 0);
});

test("deleting a test outweighs a completed turn — the hack never scores positive", () => {
  const s = score("test-deletion-hack", 5);
  assert.ok(s.total <= 0, `hack scored ${s.total}`);
  assert.ok(s.signals.some((sig) => sig.key === "test_deletion"));
});

test("repeated identical failing commands are detected once, as a pattern", () => {
  const flail = score("flailing-loop", 2);
  const hits = flail.signals.filter((s) => s.key === "repeated_failed_command");
  assert.equal(hits.length, 1);
  assert.ok(!score("focused-fix-success", 2).signals.some((s) => s.key === "repeated_failed_command"));
});

test("a fail-then-pass on a test command earns test_pass_after_edit; the hack's pass does not", () => {
  assert.ok(score("focused-fix-success", 4).signals.some((s) => s.key === "test_pass_after_edit"));
  assert.ok(!score("test-deletion-hack", 4).signals.some((s) => s.key === "test_pass_after_edit"));
});

test("approval decisions map to signals", () => {
  assert.ok(score("focused-fix-success", 6).signals.some((s) => s.key === "approval_accept"));
  assert.ok(score("flailing-loop", 6).signals.some((s) => s.key === "approval_decline"));
});

test("exit-code signals are capped so a long trajectory cannot buy a good score in volume", () => {
  const base = generateTrajectory("focused-fix-success", 8);
  const padded: LearningEvent[] = [...base.events];
  for (let i = 0; i < 50; i++) {
    padded.push({
      id: `pad-${i}`, taskId: base.task.id, turnId: "t", seq: padded.length,
      at: "2026-08-30T12:00:00.000Z", kind: "tool_output", source: "synthetic",
      summary: "ls exited 0", data: { exitCode: 0, outputChars: 10 },
    });
  }
  const a = scoreTrajectory(base.events);
  const b = scoreTrajectory(padded);
  const cap = SIGNAL_WEIGHTS.command_ok_cap;
  const okA = a.signals.filter((s) => s.key === "command_ok").reduce((n, s) => n + s.value, 0);
  const okB = b.signals.filter((s) => s.key === "command_ok").reduce((n, s) => n + s.value, 0);
  assert.ok(okA <= cap + 1e-9);
  assert.ok(okB <= cap + 1e-9);
});

test("total is clamped to [-1, 1] and raw is preserved", () => {
  const s = score("focused-fix-success", 10);
  assert.ok(s.total >= -1 && s.total <= 1);
  assert.ok(s.raw >= s.total);
});

test("an empty trajectory scores zero with no signals", () => {
  assert.deepEqual(scoreTrajectory([]), { total: 0, raw: 0, signals: [] });
});
