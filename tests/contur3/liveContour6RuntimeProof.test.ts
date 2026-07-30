// Live Contour 6 runtime-proof analyzer tests (node:test via tsx):
//   node --import tsx --test tests/contur3/liveContour6RuntimeProof.test.ts
//
// The analyzer under test is pure: production-shaped Reservation/Queue rows in,
// one structured verdict out. No Supabase client, no env access, no network, no
// filesystem access anywhere in lib/executor/liveContour6RuntimeProof.ts.
//
// Schema note proved from migrations before these fixtures were written:
//   public.night_event_reservations has physical_event_id + event_start_iso (LC6).
//   public.event_execution_queue has NO event_start_iso column — its occurrence
//   start is game_start_iso, and LC6 deliberately did not alter the Queue. Queue
//   start parity is therefore queue.game_start_iso vs reservation.event_start_iso.
//
// The final test is a static read-only regression guard over the CLI source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  analyzeLiveContour6Runtime,
  normalizeInstantMs,
  type HistoricalQueueExpectation,
  type LiveContour6ProofInput,
  type ProofQueueRow,
  type ProofReservationRow,
} from "../../lib/executor/liveContour6RuntimeProof";

const SINCE_ISO = "2026-07-30T10:26:00.000Z";
const FIXED_NOW_ISO = "2026-07-30T18:00:00.000Z";

// The historical (already proven) Queue instruction that must stay immutable.
const HISTORICAL: HistoricalQueueExpectation = {
  queue_id: "669eef5c-ae62-40cf-8d42-2d52298cb585",
  reservation_id: "97e7766c-75d4-4d52-9894-196e1f334d22",
  event_start_iso: "2026-07-27T22:40:00Z",
};

const R1_ID = HISTORICAL.reservation_id;
const R2_ID = "b2f0c9d4-1111-4a2b-9c3d-5e6f70819aa2";
const Q2_ID = "7c1a55e0-2222-4b3c-8d4e-6f7081920bb3";

// physical_event_id is the canonical merged group key; it carries the occurrence
// date, so two occurrences of one fixture are two distinct persisted identities.
const T1_PHYSICAL = "pair:argentina-vs-spain:2026-07-27";
const T2_PHYSICAL = "pair:argentina-vs-spain:2026-07-30";
const T1_START = "2026-07-27T22:40:00Z";
const T2_START = "2026-07-30T19:30:00Z";

function reservationRow(overrides: Partial<ProofReservationRow> = {}): ProofReservationRow {
  return {
    id: R2_ID,
    physical_event_id: T2_PHYSICAL,
    event_start_iso: T2_START,
    plan_run_id: "night-2026-07-30",
    match_family_key: T2_PHYSICAL,
    status: "QUEUED",
    created_at: "2026-07-30T14:00:00Z",
    updated_at: "2026-07-30T14:00:00Z",
    ...overrides,
  };
}

function r1Row(overrides: Partial<ProofReservationRow> = {}): ProofReservationRow {
  return reservationRow({
    id: R1_ID,
    physical_event_id: T1_PHYSICAL,
    event_start_iso: T1_START,
    plan_run_id: "night-2026-07-27",
    match_family_key: T1_PHYSICAL,
    created_at: "2026-07-27T14:00:00Z",
    updated_at: "2026-07-27T14:00:00Z",
    ...overrides,
  });
}

function queueRow(overrides: Partial<ProofQueueRow> = {}): ProofQueueRow {
  return {
    id: Q2_ID,
    reservation_id: R2_ID,
    selection_rank: 1,
    game_start_iso: T2_START,
    status: "READY",
    plan_run_id: "night-2026-07-30",
    match_family_key: T2_PHYSICAL,
    condition_id: "cond-t2",
    token_id: "token-t2",
    side: "YES",
    created_at: "2026-07-30T17:30:00Z",
    updated_at: "2026-07-30T17:30:00Z",
    ...overrides,
  };
}

function historicalQueueRow(overrides: Partial<ProofQueueRow> = {}): ProofQueueRow {
  return queueRow({
    id: HISTORICAL.queue_id,
    reservation_id: HISTORICAL.reservation_id,
    game_start_iso: HISTORICAL.event_start_iso,
    status: "SENT",
    plan_run_id: "night-2026-07-27",
    match_family_key: T1_PHYSICAL,
    condition_id: "cond-t1",
    token_id: "token-t1",
    created_at: "2026-07-27T21:40:00Z",
    updated_at: "2026-07-27T22:41:00Z",
    ...overrides,
  });
}

function input(overrides: Partial<LiveContour6ProofInput> = {}): LiveContour6ProofInput {
  return {
    sinceIso: SINCE_ISO,
    fixedNowIso: FIXED_NOW_ISO,
    reservations: [r1Row(), reservationRow()],
    queueRows: [historicalQueueRow(), queueRow()],
    historicalExpectation: HISTORICAL,
    historicalQueueRow: historicalQueueRow(),
    ...overrides,
  };
}

// ── 1. Complete success ──────────────────────────────────────────────────────
test("PASS_RUNTIME_T2_R2_Q2 when T2/R2/Q2 are canonical and Q1 is unchanged", () => {
  const result = analyzeLiveContour6Runtime(input());

  assert.equal(result.verdict, "PASS_RUNTIME_T2_R2_Q2");
  assert.equal(result.post_deploy_reservations.length, 1);
  assert.equal(result.post_deploy_reservations[0].id, R2_ID);

  assert.ok(result.selected_T2_R2, "R2 must be selected");
  assert.equal(result.selected_T2_R2?.reservation_id, R2_ID);
  assert.equal(result.selected_T2_R2?.physical_event_id, T2_PHYSICAL);

  assert.ok(result.selected_T1_R1, "R1 must be selected for comparison");
  assert.equal(result.selected_T1_R1?.reservation_id, R1_ID);
  assert.equal(result.selected_T1_R1?.physical_event_id, T1_PHYSICAL);

  // Identity separation proved from persisted ids only.
  assert.equal(result.identity_separation.reservation_ids_distinct, true);
  assert.equal(result.identity_separation.physical_event_ids_distinct, true);

  assert.equal(result.queue_Q2?.queue_id, Q2_ID);
  assert.equal(result.queue_Q2?.reservation_id, R2_ID);
  assert.equal(result.queue_Q2?.links_to_selected_r2, true);
  assert.equal(result.queue_start_parity.match, true);

  assert.equal(result.historical_Q1.status, "UNCHANGED");
  assert.equal(result.historical_Q1.linked_to_r2, false);
  assert.deepEqual(result.findings, []);
});

// ── 2. No qualifying canonical Reservation after cutoff ──────────────────────
test("WAIT_NO_POST_DEPLOY_OCCURRENCE when no canonical reservation exists after the cutoff", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      reservations: [r1Row()],
      queueRows: [historicalQueueRow()],
    })
  );

  assert.equal(result.verdict, "WAIT_NO_POST_DEPLOY_OCCURRENCE");
  assert.equal(result.post_deploy_reservations.length, 0);
  assert.equal(result.selected_T2_R2, null);
  assert.equal(result.queue_Q2, null);
  // Absence of a natural occurrence is not a code failure.
  assert.deepEqual(result.findings, []);
  assert.equal(result.historical_Q1.status, "UNCHANGED");
});

test("WAIT_NO_POST_DEPLOY_OCCURRENCE when a post-cutoff row has incomplete identity", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      reservations: [
        r1Row(),
        reservationRow({ event_start_iso: null }), // physical id set, start missing
      ],
      queueRows: [historicalQueueRow()],
    })
  );

  assert.equal(result.verdict, "WAIT_NO_POST_DEPLOY_OCCURRENCE");
  assert.equal(result.post_deploy_reservations.length, 0);
  assert.ok(
    result.limitations.some((l) => l.includes("identity_incomplete")),
    "incomplete identity must be surfaced as a limitation"
  );
});

// ── 3. R2 exists but Queue not due yet ──────────────────────────────────────
test("WAIT_R2_EXISTS_QUEUE_NOT_DUE when R2 exists with no Queue row yet", () => {
  const result = analyzeLiveContour6Runtime(
    input({ queueRows: [historicalQueueRow()] })
  );

  assert.equal(result.verdict, "WAIT_R2_EXISTS_QUEUE_NOT_DUE");
  assert.equal(result.selected_T2_R2?.reservation_id, R2_ID);
  assert.equal(result.queue_Q2, null);
  assert.equal(result.queue_start_parity.checked, false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.historical_Q1.status, "UNCHANGED");
});

// ── 4. Duplicate canonical identity ─────────────────────────────────────────
test("FAIL_IDENTITY_DUPLICATE when one physical_event_id carries two reservations", () => {
  const duplicate = reservationRow({
    id: "c3d1e8f5-3333-4c4d-9e5f-708192031cc4",
    created_at: "2026-07-30T14:05:00Z",
    updated_at: "2026-07-30T14:05:00Z",
  });
  const result = analyzeLiveContour6Runtime(
    input({ reservations: [r1Row(), reservationRow(), duplicate] })
  );

  assert.equal(result.verdict, "FAIL_IDENTITY_DUPLICATE");
  const group = result.canonical_uniqueness.find((g) => g.physical_event_id === T2_PHYSICAL);
  assert.equal(group?.reservation_count, 2);
  assert.equal(group?.unique, false);
  assert.ok(result.findings.some((f) => f.includes("FAIL_IDENTITY_DUPLICATE")));
});

// ── 5. Queue reuses R1 ──────────────────────────────────────────────────────
test("FAIL_QUEUE_REUSES_R1 when the post-deploy Queue row points at R1", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      queueRows: [historicalQueueRow(), queueRow({ reservation_id: R1_ID })],
    })
  );

  assert.equal(result.verdict, "FAIL_QUEUE_REUSES_R1");
  assert.equal(result.queue_Q2?.reservation_id, R1_ID);
  assert.equal(result.queue_Q2?.links_to_selected_r2, false);
  assert.ok(result.findings.some((f) => f.includes("FAIL_QUEUE_REUSES_R1")));
});

// ── 6. Queue start mismatch ─────────────────────────────────────────────────
test("FAIL_QUEUE_START_MISMATCH when Q2 start differs from R2 start", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      queueRows: [historicalQueueRow(), queueRow({ game_start_iso: "2026-07-30T20:15:00Z" })],
    })
  );

  assert.equal(result.verdict, "FAIL_QUEUE_START_MISMATCH");
  assert.equal(result.queue_start_parity.checked, true);
  assert.equal(result.queue_start_parity.match, false);
  assert.equal(result.queue_start_parity.reservation_event_start_iso, T2_START);
  assert.equal(result.queue_start_parity.queue_game_start_iso, "2026-07-30T20:15:00Z");
  assert.ok(result.findings.some((f) => f.includes("FAIL_QUEUE_START_MISMATCH")));
});

// ── 7. Historical Q1 mutated ────────────────────────────────────────────────
test("FAIL_HISTORICAL_Q1_MUTATED when Q1 was rewritten to reference R2", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      historicalQueueRow: historicalQueueRow({ reservation_id: R2_ID }),
    })
  );

  assert.equal(result.verdict, "FAIL_HISTORICAL_Q1_MUTATED");
  assert.equal(result.historical_Q1.status, "MUTATED");
  assert.equal(result.historical_Q1.reservation_id_matches, false);
  assert.equal(result.historical_Q1.linked_to_r2, true);
  assert.ok(result.findings.some((f) => f.includes("FAIL_HISTORICAL_Q1_MUTATED")));
});

test("FAIL_HISTORICAL_Q1_MUTATED when Q1 occurrence start changed", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      historicalQueueRow: historicalQueueRow({ game_start_iso: "2026-07-30T19:30:00Z" }),
    })
  );

  assert.equal(result.verdict, "FAIL_HISTORICAL_Q1_MUTATED");
  assert.equal(result.historical_Q1.event_start_matches, false);
});

test("FAIL_HISTORICAL_Q1_MUTATED when the historical Queue row is absent", () => {
  const result = analyzeLiveContour6Runtime(input({ historicalQueueRow: null }));

  assert.equal(result.verdict, "FAIL_HISTORICAL_Q1_MUTATED");
  assert.equal(result.historical_Q1.status, "NOT_FOUND");
  // A wrong --historical-queue-id produces the same symptom; say so rather than
  // asserting corruption.
  assert.ok(result.limitations.some((l) => l.includes("historical_queue_id")));
});

// ── Verdict precedence is deterministic ─────────────────────────────────────
test("historical Q1 mutation outranks every other defect", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      reservations: [r1Row(), reservationRow(), reservationRow({ id: "dup-1" })],
      queueRows: [historicalQueueRow(), queueRow({ reservation_id: R1_ID })],
      historicalQueueRow: historicalQueueRow({ reservation_id: R2_ID }),
    })
  );

  assert.equal(result.verdict, "FAIL_HISTORICAL_Q1_MUTATED");
  // Every defect is still reported, not just the winning verdict.
  assert.ok(result.findings.some((f) => f.includes("FAIL_IDENTITY_DUPLICATE")));
  assert.ok(result.findings.some((f) => f.includes("FAIL_QUEUE_REUSES_R1")));
  assert.ok(result.findings.length >= 3);
});

// ── Deterministic timestamp normalization ───────────────────────────────────
test("normalizeInstantMs treats equivalent wire formats as one instant", () => {
  const zulu = normalizeInstantMs("2026-07-27T22:40:00Z");
  assert.equal(normalizeInstantMs("2026-07-27T22:40:00.000Z"), zulu);
  assert.equal(normalizeInstantMs("2026-07-27T22:40:00+00:00"), zulu);
  // PostgREST/Postgres space-separated form must not read as a different instant.
  assert.equal(normalizeInstantMs("2026-07-27 22:40:00+00"), zulu);
  assert.equal(normalizeInstantMs(null), null);
  assert.equal(normalizeInstantMs("not-a-timestamp"), null);
});

test("queue start parity compares instants, not raw strings", () => {
  const result = analyzeLiveContour6Runtime(
    input({
      reservations: [r1Row(), reservationRow({ event_start_iso: "2026-07-30T19:30:00+00:00" })],
      queueRows: [historicalQueueRow(), queueRow({ game_start_iso: "2026-07-30 19:30:00+00" })],
    })
  );

  assert.equal(result.verdict, "PASS_RUNTIME_T2_R2_Q2");
  assert.equal(result.queue_start_parity.match, true);
});

// ── 8. Static read-only safety regression ───────────────────────────────────
const MUTATION_TOKENS = [
  ".insert(",
  ".update(",
  ".delete(",
  ".upsert(",
  "persistReservationPlan",
  "buildReservationPlan",
  "buildQueueRow",
  "claim",
  "send",
  "callback",
];

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("CLI report source contains no reachable mutation or execution path", () => {
  const cli = sourceOf("../../scripts/report-live-contour6-runtime.ts");

  for (const token of MUTATION_TOKENS) {
    assert.equal(
      cli.includes(token),
      false,
      `CLI must not contain mutation/execution token ${token}`
    );
  }

  // Read-only surface: every Supabase call is a bounded .select(...).
  assert.ok(cli.includes(".select("), "CLI must read via .select(");
  assert.ok(
    cli.includes("night_event_reservations") && cli.includes("event_execution_queue"),
    "CLI must read both canonical tables"
  );

  // Bounded queries only — no unrestricted full-table scan.
  assert.ok(
    cli.includes(".eq(") || cli.includes(".in(") || cli.includes(".or("),
    "CLI selects must be bounded by a filter"
  );

  // stdout only: no filesystem writer may be imported or called.
  for (const fsToken of ["node:fs", "writeFileSync", "createWriteStream", "appendFileSync", "mkdir"]) {
    assert.equal(cli.includes(fsToken), false, `CLI must not touch the filesystem (${fsToken})`);
  }

  // Imports must stay inside the approved allowlist.
  const importTargets = [...cli.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set([
    "@next/env",
    "../lib/supabase/server",
    "../lib/executor/liveContour6RuntimeProof",
  ]);
  for (const target of importTargets) {
    assert.ok(allowed.has(target), `unexpected CLI import: ${target}`);
  }
});

test("analyzer source is pure — no client, no env, no I/O", () => {
  const analyzer = sourceOf("../../lib/executor/liveContour6RuntimeProof.ts");

  for (const token of [
    ...MUTATION_TOKENS,
    "@supabase",
    "supabaseAdmin",
    "process.env",
    "node:fs",
    "fetch(",
    "@next/env",
  ]) {
    assert.equal(analyzer.includes(token), false, `analyzer must not contain ${token}`);
  }

  // A pure analyzer imports types only (or nothing at all).
  const importLines = analyzer.split("\n").filter((line) => line.trimStart().startsWith("import "));
  for (const line of importLines) {
    assert.ok(line.includes("import type"), `analyzer import must be type-only: ${line.trim()}`);
  }
});
