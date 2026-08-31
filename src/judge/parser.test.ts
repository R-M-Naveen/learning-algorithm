import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJudgeResponse, salvageVerdicts } from "./parser.ts";

const clean = JSON.stringify({
  verdicts: [
    { id: "made_progress", met: true, rationale: "test went green" },
    { id: "stuck_loop", met: false, rationale: "" },
  ],
  lessons: [{ context_key: "failing_test", lesson: "Reproduce before editing.", confidence: 0.7, polarity: "do" }],
  tags: ["failing_test", "focused_edit"],
});

test("parses a clean JSON verdict with lessons and tags", () => {
  const r = parseJudgeResponse(clean);
  assert.equal(r.verdicts.length, 2);
  assert.deepEqual(r.verdicts[0], { id: "made_progress", met: true, rationale: "test went green" });
  assert.equal(r.lessons.length, 1);
  assert.equal(r.lessons[0]!.contextKey, "failing_test");
  assert.deepEqual(r.tags, ["failing_test", "focused_edit"]);
});

test("strips markdown fences and tolerates surrounding prose", () => {
  const fenced = "Here is my grading:\n```json\n" + clean + "\n```\nHope this helps!";
  assert.equal(parseJudgeResponse(fenced).verdicts.length, 2);
  const prosey = "The grade follows. " + clean + " That is all.";
  assert.equal(parseJudgeResponse(prosey).verdicts.length, 2);
});

test("a truncated response salvages the complete verdicts and drops the cut-off tail", () => {
  const truncated =
    '{"verdicts":[{"id":"made_progress","met":true,"rationale":"ok"},{"id":"stuck_loop","met":false,"rationale":""},{"id":"verified_fix","met":tr';
  const r = parseJudgeResponse(truncated);
  assert.deepEqual(
    r.verdicts.map((v) => v.id),
    ["made_progress", "stuck_loop"],
  );
  assert.deepEqual(r.lessons, []); // lessons don't survive salvage — by design
});

test("salvage tolerates met/id in either key order and dedupes ids", () => {
  const messy =
    '{"met": true, "id": "a"} {"id":"b","met":false} {"id":"a","met":false}';
  const got = salvageVerdicts(messy);
  assert.deepEqual(got.map((v) => [v.id, v.met]), [["a", true], ["b", false]]);
});

test('met must be boolean true — "true" the string is not met', () => {
  const r = parseJudgeResponse('{"verdicts":[{"id":"x","met":"true","rationale":""}]}');
  assert.equal(r.verdicts[0]!.met, false);
});

test("malformed lessons are skipped, not fatal; garbage input yields empty everything", () => {
  const r = parseJudgeResponse(
    '{"verdicts":[{"id":"x","met":true}],"lessons":[{"lesson":42},{"context_key":"k","lesson":"valid one"}]}',
  );
  assert.equal(r.lessons.length, 1);
  assert.equal(r.lessons[0]!.lesson, "valid one");
  assert.deepEqual(parseJudgeResponse("no json here at all"), { verdicts: [], lessons: [], tags: [] });
});
