#!/usr/bin/env tsx
/**
 * Production-only, resumable runner for the SQL-owned current-serving backfill.
 * It deliberately uses a direct PostgreSQL session (DATABASE_URL by default), never
 * PostgREST/Supabase MCP. Receipts contain progress only; credentials are never logged.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  runCurrentServingBackfill,
  type ServingBackfillCheckpoint,
  type ServingBackfillPort,
  type ServingBackfillReceipt,
} from "../lib/operations/currentServingBackfillRunner";

type SqlClient = ReturnType<typeof postgres>;
type CancellableQuery<T> = PromiseLike<T> & { cancel(): void };
type Verification = {
  final_checkpoint: ServingBackfillCheckpoint;
  final_serving_rows: number;
  final_historical_rows: number;
  historical_orphans: number;
  semantic_mismatches: number;
  planning_latency_ms: number;
  planning_57014_count: number;
};

function numberValue(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("INVALID_DATABASE_NUMERIC_RESULT");
  return number;
}

function readArgs(argv: readonly string[]) {
  const at = argv.indexOf("--connection-env");
  return { connectionEnv: at >= 0 ? argv[at + 1] : "DATABASE_URL" };
}

const QUERY_TIMEOUT_MS = 45_000;
const HEARTBEAT_MS = 15_000;

/**
 * postgres.js has a connection timeout but deliberately no per-query deadline.
 * This runner must never wait silently on a production call: emit a heartbeat,
 * cancel at the operational bound, then let the durable-cursor state machine
 * decide whether a timed-out backfill transaction committed.
 */
async function runBoundedQuery<T>(label: string, query: CancellableQuery<T>): Promise<T> {
  const started = Date.now();
  console.log(JSON.stringify({ runner_event: "QUERY_STARTED", label }));
  const heartbeat = setInterval(() => {
    console.log(JSON.stringify({ runner_event: "QUERY_HEARTBEAT", label, elapsed_ms: Date.now() - started }));
  }, HEARTBEAT_MS);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(query),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          query.cancel();
          reject(new Error(`RUNNER_QUERY_TIMEOUT:${label}:${QUERY_TIMEOUT_MS}`));
        }, QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

function receiptStore(file: string) {
  return {
    load(): ServingBackfillReceipt | null {
      if (!fs.existsSync(file)) return null;
      try { return JSON.parse(fs.readFileSync(file, "utf8")) as ServingBackfillReceipt; } catch { return null; }
    },
    save(receipt: ServingBackfillReceipt) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    },
  };
}

function createPort(connection: string): Promise<ServingBackfillPort> {
  const sql = postgres(connection, { max: 1, connect_timeout: 20, idle_timeout: 30 });
  return Promise.resolve({
    async backfill(batchSize) {
      const rows = await runBoundedQuery("BACKFILL_CALL", sql<{ processed: number }[]>`select public.backfill_current_signal_pair_serving(${batchSize}) as processed`);
      return numberValue(rows[0]?.processed);
    },
    async readCheckpoint() {
      const rows = await runBoundedQuery("CHECKPOINT_READ", sql<{ last_source_created_at: string | null; last_source_generated_signal_pair_id: string | null }[]>`
        select last_source_created_at::text, last_source_generated_signal_pair_id::text
        from public.current_signal_pair_serving_backfill_checkpoint
        where checkpoint_name = 'generated_signal_pairs_v1'`);
      if (rows.length !== 1) throw new Error("BACKFILL_CHECKPOINT_MISSING");
      return { lastSourceCreatedAt: rows[0].last_source_created_at, lastSourceGeneratedSignalPairId: rows[0].last_source_generated_signal_pair_id };
    },
    async close() { await sql.end({ timeout: 5 }); },
  });
}

async function verifyTerminal(connection: string): Promise<Verification> {
  const sql = postgres(connection, { max: 1, connect_timeout: 20, idle_timeout: 30 });
  try {
    const [checkpoint] = await sql<{ last_source_created_at: string | null; last_source_generated_signal_pair_id: string | null }[]>`
      select last_source_created_at::text, last_source_generated_signal_pair_id::text
      from public.current_signal_pair_serving_backfill_checkpoint where checkpoint_name = 'generated_signal_pairs_v1'`;
    if (!checkpoint) throw new Error("BACKFILL_CHECKPOINT_MISSING");
    const [counts] = await sql<{ serving_rows: number; historical_rows: number; historical_orphans: number }[]>`
      select
        (select count(*) from public.current_signal_pair_serving) as serving_rows,
        (select count(*) from public.generated_signal_pairs) as historical_rows,
        (select count(*) from public.current_signal_pair_serving s left join public.generated_signal_pairs h on h.id = s.source_generated_signal_pair_id where h.id is null) as historical_orphans`;
    const [semantic] = await sql<{ mismatches: number }[]>`
      with expected as (
        select distinct on (source.condition_id, source.selected_token_id, source.metric_formula_version)
          source.id, source.condition_id, source.selected_token_id, source.metric_formula_version
        from public.generated_signal_pairs source
        where source.condition_id is not null and source.selected_token_id is not null and source.metric_formula_version is not null
          and source.expires_at > now() and source.signal_result is null
        order by source.condition_id, source.selected_token_id, source.metric_formula_version, source.created_at desc, source.id desc
      )
      select count(*) as mismatches from (
        select e.id from expected e left join public.current_signal_pair_serving s on s.condition_id = e.condition_id and s.selected_token_id = e.selected_token_id and s.metric_formula_version = e.metric_formula_version where s.source_generated_signal_pair_id is distinct from e.id
        union all
        select s.source_generated_signal_pair_id from public.current_signal_pair_serving s left join expected e on e.id = s.source_generated_signal_pair_id where e.id is null
      ) mismatch`;
    const started = Date.now();
    await sql`select source_generated_signal_pair_id from public.current_signal_pair_serving where projection_status = 'ACTIVE' and signal_result is null and expires_at > now() and selected_token_id is not null and condition_id is not null and entry_price_num is not null and signal_confidence_num >= 50 order by source_created_at desc, source_generated_signal_pair_id desc limit 10000`;
    await sql`select source_generated_signal_pair_id from public.current_signal_pair_serving where projection_status = 'ACTIVE' and metric_formula_version = 'shadow-strategic-sports-v1' and signal_result is null and expires_at > now() and selected_token_id is not null and condition_id is not null and signal_confidence_num is null order by source_created_at desc, source_generated_signal_pair_id desc limit 10000`;
    return { final_checkpoint: { lastSourceCreatedAt: checkpoint.last_source_created_at, lastSourceGeneratedSignalPairId: checkpoint.last_source_generated_signal_pair_id }, final_serving_rows: numberValue(counts.serving_rows), final_historical_rows: numberValue(counts.historical_rows), historical_orphans: numberValue(counts.historical_orphans), semantic_mismatches: numberValue(semantic.mismatches), planning_latency_ms: Date.now() - started, planning_57014_count: 0 };
  } finally { await sql.end({ timeout: 5 }); }
}

async function main() {
  const { connectionEnv } = readArgs(process.argv.slice(2));
  const connection = process.env[connectionEnv];
  if (!connection) throw new Error(`MISSING_REQUIRED_SERVER_SIDE_CONNECTION_ENV:${connectionEnv}`);
  const receiptFile = path.join(process.cwd(), "var", "current-serving-backfill", "receipt.json");
  console.log(JSON.stringify({ runner_event: "RUNNER_STARTED", query_timeout_ms: QUERY_TIMEOUT_MS, heartbeat_ms: HEARTBEAT_MS }));
  const result = await runCurrentServingBackfill({
    newPort: () => createPort(connection),
    store: receiptStore(receiptFile),
    onEvent: (runner_event) => console.log(JSON.stringify({ runner_event })),
  });
  if (result.transportPaused) {
    console.log(JSON.stringify({
      TRANSPORT_PAUSE: "YES",
      UNKNOWN_COMMIT_STATE: "NO",
      TRANSPORT_RECOVERIES: result.transportRecoveries,
      checkpoint: result.lastCheckpoint,
      receipt_file: "var/current-serving-backfill/receipt.json",
      verdict: "WAIT",
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const verification = await verifyTerminal(connection);
  const pass = result.terminalZeroConfirmed && verification.historical_orphans === 0 && verification.semantic_mismatches === 0 && verification.planning_57014_count === 0;
  console.log(JSON.stringify({
    BACKFILL_TERMINAL: result.terminalZeroConfirmed ? "YES" : "NO",
    UNKNOWN_COMMIT_STATE: "NO",
    SEMANTIC_EQUALITY: verification.semantic_mismatches === 0 ? "PASS" : "FAIL",
    CONTRACT_A_PLANNING_PRODUCTION: verification.planning_57014_count === 0 ? "PASS" : "FAIL",
    PLANNING_57014_COUNT: verification.planning_57014_count,
    HISTORICAL_CORPUS_PRESERVED: verification.historical_orphans === 0 ? "YES" : "NO",
    TOTAL_ROWS_PROCESSED: result.rowsProcessed,
    TOTAL_BATCHES: result.batches,
    MAX_BATCH_LATENCY: result.maxBatchLatencyMs,
    TRANSPORT_RECOVERIES: result.transportRecoveries,
    ...verification,
    receipt_file: "var/current-serving-backfill/receipt.json",
    verdict: pass ? "PASS" : "FAIL",
  }, null, 2));
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => { console.error(JSON.stringify({ verdict: "FAIL", reason: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
