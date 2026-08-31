// The judge orchestrator: events -> deterministic score -> packet -> backend
// -> parse -> normalized reward + lessons, all persisted. Re-judging a task
// replaces its job and reward — one judge verdict per task, like the
// deterministic score.
import { scoreTrajectory } from "../core/rewards.ts";
import { repoKeyOf } from "../core/lessons.ts";
import type { Store } from "../store/db.ts";
import type { JudgeBackend } from "./backend.ts";
import { parseJudgeResponse, type CriterionVerdict } from "./parser.ts";
import { buildJudgePacket, fillOmitted, scoreVerdicts, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM } from "./rubric.ts";

export type JudgeResult = {
  taskId: string;
  normalized: number;
  verdicts: CriterionVerdict[];
  lessonsAbsorbed: number;
  costUsd: number;
};

export async function runJudge(store: Store, taskId: string, backend: JudgeBackend): Promise<JudgeResult> {
  const events = store.eventsForTask(taskId);
  if (!events.length) throw new Error(`no events for task ${taskId}`);
  const score = scoreTrajectory(events);
  const meta = events.find((e) => e.kind === "task_meta");
  const cwd = typeof meta?.data.cwd === "string" ? (meta.data.cwd as string) : null;
  const packet = buildJudgePacket({ id: taskId, cwd, taskType: null }, events, score);

  store.beginJudgeJob(taskId, packet, backend.mode, JUDGE_PROMPT_VERSION);
  const startedAt = Date.now();
  let raw: { text: string; costUsd: number };
  try {
    raw = await backend.complete(JUDGE_SYSTEM, packet);
  } catch (err) {
    store.failJudgeJob(taskId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  const parsed = parseJudgeResponse(raw.text);
  const verdicts = fillOmitted(parsed.verdicts);
  const { normalized } = scoreVerdicts(verdicts);

  store.finishJudgeJob(taskId, JSON.stringify({ verdicts, tags: parsed.tags }), raw.costUsd, Date.now() - startedAt);
  store.recordJudgeReward(taskId, normalized);
  if (parsed.lessons.length) {
    store.absorbLessons(
      parsed.lessons.map((l) => ({
        id: `judge-${lessonKey(l.contextKey, l.lesson)}`,
        contextKey: l.contextKey,
        repoKey: repoKeyOf(cwd),
        lesson: l.lesson,
        polarity: l.polarity,
      })),
      normalized,
    );
  }
  return { taskId, normalized, verdicts, lessonsAbsorbed: parsed.lessons.length, costUsd: raw.costUsd };
}

function lessonKey(contextKey: string, lesson: string): string {
  // Same collision-on-purpose identity rule as core/lessons.lessonId, with a
  // judge- prefix so template and judge lessons never merge silently.
  let h = 0;
  const s = `${contextKey}\n${lesson}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
