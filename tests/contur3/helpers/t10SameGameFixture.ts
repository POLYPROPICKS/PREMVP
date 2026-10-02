// Live-shaped synthetic same-game provider fixture for the T10 discovery audit.
// One physical match (gameId 999) split over three provider events, the way
// Gamma serves it: core markets, corners, and halftime.
import {
  captureReservationMarketObservation,
  type FinalT3MarketObservation,
  type ReservationMarketPhase,
} from "../../../lib/executor/reservationMarketBaseline";
import { physicalMatchId } from "../../../lib/executor/contractADecisions";
import type { NightEventReservationRow } from "../../../lib/executor/executorQueueTypes";

type CaptureDeps = NonNullable<Parameters<typeof captureReservationMarketObservation>[2]>;
export type FixtureMarket = Awaited<ReturnType<NonNullable<CaptureDeps["readGameEvents"]>>>[number];

export const FIXTURE_START_ISO = "2026-07-19T19:00:00.000Z";
export const FIXTURE_GAME_ID = "999";
export const FIXTURE_OWN_EVENT_ID = "123";
export const FIXTURE_PHYSICAL_ID = physicalMatchId({ eventId: FIXTURE_OWN_EVENT_ID, eventStartIso: FIXTURE_START_ISO, gameId: FIXTURE_GAME_ID });
export const EXACT_CORNERS = { condition: "c-tc", yes: "t-tc-yes", no: "t-tc-no" } as const;

/** Best ask per token. SPREADS has no ask inside 1.85-2.00; exact TOTAL_CORNERS "Over" is 2.381. */
export const FIXTURE_ASKS: Record<string, number> = {
  "t-ml-home": 0.52, "t-ml-away": 0.30, "t-sp-a": 0.40, "t-sp-b": 0.70,
  "t-tot-over": 0.53, "t-tot-under": 0.45, "t-tc-yes": 0.42, "t-tc-no": 0.60,
};

export function market(
  eventId: string, siblings: number, type: string | null, slug: string, condition: string | null,
  tokens: string[], outcomes: string[], extra: Partial<FixtureMarket> = {},
): FixtureMarket {
  return {
    provider_event_id: eventId, event_start_iso: FIXTURE_START_ISO, condition_id: condition,
    clob_token_ids: tokens, outcomes, sports_market_type: type, provider_market_slug: slug,
    sibling_market_count: siblings, last_observed_at: "2026-07-19T18:40:00.000Z",
    provider_game_id: FIXTURE_GAME_ID, ...extra,
  };
}

/** The reserved event: core markets plus exact score. */
export function ownEventMarkets(): FixtureMarket[] {
  const e = FIXTURE_OWN_EVENT_ID;
  return [
    market(e, 4, "moneyline", "epl-ars-che-2026-07-19-ml", "c-ml", ["t-ml-home", "t-ml-away"], ["Home", "Away"]),
    market(e, 4, "spreads", "epl-ars-che-2026-07-19-spread-home-1pt5", "c-sp", ["t-sp-a", "t-sp-b"], ["Home -1.5", "Away +1.5"]),
    market(e, 4, "totals", "epl-ars-che-2026-07-19-total-2pt5", "c-tot", ["t-tot-over", "t-tot-under"], ["Over", "Under"]),
    market(e, 4, "soccer_exact_score", "epl-ars-che-2026-07-19-exact-score-1-0", "c-xs", ["t-xs-y", "t-xs-n"], ["Yes", "No"]),
  ];
}

/** Sibling provider events of the same game: exact corners + every corner derivative, and halftime. */
export function siblingEventMarkets(): FixtureMarket[] {
  const corners = "124";
  const slug = (s: string) => `epl-ars-che-2026-07-19-${s}`;
  return [
    market(corners, 6, "total_corners", slug("total-corners-9pt5"), EXACT_CORNERS.condition, [EXACT_CORNERS.yes, EXACT_CORNERS.no], ["Over", "Under"]),
    market(corners, 6, "soccer_team_total_corners", slug("team-total-corners-home-4pt5"), "c-team", ["t-team-y", "t-team-n"], ["Over", "Under"]),
    market(corners, 6, "soccer_first_half_total_corners", slug("1h-total-corners-4pt5"), "c-1h", ["t-1h-y", "t-1h-n"], ["Over", "Under"]),
    market(corners, 6, "soccer_second_half_total_corners", slug("2h-total-corners-4pt5"), "c-2h", ["t-2h-y", "t-2h-n"], ["Over", "Under"]),
    market(corners, 6, "soccer_game_corners_odd_even", slug("corners-odd-even"), "c-oe", ["t-oe-y", "t-oe-n"], ["Odd", "Even"]),
    market(corners, 6, "soccer_first_corner", slug("first-corner"), "c-fc", ["t-fc-h", "t-fc-a"], ["Home", "Away"]),
    market("125", 1, "soccer_halftime_result", slug("halftime-result"), "c-ht", ["t-ht-h", "t-ht-a"], ["Home", "Away"]),
  ];
}

export function fixtureReservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return {
    id: "11111111-1111-4111-8111-111111111111", plan_run_id: "plan", physical_event_id: FIXTURE_PHYSICAL_ID,
    event_start_iso: FIXTURE_START_ISO, game_start_iso: FIXTURE_START_ISO,
    diagnostics: {
      contract_a_stage: "PLANNING",
      source_lineage: {
        provider_event_id: FIXTURE_OWN_EVENT_ID, provider_event_start_iso: FIXTURE_START_ISO,
        provider_game_id: FIXTURE_GAME_ID, provider_market_type: "moneyline",
      },
      planning_final_identity_evidence: { condition_id: "c-ml", token_id: "t-ml-home", side: "Home" },
    },
    ...overrides,
  } as unknown as NightEventReservationRow;
}

export function fixtureBooks(asks: Record<string, number> = FIXTURE_ASKS): NonNullable<CaptureDeps["fetchBooks"]> {
  return async (ids) => ids.map((tokenId) => {
    const ask = asks[tokenId];
    return ask === undefined
      ? { ok: false as const, tokenId, latencyMs: 1, errorCode: "NO_BOOK" }
      : { ok: true as const, tokenId, latencyMs: 1,
          book: { tokenId, bids: [{ price: +(ask - 0.02).toFixed(2), size: 100 }], asks: [{ price: ask, size: 100 }] } };
  }) as never;
}

export type CapturedFixture = { run: Record<string, unknown>; rows: Record<string, unknown>[] };

export async function captureFixture(
  phase: ReservationMarketPhase,
  opts: { own?: FixtureMarket[]; discovered?: FixtureMarket[]; reservation?: NightEventReservationRow } = {},
): Promise<CapturedFixture> {
  let captured: CapturedFixture | null = null;
  await captureReservationMarketObservation(opts.reservation ?? fixtureReservation(), phase, {
    observedAt: new Date(Date.parse(FIXTURE_START_ISO) - (phase === "T_MINUS_30" ? 30 : 10) * 60_000).toISOString(),
    alreadyCaptured: async () => false,
    readExactEvent: async () => opts.own ?? ownEventMarkets(),
    readGameEvents: async () => opts.discovered ?? siblingEventMarkets(),
    fetchBooks: fixtureBooks(),
    write: async (run, rows) => { captured = { run, rows }; },
  });
  if (!captured) throw new Error("fixture capture wrote nothing");
  return captured;
}

/** Persisted observation rows are exactly the FinalT3 universe shape the Queue reads. */
export function universeFromRows(rows: Record<string, unknown>[]): FinalT3MarketObservation[] {
  return rows as unknown as FinalT3MarketObservation[];
}
