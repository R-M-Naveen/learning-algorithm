// Rollout replay: maps the engine's on-disk conversation log
// (~/.unbiased/app-engine/home/sessions/**/rollout-*.jsonl, codex 0.147.0)
// into LearningEvents. The record shapes here were taken from real files —
// see docs/EVENT-MAPPING.md for the census and the field-by-field table.
//
// Redaction happens HERE, in the mapper: nothing downstream of this function
// ever sees raw engine text.
import { redactText } from "../core/redact.ts";
import type { LearningEvent } from "../core/events.ts";
import type { TaskRow } from "../store/db.ts";

const SUMMARY_MAX = 400;

type RolloutRecord = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & { type?: string };
};

export type ReplayResult = {
  task: TaskRow & { taskType: string | null };
  events: LearningEvent[];
  /** Lines that were unparseable or of an unknown record type. */
  skipped: number;
};

function clip(text: string): string {
  const t = redactText(text);
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t;
}

/** Edits ride rollouts as exec_command apply_patch heredocs. Extract the
 *  touched files from the patch markers so real trajectories produce
 *  file_change events — without this, verified_fix/focused_changes/test-
 *  deletion detection are all blind on real data (found by the M7 report:
 *  25/25 judge "disagreements" traced to this gap). */
const PATCH_MARKER = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
const MAX_PATCH_FILES = 30;

function patchedFiles(rawArgs: string): { files: string[]; deleted: string[] } | null {
  if (!rawArgs.includes("apply_patch")) return null;
  // `arguments` is itself a JSON-serialized object, so its newlines are the
  // two-character escape \n, not real newlines — parse to recover them or
  // the line-anchored marker regex never fires.
  let text = rawArgs;
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    text = Object.values(parsed)
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  } catch {
    // leave raw; markers may still match if the args weren't JSON
  }
  const files: string[] = [];
  const deleted: string[] = [];
  let m: RegExpExecArray | null;
  PATCH_MARKER.lastIndex = 0;
  while ((m = PATCH_MARKER.exec(text)) !== null && files.length < MAX_PATCH_FILES) {
    const path = m[2]!.trim();
    files.push(path);
    if (m[1] === "Delete") deleted.push(path);
  }
  return files.length ? { files, deleted } : null;
}

/** The shell tool's output preamble carries the exit code as prose. */
function exitCodeFrom(output: string): number | undefined {
  const m = /Process exited with code (-?\d+)/.exec(output);
  return m ? Number(m[1]) : undefined;
}

export function parseRollout(text: string): ReplayResult {
  let taskId = "unknown-session";
  let createdAt = new Date(0).toISOString();
  let cwd: string | null = null;
  let currentTurn: string | null = null;
  let skipped = 0;
  const events: LearningEvent[] = [];
  let seq = 0;

  const push = (
    at: string | undefined,
    kind: LearningEvent["kind"],
    summary: string,
    data: Record<string, unknown>,
    turnId: string | null = currentTurn,
  ) => {
    events.push({
      id: `${taskId}-r${seq}`,
      taskId,
      turnId,
      seq: seq++,
      at: at ?? createdAt,
      kind,
      source: "rollout",
      summary: clip(summary),
      data,
    });
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: RolloutRecord;
    try {
      rec = JSON.parse(trimmed) as RolloutRecord;
    } catch {
      skipped++;
      continue;
    }
    const p = rec.payload ?? {};
    const turnFromMeta =
      (p.internal_chat_message_metadata_passthrough as { turn_id?: string } | undefined)?.turn_id ?? null;

    switch (rec.type) {
      case "session_meta": {
        taskId = String(p.session_id ?? p.id ?? taskId);
        createdAt = String(p.timestamp ?? rec.timestamp ?? createdAt);
        cwd = typeof p.cwd === "string" ? p.cwd : cwd;
        // Fix up ids minted before we knew the session id (session_meta is
        // line 1 in practice, but never trust "in practice").
        for (const e of events) {
          e.taskId = taskId;
          e.id = `${taskId}-r${e.seq}`;
        }
        push(rec.timestamp, "task_meta", `session in ${cwd ?? "?"}`, { cwd }, null);
        break;
      }
      case "turn_context": {
        currentTurn = typeof p.turn_id === "string" ? p.turn_id : currentTurn;
        cwd = typeof p.cwd === "string" ? p.cwd : cwd;
        push(rec.timestamp, "task_meta", `turn context in ${cwd ?? "?"}`, {
          cwd,
          model: p.model ?? null,
          approvalPolicy: p.approval_policy ?? null,
          sandbox: (p.sandbox_policy as { type?: string } | undefined)?.type ?? null,
        });
        break;
      }
      case "event_msg": {
        switch (p.type) {
          case "task_started":
            currentTurn = typeof p.turn_id === "string" ? p.turn_id : currentTurn;
            break;
          case "user_message":
            push(rec.timestamp, "user_message", String(p.message ?? ""), {
              chars: String(p.message ?? "").length,
            });
            break;
          case "agent_message":
            push(rec.timestamp, "assistant_message", String(p.message ?? ""), {
              chars: String(p.message ?? "").length,
            });
            break;
          case "token_count": {
            const last = (p.info as { last_token_usage?: Record<string, number> } | undefined)?.last_token_usage;
            if (last) {
              push(rec.timestamp, "token_usage", "token usage updated", {
                input: last.input_tokens ?? 0,
                cachedInput: last.cached_input_tokens ?? 0,
                output: last.output_tokens ?? 0,
                total: last.total_tokens ?? 0,
              });
            }
            break;
          }
          case "task_complete":
            push(
              rec.timestamp,
              "turn_completed",
              "turn completed",
              { status: "completed", durationMs: typeof p.duration_ms === "number" ? p.duration_ms : undefined },
              typeof p.turn_id === "string" ? p.turn_id : currentTurn,
            );
            break;
          default:
            break; // thread_settings_applied etc.: deliberately dropped
        }
        break;
      }
      case "response_item": {
        switch (p.type) {
          case "function_call": {
            const rawArgs = String(p.arguments ?? "");
            push(
              rec.timestamp,
              "tool_call",
              `called ${String(p.name ?? "?")}`,
              { tool: String(p.name ?? "?"), argsSummary: clip(rawArgs) },
              turnFromMeta ?? currentTurn,
            );
            const patch = patchedFiles(rawArgs);
            if (patch) {
              const desc = patch.deleted.length
                ? `patched ${patch.files.length} file(s), deleted: ${patch.deleted.join(", ")}`
                : `patched ${patch.files.length} file(s): ${patch.files.join(", ")}`;
              push(
                rec.timestamp,
                "file_change",
                desc,
                { files: patch.files, deletedFiles: patch.deleted },
                turnFromMeta ?? currentTurn,
              );
            }
            break;
          }
          case "function_call_output": {
            const output = String(p.output ?? "");
            push(
              rec.timestamp,
              "tool_output",
              clip(output.slice(0, SUMMARY_MAX)),
              { exitCode: exitCodeFrom(output), outputChars: output.length },
              turnFromMeta ?? currentTurn,
            );
            break;
          }
          default:
            break; // message / agent_message duplicates: dropped
        }
        break;
      }
      case "world_state":
      case "inter_agent_communication_metadata":
        break; // known, deliberately dropped
      default:
        skipped++;
        break;
    }
  }

  return {
    task: { id: taskId, createdAt, cwd, source: "rollout", taskType: null, outcome: null },
    events,
    skipped,
  };
}
