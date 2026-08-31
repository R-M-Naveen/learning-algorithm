import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, looksSecret } from "./redact.ts";

test("replaces bearer tokens", () => {
  const out = redactText("curl -H 'Authorization: Bearer abc123def456ghi789' https://x");
  assert.ok(!out.includes("abc123def456ghi789"));
  assert.ok(out.includes("[REDACTED]"));
});

test("replaces well-known key prefixes (sk-, ghp_, xoxb-, AKIA)", () => {
  const out = redactText(
    "keys: sk-proj-AAAABBBBCCCCDDDDEEEE ghp_0123456789abcdef0123456789abcdef0123 xoxb-1234-5678-abcdefgh AKIAIOSFODNN7EXAMPLE",
  );
  assert.ok(!/sk-proj-AAAA|ghp_0123|xoxb-1234|AKIAIOSFODNN7EXAMPLE/.test(out));
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 4);
});

test("replaces values of secret-named assignments, keeps the name", () => {
  const out = redactText("export UNBIASED_API_KEY=uk_live_9f8e7d6c5b4a and PASSWORD: hunter2secret");
  assert.ok(out.includes("UNBIASED_API_KEY"));
  assert.ok(!out.includes("uk_live_9f8e7d6c5b4a"));
  assert.ok(!out.includes("hunter2secret"));
});

test("replaces secret-named JSON fields, keeps the field name", () => {
  const out = redactText('{"apiKey":"uk_live_deadbeef01","name":"demo"}');
  assert.ok(out.includes('"apiKey"'));
  assert.ok(!out.includes("uk_live_deadbeef01"));
  assert.ok(out.includes('"name":"demo"'));
});

test("leaves ordinary prose, paths and short values alone", () => {
  const s = "ran npm test in /Users/naveen/Projects/Work/app, exit 0, key insight: cache TTL=60";
  assert.equal(redactText(s), s);
});

test("looksSecret flags residual secrets for the store's refusal check", () => {
  assert.equal(looksSecret("plain text about tests"), false);
  assert.equal(looksSecret("token sk-proj-AAAABBBBCCCCDDDDEEEE"), true);
});
