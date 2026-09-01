# Learning sidecar wire protocol — v1

The sidecar speaks newline-delimited JSON on stdio, the same framing as the
codex app-server protocol the desktop app already implements in
`EngineClient` (`unbiased-app/src/main/engine.ts`): one JSON object per line,
requests carry `{method, id, params}`, responses `{id, result}` or
`{id, error}`, notifications `{method, params}`.

The app is ONE client of this protocol. The conformance suite in
`conformance/` is the executable spec; anything that drives the sidecar the
way the suite does is a valid client.

## How it ships, and how a client launches it

`npm run bundle` produces `dist/sidecar/` — a self-contained directory. That
directory is the contract with a host app, exactly as
`unbiased-app-engine`'s `make bundle` is: the app copies it into its package
and nothing else crosses the repo boundary.

The app must not know how this repo is built. It resolves a **directory** and
reads `sidecar.json` to learn how to run what is inside:

```jsonc
{
  "name": "learning-algorithm",
  "version": "0.1.0",
  "protocolVersion": 1,          // send this in learning/initialize
  "runtime": "node",             // spawn the host's own Node…
  "entry": "learning-sidecar.mjs", // …with this script
  "args": [],
  "minNodeVersion": "22.5.0",    // refuse early with a clear message
  "builtAt": "…"
}
```

That manifest is the hook. Shipping a compiled binary later
(`"runtime": "executable"`), renaming the entry, or needing an extra flag is a
change to the manifest — not to the app. In Electron, `"runtime": "node"`
means `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.

Where the app looks for the directory is its own hook, and should mirror
`resolveEngineDir`: an env override first (for development and tests), then
the packaged resources path, then a sibling checkout.

`npm run conformance:bundle` runs this whole suite against the built bundle
rather than the tsx dev entry, so the thing that ships is the thing that is
tested. `tsx` is a dev-only loader and must never be what launches the
sidecar in a packaged app.

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
  "evaluation": {
    "holdoutFraction": 0                   // fraction of tasks WITHHELD from injection
  },
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
plus `evaluation: { holdoutFraction }` — an evaluation running invisibly is a
trap, so the posture is always readable. `store` is the same rollup
`stats/get` returns. `judge.inFlight` is
currently always 0 — the governor's counter is not exposed.

### `health/idle` (notification, client → sidecar)

Params: `{ "idle": bool }`. The app sends `idle: false` while any turn is
running. With `judge.onlyWhenIdle`, no judge call starts while not idle.

## Lessons

### `lessons/query` (request)

Params: `{ "taskText": string, "projectKey"?: string, "cwd"?: string, "repoKey"?: string, "limit"?: number }`.
Result: `{ "lessons": [{ "id", "text", "contextKey", "projectKey", "confidence", "supportCount", "score" }] }`.

**Pass `taskId` too.** With one, retrieval runs an *arm*: a deterministic
fraction of tasks (`evaluation.holdoutFraction`) is **withheld**, and the
response carries `arm: "inject" | "holdout"`. In the holdout arm `lessons` is
always `[]` — structurally, so a client cannot leak the control — and the
sidecar records a shadow impression of what it *would* have returned.

This is not optional rigour. Retrieval succeeds when a task's text resembles
work already seen, which correlates with the task being easier, so "tasks
that got lessons went better" measures familiarity unless something is
withheld to compare against. Silence — a lesson nobody deleted — is not
evidence for it either.

Lessons that have been shown enough times to judge and did not help are
filtered out here rather than merely ranked down.

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
Only the INJECT arm sends this, and only after the lessons really rode a
prompt: a query is not evidence of injection, so an impression is counted
here, not at query time.
The audit half: which lessons were actually injected, so later outcomes on
that task attribute back to them (`lesson_usage` table). Without this,
"did learning help?" is unanswerable. The sidecar resolves open usage rows
automatically when the task's `turn_completed` arrives.

### `lessons/decay` (request)

Params: `{ "unusedSince": ISO8601, "factor"?: number }` (default `0.9`).
Result: `{ "ok": true, "decayed": n }`.

Staleness, applied as an event with the CALLER's clock rather than as a term
in ranking — ranking stays time-independent so it stays testable. A lesson not
retrieved since `unusedSince` keeps `factor` of its confidence. Good advice
that has gone quiet should get quieter; a lesson that only ever rises is the
same bug as counting silence as approval.

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
