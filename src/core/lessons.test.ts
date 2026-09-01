import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LESSON_MAX,
  distillLessons,
  lessonId,
  refute,
  reinforce,
  rankLessons,
  sanitizeLesson,
  type CandidateLesson,
} from "./lessons.ts";
import { scoreTrajectory } from "./rewards.ts";
import type { LearningEvent } from "./events.ts";
import { generateTrajectory, type Archetype } from "../synth/generator.ts";

function distillFrom(archetype: Archetype, seed: number): CandidateLesson[] {
  const t = generateTrajectory(archetype, seed);
  return distillLessons(t.task, t.events, scoreTrajectory(t.events));
}

test("a successful fix distills the reproduce-verify lesson; a flail distills avoid-lessons", () => {
  const good = distillFrom("focused-fix-success", 1);
  assert.ok(good.some((l) => /reproduce/i.test(l.lesson) && l.polarity === "do"));
  const bad = distillFrom("flailing-loop", 1);
  assert.ok(bad.some((l) => /re-run|unchanged/i.test(l.lesson) && l.polarity === "avoid"));
  assert.ok(bad.some((l) => /focused|many files/i.test(l.lesson) && l.polarity === "avoid"));
});

test("test deletion always distills the safety lesson, regardless of outcome", () => {
  const hack = distillFrom("test-deletion-hack", 2);
  assert.ok(hack.some((l) => /never delete|weaken/i.test(l.lesson)));
});

test("positive lessons only distill from positively scored trajectories", () => {
  const bad = distillFrom("flailing-loop", 3);
  assert.ok(!bad.some((l) => l.polarity === "do"));
});

test("distillation is deterministic and ids are stable across runs", () => {
  const a = distillFrom("focused-fix-success", 4);
  const b = distillFrom("focused-fix-success", 4);
  assert.deepEqual(a, b);
  assert.ok(a.every((l) => l.id.length > 0));
});

test("the same lesson from two different tasks shares one id (that's what reinforcement keys on)", () => {
  const a = distillFrom("flailing-loop", 5);
  const b = distillFrom("flailing-loop", 6);
  const aIds = new Set(a.map((l) => l.id));
  assert.ok(b.some((l) => aIds.has(l.id)));
});

test("reinforce: first sighting starts low; repetition raises confidence asymptotically below 1", () => {
  const fresh = reinforce(null, { taskReward: 0.8 });
  assert.equal(fresh.supportCount, 1);
  assert.ok(fresh.confidence >= 0.3 && fresh.confidence <= 0.5);
  let row = fresh;
  const seen: number[] = [row.confidence];
  for (let i = 0; i < 20; i++) {
    row = reinforce(row, { taskReward: 0.8 });
    seen.push(row.confidence);
  }
  assert.equal(row.supportCount, 21);
  assert.ok(row.confidence < 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! > seen[i - 1]!, "confidence must be monotone");
});

test("reinforce tracks a running mean of source-task rewards", () => {
  let row = reinforce(null, { taskReward: 1.0 });
  row = reinforce(row, { taskReward: 0.0 });
  assert.ok(Math.abs((row.avgReward ?? NaN) - 0.5) < 1e-9);
});

test("rankLessons: same-repo beats other-repo at equal text relevance; confidence breaks ties", () => {
  const mk = (id: string, repoKey: string | null, confidence: number, score: number) => ({
    id, contextKey: "failing_test", repoKey, lesson: `lesson ${id}`,
    confidence, supportCount: 1, avgReward: 0.5, score,
  });
  const ranked = rankLessons(
    [mk("other-repo", "repo-b", 0.9, 1.0), mk("same-repo", "repo-a", 0.5, 1.0), mk("same-repo-confident", "repo-a", 0.9, 1.0)],
    { repoKey: "repo-a" },
  );
  assert.deepEqual(ranked.map((r) => r.id), ["same-repo-confident", "same-repo", "other-repo"]);
});

test("rankLessons: support counts, but logarithmically — 100 sightings can't drown text relevance", () => {
  const mk = (id: string, supportCount: number, score: number) => ({
    id, contextKey: "k", repoKey: null, lesson: id, confidence: 0.5, supportCount, avgReward: 0.5, score,
  });
  const ranked = rankLessons([mk("relevant", 1, 3.0), mk("popular-but-off-topic", 100, 0.2)], {});
  assert.equal(ranked[0]!.id, "relevant");
});

test("lesson identity includes the project: the same text in two projects is two lessons", () => {
  // Without this, a judge lesson about project A merges into project B's row
  // and the last writer's repo wins — which is how every lesson in the M7
  // corpus ended up carrying one arbitrary repo's key.
  const a = lessonId("general", "Run the linter before committing.", "/work/api");
  const b = lessonId("general", "Run the linter before committing.", "/work/web");
  const global = lessonId("general", "Run the linter before committing.", null);
  assert.notEqual(a, b);
  assert.notEqual(a, global);
  assert.notEqual(b, global);
  assert.equal(a, lessonId("general", "Run the linter before committing.", "/work/api"));
});

test("template lessons distill as global — the advice is not project-specific", () => {
  const hack = distillFrom("test-deletion-hack", 7);
  assert.ok(hack.length > 0);
  for (const l of hack) assert.equal(l.projectKey, null, `${l.lesson} should be global`);
});

test("rankLessons: a lesson scoped to this project outranks universal advice", () => {
  const mk = (id: string, projectKey: string | null) => ({
    id, contextKey: "general", repoKey: null, projectKey, lesson: `lesson ${id}`,
    confidence: 0.5, supportCount: 1, avgReward: 0.5, score: 1.0,
  });
  const ranked = rankLessons([mk("global", null), mk("scoped", "/work/api")], { projectKey: "/work/api" });
  assert.deepEqual(ranked.map((r) => r.id), ["scoped", "global"]);
});

test("refute lowers confidence toward zero, asymptotically, and never past it", () => {
  const start = reinforce(null, { taskReward: 1.0 });
  const once = refute(start);
  const twice = refute(once);
  assert.ok(once.confidence < start.confidence);
  assert.ok(twice.confidence < once.confidence);
  assert.ok(twice.confidence > 0);
  // Support is evidence that the behaviour happened; a refutation disputes
  // the ADVICE, so the count stands and only confidence moves.
  assert.equal(once.supportCount, start.supportCount);
});

test("one human refutation outweighs several machine reinforcements", () => {
  let row = reinforce(null, { taskReward: 1.0 });
  for (let i = 0; i < 3; i++) row = reinforce(row, { taskReward: 1.0 });
  const before = row.confidence;
  assert.ok(refute(row).confidence < before / 1.5, "a rejection must cost more than a sighting earns");
});

test("reinforce can rehabilitate a refuted lesson", () => {
  const beaten = refute(refute(reinforce(null, { taskReward: 1.0 })));
  assert.ok(reinforce(beaten, { taskReward: 1.0 }).confidence > beaten.confidence);
});

test("sanitizeLesson redacts secrets and bounds length before a lesson is stored", () => {
  const dirty = "Use the token sk-abcdefghijklmnopqrstuvwxyz012345 when calling the API.";
  const clean = sanitizeLesson(dirty);
  assert.ok(!/sk-abcdefghij/.test(clean), `secret survived: ${clean}`);
  assert.ok(clean.length > 0);
  assert.ok(sanitizeLesson("x".repeat(5000)).length <= LESSON_MAX);
  assert.equal(sanitizeLesson("  keep   the   words  "), "keep the words");
});

// ── Per-turn distillation: which turn produced which lesson ───────────────

const turnEvents = (turnId: string, kinds: [LearningEvent["kind"], Record<string, unknown>][]): LearningEvent[] =>
  kinds.map(([kind, data], i) => ({
    id: `${turnId}-${i}`,
    taskId: "t",
    turnId,
    seq: Number(turnId.replace(/\D/g, "")) * 100 + i,
    at: "2026-09-01T00:00:00.000Z",
    kind,
    source: "app" as const,
    summary: kind,
    data,
  }));

test("a distilled lesson records the turn that produced it", () => {
  const events = [
    ...turnEvents("turn-1", [
      ["file_change", { files: ["a.ts", "b.ts"] }],
      ["turn_completed", { status: "completed" }],
    ]),
  ];
  const score = scoreTrajectory(events);
  const out = distillLessons({ id: "t", createdAt: "x", cwd: "/w", source: "app", taskType: null }, events, score);
  const focused = out.find((l) => /few files/i.test(l.lesson));
  assert.ok(focused, "the focused-edit lesson should distil");
  assert.equal(focused.turnId, "turn-1", "and it should name the turn it came from");
});

test("a positive lesson is gated on ITS OWN turn, not on the task average", () => {
  // The task looks fine overall because turn 2 was clean, but turn 1 deleted a
  // test while making a focused edit. A "do" lesson drawn from turn 1 would be
  // advice learned from a turn that went badly.
  const events = [
    ...turnEvents("turn-1", [
      ["file_change", { files: ["a.ts"], deletedFiles: ["a.test.ts"] }],
      ["turn_completed", { status: "completed" }],
    ]),
    ...turnEvents("turn-2", [["turn_completed", { status: "completed" }]]),
  ];
  const score = scoreTrajectory(events);
  const out = distillLessons({ id: "t", createdAt: "x", cwd: "/w", source: "app", taskType: null }, events, score);
  assert.ok(out.some((l) => /never delete|weaken/i.test(l.lesson)), "the safety lesson still distils");
  assert.ok(
    !out.some((l) => l.polarity === "do"),
    `no 'do' lesson from a turn that deleted a test: ${JSON.stringify(out.map((l) => l.lesson))}`,
  );
});

test("the same lesson from several turns is one candidate, crediting the first turn", () => {
  // Otherwise one task would reinforce a lesson once per turn, and support
  // count would measure session length rather than recurrence across sessions.
  const events = [
    ...turnEvents("turn-1", [["file_change", { files: ["a.ts"] }], ["turn_completed", { status: "completed" }]]),
    ...turnEvents("turn-2", [["file_change", { files: ["b.ts"] }], ["turn_completed", { status: "completed" }]]),
  ];
  const score = scoreTrajectory(events);
  const out = distillLessons({ id: "t", createdAt: "x", cwd: "/w", source: "app", taskType: null }, events, score);
  const focused = out.filter((l) => /few files/i.test(l.lesson));
  assert.equal(focused.length, 1, "one candidate per task");
  assert.equal(focused[0]!.turnId, "turn-1");
});

test("a trajectory-level signal still distils, with no turn to credit", () => {
  const fail = (n: number): LearningEvent[] => [
    { id: `c${n}`, taskId: "t", turnId: null, seq: n * 2, at: "2026-09-01T00:00:00.000Z",
      kind: "tool_call", source: "app", summary: "npm test", data: { argsSummary: "npm test" } },
    { id: `o${n}`, taskId: "t", turnId: null, seq: n * 2 + 1, at: "2026-09-01T00:00:00.000Z",
      kind: "tool_output", source: "app", summary: "fail", data: { exitCode: 1 } },
  ];
  const events = [...fail(1), ...fail(2), ...fail(3)];
  const score = scoreTrajectory(events);
  const out = distillLessons({ id: "t", createdAt: "x", cwd: "/w", source: "app", taskType: null }, events, score);
  const repeat = out.find((l) => /re-run it unchanged/i.test(l.lesson));
  assert.ok(repeat, "the repeated-command lesson still distils");
  assert.equal(repeat.turnId, null);
});
