// LearningEvent: the one event schema all three producers (app, rollout
// replay, synthetic) map into. Shapes are derived from what the engine
// actually emits — see docs/EVENT-MAPPING.md for the field-by-field mapping
// and provenance rules (approval_* only exists from the app or synthetic).
import { looksSecret } from "./redact.ts";

export const EVENT_KINDS = [
  "task_meta",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_output",
  "file_change",
  "approval_requested",
  "approval_decision",
  "token_usage",
  "turn_completed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_SOURCES = ["app", "rollout", "synthetic"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export type ApprovalDecision = "accept" | "acceptForSession" | "decline";
export type TurnStatus = "completed" | "failed" | "interrupted";

export type LearningEvent = {
  id: string;
  taskId: string;
  turnId?: string | null;
  seq: number;
  at: string; // ISO 8601
  kind: EventKind;
  source: EventSource;
  /** Compact human summary. MUST already be redacted. */
  summary: string;
  data: Record<string, unknown>;
};

export type ValidationResult = { ok: true; event: LearningEvent } | { ok: false; error: string };

function isIso(at: unknown): boolean {
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) && /\d{4}-\d{2}-\d{2}T/.test(at);
}

/** Free-text fields the belt-and-suspenders secret check applies to. */
function freeText(e: { summary: string; data: Record<string, unknown> }): string[] {
  const out = [e.summary];
  for (const key of ["argsSummary", "commandSummary"]) {
    const v = e.data[key];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

export function validateEvent(raw: unknown): ValidationResult {
  const e = raw as Partial<LearningEvent> | null;
  if (!e || typeof e !== "object") return { ok: false, error: "event must be an object" };
  if (typeof e.id !== "string" || !e.id) return { ok: false, error: "id is required" };
  if (typeof e.taskId !== "string" || !e.taskId) return { ok: false, error: "taskId is required" };
  if (e.turnId !== undefined && e.turnId !== null && typeof e.turnId !== "string") {
    return { ok: false, error: "turnId must be a string or null" };
  }
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) {
    return { ok: false, error: "seq must be a non-negative integer" };
  }
  if (!isIso(e.at)) return { ok: false, error: "at must be an ISO 8601 timestamp" };
  if (!EVENT_KINDS.includes(e.kind as EventKind)) {
    return { ok: false, error: `kind must be one of ${EVENT_KINDS.join(", ")}` };
  }
  if (!EVENT_SOURCES.includes(e.source as EventSource)) {
    return { ok: false, error: `source must be one of ${EVENT_SOURCES.join(", ")}` };
  }
  if (typeof e.summary !== "string") return { ok: false, error: "summary is required" };
  if (!e.data || typeof e.data !== "object") return { ok: false, error: "data must be an object" };
  const event = e as LearningEvent;
  for (const text of freeText(event)) {
    if (looksSecret(text)) {
      return { ok: false, error: "free text contains an unredacted secret — run it through redactText first" };
    }
  }
  return { ok: true, event };
}
