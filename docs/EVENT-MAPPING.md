# LearningEvent — sources and mapping

One event schema, three producers. The schema is derived from what the
engine actually emits (verified against real rollout files and
`unbiased-app-engine/schema/v2/*.json`), not invented — so app integration
later is a mapping, not a renegotiation.

## The event

```ts
type LearningEvent = {
  id: string;             // unique, client- or mapper-assigned
  taskId: string;         // thread/session id
  turnId?: string | null;
  seq: number;            // ordering within the task
  at: string;             // ISO 8601
  kind: EventKind;
  source: "app" | "rollout" | "synthetic";
  summary: string;        // compact, REDACTED human summary
  data: KindData[kind];   // kind-specific, REDACTED
};
```

Kinds and their `data`:

| kind | data | notes |
|---|---|---|
| `task_meta` | `{ cwd?, model?, approvalPolicy?, sandbox? }` | once per task/turn-context |
| `user_message` | `{ chars }` | content stays in `summary` (truncated + redacted) |
| `assistant_message` | `{ chars }` | " |
| `tool_call` | `{ tool, argsSummary }` | argsSummary truncated + redacted |
| `tool_output` | `{ tool?, exitCode?, durationMs?, outputChars }` | exit code parsed when present |
| `file_change` | `{ files, added?, deleted? }` | app-side; rollouts only show patches as tool calls |
| `approval_requested` | `{ commandSummary }` | APP-ONLY |
| `approval_decision` | `{ decision: "accept"\|"acceptForSession"\|"decline", commandSummary? }` | APP-ONLY |
| `token_usage` | `{ input, cachedInput, output, total }` | last-turn usage, not cumulative |
| `turn_completed` | `{ status: "completed"\|"failed"\|"interrupted", durationMs? }` | |

**Provenance matters:** approval events exist only from the `app` source.
Synthetic data fabricates them (labeled); rollout replay never produces
them. Reward code must not assume their presence.

## Source 1 — rollout replay (`~/.unbiased/app-engine/home/sessions/**/rollout-*.jsonl`)

Record census taken from real files, engine 0.147.0:

| rollout record | → kind |
|---|---|
| `session_meta` | `task_meta` (cwd, session id → taskId; base_instructions DROPPED) |
| `turn_context` | `task_meta` (cwd, model, approval_policy, sandbox_policy.type) |
| `event_msg/task_started` | (sets current turnId) |
| `event_msg/user_message` | `user_message` |
| `event_msg/agent_message` | `assistant_message` |
| `response_item/function_call` | `tool_call` (name, arguments → argsSummary) |
| `response_item/function_call_output` | `tool_output` (exit code parsed from `"Process exited with code N"` in output text) |
| `event_msg/token_count` | `token_usage` (from `info.last_token_usage`) |
| `event_msg/task_complete` | `turn_completed` (status completed, duration_ms) |
| `response_item/message`, `world_state`, `inter_agent_communication_metadata`, `event_msg/thread_settings_applied` | dropped |

## Source 2 — app notifications (integration milestone; listed now so the schema is honest)

| app-side signal (`src/main/index.ts` wireNotifications / IPC) | → kind |
|---|---|
| `turn/started` | (sets turnId) |
| `item/completed` (agentMessage) | `assistant_message` |
| `item/completed` (commandExecution) | `tool_call` + `tool_output` |
| `item/fileChange/*` | `file_change` |
| `item/commandExecution/requestApproval` | `approval_requested` |
| `chat:approve` decision | `approval_decision` |
| `thread/tokenUsage/updated` | `token_usage` |
| `turn/completed` / interrupt | `turn_completed` |

## Source 3 — synthetic (`src/synth/`)

Seeded archetype generator; every trajectory carries a ground-truth label so
evals can score the scorer. Fabricated approval events are the only source
of `approval_*` besides the live app.

## Redaction — before persistence, no exceptions

Raw engine output never touches the database. The pipeline is
`raw → redact → LearningEvent → store`; `summary`, `argsSummary` and every
free-text field pass through `src/core/redact.ts` in the mapper, and the
store refuses events whose free text still matches the redactor (belt and
suspenders).

## Scope: `projectKey` on `task_meta`

A `task_meta` event SHOULD carry `data.projectKey` — the stable identity of
the project this task belongs to, resolved by the client. The app resolves a
worktree to its parent project first (its memory feature does the same, for
the same reason: keying by cwd gives every worktree an amnesiac private
store). The sidecar stores it on the task and scopes judge lessons to it;
deterministic templates stay global, because "never delete tests" is true
everywhere.

Without it, a task's lessons are global — which is safe for templates and
wrong for anything project-specific.
