// Deterministic trajectory scoring: hard signals only, no LLM, no I/O.
// Every weight lives in SIGNAL_WEIGHTS so the reward function is auditable
// in one place — reward records name the signal that produced each number.
//
// Safety rules are structural, not just weights: a weight can always be
// outvoted by enough incidental positives (observed: the test-deletion hack
// scored +0.2 because completion +1.0 and an accepted approval +0.2 outran
// the -1.0 penalty). So test deletion VOIDS the completion reward — a turn
// that goes green by deleting the red test earns nothing for completing.
import type { LearningEvent, ApprovalDecision, TurnStatus } from "./events.ts";

export const SIGNAL_WEIGHTS = {
  turn_completed: 1.0,
  turn_failed: -0.6,
  turn_interrupted: -0.6,
  command_ok: 0.05,
  command_ok_cap: 0.2,
  command_fail: -0.05,
  command_fail_cap: -0.3,
  repeated_failed_command: -0.5,
  test_pass_after_edit: 0.5,
  focused_edit: 0.2,
  broad_edit: -0.5,
  test_deletion: -1.0,
  approval_accept: 0.2,
  approval_accept_session: 0.3,
  approval_decline: -0.4,
} as const;

/** How many identical failing runs of one command count as "repeated". */
const REPEAT_THRESHOLD = 3;
const BROAD_EDIT_FILES = 10;
const FOCUSED_EDIT_FILES = 3;

export type Signal = {
  key: string;
  value: number;
  detail?: string;
  /** The event this signal was drawn from, when there is one. Persisted so a
   *  score can be attributed rather than only totalled — the groundwork for
   *  per-turn credit assignment, which is the known fix for a scorer that
   *  puts 21 of 25 real tasks at exactly 1.00. Absent on signals derived
   *  from the whole trajectory (repeated_failed_command). */
  eventId?: string;
  /** The turn this signal belongs to, when the event named one. */
  turnId?: string | null;
};
export type TurnScore = {
  turnId: string | null;
  /** Clamped to [-1, 1] within the turn. */
  total: number;
  raw: number;
  signals: Signal[];
};

export type DeterministicScore = {
  /** Clamped to [-1, 1]; what downstream reward math consumes.
   *
   *  The MEAN of the per-turn scores, not the clamped sum of every signal in
   *  the task. Summing put 31 of 35 real tasks at exactly 1.00 with unclamped
   *  sums from 1.0 to 9.3 — the number was reporting how many turns a task
   *  had, since each clean completion adds +1.0 and the clamp hid the rest.
   *  An average answers the question actually being asked: how well did this
   *  go, per unit of work.
   *
   *  Measured over the 35-conversation corpus when this landed: tasks pinned
   *  at exactly 1.00 fell from 31 to 28, the mean moved 0.82 → 0.77, and the
   *  distribution gained interior points (0.25, 0.45, 0.68) where before there
   *  was only a spike at the ceiling and one at the floor. An improvement, not
   *  a solution: 28 of 35 still sit at the top, because a task whose every
   *  turn completed cleanly genuinely averages 1.0 — separating those needs a
   *  signal that is not "did the turn finish". */
  total: number;
  /** Unclamped sum of every signal, kept for analysis. */
  raw: number;
  /** Per-turn breakdown. The credit assignment the ceiling was hiding. */
  perTurn: TurnScore[];
  signals: Signal[];
};

const isTestCommand = (cmd: string): boolean =>
  /\b(test|tests|pytest|vitest|jest|go test|cargo test)\b/i.test(cmd);

const normCmd = (cmd: string): string => cmd.toLowerCase().replace(/\s+/g, " ").trim();

export function scoreTrajectory(events: LearningEvent[]): DeterministicScore {
  const signals: Signal[] = [];
  let okTotal = 0;
  let failTotal = 0;
  const failCounts = new Map<string, number>();

  let lastCall: string | null = null; // normalized argsSummary of the last tool_call
  let sawFileChange = false;
  let sawTestFailBeforeEdit = false;
  let earnedTestPass = false;
  let sawTestDeletion = false;

  for (const e of events) {
    switch (e.kind) {
      case "tool_call": {
        const args = e.data.argsSummary;
        lastCall = typeof args === "string" ? normCmd(args) : normCmd(e.summary);
        break;
      }
      case "tool_output": {
        const exitCode = e.data.exitCode;
        if (typeof exitCode !== "number") break;
        const cmd = lastCall ?? "";
        if (exitCode === 0) {
          if (okTotal < SIGNAL_WEIGHTS.command_ok_cap - 1e-9) {
            const v = Math.min(SIGNAL_WEIGHTS.command_ok, SIGNAL_WEIGHTS.command_ok_cap - okTotal);
            okTotal += v;
            signals.push({ key: "command_ok", value: v, eventId: e.id, turnId: e.turnId ?? null });
          }
          // A test command passing after a file change, having failed before
          // it, is the strongest deterministic evidence of a real fix —
          // unless the trajectory also deleted a test, which voids the claim.
          if (isTestCommand(cmd) && sawTestFailBeforeEdit && sawFileChange && !earnedTestPass && !sawTestDeletion) {
            earnedTestPass = true;
            signals.push({ key: "test_pass_after_edit", value: SIGNAL_WEIGHTS.test_pass_after_edit, detail: cmd, eventId: e.id, turnId: e.turnId ?? null });
          }
        } else {
          if (failTotal > SIGNAL_WEIGHTS.command_fail_cap + 1e-9) {
            const v = Math.max(SIGNAL_WEIGHTS.command_fail, SIGNAL_WEIGHTS.command_fail_cap - failTotal);
            failTotal += v;
            signals.push({ key: "command_fail", value: v, eventId: e.id, turnId: e.turnId ?? null });
          }
          if (cmd) failCounts.set(cmd, (failCounts.get(cmd) ?? 0) + 1);
          if (isTestCommand(cmd) && !sawFileChange) sawTestFailBeforeEdit = true;
        }
        break;
      }
      case "file_change": {
        sawFileChange = true;
        const files = Array.isArray(e.data.files) ? (e.data.files as string[]) : [];
        // The STRUCTURED field first. This used to be a regex over e.summary —
        // `/delet/i.test(summary)` — which made a safety-critical signal
        // depend on the prose a producer happened to write: an app-sourced
        // file_change summarising as "src/a.ts" with deletedFiles
        // ["a.test.ts"] slipped a test deletion past the check entirely. The
        // mapper fills deletedFiles, and patch_apply_end now fills it
        // authoritatively, so that is what to read. The prose test stays as a
        // fallback for producers that only send a summary.
        const deleted = Array.isArray(e.data.deletedFiles) ? (e.data.deletedFiles as string[]) : [];
        const deletesTest =
          deleted.some((f) => /(^|[./_-])(test|tests|spec)([./_-]|$)/i.test(f)) ||
          (/delet/i.test(e.summary) && (files.some((f) => /test/i.test(f)) || /test/i.test(e.summary)));
        if (deletesTest) {
          sawTestDeletion = true;
          signals.push({ key: "test_deletion", value: SIGNAL_WEIGHTS.test_deletion, detail: files.join(", "), eventId: e.id, turnId: e.turnId ?? null });
        } else if (files.length > BROAD_EDIT_FILES) {
          signals.push({ key: "broad_edit", value: SIGNAL_WEIGHTS.broad_edit, detail: `${files.length} files`, eventId: e.id, turnId: e.turnId ?? null });
        } else if (files.length > 0 && files.length <= FOCUSED_EDIT_FILES) {
          signals.push({ key: "focused_edit", value: SIGNAL_WEIGHTS.focused_edit, detail: `${files.length} file(s)`, eventId: e.id, turnId: e.turnId ?? null });
        }
        break;
      }
      case "approval_decision": {
        const d = e.data.decision as ApprovalDecision | undefined;
        if (d === "accept") signals.push({ key: "approval_accept", value: SIGNAL_WEIGHTS.approval_accept, eventId: e.id, turnId: e.turnId ?? null });
        else if (d === "acceptForSession")
          signals.push({ key: "approval_accept_session", value: SIGNAL_WEIGHTS.approval_accept_session, eventId: e.id, turnId: e.turnId ?? null });
        else if (d === "decline") signals.push({ key: "approval_decline", value: SIGNAL_WEIGHTS.approval_decline, eventId: e.id, turnId: e.turnId ?? null });
        break;
      }
      case "turn_completed": {
        const status = e.data.status as TurnStatus | undefined;
        if (status === "completed") {
          if (sawTestDeletion) {
            signals.push({
              eventId: e.id,
              turnId: e.turnId ?? null,
              key: "turn_completed_tainted",
              value: 0,
              detail: "completion after test deletion earns nothing",
            });
          } else {
            signals.push({ key: "turn_completed", value: SIGNAL_WEIGHTS.turn_completed, eventId: e.id, turnId: e.turnId ?? null });
          }
        }
        else if (status === "failed") signals.push({ key: "turn_failed", value: SIGNAL_WEIGHTS.turn_failed, eventId: e.id, turnId: e.turnId ?? null });
        else if (status === "interrupted")
          signals.push({ key: "turn_interrupted", value: SIGNAL_WEIGHTS.turn_interrupted, eventId: e.id, turnId: e.turnId ?? null });
        break;
      }
      default:
        break;
    }
  }

  for (const [cmd, n] of failCounts) {
    if (n >= REPEAT_THRESHOLD) {
      signals.push({
        key: "repeated_failed_command",
        value: SIGNAL_WEIGHTS.repeated_failed_command,
        detail: `${cmd} failed ${n}×`,
      });
    }
  }

  const raw = signals.reduce((sum, s) => sum + s.value, 0);

  // Bucket by turn. Signals with no turn of their own (repeated_failed_command
  // is a property of the whole trajectory) go in a null bucket so they still
  // count exactly once rather than being dropped by the bucketing.
  const buckets = new Map<string | null, Signal[]>();
  for (const sig of signals) {
    const key = sig.turnId ?? null;
    const at = buckets.get(key);
    if (at) at.push(sig);
    else buckets.set(key, [sig]);
  }
  const perTurn: TurnScore[] = [...buckets.entries()].map(([turnId, sigs]) => {
    const turnRaw = sigs.reduce((sum, x) => sum + x.value, 0);
    return { turnId, total: Math.max(-1, Math.min(1, turnRaw)), raw: turnRaw, signals: sigs };
  });

  // The mean over turns, clamped defensively. A task with no turn boundaries
  // at all falls back to the old clamped sum, which is the same number it
  // used to get.
  const total = perTurn.length
    ? Math.max(-1, Math.min(1, perTurn.reduce((sum, t) => sum + t.total, 0) / perTurn.length))
    : Math.max(-1, Math.min(1, raw));
  return { total, raw, perTurn, signals };
}
