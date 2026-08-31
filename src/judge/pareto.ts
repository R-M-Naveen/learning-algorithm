// The Pareto judge transport. Everything here is shaped by what the gateway
// exploration (2026-08-30) established about api.unbiased.ai + gpu-router:
//
//  - chat-completions with response_format {type:"json_object"}: the cascade
//    400s json_schema, honors json_object. Schema discipline lives in the
//    prompt; the tolerant parser (parser.ts) covers the rest.
//  - 429/402/503 are typed DROP signals, never retried: 429 is the per-org
//    concurrency gauge (10 slots, 1 at low balance — shared with the user's
//    interactive turns), 402 is an empty prepaid balance, 503 is the backend
//    pool saturated. Retrying any of these makes the user's actual chat
//    worse to fund a background judgment.
//  - Calls are allowed to COMPLETE once started (no mid-flight abort):
//    settle-before-release billing means an aborted call still bills an
//    estimate. Cancelling doesn't save money, so nothing here cancels.
export type DropKind = "backpressure" | "payment" | "unavailable" | "error";

export class JudgeTransportError extends Error {
  constructor(
    readonly kind: DropKind,
    message: string,
  ) {
    super(message);
    this.name = "JudgeTransportError";
  }
}

const MAX_OUTPUT_TOKENS = 2000; // verdicts + 2 lessons fit in a few hundred

export type ParetoJudgeOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class ParetoJudgeBackend {
  readonly mode = "pareto" as const;
  constructor(private readonly opts: ParetoJudgeOptions) {}

  async complete(system: string, user: string): Promise<{ text: string; costUsd: number }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: "pareto",
          stream: false,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        // Cascade completion budget is 600s server-side; clients are told to
        // allow more. The judge is async, so patience is free.
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 620_000),
      });
    } catch (err) {
      throw new JudgeTransportError("error", `judge call failed: ${String(err)}`);
    }

    if (res.status === 429) throw new JudgeTransportError("backpressure", "gateway concurrency/rate limit");
    if (res.status === 402) throw new JudgeTransportError("payment", "prepaid balance exhausted");
    if (res.status === 503) throw new JudgeTransportError("unavailable", "no healthy backend");
    if (!res.ok) throw new JudgeTransportError("error", `judge call HTTP ${res.status}`);

    let body: {
      choices?: { message?: { content?: unknown } }[];
      usage?: { cost?: unknown };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new JudgeTransportError("error", "judge response was not JSON");
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) {
      throw new JudgeTransportError("error", "judge response had no content");
    }
    const cost = body.usage?.cost;
    return { text: content, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0 };
  }
}
