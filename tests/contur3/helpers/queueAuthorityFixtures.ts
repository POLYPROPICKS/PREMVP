import type { FireModelCandidate } from "../../../lib/executor/buildFireModelCandidates";
import type { NightEventReservationRow } from "../../../lib/executor/executorQueueTypes";

const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export function createQueueAuthorityFixture(
  nowMs: number,
  reservation: NightEventReservationRow,
  candidate: FireModelCandidate,
  sourceId = "11111111-1111-4111-8111-111111111111",
) {
  const eventStartIso = new Date(nowMs + ONE_HOUR_MS).toISOString();
  const eventSlug = candidate.event_slug || reservation.event_slug || "queue-authority-fixture-event";
  const providerEventId = "provider-event-esp-arg";
  // Production-shaped exact provider market text: the bridge must enter the
  // real Planning producer rather than depend on a hand-built final candidate.
  const marketSlug = "Argentina vs Spain - Moneyline";
  const selectedOutcome = candidate.selected_outcome || candidate.side;
  const sourceRow = {
    id: sourceId,
    condition_id: candidate.condition_id,
    selected_token_id: candidate.token_id,
    token_id: candidate.token_id,
    selected_outcome: selectedOutcome,
    score: candidate.diagnostics.score,
    stake_usd: candidate.stake_usd,
    max_entry_price: candidate.max_entry_price,
    signal_confidence_num: candidate.diagnostics.score,
    smart_money_score_num: candidate.diagnostics.smart_money,
    // Avoid the documented 50-74 / 0.44-0.58 planning bad bucket: this
    // fixture represents a row that was genuinely accepted into Reservation.
    entry_price_num: 0.42,
    metric_formula_version: candidate.diagnostics.version,
    created_at: new Date(nowMs - THIRTY_MINUTES_MS).toISOString(),
    expires_at: eventStartIso,
    signal_result: null,
    event_slug: eventSlug,
    market_slug: marketSlug,
    diagnostics: {
      gameStartIso: eventStartIso,
      dataCoverage: candidate.diagnostics.coverage,
      shadowScope: candidate.inferred_sport,
      eventTitle: reservation.event_title,
      marketTitle: marketSlug,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: providerEventId,
        eventStartIso,
      },
    },
  };
  const authoritativeReservation: NightEventReservationRow = {
    ...reservation,
    event_slug: eventSlug,
    game_start_iso: eventStartIso,
    physical_event_id: `provider:polymarket:${providerEventId}:${eventStartIso.slice(0, 10)}`,
    event_start_iso: eventStartIso,
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: {
        generated_signal_pair_id: sourceRow.id,
        generated_signal_pair_id_is_uuid: true,
        event_slug: sourceRow.event_slug,
        market_slug: sourceRow.market_slug,
        condition_id: sourceRow.condition_id,
        token_id: sourceRow.token_id,
        selected_outcome: sourceRow.selected_outcome,
        provider_event_key: `polymarket:${providerEventId}:${eventStartIso.slice(0, 10)}`,
      },
      planning_score: sourceRow.score,
      planning_tier: reservation.event_tier,
      planning_rank: reservation.reservation_rank,
      sport_metadata_source: "upstream",
    },
  };
  const fetchFinalIdentitySourceRows = async () => [sourceRow];
  const fetchExactTokenOrderbook = async () => ({
    ok: true as const,
    tokenId: sourceRow.token_id,
    latencyMs: 1,
    book: {
      tokenId: sourceRow.token_id,
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.4, size: 100 }],
    },
  });

  return {
    reservation: authoritativeReservation,
    sourceRow,
    fetchFinalIdentitySourceRows,
    fetchExactTokenOrderbook,
  };
}
