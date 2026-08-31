import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRollout } from "./replay.ts";
import { validateEvent } from "../core/events.ts";

const fixture = readFileSync(new URL("../../fixtures/rollout-sample.jsonl", import.meta.url), "utf8");

test("maps a rollout into a task plus ordered, valid LearningEvents", () => {
  const { task, events } = parseRollout(fixture);
  assert.equal(task.id, "fixture-session-0001");
  assert.equal(task.cwd, "/repo/fixture-project");
  assert.equal(task.source, "rollout");
  events.forEach((e, i) => {
    const r = validateEvent(e);
    assert.equal(r.ok, true, r.ok ? "" : `event ${i}: ${r.error}`);
    assert.equal(e.seq, i);
    assert.equal(e.source, "rollout");
  });
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "task_meta", "task_meta", "user_message", "tool_call", "tool_output", "token_usage",
      "assistant_message", "turn_completed",
      "tool_call", "file_change", "tool_output", "tool_call", "file_change", "tool_output", "turn_completed",
    ],
  );
});

test("parses the exit code out of the output text and keeps token usage per-turn", () => {
  const { events } = parseRollout(fixture);
  const out = events.find((e) => e.kind === "tool_output")!;
  assert.equal((out.data as { exitCode?: number }).exitCode, 1);
  const usage = events.find((e) => e.kind === "token_usage")!;
  assert.deepEqual(usage.data, { input: 9000, cachedInput: 2000, output: 150, total: 9150 });
});

test("turn ids attach from task_started / metadata passthrough", () => {
  const { events } = parseRollout(fixture);
  const call = events.find((e) => e.kind === "tool_call")!;
  assert.equal(call.turnId, "turn-0001");
  const done = events.find((e) => e.kind === "turn_completed")!;
  assert.equal(done.turnId, "turn-0001");
  assert.equal((done.data as { durationMs?: number }).durationMs, 49900);
});

test("redacts before anything is returned — the planted key never appears", () => {
  const { events } = parseRollout(fixture);
  const all = JSON.stringify(events);
  assert.ok(!all.includes("uk_fixture_notreal_12345"), "planted secret leaked through replay");
});

test("drops base_instructions, response_item/message, and world_state", () => {
  const { events } = parseRollout(fixture);
  const all = JSON.stringify(events);
  assert.ok(!all.includes("You are a coding agent"));
  assert.ok(!all.includes("internal duplicate"));
  assert.ok(!all.includes("world_state"));
});

test("malformed lines are skipped and counted, not fatal", () => {
  const { events, skipped } = parseRollout(fixture + "\nnot json at all\n" + '{"type":"mystery_record"}\n');
  assert.ok(events.length > 0);
  assert.equal(skipped, 2);
});

test("apply_patch commands additionally map to file_change events with the touched files", () => {
  const { events } = parseRollout(fixture);
  const changes = events.filter((e) => e.kind === "file_change");
  assert.equal(changes.length, 2);
  assert.deepEqual((changes[0]!.data as { files: string[] }).files, ["src/auth.ts", "src/auth-helper.ts"]);
  assert.equal(changes[0]!.turnId, "turn-0002");
});

test("a patch that deletes a test file says so in the summary — the safety signal keys on it", () => {
  const { events } = parseRollout(fixture);
  const del = events.filter((e) => e.kind === "file_change")[1]!;
  assert.match(del.summary, /delet/i);
  assert.deepEqual((del.data as { files: string[] }).files, ["tests/auth.test.ts"]);
});
