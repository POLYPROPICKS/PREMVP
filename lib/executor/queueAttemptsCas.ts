// lib/executor/queueAttemptsCas.ts
//
// Pure compare-and-set primitive for Queue row writes that must never erase
// diagnostics.execution_attempts_v1 (taker result, maker command, maker result).
//
// Every Queue status/diagnostics mutation on the live callback/execution path goes through
// casWriteQueue: fresh read -> compute -> CAS on updated_at (+ optional status guard). The
// execution_attempts_v1 key is ALWAYS taken from the fresh read unless the caller is itself
// the attempts writer (and then it supplies the new attempts explicitly). A stale snapshot
// held by a status writer therefore cannot remove or regress it.

import {
  EXECUTION_ATTEMPTS_KEY,
  mergeAttemptResult,
  readExecutionAttempts,
  type ExecutionAttemptsV1,
  type IrelandExecutionResult,
  type MakerFallbackCommand,
} from "./makerFallbackAuthorization";

export interface QueueCasRow {
  status: string | null;
  diagnostics: Record<string, unknown> | null;
  updated_at: string | null;
}

export interface QueueCasPort {
  read(queueId: string): Promise<QueueCasRow | null>;
  /** Writes only if the stored updated_at still equals expectedUpdatedAt. Returns the written row, or null on a lost race. */
  compareAndSet(
    queueId: string,
    expectedUpdatedAt: string | null,
    columns: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
}

export interface QueueCasPlan {
  status?: string;
  /** Additional independent columns to write (e.g. selection_reason). */
  extra?: Record<string, unknown>;
  /** Diagnostics the caller wants (may derive from a stale snapshot; attempts are overridden below). */
  diagnostics: Record<string, unknown>;
  /** Attempts writer only: the new attempts object. Omit to preserve the fresh one. */
  attempts?: ExecutionAttemptsV1;
}

export type QueueCasResult =
  | { written: true; row: Record<string, unknown> }
  | { written: false; reason: "NOOP" | "NOT_FOUND" };

export const QUEUE_CAS_MAX_RETRIES = 6;

export async function casWriteQueue(
  port: QueueCasPort,
  queueId: string,
  compute: (fresh: QueueCasRow) => QueueCasPlan | null,
  now: () => Date = () => new Date(),
): Promise<QueueCasResult> {
  for (let i = 0; i < QUEUE_CAS_MAX_RETRIES; i++) {
    const fresh = await port.read(queueId);
    if (!fresh) return { written: false, reason: "NOT_FOUND" };
    const plan = compute(fresh);
    if (plan === null) return { written: false, reason: "NOOP" };
    const diagnostics: Record<string, unknown> = { ...plan.diagnostics };
    const attempts = plan.attempts ?? (fresh.diagnostics?.[EXECUTION_ATTEMPTS_KEY] as ExecutionAttemptsV1 | undefined);
    if (attempts === undefined) delete diagnostics[EXECUTION_ATTEMPTS_KEY];
    else diagnostics[EXECUTION_ATTEMPTS_KEY] = attempts;
    const columns: Record<string, unknown> = {
      ...(plan.extra ?? {}),
      diagnostics,
      updated_at: now().toISOString(),
    };
    if (plan.status !== undefined) columns.status = plan.status;
    const row = await port.compareAndSet(queueId, fresh.updated_at, columns);
    if (row) return { written: true, row };
  }
  throw new Error("QUEUE_CAS_EXHAUSTED");
}

/** Monotonic result record (a recorded positive fill is never replaced by a smaller one). */
export async function recordAttemptResultCas(
  port: QueueCasPort,
  queueId: string,
  slot: "taker_attempt_1" | "maker_fallback_1",
  result: IrelandExecutionResult,
): Promise<void> {
  await casWriteQueue(port, queueId, (fresh) => {
    const a = readExecutionAttempts(fresh.diagnostics);
    const merged = mergeAttemptResult(a[slot]?.result, result);
    return merged === a[slot]?.result ? null : { diagnostics: fresh.diagnostics ?? {}, attempts: { ...a, [slot]: { ...(a[slot] ?? {}), result: merged } } };
  });
}

/** Single-winner maker command claim: false for every replay / concurrent loser. */
export async function claimMakerCommandCas(port: QueueCasPort, queueId: string, command: MakerFallbackCommand): Promise<boolean> {
  const res = await casWriteQueue(port, queueId, (fresh) => {
    const a = readExecutionAttempts(fresh.diagnostics);
    if (a.maker_fallback_1?.command) return null;
    return { diagnostics: fresh.diagnostics ?? {}, attempts: { ...a, maker_fallback_1: { ...(a.maker_fallback_1 ?? {}), command } } };
  });
  return res.written;
}
