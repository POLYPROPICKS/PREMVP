// R0E CANONICAL IMMUTABLE EXECUTION IDENTITY CONTRACT — production-shaped replay.
//   node --import tsx --test tests/contur3/executionIdentityParity.test.ts
//
// Incident replayed: plan_run_id=night-plan:2026-07-24:1700-minsk produced 15
// Reservations, 1 QUEUED, 14 SKIPPED with
// selection_reason=CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE and
// battle_trace_id ending "unknown:unknown", and 0 orders. The 14 rows consumed
// reservation ranks although planning had never produced a complete immutable
// execution identity for them, and rebalance then tried to REDISCOVER a market
// from event_slug / match_family_key / source lineage against a narrower
// authoritative universe.
//
// These tests enter BEFORE the divergence: sanitized production-shaped
// generated_signal_pairs rows -> the real normalization/selector
// (buildFireModelCandidates) -> the real planner (buildReservationPlan) ->
// a JSON-serialized Reservation (exactly what Supabase would store and return)
// -> the real rebalance (runEventRebalance) -> the real queue row. No candidate
// is hand-constructed past the suspected divergence, and the clock is fixed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import {
  mapQueueRowToIrelandCandidate,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";

// ── Fixed clock ──────────────────────────────────────────────────────────────
// 2026-07-24T14:00:00Z = 17:00 Minsk (the canonical plan anchor of the incident).
const PLANNING_ISO = "2026-07-24T14:00:00.000Z";
const PLANNING_MS = Date.parse(PLANNING_ISO);
const KICKOFF_ISO = "2026-07-24T15:20:00.000Z";
const CREATED_ISO = "2026-07-24T13:50:00.000Z"; // exactly T-90 (eligible snapshot, inside the 120m gate)
const REBALANCE_MS = Date.parse("2026-07-24T14:30:00.000Z"); // T-50: inside T-70..T-3

/** Run fn with Date pinned to ms (the selector reads Date.now() for its as-of). */
async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ── Sanitized production-shaped source rows ─────────────────────────────────
// Shape mirrors generated_signal_pairs as the Contract A loader reads it. No
// real tokens, no provider payloads, no credentials.
function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { __gameStart, __created, __diagnostics, ...rest } = overrides as Record<string, unknown> & {
    __gameStart?: string;
    __created?: string;
    __diagnostics?: Record<string, unknown>;
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    condition_id: "cond-default",
    selected_token_id: "tok-default",
    selected_outcome: "TEAM_A",
    score: 80,
    signal_confidence_num: 80,
    metric_formula_version: "v2-lite-growth-safe",
    entry_price_num: 0.45,
    expires_at: "2026-07-25T00:00:00.000Z",
    created_at: (__created as string) ?? CREATED_ISO,
    event_slug: "mlb-yankees-vs-phillies-2026-07-24",
    market_slug: "mlb-yankees-vs-phillies-2026-07-24-moneyline",
    diagnostics: {
      gameStartIso: (__gameStart as string) ?? KICKOFF_ISO,
      dataCoverage: 80,
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
      ...(__diagnostics ?? {}),
    },
    ...rest,
  };
}

// Fixture A — Yankees vs Phillies, Tier1 full-match, complete identity.
// This is the production shape whose reservation was SKIPPED with
// CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE.
const FIXTURE_A = sourceRow({
  id: "00000000-0000-4000-8000-00000000000a",
  condition_id: "cond-nyy-phi",
  selected_token_id: "tok-nyy-phi-yankees",
  selected_outcome: "New York Yankees",
});

// Fixture C — Keyd vs Alka: the SAME physical event surfacing twice
// (two provider representations of one game).
const FIXTURE_C1 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000c",
  condition_id: "cond-keyd-alka-1",
  selected_token_id: "tok-keyd-alka-1",
  selected_outcome: "Keyd Stars",
  event_slug: "keyd-vs-alka-2026-07-24",
  market_slug: "keyd-vs-alka-2026-07-24-moneyline",
  __diagnostics: { eventTitle: "Keyd Stars vs Alka Team", marketTitle: "Keyd vs Alka moneyline" },
});
const FIXTURE_C2 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000d",
  condition_id: "cond-keyd-alka-2",
  selected_token_id: "tok-keyd-alka-2",
  selected_outcome: "Alka Team",
  score: 95, // deliberately higher: must not create a SECOND reservation for one event
  signal_confidence_num: 95,
  event_slug: "keyd-vs-alka-2026-07-24",
  market_slug: "keyd-vs-alka-2026-07-24-spread",
  __diagnostics: { eventTitle: "Keyd Stars vs Alka Team", marketTitle: "Keyd vs Alka spread" },
});

// Fixture E — KC handicap / activity-label market: identity COMPLETE but the
// market itself is forbidden. Must stay rejected end to end.
const FIXTURE_E = sourceRow({
  id: "00000000-0000-4000-8000-00000000000e",
  condition_id: "cond-kc-activity",
  selected_token_id: "tok-kc-activity",
  selected_outcome: "Kansas City Chiefs",
  event_slug: "$52K matched activity",
  market_slug: "$52K matched activity",
  __diagnostics: { eventTitle: "$52K matched activity", marketTitle: "$52K matched activity" },
});

// Fixture B — Team Liquid vs Fnatic (esports), two representations. The frozen
// live-money universe excludes esports; this task must not broaden it.
const FIXTURE_B1 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000b",
  condition_id: "cond-liquid-fnatic-pair",
  selected_token_id: "tok-liquid-fnatic-pair",
  selected_outcome: "Team Liquid",
  event_slug: "pair:team-liquid-vs-fnatic:2026-07-24",
  market_slug: "counter-strike-team-liquid-vs-fnatic-bo3",
  __diagnostics: {
    eventTitle: "Counter-Strike: Team Liquid vs Fnatic (BO3)",
    marketTitle: "Counter-Strike: Team Liquid vs Fnatic (BO3)",
    shadowScope: "esports",
  },
});
const FIXTURE_B2 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000f",
  condition_id: "cond-liquid-fnatic-poly",
  selected_token_id: "tok-liquid-fnatic-poly",
  selected_outcome: "Fnatic",
  event_slug: "polymarket:team-liquid-fnatic",
  market_slug: "counter-strike-team-liquid-vs-fnatic-bo3-map1",
  __diagnostics: {
    eventTitle: "Counter-Strike: Team Liquid vs Fnatic (BO3)",
    marketTitle: "Counter-Strike: Team Liquid vs Fnatic — Map 1",
    shadowScope: "esports",
  },
});

// ── In-memory rebalance repo (no Supabase, no network) ──────────────────────
function makeFakeRepo(seed: NightEventReservationRow[]) {
  const queueRows: EventExecutionQueueRow[] = [];
  const skippedCalls: Array<{ id: string; reason: string }> = [];
  const queuedCalls: Array<{ id: string; reason: string }> = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() {
      return seed;
    },
    async loadQueuedReservationIds() {
      return new Set(queueRows.map((r) => r.reservation_id).filter((v): v is string => Boolean(v)));
    },
    async markReservationsExpired() {},
    async markReservationSkipped(id, reason) {
      skippedCalls.push({ id, reason });
    },
    async insertQueueRow(row) {
      queueRows.push(row);
    },
    async markReservationQueued(id, reason) {
      queuedCalls.push({ id, reason });
    },
  };
  return { repo, queueRows, skippedCalls, queuedCalls };
}

/**
 * The full production chain for a set of source rows, with a fixed clock:
 *   rows -> planning selector -> planner -> SERIALIZED reservation ->
 *   rebalance (fresh authoritative universe from the SAME rows) -> queue rows.
 */
async function replay(rows: Record<string, unknown>[], opts: { mutateReservations?: (r: NightEventReservationRow) => void } = {}) {
  const planning = await at(PLANNING_MS, () =>
    buildFireModelCandidates(1000, "all", true, rows, "CONTRACT_A_PLANNING_V1")
  );
  const plan = await at(PLANNING_MS, async () =>
    buildReservationPlan(PLANNING_MS, { fetchCandidates: async () => ({ candidates: planning.candidates }) })
  );
  // Round-trip through JSON exactly as Supabase would store and return the row.
  const reservations: NightEventReservationRow[] = JSON.parse(JSON.stringify(plan.reservations)).map(
    (r: NightEventReservationRow, i: number) => ({ ...r, id: `res-${i}`, status: "RESERVED" as const })
  );
  reservations.forEach((r) => opts.mutateReservations?.(r));

  const final = await at(REBALANCE_MS, () => buildFireModelCandidates(1000, "all", true, rows, "CONTRACT_A_V1"));
  const { repo, queueRows, skippedCalls, queuedCalls } = makeFakeRepo(reservations);
  const result = await at(REBALANCE_MS, () =>
    runEventRebalance(
      REBALANCE_MS,
      { write: true },
      {
        repo,
        fetchCandidates: async () => ({ candidates: [] as FireModelCandidate[] }),
        fetchContractAFinalCandidates: async () => ({ candidates: final.candidates }),
      }
    )
  );
  return { planning: planning.candidates, plan, reservations, final: final.candidates, result, queueRows, skippedCalls, queuedCalls };
}

function diag(row: { diagnostics: Record<string, unknown> }): Record<string, unknown> {
  return row.diagnostics ?? {};
}

// ── 1. Identity-incomplete candidates cannot consume a reservation slot ──────

test("R0E-1: an identity-incomplete source candidate never consumes a Reservation slot", async () => {
  // Same physical event, but the source row carries no token id -> the frozen
  // producer rejects it, so no candidate and no reservation can exist.
  const noToken = sourceRow({ id: "00000000-0000-4000-8000-000000000011", condition_id: "cond-no-token", selected_token_id: undefined });
  const { plan, reservations } = await replay([noToken]);
  assert.equal(plan.reservations.length, 0, "a market without a complete identity must not be reserved");
  assert.equal(reservations.length, 0);
});

test("R0E-2: the planner keeps scanning and fills the slot with the next valid authoritative candidate", async () => {
  const broken = sourceRow({ id: "00000000-0000-4000-8000-000000000012", condition_id: "cond-broken", selected_token_id: undefined, event_slug: "broken-event-2026-07-24", market_slug: "broken-event-2026-07-24-moneyline" });
  const { plan } = await replay([broken, FIXTURE_A]);
  assert.equal(plan.reservations.length, 1, "the identity-incomplete event is skipped, the valid one still fills a slot");
  assert.equal(diag(plan.reservations[0]).authoritative_condition_id, "cond-nyy-phi");
});

// ── 2. Every reservation stores an exact, complete identity ─────────────────

test("R0E-3 (production RED shape): Fixture A is reserved WITH a complete stored identity and a real battle_trace_id", async () => {
  const { plan } = await replay([FIXTURE_A]);
  assert.equal(plan.reservations.length, 1);
  const d = diag(plan.reservations[0]);
  assert.equal(d.authoritative_condition_id, "cond-nyy-phi");
  assert.equal(d.authoritative_token_id, "tok-nyy-phi-yankees");
  assert.equal(d.authoritative_side, "New York Yankees");
  assert.equal(typeof d.identity_physical_event_key, "string");
  assert.ok(String(d.identity_physical_event_key).length > 0);
  // The incident signature was a trace id ending in "unknown:unknown".
  assert.doesNotMatch(String(d.battle_trace_id), /unknown:unknown$/);
  assert.match(String(d.battle_trace_id), /:cond-nyy-phi:tok-nyy-phi-yankees$/);
});

// ── 3. Parity: planning === reservation === rebalance === queue (by ID) ─────

test("R0E-4 PARITY: planning identity === serialized Reservation identity === rebalance identity === queue identity", async () => {
  const { planning, reservations, queueRows, result } = await replay([FIXTURE_A]);
  assert.equal(result.queued_count, 1);
  assert.equal(queueRows.length, 1);

  const planningCandidate = planning.find((c) => c.condition_id === "cond-nyy-phi")!;
  const reservationDiag = diag(reservations[0]);
  const queueRow = queueRows[0];

  // Compare IDs, never labels.
  assert.equal(reservationDiag.authoritative_condition_id, planningCandidate.condition_id);
  assert.equal(reservationDiag.authoritative_token_id, planningCandidate.token_id);
  assert.equal(reservationDiag.authoritative_side, planningCandidate.side);
  assert.equal(queueRow.condition_id, reservationDiag.authoritative_condition_id);
  assert.equal(queueRow.token_id, reservationDiag.authoritative_token_id);
  assert.equal(queueRow.side, reservationDiag.authoritative_side);
  assert.equal(diag(queueRow).identity_physical_event_key, reservationDiag.identity_physical_event_key);

  // Ireland receives the exact same identity on the wire.
  const wire = mapQueueRowToIrelandCandidate(queueRow, REBALANCE_MS);
  assert.equal(wire.condition_id, "cond-nyy-phi");
  assert.equal(wire.token_id, "tok-nyy-phi-yankees");
  assert.equal(wire.side, "New York Yankees");
  assert.equal(wire.order_key, "cond-nyy-phi:tok-nyy-phi-yankees:New York Yankees");
});

test("R0E-5: a display-title-only difference does NOT change the selected IDs (titles are diagnostics only)", async () => {
  const renamed = {
    ...FIXTURE_A,
    diagnostics: {
      ...(FIXTURE_A.diagnostics as Record<string, unknown>),
      eventTitle: "N.Y. YANKEES  vs   PHILADELPHIA  PHILLIES",
      marketTitle: "Yankees @ Phillies — Moneyline",
    },
  };
  const base = await replay([FIXTURE_A]);
  const alt = await replay([renamed]);
  assert.equal(alt.queueRows.length, 1);
  assert.equal(alt.queueRows[0].condition_id, base.queueRows[0].condition_id);
  assert.equal(alt.queueRows[0].token_id, base.queueRows[0].token_id);
  assert.equal(alt.queueRows[0].side, base.queueRows[0].side);
});

test("R0E-6: a conflicting display title on the Reservation is fail-closed-safe -- it can never substitute another token", async () => {
  const { queueRows, result } = await replay([FIXTURE_A], {
    mutateReservations: (r) => {
      r.event_title = "Completely Different Game";
      r.event_slug = "some-other-event-slug";
      r.match_family_key = "pair:not-the-same:2026-01-01";
      r.best_snapshot_id = null;
    },
  });
  // The stored IDs still resolve, so execution proceeds on the SAME token --
  // the divergent strings can never point it at a different market.
  assert.equal(result.queued_count, 1);
  assert.equal(queueRows[0].condition_id, "cond-nyy-phi");
  assert.equal(queueRows[0].token_id, "tok-nyy-phi-yankees");
});

// ── 4. Rebalance validates; it never rediscovers ────────────────────────────

test("R0E-7: rebalance with an UNCHANGED source validates the stored identity (no title/slug rediscovery)", async () => {
  const { result, queueRows, skippedCalls } = await replay([FIXTURE_A]);
  assert.equal(skippedCalls.length, 0);
  assert.equal(result.queued_count, 1);
  assert.equal(queueRows[0].idempotency_key !== null, true);
});

test("R0E-8: a source change after planning produces an explicit drift reason, never a substituted market", async () => {
  const { result, skippedCalls, queueRows } = await replay([FIXTURE_A], {
    mutateReservations: (r) => {
      // The stored identity no longer exists in the authoritative universe.
      r.diagnostics = { ...r.diagnostics, authoritative_token_id: "tok-that-no-longer-exists" };
    },
  });
  assert.equal(result.queued_count, 0);
  assert.equal(queueRows.length, 0);
  assert.match(skippedCalls[0].reason, /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND: SOURCE_CHANGED_SINCE_PLANNING/);
});

test("R0E-9: a Reservation with no persisted identity is SKIPPED with IDENTITY_NOT_PERSISTED (it can never rediscover a market)", async () => {
  const { result, skippedCalls } = await replay([FIXTURE_A], {
    mutateReservations: (r) => {
      r.diagnostics = { selector_id: "CONTRACT_A_PLANNING_V1", contract_a_stage: "PLANNING" };
    },
  });
  assert.equal(result.queued_count, 0);
  assert.match(skippedCalls[0].reason, /CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE: IDENTITY_NOT_PERSISTED/);
});

// ── 5. Physical-event dedup and forbidden markets ──────────────────────────

test("R0E-10 (Fixture C): duplicate representations of one physical event yield exactly ONE reservation and ONE queue row", async () => {
  const { plan, queueRows } = await replay([FIXTURE_C1, FIXTURE_C2]);
  assert.equal(plan.reservations.length, 1, "one physical event -> one reservation slot");
  assert.equal(queueRows.length, 1, "no two queue rows for the same physical event");
  const keys = new Set(queueRows.map((r) => r.idempotency_key));
  assert.equal(keys.size, queueRows.length);
});

test("R0E-11 (Fixture E, KC regression): a complete-identity but forbidden activity-label market stays rejected end to end", async () => {
  const { planning, plan, queueRows } = await replay([FIXTURE_E]);
  const kc = planning.find((c) => c.condition_id === "cond-kc-activity");
  if (kc) {
    assert.equal(kc.live_eligible, false, "forbidden market must never be live-eligible");
  }
  assert.equal(plan.reservations.length, 0, "a forbidden market must never consume a reservation slot");
  assert.equal(queueRows.length, 0);
});

test("R0E-12 (Fixture B): esports representations are not admitted -- the live-money universe is not broadened", async () => {
  const { planning, plan, queueRows } = await replay([FIXTURE_B1, FIXTURE_B2]);
  // Both the "pair:" and the "polymarket:" representation are excluded by the
  // authoritative selector itself (ESPORTS_EXCLUDED), so neither can reach the
  // planner. This task must not widen that universe to make them pass.
  assert.equal(planning.length, 0, "no esports candidate may enter the planning universe");
  assert.equal(plan.reservations.length, 0);
  assert.equal(queueRows.length, 0);
});

// ── 6. Mixed production-shaped batch ───────────────────────────────────────

test("R0E-13: a mixed batch reserves only identity-complete allowed markets and every reservation reaches the queue", async () => {
  const { plan, result, queueRows, skippedCalls } = await replay([
    FIXTURE_A,
    FIXTURE_C1,
    FIXTURE_C2,
    FIXTURE_E,
    FIXTURE_B1,
    FIXTURE_B2,
  ]);
  assert.equal(plan.reservations.length, 2, "Yankees/Phillies + Keyd/Alka only");
  assert.equal(result.queued_count, 2, "zero dead-on-arrival reservations");
  assert.equal(skippedCalls.length, 0);
  for (const row of queueRows) {
    assert.ok(row.condition_id.length > 0);
    assert.ok(row.token_id.length > 0);
    assert.ok(row.side.length > 0);
  }
});
