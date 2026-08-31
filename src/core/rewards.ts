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

export type Signal = { key: string; value: number; detail?: string };
export type DeterministicScore = {
  /** Clamped to [-1, 1]; what downstream reward math consumes. */
  total: number;
  /** Unclamped sum, kept for analysis. */
  raw: number;
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
            signals.push({ key: "command_ok", value: v });
          }
          // A test command passing after a file change, having failed before
          // it, is the strongest deterministic evidence of a real fix —
          // unless the trajectory also deleted a test, which voids the claim.
          if (isTestCommand(cmd) && sawTestFailBeforeEdit && sawFileChange && !earnedTestPass && !sawTestDeletion) {
            earnedTestPass = true;
            signals.push({ key: "test_pass_after_edit", value: SIGNAL_WEIGHTS.test_pass_after_edit, detail: cmd });
          }
        } else {
          if (failTotal > SIGNAL_WEIGHTS.command_fail_cap + 1e-9) {
            const v = Math.max(SIGNAL_WEIGHTS.command_fail, SIGNAL_WEIGHTS.command_fail_cap - failTotal);
            failTotal += v;
            signals.push({ key: "command_fail", value: v });
          }
          if (cmd) failCounts.set(cmd, (failCounts.get(cmd) ?? 0) + 1);
          if (isTestCommand(cmd) && !sawFileChange) sawTestFailBeforeEdit = true;
        }
        break;
      }
      case "file_change": {
        sawFileChange = true;
        const files = Array.isArray(e.data.files) ? (e.data.files as string[]) : [];
        const deletesTest =
          /delet/i.test(e.summary) && (files.some((f) => /test/i.test(f)) || /test/i.test(e.summary));
        if (deletesTest) {
          sawTestDeletion = true;
          signals.push({ key: "test_deletion", value: SIGNAL_WEIGHTS.test_deletion, detail: files.join(", ") });
        } else if (files.length > BROAD_EDIT_FILES) {
          signals.push({ key: "broad_edit", value: SIGNAL_WEIGHTS.broad_edit, detail: `${files.length} files` });
        } else if (files.length > 0 && files.length <= FOCUSED_EDIT_FILES) {
          signals.push({ key: "focused_edit", value: SIGNAL_WEIGHTS.focused_edit, detail: `${files.length} file(s)` });
        }
        break;
      }
      case "approval_decision": {
        const d = e.data.decision as ApprovalDecision | undefined;
        if (d === "accept") signals.push({ key: "approval_accept", value: SIGNAL_WEIGHTS.approval_accept });
        else if (d === "acceptForSession")
          signals.push({ key: "approval_accept_session", value: SIGNAL_WEIGHTS.approval_accept_session });
        else if (d === "decline") signals.push({ key: "approval_decline", value: SIGNAL_WEIGHTS.approval_decline });
        break;
      }
      case "turn_completed": {
        const status = e.data.status as TurnStatus | undefined;
        if (status === "completed") {
          if (sawTestDeletion) {
            signals.push({
              key: "turn_completed_tainted",
              value: 0,
              detail: "completion after test deletion earns nothing",
            });
          } else {
            signals.push({ key: "turn_completed", value: SIGNAL_WEIGHTS.turn_completed });
          }
        }
        else if (status === "failed") signals.push({ key: "turn_failed", value: SIGNAL_WEIGHTS.turn_failed });
        else if (status === "interrupted")
          signals.push({ key: "turn_interrupted", value: SIGNAL_WEIGHTS.turn_interrupted });
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
  return { total: Math.max(-1, Math.min(1, raw)), raw, signals };
}
