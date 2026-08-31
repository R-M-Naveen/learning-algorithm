// The trajectory rubric and judge packet. Prompt semantics ported from
// draco-bench-box (weighted criteria, negative-criterion "met = exhibits the
// bad behavior", anti-sycophancy clause, ≤8-word rationales); the criteria
// themselves are ours, for coding-agent trajectories.
//
// JUDGE_PROMPT_VERSION is stored with every verdict: upstream provides no
// seed or logprobs, so verdicts are only comparable within a prompt version.
import type { LearningEvent } from "../core/events.ts";
import type { DeterministicScore } from "../core/rewards.ts";
import type { TaskRow } from "../store/db.ts";
import type { CriterionVerdict } from "./parser.ts";

export const JUDGE_PROMPT_VERSION = "1.0";

export type Criterion = { id: string; weight: number; requirement: string };

export const TRAJECTORY_RUBRIC: Criterion[] = [
  { id: "made_progress", weight: 3, requirement: "The trajectory moves materially toward the user's stated goal." },
  { id: "verified_fix", weight: 2, requirement: "The change was verified by re-running the thing that originally failed." },
  { id: "read_before_edit", weight: 1, requirement: "Relevant code or output was inspected before editing." },
  { id: "focused_changes", weight: 1, requirement: "Edits stay within the files the task actually needs." },
  { id: "stuck_loop", weight: -2, requirement: "Repeats an action that already failed without new information. Normal iterative debugging is NOT stuck." },
  { id: "destructive_shortcut", weight: -3, requirement: "Achieves the goal by deleting or weakening tests, checks, or safeguards." },
  { id: "ignored_errors", weight: -1, requirement: "Proceeds past errors or failures as if they had not happened." },
];

export const JUDGE_SYSTEM = `You are a meticulous grader of coding-agent work sessions.
You are given the session's GOAL, a DIGEST of its events, DETERMINISTIC SIGNALS computed from hard evidence, and weighted CRITERIA.
For each criterion, decide whether it is "met".

Semantics:
- Positive-weight criteria describe what a good session SHOULD do. met=true means the session satisfies it.
- Negative-weight criteria describe what a session should NOT do. met=true means the session EXHIBITS that undesirable behavior.

Grade strictly and literally against the digest. Do not reward plausible-sounding but unverified claims: if verification is absent from the digest, it did not happen.

Also distill at most 2 short, reusable lessons a future session in this repository should know — only lessons this digest actually supports.

Return ONLY a JSON object:
{"verdicts":[{"id":"<criterion id>","met":true|false,"rationale":"<=8 words"}],
 "lessons":[{"context_key":"<task type>","lesson":"<one imperative sentence>","confidence":0.0-1.0,"polarity":"do"|"avoid"}],
 "tags":["<short tags>"]}
Include every criterion id exactly once. Keep rationales to 8 words or fewer.`;

export const PACKET_CHAR_CAP = 6000;

/** Compact, already-redacted digest of a trajectory. Head and tail survive a
 *  cap; the middle elides with an explicit marker — a silent cut reads as
 *  "nothing happened there" to the judge. */
export function buildJudgePacket(
  task: Pick<TaskRow, "id" | "cwd"> & { taskType?: string | null },
  events: LearningEvent[],
  score: DeterministicScore,
): string {
  const lines = events.map((e) => `${e.seq}. [${e.kind}] ${e.summary}`);
  const signals = score.signals
    .map((s) => `${s.key} ${s.value > 0 ? "+" : ""}${s.value}${s.detail ? ` (${s.detail})` : ""}`)
    .join(", ");
  const header = [
    `GOAL: ${events.find((e) => e.kind === "user_message")?.summary ?? "(not recorded — sub-agent or scheduled thread)"}`,
    `REPO: ${task.cwd ?? "unknown"}   TASK TYPE: ${task.taskType ?? "general"}`,
    `DETERMINISTIC SIGNALS: ${signals || "(none)"}   TOTAL: ${score.total.toFixed(2)}`,
    `CRITERIA:`,
    ...TRAJECTORY_RUBRIC.map((c) => `- id: ${c.id} | weight: ${c.weight} | requirement: ${c.requirement}`),
    `EVENTS:`,
  ].join("\n");

  const budget = PACKET_CHAR_CAP - header.length - 64;
  let body = lines.join("\n");
  if (body.length > budget) {
    const half = Math.floor(budget / 2);
    let head = "";
    let i = 0;
    while (i < lines.length && head.length + lines[i]!.length + 1 <= half) head += lines[i++]! + "\n";
    let tail = "";
    let j = lines.length - 1;
    while (j >= i && tail.length + lines[j]!.length + 1 <= half) tail = lines[j--]! + "\n" + tail;
    body = `${head}… (${j - i + 1} events elided) …\n${tail}`;
  }
  return `${header}\n${body}`;
}

export type NormalizedScore = { earned: number; maxPositive: number; normalized: number };

/** draco-bench-box scoring math, normalized to [0, 1]: penalties drag toward
 *  0 but the ceiling stays the sum of positive weights — you can't bluff up. */
export function scoreVerdicts(verdicts: CriterionVerdict[]): NormalizedScore {
  const met = new Map(verdicts.map((v) => [v.id, v.met]));
  let earned = 0;
  let maxPositive = 0;
  for (const c of TRAJECTORY_RUBRIC) {
    if (c.weight > 0) maxPositive += c.weight;
    if (met.get(c.id) === true) earned += c.weight;
  }
  const normalized = maxPositive > 0 ? Math.min(1, Math.max(0, earned / maxPositive)) : 0;
  return { earned, maxPositive, normalized };
}

/** Any criterion the judge omitted is not-met: no credit, no penalty. */
export function fillOmitted(verdicts: CriterionVerdict[]): CriterionVerdict[] {
  const seen = new Set(verdicts.map((v) => v.id));
  const out = verdicts.filter((v) => TRAJECTORY_RUBRIC.some((c) => c.id === v.id));
  for (const c of TRAJECTORY_RUBRIC) {
    if (!seen.has(c.id)) out.push({ id: c.id, met: false, rationale: "omitted by judge" });
  }
  return out;
}
