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
  newPort: () => Promise<ServingBackfillPort>;
  store: ServingBackfillReceiptStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type ServingBackfillResult = ServingBackfillReceipt & { terminalZeroConfirmed: boolean };

function sameCheckpoint(left: ServingBackfillCheckpoint | null, right: ServingBackfillCheckpoint | null): boolean {
  return left?.lastSourceCreatedAt === right?.lastSourceCreatedAt &&
    left?.lastSourceGeneratedSignalPairId === right?.lastSourceGeneratedSignalPairId;
}

export function classifyBackfillTransportError(error: unknown): "THROTTLE" | "AMBIGUOUS" | "POSTGRES" {
  const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (/\b429\b|too many requests|throttl/.test(text)) return "THROTTLE";
  if (/timeout|timed out|disconnect|connection reset|connection terminated|econnreset|econnrefused|etimedout|network/.test(text)) return "AMBIGUOUS";
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
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let receipt = options.store.load() ?? initialReceipt(now);
  let port = await options.newPort();
  let throttleDelayMs = 500;
  let shortBatchSeen = false;

  const save = (terminal = false) => {
    receipt = { ...receipt, updatedAt: new Date(now()).toISOString(), terminal, lastCheckpoint: receipt.lastCheckpoint };
    options.store.save(receipt);
  };
  const recover = async (before: ServingBackfillCheckpoint | null, kind: "THROTTLE" | "AMBIGUOUS") => {
    await port.close();
    if (kind === "THROTTLE") {
      await sleep(throttleDelayMs);
      throttleDelayMs = Math.min(throttleDelayMs * 2, maxThrottleBackoffMs);
    }
    port = await options.newPort();
    const after = await port.readCheckpoint();
    receipt = { ...receipt, transportRecoveries: receipt.transportRecoveries + 1, lastCheckpoint: after };
    save();
    // A changed durable cursor proves a committed batch. Do not replay it; the next loop
    // starts from that cursor. The exact count is intentionally not fabricated.
    return !sameCheckpoint(before, after);
  };

  try {
    for (;;) {
      const before = await port.readCheckpoint();
      receipt = { ...receipt, lastCheckpoint: before };
      const started = now();
      let processed: number;
      try {
        processed = await port.backfill(batchSize);
      } catch (error) {
        const kind = classifyBackfillTransportError(error);
        if (kind === "POSTGRES") throw error;
        await recover(before, kind);
        continue;
      }
      throttleDelayMs = 500;
      const checkpoint = await port.readCheckpoint();
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
        return { ...receipt, terminalZeroConfirmed: true };
      }
      if (processed < batchSize) shortBatchSeen = true;
      await sleep(paceMs);
    }
  } finally {
    await port.close();
  }
}
