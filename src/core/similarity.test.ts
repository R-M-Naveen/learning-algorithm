import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_DUPLICATE_THRESHOLD, dropNearDuplicates, isNearDuplicate, overlapCoefficient } from "./similarity.ts";

// The fixtures below are VERBATIM output from the first real Pareto judge run
// (2026-09-01, three trajectories, $0.0185). The first two are the paraphrase
// pair that motivated this file; the rest are lessons from the same run that
// must stay distinct.
const PARAPHRASE_A =
  "Use sub-agents to parallelize independent exploration tasks like git history, dependency audit, and file structure review.";
const PARAPHRASE_B = "Use parallel sub-agents for independent research tasks to save time.";
const SLACK = "When a launch action redirects to a desktop-app handoff, try the in-browser 'use Slack in your browser' link instead of repeating the same click.";
const RETRY = "Do not re-attempt an identical browser navigation that already failed without changing strategy.";
const INSPECT = "Inspect sub-agent output before persisting it to memory.";
const SUMMARIZE = "Summarize repository state including branch staleness and uncommitted changes at the end of an exploration session.";
const TEMPLATE_TESTS = "Never delete or weaken tests to make the suite pass.";
const TEMPLATE_FOCUS = "Keep edits to the few files the task actually needs.";

test("the paraphrase pair the judge actually produced is recognized as one lesson", () => {
  // Different wording, same advice, so different hashes and no merge — two
  // rows both starting at 0.4 confidence, competing for the same retrieval
  // slots. This is the case the file exists for.
  assert.ok(
    isNearDuplicate(PARAPHRASE_A, PARAPHRASE_B),
    `overlap was ${overlapCoefficient(PARAPHRASE_A, PARAPHRASE_B).toFixed(2)}`,
  );
});

for (const [a, b, label] of [
  [SLACK, RETRY, "two different browser lessons"],
  [PARAPHRASE_B, INSPECT, "sub-agents used for different advice"],
  [PARAPHRASE_A, SUMMARIZE, "exploration mentioned in both, advice unrelated"],
  [TEMPLATE_TESTS, TEMPLATE_FOCUS, "two unrelated templates"],
  [SLACK, TEMPLATE_TESTS, "nothing in common"],
] as const) {
  test(`${label} stay distinct`, () => {
    assert.ok(
      !isNearDuplicate(a, b),
      `wrongly merged (overlap ${overlapCoefficient(a, b).toFixed(2)} ≥ ${NEAR_DUPLICATE_THRESHOLD})`,
    );
  });
}

test("overlap ignores case, punctuation and filler words", () => {
  assert.ok(overlapCoefficient("Keep edits FOCUSED!", "keep the edits focused") > 0.9);
  // Filler alone must not make two lessons look alike. Note the measure is
  // COARSE on very short texts — with two content words each, one shared word
  // is already 0.5 — so the assertion is the one that matters in practice:
  // below the threshold, therefore not merged. Real lessons are sentences.
  assert.ok(!isNearDuplicate("Do not do the thing to the files", "Use a thing for the tasks"));
  assert.ok(
    !isNearDuplicate(
      "Run the migration before starting the server in this project",
      "Prefer a narrower alternative when the user declines an action",
    ),
  );
});

test("an empty or fillerless string never matches anything", () => {
  assert.equal(overlapCoefficient("", "anything at all"), 0);
  assert.equal(overlapCoefficient("the and of to", "the and of to"), 0);
  assert.ok(!isNearDuplicate("", ""));
});

test("dropNearDuplicates keeps the FIRST of a similar group — ranking already chose", () => {
  // Applied after ranking and before the limit, so the better lesson survives
  // and the user still gets `limit` DISTINCT lessons rather than limit minus
  // however many paraphrases crept in.
  const ranked = [
    { id: "best", text: PARAPHRASE_A },
    { id: "dup", text: PARAPHRASE_B },
    { id: "other", text: SLACK },
  ];
  const kept = dropNearDuplicates(ranked, (x) => x.text);
  assert.deepEqual(kept.map((k) => k.id), ["best", "other"]);
});

test("suppression never crosses scopes: the same advice about two projects is two facts", () => {
  const items = [
    { id: "api", text: "The api project pins its migrations by hand.", scope: "/work/api" },
    { id: "web", text: "The web project pins its migrations by hand.", scope: "/work/web" },
    { id: "api-again", text: "The api project pins the migrations by hand.", scope: "/work/api" },
  ];
  const kept = dropNearDuplicates(items, (x) => x.text, { groupOf: (x) => x.scope });
  assert.deepEqual(kept.map((k) => k.id), ["api", "web"], "cross-scope kept, same-scope paraphrase dropped");
});

test("dropNearDuplicates is stable and keeps everything when all are distinct", () => {
  const items = [SLACK, RETRY, INSPECT, TEMPLATE_TESTS].map((text, i) => ({ id: `l${i}`, text }));
  assert.deepEqual(
    dropNearDuplicates(items, (x) => x.text).map((k) => k.id),
    items.map((k) => k.id),
  );
});
