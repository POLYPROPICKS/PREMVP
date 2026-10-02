// Shared in-memory rebalance fixture (one reserved event, completed T-10 universe, exact-book stub).
import type { RebalanceRepoPort } from "../../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../../lib/executor/executorQueueTypes";
import type { FinalT3MarketObservation } from "../../../lib/executor/reservationMarketBaseline";
import type { ComposedContour } from "../../../lib/constructor/contracts";

export const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
export const IN_WINDOW_MS = Date.parse("2026-07-19T18:52:00.000Z"); // T-8m, final write window
const PHYSICAL_ID = "provider:polymarket:event-1:2026-07-19";

function reservation(): NightEventReservationRow {
  return {
    id: "shadow-r", physical_event_id: PHYSICAL_ID, event_start_iso: KICKOFF_ISO,
    plan_run_id: "night-plan:2026-07-19:1700-minsk", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: PHYSICAL_ID, event_slug: null, event_title: null, sport: "esports", league: null,
    strategic_scope: "ESPORT", game_start_iso: KICKOFF_ISO, event_tier: "TIER1", event_score: 80,
    best_snapshot_id: null, reservation_rank: 1, status: "RESERVED", selection_reason: null,
    diagnostics: {
      contract_a_stage: "PLANNING",
      source_lineage: { provider_event_id: "event-1", provider_event_start_iso: KICKOFF_ISO, generated_signal_pair_id: "planning-pair" },
      planning_final_identity_evidence: { condition_id: "a-control", token_id: "a-token", side: "Yes" },
    },
  } as NightEventReservationRow;
}

const market = (condition: string, token: string, family: string, type: string): FinalT3MarketObservation => ({
  capture_run_id: "t3-run", reservation_id: "shadow-r", physical_event_id: PHYSICAL_ID,
  provider_event_id: "event-1", event_start_iso: KICKOFF_ISO, observation_phase: "T_MINUS_10",
  condition_id: condition, token_id: token, side: "Yes", canonical_market_family: family,
  canonical_market_type: type, best_ask: 0.52, ask_decimal_odds: 1 / 0.52,
  orderbook_fetch_status: "SUCCESS", market_slug: condition,
});

export function spyRepo() {
  const calls = { insert: 0, markQueued: 0 };
  const queue: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return [reservation()]; },
    async loadQueuedReservationIds() { return new Set<string>(); },
    async markReservationsExpired() {}, async markReservationSkipped() {},
    async markReservationQueued() { calls.markQueued += 1; },
    async insertQueueRow(row) { calls.insert += 1; queue.push(row); },
  };
  return { repo, calls, queue };
}

export const writeDeps = (repo: RebalanceRepoPort, contour?: ComposedContour) => ({
  repo,
  ...(contour ? { contour } : {}),
  readFinalT3Universe: async () => [
    market("a-control", "a-token", "MONEYLINE", "MONEYLINE"),
    market("b-spread", "b-token", "SPREADS", "SPREAD"),
  ],
  recordStrategyDecision: async () => ({ total: 2, selected: 1, written: 2 }),
  fetchExactTokenOrderbook: async (tokenId: string) => ({
    ok: true as const, tokenId, latencyMs: 1,
    book: { tokenId, bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.52, size: 100 }], raw: {} },
  }),
});

