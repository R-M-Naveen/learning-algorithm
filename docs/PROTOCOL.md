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
- Shutdown: stdin EOF or SIGTERM. The sidecar flushes its write queue and
  exits 0. In-flight judge calls are allowed to complete (aborted upstream
  calls still bill — see docs/EVENT-MAPPING.md notes).

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

## Event ingestion — ack'd, bounded, droppable

Events flow client → sidecar. The sidecar owns a bounded queue; when it is
saturated the CLIENT gets told, and low-value events are the client's to
drop. The UI must never stall on learning.

### `event/append` (request)

Params: one `LearningEvent` (see docs/EVENT-MAPPING.md).
Result: `{ "accepted": true }` or `{ "accepted": false, "reason": "queue_full" | "invalid", "detail"?: string }`.

### `event/batchAppend` (request)

Params: `{ "events": LearningEvent[] }`.
Result: `{ "accepted": n, "dropped": m, "reasons"?: string[] }`. Partial
acceptance is normal under pressure; order within a batch is preserved.

### `queue/status` (request)

Result: `{ "depth": n, "capacity": n, "dropping": bool }`.

### `health/get` (request)

Result: `{ "ok": true, "db": "open", "judge": { "mode": "...", "inFlight": n, "spentUsd": x } }`.

### `health/idle` (notification, client → sidecar)

Params: `{ "idle": bool }`. The app sends `idle: false` while any turn is
running. With `judge.onlyWhenIdle`, no judge call starts while not idle.

## Lessons

### `lessons/query` (request)

Params: `{ "taskText": string, "cwd"?: string, "taskType"?: string, "limit"?: number }`.
Result: `{ "lessons": [{ "id", "text", "contextKey", "confidence", "supportCount", "score" }] }`.
Ranking is local (SQLite FTS5/BM25 + confidence/support/recency). Empty
result is normal and means "inject nothing".

### `lessons/used` (notification, client → sidecar)

Params: `{ "lessonIds": string[], "taskId": string, "turnId"?: string }`.
The audit half: which lessons were actually injected, so later outcomes on
that task attribute back to them (`lesson_usage` table). Without this,
"did learning help?" is unanswerable. The sidecar resolves open usage rows
automatically when the task's `turn_completed` arrives.

## Judging

Scoring and template-lesson distillation run automatically inside the
sidecar whenever an ingested event stream carries a `turn_completed` — the
client never orchestrates them. The LLM judge additionally needs an explicit
trigger (or the client's idle signal, once scheduled judging lands):

### `judge/run` (request)

Params: `{ "taskId": string }`.
Result: the gated outcome verbatim — `{ "ok": true, "result": {…} }` or
`{ "ok": false, "reason": "disabled" | "not_idle" | "busy" | "budget_exhausted" | "payment_required" | "backpressure" | … }`.
Refusals are results, not errors: the governor saying no is normal operation.

## Stats / audit

### `stats/get` (request)

Result: rollup counts per table + judge spend, for the app's Resources view.

## Errors

JSON-RPC-shaped: `{ "id", "error": { "code", "message" } }`.
`-32700` parse, `-32600` invalid request, `-32601` unknown method,
`-32002` not initialized.
