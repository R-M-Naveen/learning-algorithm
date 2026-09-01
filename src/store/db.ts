// SQLite store on node:sqlite — zero native deps. One writer, WAL,
// write-then-commit discipline.
//
// The Electron packaging spike this comment used to defer is DONE (2026-09-01):
// the shipped bundle was driven under `ELECTRON_RUN_AS_NODE=1` against
// Electron 43's own Node, and node:sqlite plus an FTS5 MATCH both work —
// handshake, a 7-event ingest, the auto-distil reflex, a scoped retrieval and
// a clean exit. That was the one unknown that could have invalidated this
// storage choice, so it is worth stating as settled rather than assumed.
import { DatabaseSync } from "node:sqlite";
import { validateEvent, type LearningEvent } from "../core/events.ts";
import { reinforce, rankLessons, type CandidateLesson, type RankedLesson } from "../core/lessons.ts";
import { MIN_RETRIEVAL_CONFIDENCE, lessonIsUnsafe, refute } from "../core/lessons.ts";
import {
  HOLDOUT_TRUST_FLOOR,
  armFor,
  trustScore,
  type Arm,
  type Outcome,
  type Trust,
} from "../core/evaluation.ts";
import type { JudgeCandidate } from "../judge/sampling.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  cwd         TEXT,
  project_key TEXT,                   -- client-supplied, stable across worktrees
  source      TEXT NOT NULL,
  task_type   TEXT,
  outcome     TEXT,
  total_reward REAL,
  raw_reward  REAL                    -- unclamped; total hides the ceiling
);
CREATE TABLE IF NOT EXISTS events (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL,
  turn_id  TEXT,
  seq      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  source   TEXT NOT NULL,
  summary  TEXT NOT NULL,
  data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
CREATE TABLE IF NOT EXISTS rewards (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  event_id  TEXT,
  kind      TEXT NOT NULL,          -- deterministic | judge
  value     REAL NOT NULL,
  detail    TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judge_jobs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  state       TEXT NOT NULL,        -- queued | running | done | failed | dropped
  packet      TEXT,
  verdict     TEXT,
  judge_mode  TEXT,
  prompt_version TEXT,
  cost_usd    REAL,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
  id            TEXT PRIMARY KEY,
  context_key   TEXT NOT NULL,
  repo_key      TEXT,
  project_key   TEXT,                 -- NULL = universal advice

  lesson        TEXT NOT NULL,
  polarity      TEXT,
  confidence    REAL NOT NULL,
  support_count INTEGER NOT NULL,
  avg_reward    REAL,
  created_at    TEXT,
  last_used_at  TEXT
);
CREATE TABLE IF NOT EXISTS lesson_usage (
  id         TEXT PRIMARY KEY,
  lesson_id  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  turn_id    TEXT,
  at         TEXT NOT NULL,
  arm        TEXT,                  -- inject | holdout (the control)
  outcome    TEXT                   -- positive | negative | neutral, on resolve
);
CREATE INDEX IF NOT EXISTS lesson_usage_lesson ON lesson_usage (lesson_id);
CREATE INDEX IF NOT EXISTS lesson_usage_task ON lesson_usage (task_id);
CREATE TABLE IF NOT EXISTS lesson_refutations (
  id         TEXT PRIMARY KEY,
  lesson_id  TEXT NOT NULL,
  at         TEXT NOT NULL,
  reason     TEXT
);
CREATE TABLE IF NOT EXISTS approval_stats (
  context_key TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  accepts     INTEGER NOT NULL DEFAULT 0,
  declines    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (context_key, action_kind)
);
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  lesson, context_key UNINDEXED, id UNINDEXED
);
`;

export type TaskRow = {
  id: string;
  createdAt: string;
  cwd?: string | null;
  projectKey?: string | null;
  source: string;
  taskType?: string | null;
  outcome?: string | null;
};

export type LessonRow = {
  id: string;
  contextKey: string;
  repoKey?: string | null;
  projectKey?: string | null;
  lesson: string;
  confidence: number;
  supportCount: number;
  avgReward?: number | null;
};

export type AppendResult = { accepted: number; dropped: number; reasons: string[] };

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Additive migrations: CREATE IF NOT EXISTS skips existing tables, so
    // columns added after a database was born must be patched in.
    this.ensureColumn("judge_jobs", "duration_ms", "INTEGER");
    this.ensureColumn("lessons", "polarity", "TEXT");
    this.ensureColumn("lessons", "project_key", "TEXT");
    this.ensureColumn("tasks", "project_key", "TEXT");
    this.ensureColumn("tasks", "raw_reward", "REAL");
    this.ensureColumn("lesson_usage", "arm", "TEXT");
    // A second writer (the CLI against the app's db) should wait, not throw.
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  tableNames(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  upsertTask(t: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, created_at, cwd, project_key, source, task_type, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, cwd),
           project_key = COALESCE(excluded.project_key, project_key),
           task_type = COALESCE(excluded.task_type, task_type),
           outcome = COALESCE(excluded.outcome, outcome)`,
      )
      .run(t.id, t.createdAt, t.cwd ?? null, t.projectKey ?? null, t.source, t.taskType ?? null, t.outcome ?? null);
  }

  /** Validates every event; a bad one is dropped with a reason, never fatal.
   *  Duplicate ids are accepted as no-ops so replaying a source is safe. */
  appendEvents(events: LearningEvent[]): AppendResult {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, task_id, turn_id, seq, at, kind, source, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result: AppendResult = { accepted: 0, dropped: 0, reasons: [] };
    for (const raw of events) {
      const checked = validateEvent(raw);
      if (!checked.ok) {
        result.dropped++;
        result.reasons.push(checked.error);
        continue;
      }
      const e = checked.event;
      insert.run(e.id, e.taskId, e.turnId ?? null, e.seq, e.at, e.kind, e.source, e.summary, JSON.stringify(e.data));
      result.accepted++;
    }
    return result;
  }

  eventsForTask(taskId: string): LearningEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      turnId: (r.turn_id as string | null) ?? null,
      seq: r.seq as number,
      at: r.at as string,
      kind: r.kind as LearningEvent["kind"],
      source: r.source as LearningEvent["source"],
      summary: r.summary as string,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  upsertLesson(l: LessonRow): void {
    this.db
      .prepare(
        `INSERT INTO lessons (id, context_key, repo_key, project_key, lesson, confidence, support_count, avg_reward, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           context_key = excluded.context_key,
           repo_key = excluded.repo_key,
           project_key = excluded.project_key,
           lesson = excluded.lesson,
           confidence = excluded.confidence,
           support_count = excluded.support_count,
           avg_reward = excluded.avg_reward`,
      )
      .run(l.id, l.contextKey, l.repoKey ?? null, l.projectKey ?? null, l.lesson, l.confidence, l.supportCount, l.avgReward ?? null);
    // Regenerate the FTS row rather than mutate it — same regenerate-don't-
    // mutate rule the ecosystem applies to config.
    this.db.prepare("DELETE FROM lessons_fts WHERE id = ?").run(l.id);
    this.db.prepare("INSERT INTO lessons_fts (lesson, context_key, id) VALUES (?, ?, ?)").run(l.lesson, l.contextKey, l.id);
  }

  searchLessons(query: string, limit: number, projectKey?: string | null): (LessonRow & { score: number })[] {
    // FTS5 MATCH syntax treats punctuation as operators; quote each term.
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(" OR ");
    if (!terms) return [];
    // A scoped query sees this project's lessons plus universal advice, and
    // nothing from anyone else. An unscoped query (the CLI, the report) sees
    // everything on purpose.
    const scoped = projectKey !== undefined && projectKey !== null;
    const rows = this.db
      .prepare(
        `SELECT l.id, l.context_key, l.repo_key, l.project_key, l.lesson, l.confidence, l.support_count, l.avg_reward,
                bm25(lessons_fts) AS rank
         FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.id
         WHERE lessons_fts MATCH ?
           AND l.confidence >= ${MIN_RETRIEVAL_CONFIDENCE}${scoped ? " AND (l.project_key IS NULL OR l.project_key = ?)" : ""}
         ORDER BY rank LIMIT ?`,
      )
      .all(...(scoped ? [terms, projectKey, limit] : [terms, limit])) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      contextKey: r.context_key as string,
      repoKey: r.repo_key as string | null,
      projectKey: r.project_key as string | null,
      lesson: r.lesson as string,
      confidence: r.confidence as number,
      supportCount: r.support_count as number,
      avgReward: r.avg_reward as number | null,
      score: -(r.rank as number), // bm25() is lower-is-better; flip so higher is better
    }));
  }

  /** Persist a deterministic score: one reward row per signal, the clamped
   *  total on the task. Replaces any previous deterministic score for the
   *  task — scoring is idempotent, not accumulative. */
  recordScore(
    taskId: string,
    score: {
      total: number;
      raw: number;
      signals: { key: string; value: number; detail?: string; eventId?: string }[];
    },
  ): void {
    this.db.prepare("DELETE FROM rewards WHERE task_id = ? AND kind = 'deterministic'").run(taskId);
    const insert = this.db.prepare(
      `INSERT INTO rewards (id, task_id, event_id, kind, value, detail, created_at)
       VALUES (?, ?, ?, 'deterministic', ?, ?, datetime('now'))`,
    );
    score.signals.forEach((s, i) => {
      insert.run(`${taskId}-det-${i}`, taskId, s.eventId ?? null, s.value, s.detail ? `${s.key}: ${s.detail}` : s.key);
    });
    // Both numbers: `total` is what reward math consumes, `raw` is what the
    // clamp hid. Without raw, 21 tasks reading "1.00" are indistinguishable
    // whether their unclamped sum was 1.2 or 11.1, and the report cannot see
    // that the ceiling is where the discrimination went.
    this.db
      .prepare("UPDATE tasks SET total_reward = ?, raw_reward = ? WHERE id = ?")
      .run(score.total, score.raw, taskId);
  }

  /** The scope a task's lessons belong to, as the client declared it. */
  /** The unclamped sum, for analysis the clamped total cannot support. */
  taskRawReward(taskId: string): number | null {
    const row = this.db.prepare("SELECT raw_reward FROM tasks WHERE id = ?").get(taskId) as
      | { raw_reward: number | null }
      | undefined;
    return row?.raw_reward ?? null;
  }

  taskProjectKey(taskId: string): string | null {
    const row = this.db.prepare("SELECT project_key FROM tasks WHERE id = ?").get(taskId) as
      | { project_key: string | null }
      | undefined;
    return row?.project_key ?? null;
  }

  /** Every reward row for a task, with the event each was attributed to. */
  rewardsForTask(taskId: string): { kind: string; value: number; detail: string | null; eventId: string | null }[] {
    const rows = this.db
      .prepare("SELECT kind, value, detail, event_id FROM rewards WHERE task_id = ? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      kind: r.kind as string,
      value: r.value as number,
      detail: (r.detail as string | null) ?? null,
      eventId: (r.event_id as string | null) ?? null,
    }));
  }

  taskReward(taskId: string): number | null {
    const row = this.db.prepare("SELECT total_reward FROM tasks WHERE id = ?").get(taskId) as
      | { total_reward: number | null }
      | undefined;
    return row?.total_reward ?? null;
  }

  taskIds(): string[] {
    return (this.db.prepare("SELECT id FROM tasks ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
  }

  /** Insert-or-reinforce each candidate: a lesson seen again gains support
   *  and confidence instead of a duplicate row (ids collide by design). */
  absorbLessons(candidates: CandidateLesson[], taskReward: number): void {
    const read = this.db.prepare("SELECT confidence, support_count, avg_reward FROM lessons WHERE id = ?");
    for (const c of candidates) {
      // Refused, not sanitized-in-place: the id is a hash of the text, so
      // rewriting the text here would divorce a row from its identity. The
      // boundary that produced it is responsible for sanitizing (judge.ts
      // does), and this catches the call site that forgot.
      if (lessonIsUnsafe(c.lesson)) continue;
      const row = read.get(c.id) as
        | { confidence: number; support_count: number; avg_reward: number | null }
        | undefined;
      const next = reinforce(
        row ? { confidence: row.confidence, supportCount: row.support_count, avgReward: row.avg_reward } : null,
        { taskReward },
      );
      this.upsertLesson({
        id: c.id,
        contextKey: c.contextKey,
        repoKey: c.repoKey,
        projectKey: c.projectKey ?? null,
        lesson: c.lesson,
        confidence: next.confidence,
        supportCount: next.supportCount,
        avgReward: next.avgReward,
      });
      this.db.prepare("UPDATE lessons SET polarity = ? WHERE id = ?").run(c.polarity, c.id);
    }
  }

  /** FTS search widened, then re-ranked by confidence/support/repo affinity. */
  queryLessons(
    text: string,
    opts: { repoKey?: string | null; projectKey?: string | null; limit?: number },
  ): RankedLesson[] {
    const limit = opts.limit ?? 5;
    const hits = this.searchLessons(text, Math.max(limit * 4, 20), opts.projectKey);
    return rankLessons(hits, { repoKey: opts.repoKey ?? null, projectKey: opts.projectKey ?? null }).slice(0, limit);
  }

  /** Tasks that have never been judged, with what the sampler needs to
   *  choose between them: the deterministic score, the project, and how many
   *  of that project's tasks already carry a verdict. */
  judgeCandidates(): JudgeCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.total_reward AS score, t.project_key AS project_key,
                (SELECT COUNT(*) FROM judge_jobs j2
                   JOIN tasks t2 ON t2.id = j2.task_id
                  WHERE j2.state = 'done'
                    AND ((t2.project_key IS NULL AND t.project_key IS NULL) OR t2.project_key = t.project_key)
                ) AS project_judged
         FROM tasks t
         WHERE NOT EXISTS (SELECT 1 FROM judge_jobs j WHERE j.task_id = t.id AND j.state = 'done')
         ORDER BY t.created_at`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      taskId: r.id as string,
      score: (r.score as number | null) ?? null,
      projectKey: (r.project_key as string | null) ?? null,
      projectJudged: (r.project_judged as number) ?? 0,
    }));
  }

  /** Every lesson, for the report. */
  allLessons(): LessonRow[] {
    const rows = this.db
      .prepare("SELECT id, context_key, repo_key, project_key, lesson, confidence, support_count, avg_reward FROM lessons ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      contextKey: r.context_key as string,
      repoKey: r.repo_key as string | null,
      projectKey: r.project_key as string | null,
      lesson: r.lesson as string,
      confidence: r.confidence as number,
      supportCount: r.support_count as number,
      avgReward: r.avg_reward as number | null,
    }));
  }

  /** The arm comparison: for every task that had lessons retrieved, which arm
   *  it was in and how it went. This is the primary Phase 2 metric — the
   *  effect of injecting, measured against tasks deliberately withheld,
   *  rather than inferred from lessons nobody deleted. */
  armOutcomes(): { arm: string; taskId: string; outcome: string | null; score: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT u.arm AS arm, u.task_id AS task_id, u.outcome AS outcome, t.total_reward AS score
         FROM lesson_usage u LEFT JOIN tasks t ON t.id = u.task_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      arm: (r.arm as string | null) ?? "inject",
      taskId: r.task_id as string,
      outcome: (r.outcome as string | null) ?? null,
      score: (r.score as number | null) ?? null,
    }));
  }

  /** How many times a lesson actually rode a prompt (inject), and how many
   *  times it would have but was deliberately withheld (holdout). */
  impressionsFor(lessonId: string): { inject: number; holdout: number } {
    const rows = this.db
      .prepare("SELECT arm, COUNT(*) AS n FROM lesson_usage WHERE lesson_id = ? GROUP BY arm")
      .all(lessonId) as { arm: string | null; n: number }[];
    let inject = 0;
    let holdout = 0;
    for (const r of rows) {
      if (r.arm === "holdout") holdout += r.n;
      else inject += r.n; // NULL arm = pre-arm rows, which were all injections
    }
    return { inject, holdout };
  }

  /** Trust over the INJECT arm only: a withheld lesson cannot have helped or
   *  harmed, so counting shadow impressions against it would punish a lesson
   *  for the control group's existence. */
  trustFor(lessonId: string): Trust {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN outcome = 'positive' THEN 1 ELSE 0 END) AS good
         FROM lesson_usage
         WHERE lesson_id = ? AND (arm IS NULL OR arm = 'inject') AND outcome IS NOT NULL`,
      )
      .get(lessonId) as { n: number; good: number | null };
    return trustScore({ successes: row.good ?? 0, impressions: row.n });
  }

  lessonById(lessonId: string): LessonRow | null {
    const r = this.db
      .prepare("SELECT id, context_key, repo_key, project_key, lesson, confidence, support_count, avg_reward FROM lessons WHERE id = ?")
      .get(lessonId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      contextKey: r.context_key as string,
      repoKey: r.repo_key as string | null,
      projectKey: r.project_key as string | null,
      lesson: r.lesson as string,
      confidence: r.confidence as number,
      supportCount: r.support_count as number,
      avgReward: r.avg_reward as number | null,
    };
  }

  /** Staleness, applied as an EVENT rather than as a term in ranking: the
   *  caller supplies the cutoff, so ranking stays time-independent and every
   *  test stays deterministic. A lesson not used since `unusedSince` loses a
   *  fraction of its confidence. */
  decayUnusedLessons(unusedSince: string, factor: number): number {
    const f = Math.max(0, Math.min(1, factor));
    const stale = this.db
      .prepare(
        `SELECT l.id FROM lessons l
         WHERE COALESCE(
           (SELECT MAX(u.at) FROM lesson_usage u WHERE u.lesson_id = l.id),
           l.created_at
         ) < ?`,
      )
      .all(unusedSince) as { id: string }[];
    const update = this.db.prepare("UPDATE lessons SET confidence = confidence * ? WHERE id = ?");
    for (const row of stale) update.run(f, row.id);
    return stale.length;
  }

  /** A lesson was wrong. Lowers confidence hard and records the refutation,
   *  so a lesson the user rejected stops riding prompts without vanishing
   *  from the audit trail. The coupling seam for the app's memory_forget. */
  refuteLesson(lessonId: string, reason?: string | null): { confidence: number } | { error: string } {
    const row = this.db
      .prepare("SELECT confidence, support_count, avg_reward FROM lessons WHERE id = ?")
      .get(lessonId) as { confidence: number; support_count: number; avg_reward: number | null } | undefined;
    if (!row) return { error: `unknown lesson ${lessonId}` };
    const next = refute({
      confidence: row.confidence,
      supportCount: row.support_count,
      avgReward: row.avg_reward,
    });
    this.db.prepare("UPDATE lessons SET confidence = ? WHERE id = ?").run(next.confidence, lessonId);
    this.db
      .prepare(
        `INSERT INTO lesson_refutations (id, lesson_id, at, reason)
         VALUES (?, ?, datetime('now'), ?)`,
      )
      .run(`${lessonId}:${Date.now()}:${Math.trunc(next.confidence * 1e6)}`, lessonId, reason ?? null);
    return { confidence: next.confidence };
  }

  refutationCount(lessonId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM lesson_refutations WHERE lesson_id = ?")
      .get(lessonId) as { n: number };
    return row.n;
  }

  /** Retrieval WITH an arm. The holdout arm returns nothing — structurally,
   *  so a buggy client cannot leak the control — but records what it would
   *  have injected, which is the row that makes the comparison possible.
   *
   *  Lessons that have been judged and failed are filtered out here rather
   *  than merely ranked down: past a point, continuing to spend prompt on
   *  something measured not to help is just cost. */
  queryLessonsForTask(
    text: string,
    opts: { taskId: string; projectKey?: string | null; holdoutFraction?: number; limit?: number },
  ): { arm: Arm; lessons: RankedLesson[] } {
    const arm = armFor(opts.taskId, opts.holdoutFraction ?? 0);
    const candidates = this.queryLessons(text, {
      projectKey: opts.projectKey ?? null,
      limit: opts.limit ?? 5,
    }).filter((l) => {
      const t = this.trustFor(l.id);
      return !t.judged || (t.trust ?? 0) >= HOLDOUT_TRUST_FLOOR;
    });
    if (arm === "holdout") {
      // The shadow impression: this is what the user would have been given.
      this.recordLessonUse(candidates.map((l) => l.id), opts.taskId, null, "holdout");
      return { arm, lessons: [] };
    }
    return { arm, lessons: candidates };
  }

  /** The audit half of injection: which lessons rode which task. */
  recordLessonUse(lessonIds: string[], taskId: string, turnId?: string | null, arm: Arm = "inject"): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO lesson_usage (id, lesson_id, task_id, turn_id, at, arm, outcome)
       VALUES (?, ?, ?, ?, datetime('now'), ?, NULL)`,
    );
    for (const lessonId of lessonIds) {
      insert.run(`${taskId}:${lessonId}`, lessonId, taskId, turnId ?? null, arm);
      this.db.prepare("UPDATE lessons SET last_used_at = datetime('now') WHERE id = ?").run(lessonId);
    }
  }

  resolveLessonUse(taskId: string, outcome: string): void {
    this.db.prepare("UPDATE lesson_usage SET outcome = ? WHERE task_id = ? AND outcome IS NULL").run(outcome, taskId);
  }

  /** The classified form. `outcome` here comes from classifyOutcome, which
   *  vetoes a success on an interrupt or a declined approval — the two ways
   *  the user corrects the agent that a score cannot see. */
  resolveLessonUseWithOutcome(taskId: string, outcome: Outcome): void {
    this.resolveLessonUse(taskId, outcome);
  }

  usageForTask(taskId: string): { lessonId: string; turnId: string | null; outcome: string | null }[] {
    const rows = this.db
      .prepare("SELECT lesson_id, turn_id, outcome FROM lesson_usage WHERE task_id = ?")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      lessonId: r.lesson_id as string,
      turnId: (r.turn_id as string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null,
    }));
  }

  // ── Judge jobs ─────────────────────────────────────────────────────────
  // One job per task: begin replaces any previous attempt, finish/fail
  // resolve it. The packet and verdict are kept for the M7 replay report.

  beginJudgeJob(taskId: string, packet: string, judgeMode: string, promptVersion: string): void {
    this.db.prepare("DELETE FROM judge_jobs WHERE task_id = ?").run(taskId);
    this.db
      .prepare(
        `INSERT INTO judge_jobs (id, task_id, state, packet, judge_mode, prompt_version, created_at)
         VALUES (?, ?, 'running', ?, ?, ?, datetime('now'))`,
      )
      .run(`job-${taskId}`, taskId, packet, judgeMode, promptVersion);
  }

  finishJudgeJob(taskId: string, verdictJson: string, costUsd: number, durationMs?: number): void {
    this.db
      .prepare(
        "UPDATE judge_jobs SET state = 'done', verdict = ?, cost_usd = ?, duration_ms = ?, finished_at = datetime('now') WHERE task_id = ?",
      )
      .run(verdictJson, costUsd, durationMs ?? null, taskId);
  }

  failJudgeJob(taskId: string, error: string): void {
    this.db
      .prepare(
        "UPDATE judge_jobs SET state = 'failed', verdict = ?, finished_at = datetime('now') WHERE task_id = ?",
      )
      .run(JSON.stringify({ error }), taskId);
  }

  judgeJobForTask(
    taskId: string,
  ): {
    state: string;
    judgeMode: string | null;
    promptVersion: string | null;
    costUsd: number | null;
    durationMs: number | null;
  } | null {
    const r = this.db
      .prepare("SELECT state, judge_mode, prompt_version, cost_usd, duration_ms FROM judge_jobs WHERE task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      state: r.state as string,
      judgeMode: (r.judge_mode as string | null) ?? null,
      promptVersion: (r.prompt_version as string | null) ?? null,
      costUsd: (r.cost_usd as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
    };
  }

  judgeJobCount(taskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM judge_jobs WHERE task_id = ?").get(taskId) as { n: number }).n;
  }

  /** A transport drop (429/402/503): the job is closed as dropped, kept for
   *  the audit trail. Distinct from 'failed' — dropped means WE chose not to
   *  compete with the user's traffic, not that judging broke. */
  dropJudgeJob(taskId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE judge_jobs SET state = 'dropped', verdict = ?, finished_at = datetime('now') WHERE task_id = ?",
      )
      .run(JSON.stringify({ dropped: reason }), taskId);
  }

  /** Total judge spend on the books (done jobs only). Seeds the governor. */
  judgeSpendTotal(): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM judge_jobs WHERE state = 'done'")
      .get() as { s: number };
    return r.s;
  }

  recordJudgeReward(taskId: string, normalized: number): void {
    this.db.prepare("DELETE FROM rewards WHERE task_id = ? AND kind = 'judge'").run(taskId);
    this.db
      .prepare(
        `INSERT INTO rewards (id, task_id, event_id, kind, value, detail, created_at)
         VALUES (?, ?, NULL, 'judge', ?, 'trajectory_normalized', datetime('now'))`,
      )
      .run(`${taskId}-judge`, taskId, normalized);
  }

  judgeReward(taskId: string): number | null {
    const r = this.db
      .prepare("SELECT value FROM rewards WHERE task_id = ? AND kind = 'judge'")
      .get(taskId) as { value: number } | undefined;
    return r?.value ?? null;
  }

  // ── Report reads ───────────────────────────────────────────────────────

  taskSummaries(): { id: string; source: string; cwd: string | null; createdAt: string; totalReward: number | null }[] {
    const rows = this.db
      .prepare("SELECT id, source, cwd, created_at, total_reward FROM tasks ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      source: r.source as string,
      cwd: (r.cwd as string | null) ?? null,
      createdAt: r.created_at as string,
      totalReward: (r.total_reward as number | null) ?? null,
    }));
  }

  /** Tasks holding both a deterministic and a judge reward — the agreement dataset. */
  judgePairs(): { taskId: string; det: number; judge: number; mode: string | null; durationMs: number | null; costUsd: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS task_id, t.total_reward AS det, r.value AS judge,
                j.judge_mode AS mode, j.duration_ms AS duration_ms, j.cost_usd AS cost_usd
         FROM tasks t
         JOIN rewards r ON r.task_id = t.id AND r.kind = 'judge'
         LEFT JOIN judge_jobs j ON j.task_id = t.id
         WHERE t.total_reward IS NOT NULL`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      taskId: r.task_id as string,
      det: r.det as number,
      judge: r.judge as number,
      mode: (r.mode as string | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      costUsd: (r.cost_usd as number | null) ?? null,
    }));
  }

  /** Deterministic signal frequencies across all scored tasks. */
  signalFrequencies(): { key: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN instr(detail, ':') > 0 THEN substr(detail, 1, instr(detail, ':') - 1) ELSE detail END AS key,
                COUNT(*) AS count
         FROM rewards WHERE kind = 'deterministic' GROUP BY key ORDER BY count DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({ key: r.key as string, count: r.count as number }));
  }

  lessonSummaries(): { lesson: string; polarity: string | null; confidence: number; supportCount: number }[] {
    const rows = this.db
      .prepare("SELECT lesson, polarity, confidence, support_count FROM lessons ORDER BY confidence DESC, support_count DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      lesson: r.lesson as string,
      polarity: (r.polarity as string | null) ?? null,
      confidence: r.confidence as number,
      supportCount: r.support_count as number,
    }));
  }

  stats(): { tasks: number; events: number; lessons: number; rewards: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      tasks: one("SELECT COUNT(*) n FROM tasks"),
      events: one("SELECT COUNT(*) n FROM events"),
      lessons: one("SELECT COUNT(*) n FROM lessons"),
      rewards: one("SELECT COUNT(*) n FROM rewards"),
    };
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
