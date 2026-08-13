export type ServingBackfillCheckpoint = {
  lastSourceCreatedAt: string | null;
  lastSourceGeneratedSignalPairId: string | null;
};

export type ServingBackfillReceipt = {
  startedAt: string;
  updatedAt: string;
  batches: number;
  rowsProcessed: number;
  maxBatchLatencyMs: number;
  transportRecoveries: number;
  lastCheckpoint: ServingBackfillCheckpoint | null;
  terminal: boolean;
  transportPaused?: boolean;
};

export interface ServingBackfillPort {
  backfill(batchSize: number): Promise<number>;
  readCheckpoint(): Promise<ServingBackfillCheckpoint>;
  close(): Promise<void>;
}

export interface ServingBackfillReceiptStore {
  load(): ServingBackfillReceipt | null;
  save(receipt: ServingBackfillReceipt): void;
}

export type ServingBackfillRunnerOptions = {
  batchSize?: number;
  paceMs?: number;
  maxThrottleBackoffMs?: number;
  maxTransportRecoveries?: number;
  newPort: () => Promise<ServingBackfillPort>;
  store: ServingBackfillReceiptStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onEvent?: (event: "POOL_EXHAUSTED" | "RECOVERY_BACKOFF" | "CHECKPOINT_RECOVERED" | "BACKFILL_RESUMED") => void;
};

export type ServingBackfillResult = ServingBackfillReceipt & { terminalZeroConfirmed: boolean; transportPaused: boolean };

function sameCheckpoint(left: ServingBackfillCheckpoint | null, right: ServingBackfillCheckpoint | null): boolean {
  return left?.lastSourceCreatedAt === right?.lastSourceCreatedAt &&
    left?.lastSourceGeneratedSignalPairId === right?.lastSourceGeneratedSignalPairId;
}

export function classifyBackfillTransportError(error: unknown): "THROTTLE" | "POOL_EXHAUSTED" | "AMBIGUOUS" | "POSTGRES" {
  const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (/\b429\b|too many requests|throttl/.test(text)) return "THROTTLE";
  if (/echeckouttimeout|check out connection from the pool|session mode/.test(text)) return "POOL_EXHAUSTED";
  if (/timeout|timed out|authentication did not complete|failed to connect to database|disconnect|connection reset|connection terminated|econnreset|econnrefused|etimedout|network/.test(text)) return "AMBIGUOUS";
  return "POSTGRES";
}

const initialReceipt = (now: () => number): ServingBackfillReceipt => ({
  startedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
  batches: 0, rowsProcessed: 0, maxBatchLatencyMs: 0, transportRecoveries: 0,
  lastCheckpoint: null, terminal: false,
});

/** Sequential-only state machine. An ambiguous call is never replayed before its durable
 * cursor is re-read; a changed cursor proves the transaction committed and execution advances. */
export async function runCurrentServingBackfill(options: ServingBackfillRunnerOptions): Promise<ServingBackfillResult> {
  const batchSize = options.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("INVALID_BATCH_SIZE");
  const paceMs = options.paceMs ?? 250;
  const maxThrottleBackoffMs = options.maxThrottleBackoffMs ?? 10_000;
  const maxTransportRecoveries = options.maxTransportRecoveries ?? 8;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let receipt = options.store.load() ?? initialReceipt(now);
  let port = await options.newPort();
  let throttleDelayMs = 500;
  let consecutiveTransportFailures = 0;
  let shortBatchSeen = false;

  const save = (terminal = false, transportPaused = false) => {
    receipt = { ...receipt, updatedAt: new Date(now()).toISOString(), terminal, transportPaused, lastCheckpoint: receipt.lastCheckpoint };
    options.store.save(receipt);
  };
  const recover = async (before: ServingBackfillCheckpoint | null, firstKind: "THROTTLE" | "POOL_EXHAUSTED" | "AMBIGUOUS") => {
    let kind = firstKind;
    for (;;) {
      consecutiveTransportFailures += 1;
      receipt = { ...receipt, transportRecoveries: receipt.transportRecoveries + 1, lastCheckpoint: before };
      if (kind === "POOL_EXHAUSTED") options.onEvent?.("POOL_EXHAUSTED");
      if (consecutiveTransportFailures > maxTransportRecoveries) {
        save(false, true);
        return null;
      }
      await port.close();
      const backoffMs = Math.min(500 * 2 ** (consecutiveTransportFailures - 1), maxThrottleBackoffMs);
      const delayMs = backoffMs + Math.floor(random() * Math.max(1, Math.floor(backoffMs / 4)));
      options.onEvent?.("RECOVERY_BACKOFF");
      await sleep(delayMs);
      port = await options.newPort();
      try {
        const after = await port.readCheckpoint();
        receipt = { ...receipt, lastCheckpoint: after };
        save();
        consecutiveTransportFailures = 0;
        throttleDelayMs = 500;
        options.onEvent?.("CHECKPOINT_RECOVERED");
        options.onEvent?.("BACKFILL_RESUMED");
        // The next loop always starts from this durable cursor. Exact processed count
        // remains intentionally unknown after an ambiguous transport failure.
        return after;
      } catch (error) {
        const nextKind = classifyBackfillTransportError(error);
        if (nextKind === "POSTGRES") throw error;
        kind = nextKind;
      }
    }
  };

  try {
    for (;;) {
      let before: ServingBackfillCheckpoint;
      try {
        before = await port.readCheckpoint();
      } catch (error) {
        const kind = classifyBackfillTransportError(error);
        if (kind === "POSTGRES") throw error;
        if (await recover(receipt.lastCheckpoint, kind) === null) return { ...receipt, terminalZeroConfirmed: false, transportPaused: true };
        continue;
      }
      receipt = { ...receipt, lastCheckpoint: before };
      const started = now();
      let processed: number;
      try {
        processed = await port.backfill(batchSize);
      } catch (error) {
        const kind = classifyBackfillTransportError(error);
        if (kind === "POSTGRES") throw error;
        if (await recover(before, kind) === null) return { ...receipt, terminalZeroConfirmed: false, transportPaused: true };
        continue;
      }
      throttleDelayMs = 500;
      let checkpoint: ServingBackfillCheckpoint;
      try {
        checkpoint = await port.readCheckpoint();
      } catch (error) {
        const kind = classifyBackfillTransportError(error);
        if (kind === "POSTGRES") throw error;
        if (await recover(before, kind) === null) return { ...receipt, terminalZeroConfirmed: false, transportPaused: true };
        continue;
      }
      consecutiveTransportFailures = 0;
      receipt = {
        ...receipt,
        batches: receipt.batches + 1,
        rowsProcessed: receipt.rowsProcessed + processed,
        maxBatchLatencyMs: Math.max(receipt.maxBatchLatencyMs, now() - started),
        lastCheckpoint: checkpoint,
      };
      save();
      if (processed === 0 && shortBatchSeen) {
        save(true);
        return { ...receipt, terminalZeroConfirmed: true, transportPaused: false };
      }
      if (processed < batchSize) shortBatchSeen = true;
      await sleep(paceMs);
    }
  } finally {
    await port.close();
  }
}
