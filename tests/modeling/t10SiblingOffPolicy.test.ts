// T10_SIBLING_OFFPOLICY_V1 — settlement states, executability bounds, dataset economics and the frozen C0/C1 evaluation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOffPolicyDataset, classifyExecutability, classifySiblingSettlement, evaluateView, isSupportedSibling,
  summarizeCoverage, viewIncludes, T10_OFFPOLICY_VERSION,
  type SiblingObservationRow, type SiblingSettlement,
} from "../../lib/modeling/t10-offpolicy/siblingOffPolicy";
import { T10_EXECUTABLE_TELEMETRY_VERSION } from "../../lib/executor/reservationMarketBaseline";
import type { GammaMarket } from "../../lib/feed/resolveSignalOutcome";

const market = (over: Partial<GammaMarket> & { prices?: string[] } = {}): GammaMarket => ({
  conditionId: "c1", closed: true, active: false,
  outcomes: JSON.stringify(["Yes", "No"]), outcomePrices: JSON.stringify(over.prices ?? ["1", "0"]), clobTokenIds: JSON.stringify(["t1", "t2"]),
  ...over,
});
const settle = (tokenId: string, m: GammaMarket | null, conditionId = "c1") => classifySiblingSettlement({ conditionId, tokenId, market: m });

test("settlement: WIN / LOSS from the provider's single >=0.99 winner; the token decides the side", () => {
  assert.equal(settle("t1", market()).state, "SETTLED_WIN");
  assert.equal(settle("t2", market()).state, "SETTLED_LOSS");
  assert.equal(settle("t1", market()).winningTokenId, "t1");
});

test("settlement: never converts unresolved to a loss; typed non-results", () => {
  assert.equal(settle("t1", market({ closed: false })).state, "UNRESOLVED");
  assert.equal(settle("t1", market({ prices: ["0.7", "0.3"] })).state, "UNRESOLVED", "closed without a single winner");
  assert.equal(settle("t1", market({ prices: ["0.5", "0.5"] })).state, "VOID_PUSH");
  assert.equal(settle("t1", null).state, "SOURCE_UNAVAILABLE");
  assert.equal(settle("t1", market({ conditionId: "OTHER" })).state, "IDENTITY_NOT_PROVEN", "provider market of a different condition");
  assert.equal(settle("not-a-token", market()).state, "IDENTITY_NOT_PROVEN", "token absent from the provider market");
  assert.equal(settle("", market()).state, "IDENTITY_NOT_PROVEN");
  assert.equal(settle("t1", market({ conditionId: "C1" })).state, "SETTLED_WIN", "condition id compare is case-insensitive");
});

const row = (over: Partial<SiblingObservationRow> = {}): SiblingObservationRow => ({
  physical_event_id: "ev1", provider_event_id: "1", event_start_iso: "2026-10-03T16:00:00.000Z", observed_at: "2026-10-03T15:50:00.000Z",
  condition_id: "c1", token_id: "t1", side: "Yes", canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", provider_market_type_raw: "moneyline",
  best_bid: 0.48, best_ask: 0.5, tick_size: 0.01, minimum_order_size: 5, orderbook_fetch_status: "SUCCESS", ask_depth_relevant_usd: null,
  sport_family: "soccer", ...over,
});

test("executability: pre-telemetry rows give conclusive BLOCKED verdicts only; everything else is UNKNOWN (upper bound), never EXECUTABLE", () => {
  assert.deepEqual(classifyExecutability(row({ best_ask: 0.57 })), { state: "NOT_EXECUTABLE_DEPTH_AT_CAP", source: "PERSISTED_BOOK_PROXY", conclusive: true });
  assert.equal(classifyExecutability(row({ best_ask: 0.54 })).state, "NOT_EXECUTABLE_MIN_ORDER_SIZE", "2.50/0.54 = 4.63 shares < 5; depth cannot cure it");
  assert.equal(classifyExecutability(row({ best_ask: 0.5 })).state, "UNKNOWN_DEPTH_NOT_PERSISTED");
  assert.equal(classifyExecutability(row({ best_ask: 0.5 })).conclusive, false);
  assert.equal(classifyExecutability(row({ minimum_order_size: null })).state, "UNKNOWN_MIN_ORDER_SIZE");
  assert.equal(classifyExecutability(row({ orderbook_fetch_status: "FAILED", best_ask: null })).state, "UNKNOWN_BOOK_UNAVAILABLE");
});

test("executability: a telemetry row's own state is authoritative", () => {
  const t = classifyExecutability(row({ executable_telemetry_version: T10_EXECUTABLE_TELEMETRY_VERSION, executable_full_stake_state: "EXECUTABLE", executable_full_stake: true }));
  assert.deepEqual(t, { state: "EXECUTABLE", source: "TELEMETRY_V1", conclusive: true });
  const u = classifyExecutability(row({ executable_telemetry_version: T10_EXECUTABLE_TELEMETRY_VERSION, executable_full_stake_state: "UNKNOWN_BOOK_UNAVAILABLE" }));
  assert.equal(u.conclusive, false);
});

const win = (): SiblingSettlement => ({ state: "SETTLED_WIN", reason: "PROVIDER_RESOLVED", winningTokenId: "t1" });
const loss = (): SiblingSettlement => ({ state: "SETTLED_LOSS", reason: "PROVIDER_RESOLVED", winningTokenId: "t2" });
const unresolved = (): SiblingSettlement => ({ state: "UNRESOLVED", reason: "MARKET_OPEN", winningTokenId: null });

test("dataset: ordinary $2.50 gross result, fee never assumed 0, unsupported families dropped, identity + lineage preserved", () => {
  const rows = [
    row(), // WIN at 0.50
    row({ condition_id: "c2", token_id: "t3", best_ask: 0.5 }), // LOSS
    row({ condition_id: "c3", token_id: "t5", best_ask: 0.5 }), // UNRESOLVED
    row({ condition_id: "c4", token_id: "t7", canonical_market_family: "OTHER_STRUCTURED" }), // not supported
  ];
  const by = new Map<string, SiblingSettlement>([["c1|t1", win()], ["c2|t3", loss()], ["c3|t5", unresolved()]]);
  const ds = buildOffPolicyDataset(rows, by);
  assert.equal(ds.length, 3, "unsupported family is not part of the supported-sibling denominator");
  assert.equal(ds[0].dataset_version, T10_OFFPOLICY_VERSION);
  assert.equal(ds[0].offpolicy_gross_pnl_usd, 2.5, "2.50 * (1/0.50 - 1)");
  assert.equal(ds[1].offpolicy_gross_pnl_usd, -2.5);
  assert.equal(ds[2].offpolicy_gross_pnl_usd, null, "unresolved is NOT a loss");
  assert.equal(ds[0].fee_state, "FEE_UNKNOWN_GROSS_ONLY");
  assert.equal(ds[0].fee_usd, null);
  assert.equal(ds[0].offpolicy_net_pnl_usd, null);
  assert.deepEqual([ds[0].physical_event_id, ds[0].condition_id, ds[0].token_id, ds[0].side], ["ev1", "c1", "t1", "Yes"]);
  assert.equal(ds[0].lineage.source_table, "reservation_market_observations");
  assert.equal(ds[0].event_date_utc, "2026-10-03");
  assert.equal(isSupportedSibling(row({ canonical_market_family: null })), false);
});

test("dataset: telemetry-proven rows price at the VWAP and carry a known fee; a missing settlement is SOURCE_UNAVAILABLE, not a loss", () => {
  const t = row({
    executable_telemetry_version: T10_EXECUTABLE_TELEMETRY_VERSION, executable_full_stake_state: "EXECUTABLE", executable_full_stake: true,
    full_stake_executable_vwap: 0.5, taker_fee_state: "KNOWN", taker_fee_usd: 0.0375,
  });
  const [w] = buildOffPolicyDataset([t], new Map([["c1|t1", win()]]));
  assert.equal(w.offpolicy_entry_price_source, "TELEMETRY_VWAP");
  assert.equal(w.fee_state, "FEE_KNOWN_NET_AVAILABLE");
  assert.equal(w.offpolicy_net_pnl_usd, 2.4625);
  const [missing] = buildOffPolicyDataset([row()], new Map());
  assert.equal(missing.settlement_state, "SOURCE_UNAVAILABLE");
  assert.equal(missing.offpolicy_gross_pnl_usd, null);
});

// Two events. ev1: a soccer ML at 0.55 (WIN, above the 0.54 cap) and a cheaper soccer spread at 0.50 (LOSS).
// ev2: a tennis ML at 0.52 (WIN). ev3: soccer 0.58 unresolved.
function fixtureDataset() {
  const rows: SiblingObservationRow[] = [
    row({ physical_event_id: "ev1", condition_id: "a", token_id: "a1", best_ask: 0.55 }),
    row({ physical_event_id: "ev1", condition_id: "b", token_id: "b1", best_ask: 0.5, canonical_market_family: "SPREADS" }),
    row({ physical_event_id: "ev2", condition_id: "c", token_id: "c1", best_ask: 0.52, sport_family: "tennis", event_start_iso: "2026-10-04T12:00:00.000Z", observed_at: "2026-10-04T11:50:00.000Z" }),
    row({ physical_event_id: "ev3", condition_id: "d", token_id: "d1", best_ask: 0.58, event_start_iso: "2026-10-05T12:00:00.000Z", observed_at: "2026-10-05T11:50:00.000Z" }),
    row({ physical_event_id: "ev4", condition_id: "e", token_id: "e1", best_ask: 0.7 }), // out of every frozen band
  ];
  const by = new Map<string, SiblingSettlement>([["a|a1", win()], ["b|b1", loss()], ["c|c1", win()], ["d|d1", unresolved()], ["e|e1", loss()]]);
  return buildOffPolicyDataset(rows, by);
}

test("frozen C0/C1 over one common physical-event denominator; RAW keeps the above-cap sibling, EXECUTABLE views cannot", () => {
  const ds = fixtureDataset();
  const [rawC0, rawC1] = evaluateView(ds, "RAW");
  assert.equal(rawC0.common_processed_physical_events_n, 3, "ev1, ev2, ev4 have a settled priced sibling; ev3 is unresolved");
  assert.equal(rawC1.common_processed_physical_events_n, rawC0.common_processed_physical_events_n);
  // engine order: same decision time -> lowest entry price first, so ev1 selects the 0.50 spread (LOSS), not the 0.55 ML.
  assert.equal(rawC0.selected_physical_events_n, 2);
  assert.deepEqual([rawC0.wins, rawC0.losses], [1, 1]);
  assert.equal(rawC1.selected_physical_events_n, 1, "C1 = soccer only; tennis ev2 excluded");
  assert.equal(rawC1.losses, 1);
  assert.equal(rawC0.unresolved_qualifying_siblings_n, 1, "ev3's 0.58 sibling qualifies but is unresolved: counted, not lost");
  assert.equal(rawC0.pnl_u, round2(-1 + (1 / 0.52 - 1)));
  const [exC0] = evaluateView(ds, "EXECUTABLE_UPPER_BOUND");
  // 0.55 / 0.58 are conclusively above the 0.54 cap; 0.52 ML ... min-size 2.5/0.52 = 4.81 < 5 -> conclusively blocked too.
  assert.equal(exC0.common_processed_physical_events_n, rawC0.common_processed_physical_events_n, "same denominator in every view");
  assert.equal(exC0.selected_physical_events_n, 1, "only the 0.50 spread survives the cap and the min-size block");
  const [proven] = evaluateView(ds, "EXECUTABLE_PROVEN");
  assert.equal(proven.selected_physical_events_n, 0, "no pre-telemetry row can be PROVEN executable");
  assert.equal(proven.roi_pct, 0);
});

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

test("uncollapsed view exposes selection sensitivity; sport mix, fee and executability mixes describe the selected bets", () => {
  const ds = fixtureDataset();
  const [rawC0] = evaluateView(ds, "RAW");
  assert.equal(rawC0.uncollapsed_qualifying_siblings.n, 3, "0.55 + 0.50 + 0.52 as independent flat bets");
  assert.deepEqual(rawC0.sport_mix, { soccer: 1, tennis: 1 });
  assert.deepEqual(Object.keys(rawC0.uncollapsed_by_family), ["MONEYLINE", "SPREADS"]);
  assert.equal(rawC0.uncollapsed_by_family.MONEYLINE.n, 2, "0.55 and 0.52 moneylines");
  assert.equal(rawC0.uncollapsed_by_family.SPREADS.n, 1);
  assert.equal(rawC0.selected_fee_unknown_n, 2);
  assert.equal(rawC0.selected_fee_known_n, 0);
  assert.equal(rawC0.date_coverage.first_event_date, "2026-10-03");
  assert.equal(rawC0.date_coverage.days_n, 2, "settled-priced events span 2026-10-03..04; the unresolved 10-05 event is not in the evaluated range");
});

test("viewIncludes: RAW ignores executability; upper bound excludes only conclusively blocked states", () => {
  const [a, , c] = fixtureDataset();
  assert.equal(viewIncludes("RAW", a), true);
  assert.equal(viewIncludes("EXECUTABLE_UPPER_BOUND", a), false, "above cap");
  assert.equal(viewIncludes("EXECUTABLE_UPPER_BOUND", c), false, "min-size blocked at its best ask");
  assert.equal(viewIncludes("EXECUTABLE_PROVEN", a), false);
});

test("coverage: supported siblings, settlement states, executability and telemetry counts", () => {
  const cov = summarizeCoverage(fixtureDataset());
  assert.equal(cov.supported_siblings_n, 5);
  assert.equal(cov.supported_physical_events_n, 4);
  assert.deepEqual(cov.supported_siblings_by_family, { MONEYLINE: 4, SPREADS: 1 });
  assert.equal(cov.settled_siblings_n, 4);
  assert.equal(cov.unresolved_siblings_n, 1);
  assert.equal(cov.common_physical_events_n, 3);
  assert.equal(cov.telemetry_rows_n, 0);
  assert.equal(cov.fee_unknown_n, 5);
  assert.deepEqual(cov.date_range, { first_event_date: "2026-10-03", last_event_date: "2026-10-05" });
});
