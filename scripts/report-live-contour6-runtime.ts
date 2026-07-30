// scripts/report-live-contour6-runtime.ts
//
// Read-only Live Contour 6 runtime proof. Prints ONE JSON object to stdout and
// writes no file anywhere.
//
//   npx tsx scripts/report-live-contour6-runtime.ts \
//     --since 2026-07-30T10:26:00Z \
//     --historical-queue-id 669eef5c-ae62-40cf-8d42-2d52298cb585 \
//     --historical-reservation-id 97e7766c-75d4-4d52-9894-196e1f334d22 \
//     --historical-event-start 2026-07-27T22:40:00Z
//
// Every database call is a bounded .select(...). There is no mutation path, no
// planning or rebalance entry point, no order path, and no external HTTP call in
// this file or in the pure analyzer it delegates to.
//
// All proof logic lives in lib/executor/liveContour6RuntimeProof.ts so it is
// unit-tested against production-shaped fixtures; this file only resolves
// arguments, runs bounded reads, and prints the analyzer's verdict.
//
// Exit codes: 0 = a report was produced (including WAIT and FAIL verdicts),
//             1 = invalid arguments, absent credentials, or a read failure.

import { loadEnvConfig } from "@next/env";

import {
  ANALYZER_VERSION,
  analyzeLiveContour6Runtime,
  normalizeInstantMs,
  type LiveContour6ProofInput,
  type ProofQueueRow,
  type ProofReservationRow,
} from "../lib/executor/liveContour6RuntimeProof";

const REPORT_VERSION = "lc6-runtime-report-v1";
const RESERVATION_TABLE = "night_event_reservations";
const QUEUE_TABLE = "event_execution_queue";

const RESERVATION_FIELDS =
  "id,physical_event_id,event_start_iso,plan_run_id,match_family_key,status,created_at,updated_at";
// event_execution_queue has no event_start_iso column (LC6 did not alter the
// Queue); game_start_iso is its occurrence-start equivalent.
const QUEUE_FIELDS =
  "id,reservation_id,selection_rank,game_start_iso,status,plan_run_id,match_family_key,condition_id,token_id,side,created_at,updated_at";

const ROW_CAP = 500;

const REQUIRED_ARGS = [
  "since",
  "historical-queue-id",
  "historical-reservation-id",
  "historical-event-start",
] as const;

type RequiredArg = (typeof REQUIRED_ARGS)[number];

interface Args {
  since: string;
  historicalQueueId: string;
  historicalReservationId: string;
  historicalEventStart: string;
}

function fail(message: string): never {
  console.error(`[lc6-runtime-report] ${message}`);
  process.exit(1);
}

function logReadFailure(operation: string, table: string, error: { code?: string; message?: string }): never {
  // Safe context only: operation, table, error code, error message. Never any
  // environment value, token, key, URL or unrelated row content.
  console.error(
    `[lc6-runtime-report] read failure operation=${operation} table=${table} ` +
      `code=${error.code ?? "unknown"} message=${error.message ?? "unknown"}`
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected positional argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`missing value for --${key}`);
      value = next;
      i += 1;
    }
    if (!(REQUIRED_ARGS as readonly string[]).includes(key)) fail(`unknown argument: --${key}`);
    if (raw.has(key)) fail(`duplicate argument: --${key}`);
    raw.set(key, value);
  }

  for (const name of REQUIRED_ARGS) {
    const value = raw.get(name);
    if (value === undefined || value.trim() === "") fail(`missing required argument: --${name}`);
  }

  const get = (name: RequiredArg): string => (raw.get(name) as string).trim();

  const since = get("since");
  if (normalizeInstantMs(since) === null) fail(`--since must be a valid ISO instant, got: ${since}`);
  const historicalEventStart = get("historical-event-start");
  if (normalizeInstantMs(historicalEventStart) === null) {
    fail(`--historical-event-start must be a valid ISO instant, got: ${historicalEventStart}`);
  }

  return {
    since,
    historicalQueueId: get("historical-queue-id"),
    historicalReservationId: get("historical-reservation-id"),
    historicalEventStart,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toReservation(row: Record<string, unknown>): ProofReservationRow {
  return {
    id: String(row.id ?? ""),
    physical_event_id: text(row.physical_event_id),
    event_start_iso: text(row.event_start_iso),
    plan_run_id: text(row.plan_run_id),
    match_family_key: text(row.match_family_key),
    status: text(row.status),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function toQueue(row: Record<string, unknown>): ProofQueueRow {
  const rank = row.selection_rank;
  return {
    id: String(row.id ?? ""),
    reservation_id: text(row.reservation_id),
    selection_rank: typeof rank === "number" ? rank : rank === null || rank === undefined ? null : Number(rank),
    game_start_iso: text(row.game_start_iso),
    status: text(row.status),
    plan_run_id: text(row.plan_run_id),
    match_family_key: text(row.match_family_key),
    condition_id: text(row.condition_id),
    token_id: text(row.token_id),
    side: text(row.side),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (row.id && !seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnvConfig(process.cwd());

  // Presence check only — values are never read into the report or logged.
  const hasCredentials =
    typeof process.env.SUPABASE_URL === "string" &&
    process.env.SUPABASE_URL.length > 0 &&
    typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string" &&
    process.env.SUPABASE_SERVICE_ROLE_KEY.length > 0;

  if (!hasCredentials) {
    console.log(
      JSON.stringify(
        {
          report_version: REPORT_VERSION,
          analyzer_version: ANALYZER_VERSION,
          window_start: args.since,
          DB_AVAILABLE: false,
          verdict: "STOP_PRODUCTION_READ_UNAVAILABLE",
          limitations: ["production read credentials are absent in this environment"],
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const { supabaseAdmin } = await import("../lib/supabase/server");

  // ── 1. Reservations touched at or after the deployment cutoff ─────────────
  // Two bounded range reads (created_at, updated_at) rather than one compound
  // filter: ISO values carry dots, which a compound filter string would have to
  // escape. Results are merged by id.
  const createdSince = await supabaseAdmin
    .from(RESERVATION_TABLE)
    .select(RESERVATION_FIELDS)
    .gte("created_at", args.since)
    .order("created_at", { ascending: false })
    .limit(ROW_CAP);
  if (createdSince.error) logReadFailure("reservations_created_since", RESERVATION_TABLE, createdSince.error);

  const changedSince = await supabaseAdmin
    .from(RESERVATION_TABLE)
    .select(RESERVATION_FIELDS)
    .gte("updated_at", args.since)
    .order("updated_at", { ascending: false })
    .limit(ROW_CAP);
  if (changedSince.error) logReadFailure("reservations_changed_since", RESERVATION_TABLE, changedSince.error);

  const postDeployReservations = dedupeById(
    [...(createdSince.data ?? []), ...(changedSince.data ?? [])].map((row) =>
      toReservation(row as Record<string, unknown>)
    )
  );

  // ── 2. The historical Reservation, by exact id, for the T1/R1 comparison ──
  const historicalReservation = await supabaseAdmin
    .from(RESERVATION_TABLE)
    .select(RESERVATION_FIELDS)
    .eq("id", args.historicalReservationId)
    .limit(1);
  if (historicalReservation.error) {
    logReadFailure("historical_reservation_by_id", RESERVATION_TABLE, historicalReservation.error);
  }

  const reservations = dedupeById([
    ...postDeployReservations,
    ...(historicalReservation.data ?? []).map((row) => toReservation(row as Record<string, unknown>)),
  ]);

  // ── 3. Queue rows for the candidate Reservations — every status, no filter ─
  const reservationIds = reservations.map((row) => row.id).filter((id) => id.length > 0);
  const queueByReservation = reservationIds.length
    ? await supabaseAdmin
        .from(QUEUE_TABLE)
        .select(QUEUE_FIELDS)
        .in("reservation_id", reservationIds)
        .order("created_at", { ascending: false })
        .limit(ROW_CAP)
    : { data: [], error: null };
  if (queueByReservation.error) logReadFailure("queue_by_reservation_ids", QUEUE_TABLE, queueByReservation.error);

  // Also read Queue rows created after the cutoff, so a row pointing at neither
  // candidate Reservation still appears in the proof.
  const queueSince = await supabaseAdmin
    .from(QUEUE_TABLE)
    .select(QUEUE_FIELDS)
    .gte("created_at", args.since)
    .order("created_at", { ascending: false })
    .limit(ROW_CAP);
  if (queueSince.error) logReadFailure("queue_created_since", QUEUE_TABLE, queueSince.error);

  // ── 4. The historical Queue instruction, by exact id ─────────────────────
  const historicalQueue = await supabaseAdmin
    .from(QUEUE_TABLE)
    .select(QUEUE_FIELDS)
    .eq("id", args.historicalQueueId)
    .limit(1);
  if (historicalQueue.error) logReadFailure("historical_queue_by_id", QUEUE_TABLE, historicalQueue.error);

  const historicalQueueRows = (historicalQueue.data ?? []).map((row) => toQueue(row as Record<string, unknown>));
  const queueRows = dedupeById([
    ...(queueByReservation.data ?? []).map((row) => toQueue(row as Record<string, unknown>)),
    ...(queueSince.data ?? []).map((row) => toQueue(row as Record<string, unknown>)),
    ...historicalQueueRows,
  ]);

  // ── 5. Pure analysis ─────────────────────────────────────────────────────
  const fixedNow = new Date().toISOString();
  const input: LiveContour6ProofInput = {
    sinceIso: args.since,
    fixedNowIso: fixedNow,
    reservations,
    queueRows,
    historicalExpectation: {
      queue_id: args.historicalQueueId,
      reservation_id: args.historicalReservationId,
      event_start_iso: args.historicalEventStart,
    },
    historicalQueueRow: historicalQueueRows[0] ?? null,
  };
  const result = analyzeLiveContour6Runtime(input);

  console.log(
    JSON.stringify(
      {
        report_version: REPORT_VERSION,
        analyzer_version: result.analyzer_version,
        fixed_now: result.fixed_now,
        window_start: result.window_start,
        DB_AVAILABLE: true,
        verdict: result.verdict,
        post_deploy_reservations: result.post_deploy_reservations,
        canonical_uniqueness: result.canonical_uniqueness,
        selected_T1_R1: result.selected_T1_R1,
        selected_T2_R2: result.selected_T2_R2,
        identity_separation: result.identity_separation,
        queue_Q2: result.queue_Q2,
        queue_start_parity: result.queue_start_parity,
        historical_Q1: result.historical_Q1,
        findings: result.findings,
        limitations: result.limitations,
        rows_examined: {
          reservations: reservations.length,
          queue_rows: queueRows.length,
          row_cap_per_query: ROW_CAP,
        },
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(
    `[lc6-runtime-report] FAILED: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
