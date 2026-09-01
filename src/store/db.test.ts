import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./db.ts";
import type { LearningEvent } from "../core/events.ts";
import { generateTrajectory } from "../synth/generator.ts";
import { scoreTrajectory } from "../core/rewards.ts";

function ev(partial: Partial<LearningEvent>): LearningEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    taskId: "task-1",
    turnId: "turn-1",
    seq: 0,
    at: "2026-08-30T12:00:00.000Z",
    kind: "tool_output",
    source: "synthetic",
    summary: "ok",
    data: {},
    ...partial,
  };
}

test("migrates a fresh database and reports its tables", () => {
  const store = openStore(":memory:");
  const tables = store.tableNames();
  for (const t of ["tasks", "events", "rewards", "judge_jobs", "lessons", "lesson_usage", "approval_stats"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  store.close();
});

test("events round-trip in seq order and tasks upsert from them", () => {
  const store = openStore(":memory:");
  store.upsertTask({ id: "task-1", createdAt: "2026-08-30T12:00:00.000Z", cwd: "/repo", source: "synthetic" });
  const r = store.appendEvents([
    ev({ seq: 1, summary: "second" }),
    ev({ seq: 0, summary: "first" }),
  ]);
  assert.equal(r.accepted, 2);
  assert.equal(r.dropped, 0);
  const back = store.eventsForTask("task-1");
  assert.deepEqual(back.map((e) => e.summary), ["first", "second"]);
  assert.equal(store.stats().events, 2);
  store.close();
});

test("an invalid event is dropped with a reason, not stored and not fatal to the batch", () => {
  const store = openStore(":memory:");
  const r = store.appendEvents([ev({}), { ...ev({}), kind: "telepathy" } as unknown as LearningEvent]);
  assert.equal(r.accepted, 1);
  assert.equal(r.dropped, 1);
  assert.match(r.reasons[0] ?? "", /kind/);
  store.close();
});

test("duplicate event ids are idempotent (replay-safe), not an error", () => {
  const store = openStore(":memory:");
  const e = ev({ id: "fixed-id" });
  store.appendEvents([e]);
  const r = store.appendEvents([e]);
  assert.equal(r.accepted, 1); // accepted-as-noop
  assert.equal(store.stats().events, 1);
  store.close();
});

test("lessons are FTS-searchable with BM25 ranking", () => {
  const store = openStore(":memory:");
  store.upsertLesson({
    id: "l1", contextKey: "typescript:failing_test", repoKey: "repo-a",
    lesson: "Read the failing test and stack trace before editing implementation.",
    confidence: 0.8, supportCount: 3,
  });
  store.upsertLesson({
    id: "l2", contextKey: "typescript:ui_bug", repoKey: "repo-a",
    lesson: "Reproduce the rendering glitch in the browser before changing CSS.",
    confidence: 0.6, supportCount: 1,
  });
  const hits = store.searchLessons("failing test stack trace", 5);
  assert.equal(hits[0]?.id, "l1");
  store.close();
});

test("upsertLesson on an existing id updates confidence/support and the FTS index follows", () => {
  const store = openStore(":memory:");
  store.upsertLesson({ id: "l1", contextKey: "k", repoKey: "r", projectKey: null, lesson: "narrow tests first", confidence: 0.5, supportCount: 1 });
  store.upsertLesson({ id: "l1", contextKey: "k", repoKey: "r", projectKey: null, lesson: "run narrow tests before the full suite", confidence: 0.7, supportCount: 2 });
  const hits = store.searchLessons("full suite", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.confidence, 0.7);
  assert.equal(store.stats().lessons, 1);
  store.close();
});

test("recordScore persists per-signal rewards and rolls the total up onto the task", () => {
  const store = openStore(":memory:");
  store.upsertTask({ id: "task-1", createdAt: "2026-08-30T12:00:00.000Z", cwd: "/repo", source: "synthetic" });
  store.recordScore("task-1", {
    total: 0.8,
    raw: 1.3,
    signals: [
      { key: "turn_completed", value: 1.0 },
      { key: "focused_edit", value: 0.2, detail: "1 file(s)" },
    ],
  });
  assert.equal(store.stats().rewards, 2);
  assert.equal(store.taskReward("task-1"), 0.8);
  // Re-scoring replaces, never accumulates — a task has one deterministic score.
  store.recordScore("task-1", { total: 0.5, raw: 0.5, signals: [{ key: "turn_completed", value: 1.0 }] });
  assert.equal(store.stats().rewards, 1);
  assert.equal(store.taskReward("task-1"), 0.5);
  store.close();
});

test("absorbLessons: first sighting inserts, repeat sighting reinforces the same row", () => {
  const store = openStore(":memory:");
  const candidate = {
    id: "abc123", contextKey: "failing_test", repoKey: "repo-a",
    lesson: "Never delete or weaken tests to make the suite pass.", polarity: "avoid" as const,
    projectKey: null, turnId: null,
  };
  store.absorbLessons([candidate], 0.8);
  store.absorbLessons([candidate], 0.4);
  assert.equal(store.stats().lessons, 1);
  const [row] = store.searchLessons("delete weaken tests", 5);
  assert.equal(row!.supportCount, 2);
  assert.ok(row!.confidence > 0.4);
  assert.ok(Math.abs((row!.avgReward ?? NaN) - 0.6) < 1e-9);
  store.close();
});

test("planted lesson: the topical, same-repo lesson wins the query", () => {
  const store = openStore(":memory:");
  const plant = (id: string, repoKey: string, lesson: string) =>
    store.absorbLessons([{ id, contextKey: "failing_test", repoKey, projectKey: null, turnId: null, lesson, polarity: "do" as const }], 0.9);
  plant("l-target", "webshop", "Reproduce the failing test first, then make a focused edit.");
  plant("l-other-repo", "api-server", "Reproduce the failing test first, then make a focused edit.");
  plant("l-off-topic", "webshop", "Prefer narrow lint runs before committing.");
  const ranked = store.queryLessons("fix the failing test in auth", { repoKey: "webshop", limit: 3 });
  assert.equal(ranked[0]!.id, "l-target");
  store.close();
});

test("lesson usage: record on injection, resolve when the task ends, last_used_at follows", () => {
  const store = openStore(":memory:");
  store.absorbLessons(
    [{ id: "l1", contextKey: "k", repoKey: null, projectKey: null, turnId: null, lesson: "reproduce first", polarity: "do" as const }],
    0.5,
  );
  store.recordLessonUse(["l1"], "task-9", "turn-1");
  let usage = store.usageForTask("task-9");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.outcome, null);
  store.resolveLessonUse("task-9", "completed");
  usage = store.usageForTask("task-9");
  assert.equal(usage[0]!.outcome, "completed");
  const [row] = store.searchLessons("reproduce", 1);
  assert.ok(row, "lesson still searchable after use");
  store.close();
});

test("a project-scoped lesson never surfaces in another project; global advice surfaces in both", () => {
  // The leakage fix. Before this, repo affinity was a +0.3 ranking bonus and
  // nothing else, so a lesson learned in one repo could outrank the local
  // one on text relevance alone.
  const store = openStore(":memory:");
  store.absorbLessons(
    [
      { id: "scoped-a", contextKey: "general", repoKey: null, projectKey: "/work/api", turnId: null,
        lesson: "The api project pins its migrations by hand.", polarity: "avoid" },
      { id: "scoped-b", contextKey: "general", repoKey: null, projectKey: "/work/web", turnId: null,
        lesson: "The web project pins its migrations by hand.", polarity: "avoid" },
      { id: "universal", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
        lesson: "Never delete tests to make the suite pass, pins or otherwise.", polarity: "avoid" },
    ],
    1.0,
  );

  const inApi = store.queryLessons("pins migrations tests", { projectKey: "/work/api", limit: 10 }).map((l) => l.id);
  assert.ok(inApi.includes("scoped-a"));
  assert.ok(inApi.includes("universal"), "universal advice applies everywhere");
  assert.ok(!inApi.includes("scoped-b"), "another project's lesson must not leak in");

  const anywhere = store.queryLessons("pins migrations tests", { limit: 10 }).map((l) => l.id);
  assert.ok(anywhere.includes("scoped-a") && anywhere.includes("scoped-b"), "an unscoped query still sees everything");
  store.close();
});

test("a refuted lesson stops being retrieved, and the refutation is on the record", () => {
  const store = openStore(":memory:");
  const l = { id: "doomed", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
    lesson: "Always run the whole suite before every commit.", polarity: "do" as const };
  store.absorbLessons([l], 1.0);
  assert.equal(store.queryLessons("suite commit", { limit: 5 }).length, 1);

  // Refuted until it falls under the retrieval floor: the row survives for
  // audit, but it stops riding prompts.
  let last = 1;
  for (let i = 0; i < 12 && last > 0; i++) {
    const r = store.refuteLesson("doomed");
    assert.ok(!("error" in r));
    last = store.queryLessons("suite commit", { limit: 5 }).length;
  }
  assert.equal(last, 0, "a thoroughly refuted lesson must not be returned");
  assert.equal(store.stats().lessons, 1, "the row is kept for audit");
  assert.ok(store.refutationCount("doomed") > 0);

  assert.ok("error" in store.refuteLesson("no-such-lesson"));
  store.close();
});

test("the store refuses a lesson whose text still carries a secret", () => {
  // Belt-and-suspenders, the same shape as validateEvent refusing an event:
  // the boundary sanitizes, the store still checks, because a lesson goes
  // back out into a prompt.
  const store = openStore(":memory:");
  store.absorbLessons(
    [{ id: "leaky", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
       lesson: "Authenticate with Bearer abcdefghijklmnopqrstuv when deploying.", polarity: "do" as const }],
    1.0,
  );
  assert.equal(store.stats().lessons, 0, "a lesson carrying a secret must not be stored");
  store.close();
});

test("a score is attributed, not just totalled: raw survives the clamp and signals name their event", () => {
  // The clamp is where the scorer's discrimination went — 21 of 25 real tasks
  // read exactly 1.00 with unclamped sums from 1.2 to 11.1. Persisting raw and
  // the event behind each signal is what makes per-turn credit assignment
  // possible later.
  const store = openStore(":memory:");
  const t = generateTrajectory("focused-fix-success", 11);
  store.upsertTask(t.task);
  store.appendEvents(t.events);
  const score = scoreTrajectory(t.events);
  store.recordScore(t.task.id, score);

  assert.equal(store.taskReward(t.task.id), score.total);
  assert.equal(store.taskRawReward(t.task.id), score.raw);
  const attributed = store.rewardsForTask(t.task.id).filter((r) => r.eventId !== null);
  assert.ok(attributed.length > 0, "event-derived signals must carry their event id");
  const ids = new Set(t.events.map((e) => e.id));
  for (const r of attributed) assert.ok(ids.has(r.eventId!), `${r.eventId} is not an event of this task`);
  store.close();
});

test("the holdout arm records a shadow impression and injects nothing", () => {
  // Without a withheld arm, "tasks with lessons went better" is confounded by
  // the tasks that retrieve lessons being the familiar ones. The shadow row is
  // what makes the control comparable: same retrieval, no injection.
  const store = openStore(":memory:");
  store.absorbLessons(
    [{ id: "l1", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
       lesson: "Reproduce the failing test first, then edit.", polarity: "do" as const }],
    1.0,
  );
  const held = store.queryLessonsForTask("reproduce failing test", { taskId: "t-held", holdoutFraction: 1 });
  assert.equal(held.arm, "holdout");
  assert.deepEqual(held.lessons, [], "the holdout arm must return nothing the app could inject");
  assert.equal(store.impressionsFor("l1").holdout, 1, "but the shadow impression is on the record");

  const shown = store.queryLessonsForTask("reproduce failing test", { taskId: "t-shown", holdoutFraction: 0 });
  assert.equal(shown.arm, "inject");
  assert.equal(shown.lessons.length, 1);
  // The inject arm's impression is only counted once the app CONFIRMS it rode
  // a prompt — the query alone is not evidence of injection.
  assert.equal(store.impressionsFor("l1").inject, 0);
  store.recordLessonUse(["l1"], "t-shown", "turn-1");
  assert.equal(store.impressionsFor("l1").inject, 1);
  store.close();
});

test("being shown and not helping drives trust down and eventually out of retrieval", () => {
  const store = openStore(":memory:");
  store.absorbLessons(
    [{ id: "dud", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
       lesson: "Always reformat the whole file before editing.", polarity: "do" as const }],
    1.0,
  );
  // Six injections, every one of them followed by a turn the user interrupted.
  for (let i = 0; i < 6; i++) {
    store.recordLessonUse(["dud"], `t-${i}`, "turn-1");
    store.resolveLessonUseWithOutcome(`t-${i}`, "negative");
  }
  const t = store.trustFor("dud");
  assert.equal(t.judged, true);
  assert.ok((t.trust ?? 1) < 0.2, `trust should be low, got ${t.trust}`);
  assert.equal(
    store.queryLessonsForTask("reformat whole file", { taskId: "t-next", holdoutFraction: 0 }).lessons.length,
    0,
    "a lesson that has been shown repeatedly without helping stops being retrieved",
  );
  store.close();
});

test("decay is an explicit event with a caller-supplied clock, not a term in ranking", () => {
  // Ranking stays time-independent on purpose; staleness is applied by a call
  // whose `unusedSince` the caller decides, so tests stay deterministic.
  const store = openStore(":memory:");
  store.absorbLessons(
    [{ id: "stale", contextKey: "general", repoKey: null, projectKey: null, turnId: null,
       lesson: "The build script lives in tools/build.sh.", polarity: "do" as const }],
    1.0,
  );
  const before = store.lessonById("stale")!.confidence;
  const n = store.decayUnusedLessons("2999-01-01T00:00:00.000Z", 0.5);
  assert.equal(n, 1);
  assert.ok(store.lessonById("stale")!.confidence < before);
  // Nothing is due when the cutoff predates every lesson.
  assert.equal(store.decayUnusedLessons("1999-01-01T00:00:00.000Z", 0.5), 0);
  store.close();
});
