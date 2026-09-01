import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningServer } from "./stdio.ts";
import { generateTrajectory } from "../synth/generator.ts";

type Resp = { id?: number | null; result?: Record<string, unknown>; error?: { code: number; message: string } };

async function send(server: LearningServer, msg: unknown): Promise<Resp | null> {
  const out = await server.handleLine(JSON.stringify(msg));
  return out === null ? null : (JSON.parse(out) as Resp);
}

const INIT = {
  method: "learning/initialize",
  id: 1,
  params: {
    protocolVersion: 1,
    clientInfo: { name: "conformance", version: "0" },
    dbPath: ":memory:",
    judge: { mode: "mock", enabled: true, maxInFlight: 1, onlyWhenIdle: true, monthlyBudgetUsd: 1 },
  },
};

async function initialized(): Promise<LearningServer> {
  const s = new LearningServer();
  await send(s, INIT);
  return s;
}

test("any request before initialize is refused with -32002", async () => {
  const s = new LearningServer();
  const r = await send(s, { method: "stats/get", id: 5 });
  assert.equal(r!.error!.code, -32002);
});

test("initialize handshakes with matching protocol version; a mismatch is an error, not a downgrade", async () => {
  const s = new LearningServer();
  const r = await send(s, INIT);
  assert.equal((r!.result as { protocolVersion: number }).protocolVersion, 1);
  const s2 = new LearningServer();
  const bad = await send(s2, { ...INIT, params: { ...INIT.params, protocolVersion: 99 } });
  assert.ok(bad!.error);
});

test("event/append acks a valid event and refuses an invalid one with the reason", async () => {
  const s = await initialized();
  const ev = generateTrajectory("focused-fix-success", 1).events[0]!;
  const ok = await send(s, { method: "event/append", id: 2, params: ev });
  assert.deepEqual(ok!.result, { accepted: true });
  const bad = await send(s, { method: "event/append", id: 3, params: { ...ev, kind: "telepathy" } });
  assert.equal((bad!.result as { accepted: boolean }).accepted, false);
  assert.match(String((bad!.result as { detail?: string }).detail), /kind/);
});

test("event/batchAppend reports partial acceptance and preserves order", async () => {
  const s = await initialized();
  const t = generateTrajectory("focused-fix-success", 2);
  const events = [...t.events.slice(0, 3), { ...t.events[3]!, kind: "nope" }];
  const r = await send(s, { method: "event/batchAppend", id: 4, params: { events } });
  assert.deepEqual(r!.result, { accepted: 3, dropped: 1, reasons: [(r!.result as { reasons: string[] }).reasons[0]] });
});

test("a turn_completed in the stream triggers scoring and distillation on its own", async () => {
  const s = await initialized();
  const t = generateTrajectory("focused-fix-success", 3);
  await send(s, { method: "event/batchAppend", id: 5, params: { events: t.events } });
  const stats = await send(s, { method: "stats/get", id: 6 });
  const st = stats!.result as { rewards: number; lessons: number };
  assert.ok(st.rewards > 0, "deterministic score must be recorded");
  assert.ok(st.lessons > 0, "template lessons must be distilled");
  const q = await send(s, { method: "lessons/query", id: 7, params: { taskText: "fix the failing test", limit: 3 } });
  assert.ok((q!.result as { lessons: unknown[] }).lessons.length > 0);
});

test("lessons/used is a notification (no reply) and records + resolves through the audit trail", async () => {
  const s = await initialized();
  const t = generateTrajectory("focused-fix-success", 4);
  await send(s, { method: "event/batchAppend", id: 8, params: { events: t.events.slice(0, 3) } });
  const none = await send(s, {
    method: "lessons/used",
    params: { lessonIds: ["l-x"], taskId: t.task.id, turnId: "turn-1" },
  });
  assert.equal(none, null);
  assert.equal(s.store!.usageForTask(t.task.id)[0]!.outcome, null);
  await send(s, { method: "event/batchAppend", id: 9, params: { events: t.events.slice(3) } });
  // The CLASSIFIED outcome, not the raw turn status: what a lesson is judged
  // by has to account for the user interrupting or refusing, which a status of
  // "completed" cannot express.
  assert.equal(s.store!.usageForTask(t.task.id)[0]!.outcome, "positive");
});

test("judge/run is governed: refused while busy, admitted after health/idle says idle", async () => {
  const s = await initialized();
  const t = generateTrajectory("focused-fix-success", 5);
  await send(s, { method: "event/batchAppend", id: 10, params: { events: t.events } });
  const refused = await send(s, { method: "judge/run", id: 11, params: { taskId: t.task.id } });
  assert.deepEqual(refused!.result, { ok: false, reason: "not_idle" });
  await send(s, { method: "health/idle", params: { idle: true } });
  const admitted = await send(s, { method: "judge/run", id: 12, params: { taskId: t.task.id } });
  assert.equal((admitted!.result as { ok: boolean }).ok, true);
});

test("health/get and queue/status report the world honestly", async () => {
  const s = await initialized();
  const h = (await send(s, { method: "health/get", id: 13 }))!.result as Record<string, unknown>;
  assert.equal(h.ok, true);
  assert.equal((h.judge as { mode: string }).mode, "mock");
  const q = (await send(s, { method: "queue/status", id: 14 }))!.result as Record<string, unknown>;
  assert.equal(typeof q.capacity, "number");
  assert.equal(q.dropping, false);
});

test("unknown method → -32601; unparseable line → -32700 with null id; a stray notification is ignored", async () => {
  const s = await initialized();
  assert.equal((await send(s, { method: "does/not-exist", id: 15 }))!.error!.code, -32601);
  const garbage = JSON.parse((await s.handleLine("{not json"))!) as Resp;
  assert.equal(garbage.error!.code, -32700);
  assert.equal(garbage.id, null);
  assert.equal(await s.handleLine(JSON.stringify({ method: "does/not-exist" })), null);
});
