import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, type LearningEvent } from "./events.ts";

const good: LearningEvent = {
  id: "ev-1",
  taskId: "task-1",
  turnId: "turn-1",
  seq: 0,
  at: "2026-08-30T12:00:00.000Z",
  kind: "tool_output",
  source: "synthetic",
  summary: "npm test exited 0",
  data: { tool: "shell", exitCode: 0, durationMs: 1200, outputChars: 340 },
};

test("a well-formed event validates and comes back typed", () => {
  const r = validateEvent(good);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.event.kind, "tool_output");
});

test("missing taskId is rejected with a reason naming the field", () => {
  const r = validateEvent({ ...good, taskId: "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /taskId/);
});

test("unknown kind is rejected", () => {
  const r = validateEvent({ ...good, kind: "telepathy" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /kind/);
});

test("non-ISO timestamp is rejected", () => {
  const r = validateEvent({ ...good, at: "yesterday" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /at/);
});

test("an approval_decision from a non-app source still validates (synthetic fabricates them)", () => {
  const r = validateEvent({
    ...good,
    kind: "approval_decision",
    data: { decision: "decline", commandSummary: "rm -rf build" },
  });
  assert.equal(r.ok, true);
});

test("a summary that still contains a secret is rejected, not silently stored", () => {
  const r = validateEvent({ ...good, summary: "ran with sk-proj-AAAABBBBCCCCDDDDEEEE" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /redact/i);
});
