import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRAJECTORY_RUBRIC, JUDGE_SYSTEM, JUDGE_PROMPT_VERSION,
  buildJudgePacket, scoreVerdicts, fillOmitted, PACKET_CHAR_CAP,
} from "./rubric.ts";
import { scoreTrajectory } from "../core/rewards.ts";
import { generateTrajectory } from "../synth/generator.ts";
import type { LearningEvent } from "../core/events.ts";

test("the rubric has both positive and negative criteria and a versioned prompt", () => {
  assert.ok(TRAJECTORY_RUBRIC.some((c) => c.weight > 0));
  assert.ok(TRAJECTORY_RUBRIC.some((c) => c.weight < 0));
  assert.match(JUDGE_PROMPT_VERSION, /^\d+\.\d+$/);
  assert.ok(JUDGE_SYSTEM.includes("JSON"));
  assert.ok(/negative/i.test(JUDGE_SYSTEM), "must explain negative-criterion semantics");
});

test("scoreVerdicts: all positives met = 1; nothing met = 0; penalties drag toward 0 but never below", () => {
  const allPos = TRAJECTORY_RUBRIC.filter((c) => c.weight > 0).map((c) => ({ id: c.id, met: true, rationale: "" }));
  assert.equal(scoreVerdicts(allPos).normalized, 1);
  assert.equal(scoreVerdicts([]).normalized, 0);
  const negId = TRAJECTORY_RUBRIC.find((c) => c.weight < 0)!.id;
  const withPenalty = scoreVerdicts([...allPos, { id: negId, met: true, rationale: "" }]);
  assert.ok(withPenalty.normalized < 1);
  const onlyPenalty = scoreVerdicts([{ id: negId, met: true, rationale: "" }]);
  assert.equal(onlyPenalty.normalized, 0, "clamped at 0, never negative");
});

test("fillOmitted: every rubric criterion appears exactly once, omissions default to not-met", () => {
  const partial = [{ id: TRAJECTORY_RUBRIC[0]!.id, met: true, rationale: "x" }];
  const full = fillOmitted(partial);
  assert.equal(full.length, TRAJECTORY_RUBRIC.length);
  const omitted = full.find((v) => v.id !== TRAJECTORY_RUBRIC[0]!.id)!;
  assert.equal(omitted.met, false);
  assert.equal(omitted.rationale, "omitted by judge");
});

test("the packet carries the goal, the deterministic signals, and the event digest", () => {
  const t = generateTrajectory("focused-fix-success", 1);
  const packet = buildJudgePacket(t.task, t.events, scoreTrajectory(t.events));
  assert.ok(packet.includes("test_pass_after_edit"), "signals must be visible to the judge");
  assert.ok(packet.includes("Fix the failing test"), "the user's goal must be visible");
  assert.ok(packet.includes("turn completed"), "the ending must be visible");
});

test("the packet is capped: a huge trajectory keeps its head and tail, stays under the cap", () => {
  const t = generateTrajectory("focused-fix-success", 2);
  const padded: LearningEvent[] = [...t.events];
  for (let i = 0; i < 2000; i++) {
    padded.splice(2, 0, {
      id: `pad-${i}`, taskId: t.task.id, turnId: "t", seq: 0,
      at: "2026-08-30T12:00:00.000Z", kind: "tool_output", source: "synthetic",
      summary: `padding output number ${i} with some length to it`, data: { exitCode: 0, outputChars: 10 },
    });
  }
  padded.forEach((e, i) => (e.seq = i));
  const packet = buildJudgePacket(t.task, padded, scoreTrajectory(padded));
  assert.ok(packet.length <= PACKET_CHAR_CAP, `packet ${packet.length} > cap ${PACKET_CHAR_CAP}`);
  assert.ok(packet.includes("Fix the failing test"), "head survives");
  assert.ok(packet.includes("turn completed"), "tail survives");
  assert.ok(packet.includes("elided"), "the elision is declared, not silent");
});

test("the signals line cannot crowd out the trajectory it is supposed to be checked against", () => {
  // Measured on real packets: the unbounded signals line took up to 4220 of
  // 6000 chars, leaving ~1.4 chars per event for a 1043-event trajectory. The
  // judge was then grading the deterministic scorer's own summary, which
  // mechanically manufactures agreement and destroys the point of a second
  // opinion.
  const events = Array.from({ length: 400 }, (_, i) => ({
    id: `e${i}`,
    taskId: "t",
    turnId: "turn-1",
    seq: i,
    at: "2026-09-01T00:00:00.000Z",
    kind: i === 0 ? ("user_message" as const) : ("tool_call" as const),
    source: "rollout" as const,
    summary: i === 0 ? "fix the failing test" : `ran some command number ${i} with a fairly long summary line`,
    data: {},
  }));
  const signals = Array.from({ length: 300 }, (_, i) => ({
    key: `signal_number_${i}`,
    value: 0.05,
    detail: `a detail string that is deliberately quite long for signal ${i}`,
  }));
  const packet = buildJudgePacket({ id: "t", cwd: "/w", taskType: null }, events, {
    total: 1,
    raw: 15,
    signals,
  });

  assert.ok(packet.length <= PACKET_CHAR_CAP, `packet is ${packet.length}`);
  const digest = packet.slice(packet.indexOf("EVENTS:"));
  assert.ok(
    digest.length > PACKET_CHAR_CAP * 0.4,
    `the trajectory must keep a real share of the packet, got ${digest.length} of ${PACKET_CHAR_CAP}`,
  );
  // And the truncation must announce itself, in both places.
  assert.match(packet, /signals elided/);
  assert.ok(packet.includes("GOAL: fix the failing test"), "the goal survives truncation");
});
