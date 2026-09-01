// Lessons: distilled from scored trajectories, reinforced on repetition,
// ranked at retrieval. Pure — the store applies these functions to rows.
//
// Deterministic distillation only, for now: lesson text comes from templates
// keyed on reward signals, so the same behavior always yields the same
// lesson with the same id — which is exactly what reinforcement keys on.
// The judge (M4/M5) will add distillation with free-text lessons; those ride
// the same reinforce/rank machinery.
import { createHash } from "node:crypto";
import { looksSecret, redactText } from "./redact.ts";
import type { LearningEvent } from "./events.ts";
import type { DeterministicScore } from "./rewards.ts";
import type { TaskRow, LessonRow } from "../store/db.ts";

export type CandidateLesson = {
  /** hash(projectKey + contextKey + text): identical lessons collide on
   *  purpose, but only within the same scope. */
  id: string;
  contextKey: string;
  /** basename of the task cwd; null when unknown. Display/affinity only. */
  repoKey: string | null;
  /** The scope this lesson is true in. null = universal advice that applies
   *  in every project. A stable, client-supplied identity (the app resolves a
   *  worktree to its parent project), NOT a cwd basename — `/a/api` and
   *  `/b/api` are different projects, and a worktree is not its own. */
  projectKey: string | null;
  lesson: string;
  polarity: "do" | "avoid";
};

/** Signal key → lesson template. Positive templates require a positive
 *  trajectory (a "do" from a failed task is noise); avoid-templates and the
 *  safety template distill regardless of outcome. */
const DO_TEMPLATES: Record<string, string> = {
  test_pass_after_edit:
    "Reproduce the failing test first, read the relevant source, make a focused edit, then verify with the same targeted test.",
  focused_edit: "Keep edits to the few files the task actually needs.",
};

const AVOID_TEMPLATES: Record<string, string> = {
  repeated_failed_command:
    "If a command fails, do not re-run it unchanged — gather new information before retrying.",
  broad_edit: "Avoid touching many files for a single fix; prefer a small focused diff.",
  approval_decline:
    "An action of this shape was declined by the user; prefer a narrower alternative or ask first.",
};

const SAFETY_TEMPLATES: Record<string, string> = {
  test_deletion: "Never delete or weaken tests to make the suite pass.",
};

/** Scope is part of identity. Without it, two projects' lessons with the
 *  same text collide on one row and `upsertLesson`'s last writer decides
 *  which project it claims to be from — which is exactly how every lesson in
 *  the M7 corpus came to carry one arbitrary repo's key. */
/** A lesson is one sentence of advice; anything longer is a digest that
 *  wandered in. Bounded because lessons ride real prompts. */
export const LESSON_MAX = 300;

/** Free-text lessons (the judge writes them) get the same treatment event
 *  summaries get, for the same reason: this text is persisted and then
 *  injected into every future prompt that retrieves it, so a secret here
 *  outlives the session it leaked from. Templates are static and safe; this
 *  exists for everything that is not. */
export function sanitizeLesson(text: string): string {
  return redactText(text).replace(/\s+/g, " ").trim().slice(0, LESSON_MAX);
}

/** The store's refusal check — the belt to sanitizeLesson's braces. */
export function lessonIsUnsafe(text: string): boolean {
  return !text.trim() || looksSecret(text) || text.length > LESSON_MAX;
}

export function lessonId(contextKey: string, lesson: string, projectKey?: string | null): string {
  return createHash("sha256")
    .update(`${projectKey ?? ""}\n${contextKey}\n${lesson}`)
    .digest("hex")
    .slice(0, 16);
}

export function repoKeyOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return base || null;
}

export function distillLessons(
  task: TaskRow & { taskType?: string | null },
  _events: LearningEvent[],
  score: DeterministicScore,
): CandidateLesson[] {
  const contextKey = task.taskType ?? "general";
  const repoKey = repoKeyOf(task.cwd);
  // Templates are universal advice ("never delete tests"), so they distill
  // GLOBAL: one row per lesson, support accumulating across every project.
  // Project-specific claims come from the judge, which scopes its own.
  const present = new Set(score.signals.map((s) => s.key));
  const out: CandidateLesson[] = [];
  const push = (lesson: string, polarity: "do" | "avoid") =>
    out.push({ id: lessonId(contextKey, lesson, null), contextKey, repoKey, projectKey: null, lesson, polarity });

  for (const [signal, text] of Object.entries(SAFETY_TEMPLATES)) {
    if (present.has(signal)) push(text, "avoid");
  }
  for (const [signal, text] of Object.entries(AVOID_TEMPLATES)) {
    if (present.has(signal)) push(text, "avoid");
  }
  if (score.total > 0) {
    for (const [signal, text] of Object.entries(DO_TEMPLATES)) {
      if (present.has(signal)) push(text, "do");
    }
  }
  return out;
}

// ── Reinforcement ────────────────────────────────────────────────────────

export type ReinforceInput = { taskReward: number };
export type ReinforcedValues = { confidence: number; supportCount: number; avgReward: number | null };

const FRESH_CONFIDENCE = 0.4;
/** Each repeat closes this fraction of the gap to 1 — asymptotic, never 1. */
const CONFIDENCE_STEP = 0.15;
/** What a refutation keeps. Deliberately far harsher than a sighting earns:
 *  reinforcement is machine evidence that a pattern recurred, a refutation is
 *  a human saying the advice is wrong, and the second should win. Multiplicative
 *  so it is asymptotic toward 0 and never negative. */
const REFUTE_FACTOR = 0.5;
/** Below this a lesson is dead: kept for audit, never retrieved. This is the
 *  decay the system lacked — event-driven rather than time-based, so it stays
 *  deterministic and every test stays time-independent. */
export const MIN_RETRIEVAL_CONFIDENCE = 0.1;

export function reinforce(existing: ReinforcedValues | null, input: ReinforceInput): ReinforcedValues {
  if (!existing) {
    return { confidence: FRESH_CONFIDENCE, supportCount: 1, avgReward: input.taskReward };
  }
  const supportCount = existing.supportCount + 1;
  const confidence = existing.confidence + (1 - existing.confidence) * CONFIDENCE_STEP;
  const prevAvg = existing.avgReward ?? 0;
  const avgReward = prevAvg + (input.taskReward - prevAvg) / supportCount;
  return { confidence, supportCount, avgReward };
}

/** The inverse of reinforce, for when the advice turns out to be wrong —
 *  the user deleting the memory it became, a human review, an outcome that
 *  contradicts it. Support is untouched: the behaviour really did recur, it
 *  is the LESSON drawn from it that is being disputed. */
export function refute(existing: ReinforcedValues): ReinforcedValues {
  return { ...existing, confidence: existing.confidence * REFUTE_FACTOR };
}

// ── Retrieval ranking ────────────────────────────────────────────────────

export type RankOptions = { repoKey?: string | null; projectKey?: string | null };
export type RankedLesson = LessonRow & { score: number; finalScore: number };

/** Combine FTS relevance with what reinforcement has learned. Text relevance
 *  carries the most weight; support enters logarithmically so frequency can
 *  never drown topicality; same-repo lessons get a fixed affinity bonus.
 *  Recency is deliberately absent for now — it would make ranking
 *  time-dependent, and with it every test. */
export function rankLessons(hits: (LessonRow & { score: number })[], opts: RankOptions): RankedLesson[] {
  return hits
    .map((h) => ({
      ...h,
      finalScore:
        h.score +
        0.5 * h.confidence +
        0.2 * Math.log1p(h.supportCount) +
        (opts.repoKey && h.repoKey === opts.repoKey ? 0.3 : 0) +
        // Something learned about THIS project outranks universal advice at
        // equal relevance: it is the more specific claim.
        (opts.projectKey && h.projectKey === opts.projectKey ? 0.3 : 0),
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}
