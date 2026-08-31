import { test } from "node:test";
import assert from "node:assert/strict";
import { ParetoJudgeBackend, JudgeTransportError } from "./pareto.ts";

type Captured = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const okBody = {
  choices: [{ message: { content: '{"verdicts":[{"id":"made_progress","met":true,"rationale":"ok"}]}' } }],
  usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0042 },
};

test("speaks chat-completions with json_object — never json_schema — and bounded output", async () => {
  const { fetch, calls } = fakeFetch(200, okBody);
  const b = new ParetoJudgeBackend({ baseUrl: "https://api.unbiased.ai/v1", apiKey: "uk_test", fetchImpl: fetch });
  await b.complete("SYS", "USER");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.unbiased.ai/v1/chat/completions");
  const req = JSON.parse(String(calls[0]!.init.body));
  assert.equal(req.model, "pareto");
  assert.deepEqual(req.response_format, { type: "json_object" });
  assert.equal(req.stream, false);
  assert.ok(req.max_tokens > 0 && req.max_tokens <= 4000);
  assert.deepEqual(req.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer uk_test");
});

test("returns the content and the gateway-reported cost", async () => {
  const { fetch } = fakeFetch(200, okBody);
  const b = new ParetoJudgeBackend({ baseUrl: "https://x", apiKey: "k", fetchImpl: fetch });
  const r = await b.complete("s", "u");
  assert.ok(r.text.includes("made_progress"));
  assert.equal(r.costUsd, 0.0042);
});

test("a missing usage.cost is 0, not NaN", async () => {
  const { fetch } = fakeFetch(200, { choices: [{ message: { content: "{}" } }] });
  const b = new ParetoJudgeBackend({ baseUrl: "https://x", apiKey: "k", fetchImpl: fetch });
  assert.equal((await b.complete("s", "u")).costUsd, 0);
});

test("429/402/503 map to typed drop reasons and are NEVER retried", async () => {
  for (const [status, kind] of [[429, "backpressure"], [402, "payment"], [503, "unavailable"]] as const) {
    const { fetch, calls } = fakeFetch(status, { error: { message: "no" } });
    const b = new ParetoJudgeBackend({ baseUrl: "https://x", apiKey: "k", fetchImpl: fetch });
    await assert.rejects(
      () => b.complete("s", "u"),
      (err: unknown) => err instanceof JudgeTransportError && err.kind === kind,
    );
    assert.equal(calls.length, 1, `status ${status} must not be retried`);
  }
});

test("other HTTP failures and empty responses are generic errors", async () => {
  const { fetch } = fakeFetch(500, { error: "boom" });
  const b = new ParetoJudgeBackend({ baseUrl: "https://x", apiKey: "k", fetchImpl: fetch });
  await assert.rejects(
    () => b.complete("s", "u"),
    (err: unknown) => err instanceof JudgeTransportError && err.kind === "error",
  );
  const empty = fakeFetch(200, { choices: [] });
  const b2 = new ParetoJudgeBackend({ baseUrl: "https://x", apiKey: "k", fetchImpl: empty.fetch });
  await assert.rejects(() => b2.complete("s", "u"));
});
