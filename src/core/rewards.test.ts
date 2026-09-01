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
  assert.deepEqual(scoreTrajectory([]), { total: 0, raw: 0, perTurn: [], signals: [] });
});

test("per-turn scoring: a 30-turn task no longer scores the same as a 1-turn task", () => {
  // The ceiling problem, measured: 31 of 35 real tasks read exactly 1.00 with
  // unclamped sums from 1.0 to 9.3, because completion (+1.0) is summed per
  // turn and then clamped. Scoring each turn and averaging makes the number
  // mean "how well did this go", not "how many turns were there".
  const turn = (n: number, status = "completed"): LearningEvent[] => [
    {
      id: `t${n}-c`, taskId: "t", turnId: `turn-${n}`, seq: n * 10, at: "2026-09-01T00:00:00.000Z",
      kind: "turn_completed", source: "app", summary: "done", data: { status },
    },
  ];
  const one = scoreTrajectory(turn(1));
  const thirty = scoreTrajectory(Array.from({ length: 30 }, (_, i) => turn(i + 1)).flat());
  assert.equal(one.perTurn.length, 1);
  assert.equal(thirty.perTurn.length, 30);
  // Both are "every turn completed cleanly", so both should read the same.
  assert.ok(Math.abs(one.total - thirty.total) < 1e-9, `${one.total} vs ${thirty.total}`);
  // And raw still records what the sum was, for anyone who wants it.
  assert.ok(thirty.raw > one.raw);
});

test("per-turn scoring: one bad turn among many is visible instead of drowned", () => {
  const mk = (n: number, status: string): LearningEvent => ({
    id: `t${n}`, taskId: "t", turnId: `turn-${n}`, seq: n, at: "2026-09-01T00:00:00.000Z",
    kind: "turn_completed", source: "app", summary: "x", data: { status },
  });
  const allGood = scoreTrajectory([mk(1, "completed"), mk(2, "completed"), mk(3, "completed")]);
  const oneBad = scoreTrajectory([mk(1, "completed"), mk(2, "interrupted"), mk(3, "completed")]);
  assert.ok(oneBad.total < allGood.total, "an interrupted turn has to cost something");
  const bad = oneBad.perTurn.find((t) => t.turnId === "turn-2");
  assert.ok(bad && bad.total < 0, "and it must be attributable to the turn it happened in");
});

test("signals with no turn of their own still count once, at the task level", () => {
  // repeated_failed_command is a property of the whole trajectory, not of any
  // single turn; it must not be silently dropped by per-turn bucketing.
  const cmd = (n: number, exit: number): LearningEvent[] => [
    { id: `c${n}`, taskId: "t", turnId: null, seq: n * 2, at: "2026-09-01T00:00:00.000Z",
      kind: "tool_call", source: "app", summary: "npm test", data: { argsSummary: "npm test" } },
    { id: `o${n}`, taskId: "t", turnId: null, seq: n * 2 + 1, at: "2026-09-01T00:00:00.000Z",
      kind: "tool_output", source: "app", summary: "fail", data: { exitCode: exit } },
  ];
  const s = scoreTrajectory([...cmd(1, 1), ...cmd(2, 1), ...cmd(3, 1)]);
  assert.ok(s.signals.some((x) => x.key === "repeated_failed_command"), "the trajectory-level signal survives");
});
