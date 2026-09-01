# Learning sidecar wire protocol — v1

The sidecar speaks newline-delimited JSON on stdio, the same framing as the
codex app-server protocol the desktop app already implements in
`EngineClient` (`unbiased-app/src/main/engine.ts`): one JSON object per line,
requests carry `{method, id, params}`, responses `{id, result}` or
`{id, error}`, notifications `{method, params}`.

The app is ONE client of this protocol. The conformance suite in
`conformance/` is the executable spec; anything that drives the sidecar the
way the suite does is a valid client.

## Lifecycle

- The client spawns the sidecar and MUST send `learning/initialize` first.
  Any other method before the handshake returns error `-32002 not initialized`.
- Shutdown: stdin EOF or SIGTERM. The sidecar waits for in-flight work and
  exits 0. In-flight judge calls are allowed to complete (aborted upstream
  calls still bill), so a judge call in progress can delay exit by up to its
  620s timeout — **the client owns the grace timer** and should SIGKILL after
  its own deadline.
- **Responses are NOT ordered.** Lines are handled concurrently; match on
  `id`. Ordering was given up deliberately: handling used to be chained, and
  one slow `judge/run` then blocked every `event/append` and `lessons/query`
  behind it for as long as the gateway took.

### `learning/initialize` (request)

```jsonc
{
  "protocolVersion": 1,
  "clientInfo": { "name": "unbiased_app", "version": "1.7.0" },
  "dbPath": "/path/to/learning.db",       // client-owned location (app: userData)
  "judge": {
    "mode": "mock",                        // "mock" | "local" | "pareto"
    "enabled": false,                      // pareto mode is opt-in, default OFF
    "maxInFlight": 1,
    "onlyWhenIdle": true,                  // client reports idleness via health/idle
    "monthlyBudgetUsd": 0
  }
}
```

Response: `{ "protocolVersion": 1, "server": { "name": "learning-algorithm", "version": "0.1.0" } }`.
Version mismatch is an error, not a silent downgrade.

## Event ingestion

Events flow client → sidecar. The UI must never stall on learning, so
low-value events are the client's to drop.

> **Honesty note.** Ingestion today is a synchronous SQLite write: the queue
> never fills, `queue/status` always answers `{depth: 0, dropping: false}`,
> and `reason: "queue_full"` is never produced. The bounded-queue contract
> below is reserved, not implemented — do not write a client that waits for
> backpressure it will never be told about.

### `event/append` (request)

Params: one `LearningEvent` (see docs/EVENT-MAPPING.md).
Result: `{ "accepted": true }` or `{ "accepted": false, "reason": "invalid", "detail"?: string }`.
(`"queue_full"` is reserved; see the honesty note above.)

### `event/batchAppend` (request)

Params: `{ "events": LearningEvent[] }`.
Result: `{ "accepted": n, "dropped": m, "reasons"?: string[] }`. Partial
acceptance is normal under pressure; order within a batch is preserved.

### `queue/status` (request)

Result: `{ "depth": n, "capacity": n, "dropping": bool }`.

### `health/get` (request)

Result: `{ "ok": true, "db": "open", "judge": { "mode", "enabled", "inFlight", "spentUsd" }, "store": {…} }`
where `store` is the same rollup `stats/get` returns. `judge.inFlight` is
currently always 0 — the governor's counter is not exposed.

### `health/idle` (notification, client → sidecar)

Params: `{ "idle": bool }`. The app sends `idle: false` while any turn is
running. With `judge.onlyWhenIdle`, no judge call starts while not idle.

## Lessons

### `lessons/query` (request)

Params: `{ "taskText": string, "projectKey"?: string, "cwd"?: string, "repoKey"?: string, "limit"?: number }`.
Result: `{ "lessons": [{ "id", "text", "contextKey", "projectKey", "confidence", "supportCount", "score" }] }`.

**Pass `projectKey`.** It is the scope, and it is a hard filter: a scoped
query returns this project's lessons plus universal advice and nothing from
any other project. It must be a stable identity the CLIENT resolves — the app
maps a worktree to its parent project before sending — because the sidecar
must not re-derive it from `cwd`, which cannot tell `/a/api` from `/b/api`.
Omit it only for a deliberately global query (the CLI, the report).

Ranking is local: FTS5/BM25, plus confidence, plus `log(support)`, plus an
affinity bonus when a lesson is scoped to the queried project. There is **no
recency term** — it would make ranking time-dependent. Lessons below a
retrieval-confidence floor are never returned (see `lessons/refute`). Empty
result is normal and means "inject nothing".

`taskType` is not a query dimension: `contextKey` is stored and returned but
nothing computes a task type yet, so every lesson currently sits in
`"general"`.

### `lessons/used` (notification, client → sidecar)

Params: `{ "lessonIds": string[], "taskId": string, "turnId"?: string }`.
The audit half: which lessons were actually injected, so later outcomes on
that task attribute back to them (`lesson_usage` table). Without this,
"did learning help?" is unanswerable. The sidecar resolves open usage rows
automatically when the task's `turn_completed` arrives.

### `lessons/refute` (request)

Params: `{ "lessonId": string, "reason"?: string }`.
Result: `{ "ok": true, "confidence": x }` or `{ "ok": false, "reason": "unknown_lesson" | "missing_lesson_id" }`.

The negative half of the loop, and the seam the app's memory feature calls
when the user deletes what a lesson became. A refutation costs far more
confidence than a sighting earns — reinforcement is machine evidence that a
pattern recurred, a refutation is a human saying the advice is wrong — and a
lesson driven below the retrieval floor stops riding prompts while staying on
the record in `lesson_refutations`. Refusals are results: an unknown id means
a stale client, not a protocol violation.

## Judging

Scoring and template-lesson distillation run automatically inside the
sidecar whenever an ingested event stream carries a `turn_completed` — the
client never orchestrates them. The LLM judge additionally needs an explicit
trigger (or the client's idle signal, once scheduled judging lands):

### `judge/run` (request)

Params: `{ "taskId": string }`.
Result: the gated outcome verbatim — `{ "ok": true, "result": {…} }` or
`{ "ok": false, "reason": "disabled" | "not_idle" | "busy" | "budget_exhausted" | "payment_required" | "payment" | "backpressure" | "unavailable" | "error" }`.
Refusals are results, not errors: the governor saying no is normal operation.
(`payment` is the first refusal after a live 402; `payment_required` is every
one after it, because a 402 suspends the judge until a human re-enables it.)

**Do not await `judge/run` on a request the UI is waiting for.** It can take
up to 620s. Responses are unordered, so other calls proceed — but the answer
to this one may be minutes away.

## Stats / audit

### `stats/get` (request)

Result: `{ "tasks", "events", "lessons", "rewards", "judgeSpendUsd" }` — for
the app's Resources view.

## Errors

JSON-RPC-shaped: `{ "id", "error": { "code", "message" } }`.
`-32700` parse, `-32600` invalid request, `-32601` unknown method,
`-32002` not initialized, `-32000` anything else thrown (including a
protocol-version mismatch, which is an error rather than a silent downgrade).
