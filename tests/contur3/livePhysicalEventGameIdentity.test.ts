// LIVE_PHYSICAL_EVENT_GAME_IDENTITY_V1 -- ONE PHYSICAL EVENT = MAX ONE ECONOMIC EXPOSURE.
// Production witness (Gangwon FC vs Bucheon FC 1995): root MONEYLINE Reservation persisted
// provider:polymarket:game:90106178:<date>, derivative TOTAL_CORNERS Reservation persisted
// provider:polymarket:1082325:<date>; its capture proved provider_game_id 90106178. Two Queue rows were created.
import test from "node:test";
import assert from "node:assert/strict";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import { readCompletedFinalT3Universe, type FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";
import {
  LIVE_PHYSICAL_EVENT_GAME_ID_AMBIGUOUS,
  LIVE_PHYSICAL_EVENT_GAME_ID_CONTRADICTION,
  liveEconomicPhysicalEventKey,
} from "../../lib/executor/liveEconomicPhysicalEventKey";

const KICKOFF = "2026-07-19T19:00:00.000Z";
const NOW = Date.parse("2026-07-19T18:46:30.000Z");
const GAME = "90106178";
const GAME_KEY = `provider:polymarket:game:${GAME}:2026-07-19`;
const CORNERS_ID = "provider:polymarket:1082325:2026-07-19";

type Mkt = { cond: string; token: string; family: string; type: string };
const ML: Mkt = { cond: "ml-money", token: "ml-token", family: "MONEYLINE", type: "MONEYLINE" };
const ML2: Mkt = { cond: "ml2-money", token: "ml2-token", family: "MONEYLINE", type: "MONEYLINE" };
const TOT: Mkt = { cond: "tot-total", token: "tot-token", family: "TOTALS", type: "TOTAL" };
const COR: Mkt = { cond: "cor-corners", token: "cor-token", family: "TOTAL_CORNERS", type: "TOTAL_CORNERS" };
const SP: Mkt = { cond: "sp-spread", token: "sp-token", family: "SPREADS", type: "SPREAD" };
// Per-family in-support prices (TOTAL_CORNERS has its own support band).
const PX = (token: string): [number, number] => token === COR.token ? [0.42, 0.43] : [0.50, 0.52];

type Res = { id: string; physical: string; providerEventId: string; family: string; markets: Mkt[]; provenGameId: string | null | string[] };

function reservationRow(r: Res): NightEventReservationRow {
  return {
    id: r.id, plan_run_id: "night-plan:2026-07-19", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: r.family, event_slug: "gangwon-vs-bucheon", event_title: "Gangwon FC vs Bucheon FC 1995",
    sport: "soccer", league: null, strategic_scope: "WC", game_start_iso: KICKOFF, event_tier: "TIER1", event_score: 80,
    best_snapshot_id: null, reservation_rank: 1, status: "RESERVED", selection_reason: null,
    physical_event_id: r.physical, event_start_iso: KICKOFF,
    diagnostics: { contract_a_stage: "PLANNING", source_lineage: { provider_event_id: r.providerEventId },
      planning_final_identity_evidence: { condition_id: r.markets[0].cond, token_id: r.markets[0].token, side: "Yes" } },
  } as NightEventReservationRow;
}

function universe(r: Res, phase: "T_MINUS_10" | "T_MINUS_30"): FinalT3MarketObservation[] {
  return r.markets.map((m, i) => ({
    capture_run_id: `${r.id}-${phase}`, reservation_id: r.id, physical_event_id: r.physical, provider_event_id: r.providerEventId,
    event_start_iso: KICKOFF, observation_phase: phase, condition_id: m.cond, token_id: m.token, side: "Yes",
    canonical_market_family: m.family, canonical_market_type: m.type,
    // TOTAL_CORNERS needs the raw provider proof and the exact corners slug to be family-eligible.
    provider_market_type_raw: m.family === "TOTAL_CORNERS" ? "total_corners" : null,
    market_slug: m.family === "TOTAL_CORNERS" ? "total-corners" : m.cond,
    best_bid: PX(m.token)[0], best_ask: PX(m.token)[1], ask_decimal_odds: 1 / PX(m.token)[1], orderbook_fetch_status: "SUCCESS",
    observed_at: phase === "T_MINUS_10" ? "2026-07-19T18:46:00.000Z" : "2026-07-19T18:35:00.000Z",
    ...(r.provenGameId === null ? {} : { discovery_provider_game_id: Array.isArray(r.provenGameId) ? r.provenGameId[i % r.provenGameId.length] : r.provenGameId }),
  }));
}

const bookOf = (tokenId: string): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 3,
  book: { tokenId, bids: [{ price: PX(tokenId)[0], size: 100 }], asks: [{ price: PX(tokenId)[1], size: 100 }], tickSize: 0.01, minimumOrderSize: 5, providerTimestampMs: NOW },
});
const fee = (tokenId: string): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: 0.05, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID",
  observedAtIso: new Date(NOW).toISOString(), latencyMs: 1,
});

/** In-memory Queue whose exposure loader mirrors the production Supabase filters exactly. */
function queueRepo(reservations: NightEventReservationRow[], prior: EventExecutionQueueRow[] = []) {
  const queueRows: EventExecutionQueueRow[] = [...prior];
  const queued = new Set<string>(prior.map((q) => q.reservation_id).filter((v): v is string => !!v));
  const repo: RebalanceRepoPort = {
    async loadEventExposureQueueRows(r, liveKey) {
      return queueRows.filter((q) => q.reservation_id === r.id || q.match_family_key === r.match_family_key ||
        q.diagnostics?.physical_event_id === r.physical_event_id ||
        (!!liveKey && (q.diagnostics?.physical_event_id === liveKey || q.diagnostics?.live_physical_event_key === liveKey)));
    },
    async loadActiveReservations() { return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING"); },
    async loadQueuedReservationIds() { return new Set(queued); },
    async markReservationsExpired() {},
    async markReservationSkipped(id, reason) { const r = reservations.find((x) => x.id === id); if (r) { r.status = "SKIPPED"; r.selection_reason = reason; } },
    async insertQueueRow(row) { queueRows.push(row); if (row.reservation_id) queued.add(row.reservation_id); },
    async markReservationQueued(id) { const r = reservations.find((x) => x.id === id); if (r) r.status = "QUEUED"; },
  };
  return { repo, queueRows };
}

async function rebalance(activation: boolean, active: Res[], prior: EventExecutionQueueRow[] = []) {
  const rows = active.map(reservationRow);
  const { repo, queueRows } = queueRepo(rows, prior);
  const byId = new Map(active.map((r) => [r.id, r]));
  const result = await runEventRebalance(NOW, { write: true }, {
    repo,
    readFinalT3Universe: async (r) => universe(byId.get(r.id!)!, "T_MINUS_10"),
    readT30Universe: async (r) => universe(byId.get(r.id!)!, "T_MINUS_30"),
    recordStrategyDecision: async () => ({ total: 2, selected: 1, written: 2 }),
    fetchExactTokenOrderbook: async (tokenId: string) => bookOf(tokenId),
    fetchTokenFeeSchedule: async (tokenId: string) => fee(tokenId),
    writeGuardTelemetry: async () => {},
    t10EconomicActivation: activation,
  });
  return { result, queueRows, reservations: rows };
}

// Production witness shapes.
const GANGWON_ML: Res = { id: "e316f9e0-1b70-4b89-a61d-8b2cb758647d", physical: GAME_KEY, providerEventId: "1082180", family: "pair:gangwon-ml", markets: [ML], provenGameId: GAME };
const GANGWON_CORNERS: Res = { id: "a5ee83b7-09d4-4a2e-b123-970c61bc53a6", physical: CORNERS_ID, providerEventId: "1082325", family: "pair:gangwon-corners", markets: [COR], provenGameId: GAME };

for (const activation of [true, false]) {
  const arm = activation ? "ON" : "OFF";

  test(`A[${arm}]: root MONEYLINE + derivative TOTAL_CORNERS of the same gameId due together => max one Queue row`, async () => {
    for (const order of [[GANGWON_ML, GANGWON_CORNERS], [GANGWON_CORNERS, GANGWON_ML]]) {
      const { queueRows, result, reservations } = await rebalance(activation, order);
      assert.equal(queueRows.length, 1, "one physical event => one economic exposure");
      assert.equal(queueRows[0].diagnostics.live_physical_event_key, GAME_KEY);
      const blocked = reservations.find((r) => r.id !== queueRows[0].reservation_id)!;
      assert.equal(blocked.status, "SKIPPED");
      assert.ok(result.outcomes.some((o) => o.reservation_id === blocked.id && o.reason === "PHYSICAL_EVENT_EXPOSURE_PLANNED_THIS_RUN"));
    }
  });

  test(`B[${arm}]: derivative TOTAL_CORNERS first, MONEYLINE second => max one exposure`, async () => {
    const first = await rebalance(activation, [GANGWON_CORNERS]);
    assert.equal(first.queueRows.length, 1);
    const corners = first.queueRows[0];
    assert.equal(corners.diagnostics.physical_event_id, CORNERS_ID, "persisted Reservation identity is never rewritten");
    assert.equal(corners.diagnostics.live_physical_event_key, GAME_KEY);
    const second = await rebalance(activation, [GANGWON_ML], [corners]);
    assert.equal(second.queueRows.length, 1, "MONEYLINE sees the corners exposure through the canonical game key");
    assert.equal(second.reservations[0].status, "SKIPPED");
  });

  test(`C[${arm}]: MONEYLINE first, corners second => max one exposure (incl. a pre-patch root row with no live key)`, async () => {
    const first = await rebalance(activation, [GANGWON_ML]);
    assert.equal(first.queueRows.length, 1);
    const ml = first.queueRows[0];
    assert.equal(ml.diagnostics.physical_event_id, GAME_KEY);
    const second = await rebalance(activation, [GANGWON_CORNERS], [ml]);
    assert.equal(second.queueRows.length, 1);
    assert.equal(second.reservations[0].status, "SKIPPED");
    // A root row written before this patch carries only physical_event_id: still found by the game key.
    const { live_physical_event_key: _k, ...legacyDiag } = ml.diagnostics;
    const legacy = await rebalance(activation, [GANGWON_CORNERS], [{ ...ml, diagnostics: legacyDiag }]);
    assert.equal(legacy.queueRows.length, 1);
  });

  test(`D[${arm}]: two different gameIds with the same kickoff (and title) remain independent`, async () => {
    const other: Res = { id: "res-other-game", physical: "provider:polymarket:game:90106999:2026-07-19", providerEventId: "1082900",
      family: "pair:other", markets: [ML2], provenGameId: "90106999" };
    const { queueRows } = await rebalance(activation, [GANGWON_ML, other]);
    assert.equal(queueRows.length, 2);
    assert.deepEqual(queueRows.map((q) => q.diagnostics.live_physical_event_key).sort(), [GAME_KEY, other.physical].sort());
  });

  test(`E[${arm}]: unresolved / ambiguous / contradicting derivative identity fails closed, never fuzzy-inferred`, async () => {
    // No proven gameId: the derivative keeps its own persisted identity -- never merged by title or kickoff.
    const unresolved = { ...GANGWON_CORNERS, provenGameId: null };
    const solo = await rebalance(activation, [unresolved]);
    assert.equal(solo.queueRows[0].diagnostics.live_physical_event_key, CORNERS_ID);
    // Two proven gameIds in one capture: ambiguous -> no Queue.
    const ambiguous = await rebalance(activation, [{ ...GANGWON_CORNERS, markets: [COR, TOT], provenGameId: [GAME, "90106999"] }]);
    assert.equal(ambiguous.queueRows.length, 0);
    assert.equal(ambiguous.reservations[0].selection_reason, LIVE_PHYSICAL_EVENT_GAME_ID_AMBIGUOUS);
    // A game-based Reservation contradicted by its capture: no Queue.
    const contradicted = await rebalance(activation, [{ ...GANGWON_ML, provenGameId: "90106999" }]);
    assert.equal(contradicted.queueRows.length, 0);
    assert.equal(contradicted.reservations[0].selection_reason, LIVE_PHYSICAL_EVENT_GAME_ID_CONTRADICTION);
  });

  test(`F[${arm}]: SPREADS remains observation-only on a derivative Reservation`, async () => {
    const onlySpreads = await rebalance(activation, [{ ...GANGWON_CORNERS, markets: [SP] }]);
    assert.equal(onlySpreads.queueRows.length, 0);
    const withCorners = await rebalance(activation, [{ ...GANGWON_CORNERS, markets: [SP, COR] }]);
    assert.deepEqual(withCorners.queueRows.map((q) => q.token_id), ["cor-token"]);
  });

  test(`G[${arm}]: allowed-family selection within ONE Reservation is unchanged by the live key`, async () => {
    const markets = [ML, TOT, COR];
    const proven = await rebalance(activation, [{ ...GANGWON_CORNERS, markets }]);
    const unproven = await rebalance(activation, [{ ...GANGWON_CORNERS, markets, provenGameId: null }]);
    assert.equal(proven.queueRows.length, 1);
    assert.deepEqual([proven.queueRows[0].condition_id, proven.queueRows[0].token_id, proven.queueRows[0].side],
      [unproven.queueRows[0].condition_id, unproven.queueRows[0].token_id, unproven.queueRows[0].side]);
    assert.equal(proven.queueRows[0].idempotency_key, unproven.queueRows[0].idempotency_key, "persisted idempotency identity unchanged");
  });

  test(`H[${arm}]: exact physical_event_id behavior unchanged where no derived gameId is needed`, async () => {
    // Root game-based Reservation with no audit: key = persisted id; a prior row on the same persisted id blocks.
    const plain = { ...GANGWON_ML, provenGameId: null };
    const first = await rebalance(activation, [plain]);
    assert.equal(first.queueRows[0].diagnostics.live_physical_event_key, GAME_KEY);
    const sibling: Res = { ...plain, id: "res-ml-sibling", family: "pair:gangwon-ml-2" };
    const second = await rebalance(activation, [sibling], [first.queueRows[0]]);
    assert.equal(second.queueRows.length, 1);
    assert.equal(second.reservations[0].status, "SKIPPED");
  });
}

test("key resolver: proven gameId wins for live identity only; persisted id is the fallback", () => {
  const u = (g: string | null) => [{ discovery_provider_game_id: g }];
  assert.deepEqual(liveEconomicPhysicalEventKey({ persistedPhysicalEventId: CORNERS_ID, eventStartIso: KICKOFF, providerEventId: "1082325", universe: u(GAME) }),
    { ok: true, key: GAME_KEY, source: "PROVEN_PROVIDER_GAME_ID" });
  assert.deepEqual(liveEconomicPhysicalEventKey({ persistedPhysicalEventId: CORNERS_ID, eventStartIso: KICKOFF, providerEventId: "1082325", universe: u(null) }),
    { ok: true, key: CORNERS_ID, source: "PERSISTED_PHYSICAL_EVENT_ID" });
  assert.equal(liveEconomicPhysicalEventKey({ persistedPhysicalEventId: null, eventStartIso: KICKOFF, providerEventId: "x", universe: u(GAME) }).ok, false);
});

test("capture read: proven gameId comes only from a valid T10 discovery audit, never inferred", async () => {
  const res = reservationRow(GANGWON_CORNERS);
  const run = (audit: unknown) => ({
    id: "run-1", reservation_id: res.id, physical_event_id: CORNERS_ID, provider_event_id: "1082325", event_start_iso: KICKOFF,
    observation_phase: "T_MINUS_10", source_version: "RESERVATION_MARKET_BASELINE_V1", capture_complete: true, capture_status: "COMPLETE",
    market_tokens_expected_n: 1, market_tokens_observed_n: 1, discovery_audit_v1: audit,
  });
  const obs = { id: "o-1", capture_run_id: "run-1", reservation_id: res.id, physical_event_id: CORNERS_ID, provider_event_id: "1082325",
    event_start_iso: KICKOFF, observation_phase: "T_MINUS_10", condition_id: "c", token_id: "t", side: "Yes" };
  const read = async (audit: unknown) => {
    return readCompletedFinalT3Universe(res, { readRuns: async () => [run(audit)], readObservations: async (_id, after) => after === "00000000-0000-0000-0000-000000000000" ? [obs] : [] });
  };
  assert.equal((await read({ version: "T10_DISCOVERY_AUDIT_V1", provider_game_id: GAME }))[0].discovery_provider_game_id, GAME);
  for (const bad of [null, {}, { version: "OTHER", provider_game_id: GAME }, { version: "T10_DISCOVERY_AUDIT_V1", provider_game_id: "" },
    { version: "T10_DISCOVERY_AUDIT_V1", provider_game_id: GAME, audit_overflow: true }]) {
    assert.equal((await read(bad))[0].discovery_provider_game_id, undefined);
  }
});
