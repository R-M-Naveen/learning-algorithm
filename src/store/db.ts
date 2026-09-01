// SQLite store on node:sqlite — zero native deps, FTS5 available (verified
// on the dev machine and required by the Electron 43 packaging spike before
// app integration). One writer, WAL, write-then-commit discipline.
import { DatabaseSync } from "node:sqlite";
import { validateEvent, type LearningEvent } from "../core/events.ts";
import { reinforce, rankLessons, type CandidateLesson, type RankedLesson } from "../core/lessons.ts";
import { MIN_RETRIEVAL_CONFIDENCE, refute } from "../core/lessons.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  cwd         TEXT,
  project_key TEXT,                   -- client-supplied, stable across worktrees
  source      TEXT NOT NULL,
  task_type   TEXT,
  outcome     TEXT,
  total_reward REAL
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
  outcome    TEXT                   -- filled in when the turn/task resolves
);
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
  recordScore(taskId: string, score: { total: number; raw: number; signals: { key: string; value: number; detail?: string }[] }): void {
    this.db.prepare("DELETE FROM rewards WHERE task_id = ? AND kind = 'deterministic'").run(taskId);
    const insert = this.db.prepare(
      `INSERT INTO rewards (id, task_id, event_id, kind, value, detail, created_at)
       VALUES (?, ?, NULL, 'deterministic', ?, ?, datetime('now'))`,
    );
    score.signals.forEach((s, i) => {
      insert.run(`${taskId}-det-${i}`, taskId, s.value, s.detail ? `${s.key}: ${s.detail}` : s.key);
    });
    this.db.prepare("UPDATE tasks SET total_reward = ? WHERE id = ?").run(score.total, taskId);
  }

  /** The scope a task's lessons belong to, as the client declared it. */
  taskProjectKey(taskId: string): string | null {
    const row = this.db.prepare("SELECT project_key FROM tasks WHERE id = ?").get(taskId) as
      | { project_key: string | null }
      | undefined;
    return row?.project_key ?? null;
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

  /** The audit half of injection: which lessons rode which task. */
  recordLessonUse(lessonIds: string[], taskId: string, turnId?: string | null): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO lesson_usage (id, lesson_id, task_id, turn_id, at, outcome)
       VALUES (?, ?, ?, ?, datetime('now'), NULL)`,
    );
    for (const lessonId of lessonIds) {
      insert.run(`${taskId}:${lessonId}`, lessonId, taskId, turnId ?? null);
      this.db.prepare("UPDATE lessons SET last_used_at = datetime('now') WHERE id = ?").run(lessonId);
    }
  }

  resolveLessonUse(taskId: string, outcome: string): void {
    this.db.prepare("UPDATE lesson_usage SET outcome = ? WHERE task_id = ? AND outcome IS NULL").run(outcome, taskId);
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
