// Judge backends. The interface is one method so a backend can be the mock
// (tests, offline), a local model (Ollama), or Pareto through the gateway
// (M5, behind budget/idle gates) without the orchestrator caring which.
import { TRAJECTORY_RUBRIC } from "./rubric.ts";

export type JudgeMode = "mock" | "local" | "pareto";

export type JudgeBackend = {
  readonly mode: JudgeMode;
  /** One completion: system + user in, raw text + cost out. */
  complete(system: string, user: string): Promise<{ text: string; costUsd: number }>;
};

/** Deterministic offline judge: reads the DETERMINISTIC SIGNALS line of the
 *  packet and grades from it. It answers in the REAL wire shape — fenced
 *  JSON, the way models actually reply — so the live parsing path is what
 *  tests exercise. Free, instant, and honest about being a heuristic. */
export class MockJudgeBackend implements JudgeBackend {
  readonly mode = "mock" as const;

  async complete(_system: string, user: string): Promise<{ text: string; costUsd: number }> {
    const has = (signal: string) => user.includes(signal);
    const total = Number(/TOTAL: (-?[\d.]+)/.exec(user)?.[1] ?? 0);

    const met: Record<string, boolean> = {
      made_progress: total > 0,
      verified_fix: has("test_pass_after_edit"),
      read_before_edit: has("test_pass_after_edit"), // reproduce-first implies inspection
      focused_changes: has("focused_edit") && !has("broad_edit"),
      stuck_loop: has("repeated_failed_command"),
      destructive_shortcut: has("test_deletion"),
      ignored_errors: has("turn_interrupted") && has("command_fail"),
    };
    const verdicts = TRAJECTORY_RUBRIC.map((c) => ({
      id: c.id,
      met: met[c.id] === true,
      rationale: met[c.id] ? "signal present" : "no supporting signal",
    }));

    const lessons: Record<string, unknown>[] = [];
    if (met.destructive_shortcut) {
      lessons.push({
        context_key: "general",
        lesson: "Do not delete tests to make the suite pass; fix the code the test protects.",
        confidence: 0.9,
        polarity: "avoid",
      });
    }
    if (met.verified_fix) {
      lessons.push({
        context_key: "general",
        lesson: "Re-run the originally failing command to verify a fix.",
        confidence: 0.7,
        polarity: "do",
      });
    }

    const tags = Object.entries(met).filter(([, v]) => v).map(([k]) => k);
    const body = JSON.stringify({ verdicts, lessons, tags }, null, 1);
    return { text: "Here is the grading:\n```json\n" + body + "\n```\n", costUsd: 0 };
  }
}
