// The judge governor: every rule the gateway exploration made non-negotiable,
// in one place, enforced BEFORE a request exists.
//
//  - disabled by default: paid judging is opt-in, never ambient
//  - one in flight: the per-org concurrency gauge (10 slots, 1 at low
//    balance) is shared with the user's interactive turns — a background
//    judge must never 429 the user's own chat
//  - only when idle: idleness is REPORTED by the client (health/idle);
//    unknown means busy
//  - hard budget: prior spend (from the store) plus session spend, refused
//    at the ceiling, no grace
//  - 402 suspends until a human re-enables: an empty wallet is not a
//    condition to poll
import type { Store } from "../store/db.ts";
import type { JudgeBackend } from "./backend.ts";
import { runJudge, type JudgeResult } from "./judge.ts";
import { JudgeTransportError } from "./pareto.ts";

export type AdmitRefusal = "disabled" | "not_idle" | "busy" | "budget_exhausted" | "payment_required";
export type Admit = { ok: true } | { ok: false; reason: AdmitRefusal };

export type GovernorConfig = {
  enabled?: boolean;
  maxInFlight?: number;
  onlyWhenIdle?: boolean;
  budgetUsd: number;
  /** Spend already on the books (seed from store.judgeSpendTotal()). */
  spentUsd: number;
};

export class JudgeGovernor {
  private readonly enabled: boolean;
  private readonly maxInFlight: number;
  private readonly onlyWhenIdle: boolean;
  private readonly budgetUsd: number;
  private spentUsd: number;
  private idle = false;
  private inFlight = 0;
  private suspended = false;

  constructor(cfg: GovernorConfig) {
    this.enabled = cfg.enabled ?? false;
    this.maxInFlight = cfg.maxInFlight ?? 1;
    this.onlyWhenIdle = cfg.onlyWhenIdle ?? true;
    this.budgetUsd = cfg.budgetUsd;
    this.spentUsd = cfg.spentUsd;
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  addSpend(usd: number): void {
    this.spentUsd += usd;
  }

  /** A 402 was seen: refuse everything until a human re-enables. */
  notePayment(): void {
    this.suspended = true;
  }

  spent(): number {
    return this.spentUsd;
  }

  admit(): Admit {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    if (this.suspended) return { ok: false, reason: "payment_required" };
    if (this.spentUsd >= this.budgetUsd) return { ok: false, reason: "budget_exhausted" };
    if (this.onlyWhenIdle && !this.idle) return { ok: false, reason: "not_idle" };
    if (this.inFlight >= this.maxInFlight) return { ok: false, reason: "busy" };
    this.inFlight++;
    return { ok: true };
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export type GatedResult = { ok: true; result: JudgeResult } | { ok: false; reason: AdmitRefusal | string };

/** The only sanctioned way to run a paid judge. Refusals return, drops mark
 *  the job dropped — nothing here throws for expected outcomes, and the
 *  in-flight slot is always released. */
export async function runJudgeGated(
  store: Store,
  taskId: string,
  backend: JudgeBackend,
  governor: JudgeGovernor,
): Promise<GatedResult> {
  const admit = governor.admit();
  if (!admit.ok) return { ok: false, reason: admit.reason };
  try {
    const result = await runJudge(store, taskId, backend);
    governor.addSpend(result.costUsd);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof JudgeTransportError) {
      // Drop, never retry: 429/503 mean the gateway is protecting the user's
      // own traffic; 402 additionally suspends paid judging entirely.
      store.dropJudgeJob(taskId, err.kind);
      if (err.kind === "payment") governor.notePayment();
      return { ok: false, reason: err.kind };
    }
    // runJudge already marked the job failed for non-transport errors.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    governor.release();
  }
}
