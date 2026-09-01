// Conformance: the executable spec of docs/PROTOCOL.md, and the integration
// contract with unbiased-app. It spawns the REAL sidecar process and drives
// it over real stdio pipes — if this suite is green, a client that does what
// it does (which is what the app's LearningClient will do) works. Mirrors
// the conformance/ pattern in unbiased-app-engine.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTrajectory } from "../src/synth/generator.ts";

const dbPath = join(mkdtempSync(join(tmpdir(), "learning-conformance-")), "learning.db");
const proc = spawn(process.execPath, ["--import", "tsx", "src/adapters/stdio.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 1;
createInterface({ input: proc.stdout }).on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number | null };
  if (typeof msg.id === "number" && pending.has(msg.id)) {
    pending.get(msg.id)!(msg as Record<string, unknown>);
    pending.delete(msg.id);
  } else if (msg.id === null) {
    parseErrorResponse = msg as Record<string, unknown>;
  }
});
let parseErrorResponse: Record<string, unknown> | null = null;

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ method, id, params }) + "\n");
  });
}
function notify(method: string, params?: unknown): void {
  proc.stdin.write(JSON.stringify({ method, params }) + "\n");
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const res = (m: Record<string, unknown>) => m.result as Record<string, unknown>;
const errCode = (m: Record<string, unknown>) => (m.error as { code: number } | undefined)?.code;

// 1. The handshake gate.
const early = await request("stats/get");
check("request before initialize refused with -32002", errCode(early) === -32002);

const init = await request("learning/initialize", {
  protocolVersion: 1,
  clientInfo: { name: "conformance", version: "0" },
  dbPath,
  judge: { mode: "mock", enabled: true, maxInFlight: 1, onlyWhenIdle: true, monthlyBudgetUsd: 1 },
});
check("initialize returns protocolVersion 1", res(init)?.protocolVersion === 1);

// 2. Ingestion, acks, idempotency.
const t = generateTrajectory("focused-fix-success", 42);
const batch = await request("event/batchAppend", { events: t.events });
check("batchAppend accepts a full trajectory", res(batch)?.accepted === t.events.length && res(batch)?.dropped === 0);
const again = await request("event/batchAppend", { events: t.events });
check("replaying the same batch is idempotent, not an error", res(again)?.accepted === t.events.length);
const one = await request("event/append", generateTrajectory("flailing-loop", 42).events[0]);
check("event/append acks a single event", res(one)?.accepted === true);
const bad = await request("event/append", { nonsense: true });
check("an invalid event is refused with a reason", res(bad)?.accepted === false && res(bad)?.reason === "invalid");

// 3. The sidecar's reflexes: turn_completed triggered scoring + distillation.
const stats = await request("stats/get");
check("turn_completed auto-scored the task", (res(stats)?.rewards as number) > 0);
check("template lessons distilled without being asked", (res(stats)?.lessons as number) > 0);

// 4. Retrieval + the audit trail.
const q = await request("lessons/query", { taskText: "fix the failing test", cwd: t.task.cwd, limit: 3 });
const lessons = res(q)?.lessons as { id: string }[];
check("lessons/query returns ranked lessons", Array.isArray(lessons) && lessons.length > 0);
notify("lessons/used", { lessonIds: [lessons[0]!.id], taskId: t.task.id, turnId: "turn-x" });

// The other half of the loop: the user rejected what a lesson became, so the
// lesson loses confidence. A stale id is a result, not a protocol violation.
const refuted = await request("lessons/refute", { lessonId: lessons[0]!.id, reason: "user deleted the memory" });
check(
  "lessons/refute lowers confidence",
  res(refuted)?.ok === true && (res(refuted)?.confidence as number) > 0,
);
const bogus = await request("lessons/refute", { lessonId: "no-such-lesson" });
check(
  "refuting an unknown lesson is a result, not an error",
  res(bogus)?.ok === false && res(bogus)?.reason === "unknown_lesson",
);

// 5. The governed judge.
const refused = await request("judge/run", { taskId: t.task.id });
check("judge/run refused while not idle", res(refused)?.ok === false && res(refused)?.reason === "not_idle");
notify("health/idle", { idle: true });
const judged = await request("judge/run", { taskId: t.task.id });
check("judge/run admitted after health/idle", res(judged)?.ok === true);

// 6. Observability + error surfaces.
const health = await request("health/get");
check("health/get reports the judge posture", (res(health)?.judge as { mode: string })?.mode === "mock");
const queue = await request("queue/status");
check("queue/status reports capacity honestly", typeof res(queue)?.capacity === "number" && res(queue)?.dropping === false);
const unknown = await request("no/such-method");
check("unknown method → -32601", errCode(unknown) === -32601);
proc.stdin.write("{this is not json\n");
await new Promise((r) => setTimeout(r, 300));
check("unparseable line → -32700 with null id", parseErrorResponse !== null && errCode(parseErrorResponse!) === -32700);

// 7. Clean shutdown on EOF.
proc.stdin.end();
const exitCode: number | null = await new Promise((r) => proc.on("exit", (code) => r(code)));
check("stdin EOF exits 0", exitCode === 0);

console.log(failures === 0 ? "\nconformance: all green" : `\nconformance: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
