// PHYSICAL_MATCH_EVENT_AUTHORITY_REPAIR_V1 — the Reservation owns ONE real
// physical match (structured event-level gameId), never a derivative provider
// sub-event. Fixtures mirror live Gamma evidence (2026-10-01): provider events
// 1039742 (main, moneyline), 1041677 (more-markets: spreads/totals),
// 1039754 (exact score), 1039756 (halftime) — gameId 90122881 for FK Austria
// Wien vs Inter, 90122882 for HB Koge vs Servette; sub-events carry
// parentEventId and the SAME gameId as their main event.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION,
  captureReservationMarketObservation,
  isLiveBUniverseMarket,
  providerEventIdentityContradiction,
  selectReservationT3AbDecisions,
  type FinalT3MarketObservation,
} from "../../lib/executor/reservationMarketBaseline";
import { buildContractAFinalIdentityDecision, physicalIdUnderStoredFormat, physicalMatchId, resolveContractAProviderPhysicalEventIdentity } from "../../lib/executor/contractADecisions";
import { buildReservationCandidateManifestsByPhysicalEvent } from "../../lib/executor/nightEventReservations";
import { planningDecisionFromReservation } from "../../lib/executor/eventExecutionQueue";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const START = "2026-10-01T16:45:00Z";
const GAME_A = "90122881";
const GAME_B = "90122882";

type Mkt = Parameters<typeof providerEventIdentityContradiction>[1][number];
const mkt = (eventId: string, gameId: string, type: string, slug: string, n: number): Mkt => ({
  provider_event_id: eventId, event_start_iso: START, condition_id: `0xc-${eventId}-${slug}-${n}`,
  clob_token_ids: [`t-${eventId}-${slug}-${n}-a`, `t-${eventId}-${slug}-${n}-b`], outcomes: ["Yes", "No"],
  sports_market_type: type, provider_market_slug: slug, sibling_market_count: 1,
  last_observed_at: START, provider_game_id: gameId,
});
const exactScore = (eventId: string, gameId: string) =>
  Array.from({ length: 17 }, (_, i) => mkt(eventId, gameId, "soccer_exact_score", `uwcl-exact-score-${i}`, i));
const halftime = (eventId: string, gameId: string) =>
  [0, 1, 2].map((i) => mkt(eventId, gameId, "soccer_halftime_result", `uwcl-halftime-${i}`, i));
const moneyline = (eventId: string, gameId: string) => [mkt(eventId, gameId, "moneyline", "uwcl-ml-home", 0)];
const moreMarkets = (eventId: string, gameId: string) => [
  mkt(eventId, gameId, "spreads", "uwcl-spread-home-1pt5", 0),
  mkt(eventId, gameId, "totals", "uwcl-total-2pt5", 0),
  mkt(eventId, gameId, "first_half_totals", "uwcl-first-half-total-1pt5", 0),
  mkt(eventId, gameId, "soccer_team_totals", "uwcl-team-total-home", 0),
  mkt(eventId, gameId, "total_corners", "uwcl-total-corners-9pt5", 0),
  mkt(eventId, gameId, "total_corners", "uwcl-team-corners-home-4pt5", 1),
];

const sourceRow = (id: string, eventId: string, gameId: string | null, marketType: string, cond: string) => ({
  id, condition_id: cond, selected_token_id: `tok-${cond}`, selected_outcome: "Yes", market_slug: `m-${cond}`,
  diagnostics: {
    providerEventContext: {
      v: "v1", provider: "polymarket", eventId, eventStartIso: START, marketType,
      ...(gameId ? { gameId } : {}),
    },
  },
});

test("PMEA-1: gameId owns the physical match across main + derivative provider events; different matches never merge", () => {
  const ml = resolveContractAProviderPhysicalEventIdentity(sourceRow("1", "1039742", GAME_A, "moneyline", "c1").diagnostics)!;
  const more = resolveContractAProviderPhysicalEventIdentity(sourceRow("2", "1041677", GAME_A, "spreads", "c2").diagnostics)!;
  const exact = resolveContractAProviderPhysicalEventIdentity(sourceRow("3", "1039754", GAME_A, "moneyline", "c3").diagnostics)!;
  const other = resolveContractAProviderPhysicalEventIdentity(sourceRow("4", "1039744", GAME_B, "moneyline", "c4").diagnostics)!;
  assert.equal(ml.physicalEventId, more.physicalEventId);
  assert.equal(ml.physicalEventId, exact.physicalEventId, "derivative sub-event id is lineage, not identity");
  assert.notEqual(ml.physicalEventId, other.physicalEventId, "same start time, different gameId => different match");
  assert.equal(ml.physicalEventId, `provider:polymarket:game:${GAME_A}:2026-10-01`);
  assert.equal(exact.eventId, "1039754", "provider event id preserved as source lineage");
});

test("PMEA-2: no structured gameId falls back to the legacy provider-event identity (no title/fuzzy inference)", () => {
  const legacy = resolveContractAProviderPhysicalEventIdentity(sourceRow("1", "555", null, "moneyline", "c1").diagnostics)!;
  assert.equal(legacy.physicalEventId, "provider:polymarket:555:2026-10-01");
  assert.equal(physicalMatchId({ eventId: "555", eventStartIso: START, gameId: null }), legacy.physicalEventId);
});

test("PMEA-3: manifest groups same-gameId siblings from different provider events into ONE match, keeps matches apart, carries event lineage", () => {
  const rows = [
    sourceRow("a1", "1039742", GAME_A, "moneyline", "ca1"),
    sourceRow("a2", "1041677", GAME_A, "spreads", "ca2"),
    sourceRow("a3", "1041677", GAME_A, "totals", "ca3"),
    sourceRow("b1", "1039744", GAME_B, "moneyline", "cb1"),
    sourceRow("b2", "1041676", GAME_B, "spreads", "cb2"),
  ];
  const idA = physicalMatchId({ eventId: "x", eventStartIso: START, gameId: GAME_A });
  const idB = physicalMatchId({ eventId: "x", eventStartIso: START, gameId: GAME_B });
  const manifests = buildReservationCandidateManifestsByPhysicalEvent(rows, new Set([idA, idB]));
  assert.equal(manifests.size, 2);
  const a = manifests.get(idA)!.entries;
  assert.deepEqual(a.map((e) => e.condition_id).sort(), ["ca1", "ca2", "ca3"]);
  assert.deepEqual([...new Set(a.map((e) => e.provider_event_id))].sort(), ["1039742", "1041677"]);
  assert.ok(a.every((e) => e.provider_game_id === GAME_A));
  const b = manifests.get(idB)!.entries;
  assert.deepEqual(b.map((e) => e.condition_id).sort(), ["cb1", "cb2"]);
  assert.ok(b.every((e) => e.provider_game_id === GAME_B));
});

test("PMEA-4: contradiction — event 1039754 (exact score only) cannot back a claimed moneyline/spreads/totals row; 1039756 (halftime only) likewise", () => {
  const claim = { gameId: GAME_A, marketType: "moneyline" };
  assert.equal(providerEventIdentityContradiction(claim, exactScore("1039754", GAME_A)), "CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT");
  assert.equal(providerEventIdentityContradiction({ gameId: GAME_B, marketType: "spreads" }, halftime("1039756", GAME_B)), "CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT");
  assert.equal(providerEventIdentityContradiction({ gameId: GAME_A, marketType: "totals" }, exactScore("1039754", GAME_A)), "CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT");
  assert.equal(providerEventIdentityContradiction(claim, moneyline("1039742", GAME_A)), null);
  assert.equal(providerEventIdentityContradiction({ gameId: GAME_A, marketType: "spreads" }, moreMarkets("1041677", GAME_A)), null);
  assert.equal(providerEventIdentityContradiction(claim, moneyline("1039744", GAME_B)), "GAME_ID_MISMATCH");
});

test("PMEA-5: exact score, halftime, team/period derivatives and props are outside the live B universe", () => {
  assert.equal(exactScore("1", GAME_A).some(isLiveBUniverseMarket), false);
  assert.equal(halftime("1", GAME_A).some(isLiveBUniverseMarket), false);
  const more = moreMarkets("1", GAME_A);
  assert.deepEqual(more.filter(isLiveBUniverseMarket).map((m) => m.provider_market_slug),
    ["uwcl-spread-home-1pt5", "uwcl-total-2pt5", "uwcl-total-corners-9pt5"]);
});

const reservation = (diag: Record<string, unknown>, physicalEventId: string) => ({
  id: "77777777-7777-4777-8777-777777777777", plan_run_id: "plan", physical_event_id: physicalEventId,
  event_start_iso: START, diagnostics: diag,
}) as unknown as NightEventReservationRow;

async function capture(res: NightEventReservationRow, byEvent: Record<string, Mkt[]>) {
  const reads: string[] = [];
  let run: Record<string, unknown> = {};
  let observations: Record<string, unknown>[] = [];
  await captureReservationMarketObservation(res, "T_MINUS_30", {
    observedAt: "2026-10-01T16:20:00Z",
    alreadyCaptured: async () => false,
    readExactEvent: async (id) => { reads.push(id); const m = byEvent[id]; if (!m) throw new Error("unavailable"); return m; },
    fetchBooks: async (tokens: string[]) => tokens.map(() => ({ ok: false, errorCode: "NO_BOOK", latencyMs: 1 })) as never,
    write: async (r, o) => { run = r; observations = o; },
  });
  return { reads, run, observations };
}

const idA = physicalMatchId({ eventId: "1039754", eventStartIso: START, gameId: GAME_A });
const lineageA = { provider_event_id: "1039754", provider_event_start_iso: START, provider_game_id: GAME_A, provider_market_type: "moneyline" };
const manifestA = [
  { provider_event_id: "1039742", provider_game_id: GAME_A },
  { provider_event_id: "1041677", provider_game_id: GAME_A },
  { provider_event_id: "1039744", provider_game_id: GAME_B }, // other match: must never be read
];

test("PMEA-6: Reservation on derivative event 1039754 — universe is the same-match supported siblings only; exact score excluded; other match never read", async () => {
  const res = reservation({ source_lineage: lineageA, candidate_manifest: manifestA }, idA);
  const { reads, run, observations } = await capture(res, {
    "1039754": exactScore("1039754", GAME_A),
    "1039742": moneyline("1039742", GAME_A),
    "1041677": moreMarkets("1041677", GAME_A),
    "1039744": moneyline("1039744", GAME_B),
  });
  assert.deepEqual(reads, ["1039754", "1039742", "1041677"], "lineage event + same-game manifest siblings only; GAME_B event never read");
  assert.equal(run.failure_reason, null);
  assert.deepEqual([...new Set(observations.map((o) => o.canonical_market_family))].sort(), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.equal(observations.some((o) => String(o.provider_market_type_raw).includes("exact_score")), false);
  assert.ok(observations.every((o) => o.physical_event_id === idA));
});

test("PMEA-7: derivative-only exact event with no same-match siblings fails closed with the typed contradiction (1039754 and 1039756)", async () => {
  const exactOnly = await capture(reservation({ source_lineage: lineageA, candidate_manifest: [] }, idA),
    { "1039754": exactScore("1039754", GAME_A) });
  assert.equal(exactOnly.run.capture_status, "CAPTURE_FAILED");
  assert.equal(exactOnly.run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
  assert.equal(PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION, "PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION");
  assert.equal(exactOnly.observations.length, 0, "contradicted derivative event contributes no identities");

  const idB = physicalMatchId({ eventId: "1039756", eventStartIso: START, gameId: GAME_B });
  const half = await capture(reservation({
    source_lineage: { provider_event_id: "1039756", provider_event_start_iso: START, provider_game_id: GAME_B, provider_market_type: "totals" },
    candidate_manifest: [],
  }, idB), { "1039756": halftime("1039756", GAME_B) });
  assert.equal(half.run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
  assert.equal(half.run.capture_status, "CAPTURE_FAILED");
});

test("PMEA-8: a sibling whose payload belongs to another match is dropped, never substituted", async () => {
  const res = reservation({ source_lineage: lineageA, candidate_manifest: [{ provider_event_id: "1041677", provider_game_id: GAME_A }] }, idA);
  const { run, observations } = await capture(res, {
    "1039754": exactScore("1039754", GAME_A),
    "1041677": moreMarkets("1041677", GAME_B), // payload gameId disagrees with the manifest's claim
  });
  assert.equal(observations.length, 0);
  assert.equal(run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
});

test("PMEA-9: Reservation physical id is validated against the game-based identity; provider event id stays lineage", () => {
  const res = reservation({
    source_lineage: { ...lineageA }, planning_score: 80, planning_tier: "A", planning_rank: 1,
  }, idA);
  (res as unknown as Record<string, unknown>).event_score = 80;
  assert.ok(planningDecisionFromReservation(res), "game-based physical id validates against its lineage");
  assert.equal(planningDecisionFromReservation(res)!.source_lineage.provider_event_id, "1039754");
  const forged = reservation({ source_lineage: { ...lineageA, provider_game_id: GAME_B }, planning_score: 80, planning_tier: "A", planning_rank: 1 }, idA);
  assert.equal(planningDecisionFromReservation(forged), null, "lineage game id that does not own the physical id is rejected");
});

test("PMEA-10: B selection over the same-match universe never picks exact score / halftime", () => {
  const obs = (m: Mkt, family: string, type: string, ask: number): FinalT3MarketObservation => ({
    capture_run_id: "run", reservation_id: "77777777-7777-4777-8777-777777777777", observation_phase: "T_MINUS_3", physical_event_id: idA, event_start_iso: START, condition_id: m.condition_id!,
    token_id: String(m.clob_token_ids), side: "Yes", canonical_market_family: family, canonical_market_type: type,
    provider_market_type_raw: m.sports_market_type, market_slug: m.provider_market_slug,
    best_ask: ask, ask_decimal_odds: 1 / ask, orderbook_fetch_status: "SUCCESS", spread_abs: 0.01,
  } as unknown as FinalT3MarketObservation);
  const universe = [
    ...exactScore("1039754", GAME_A).map((m) => obs(m, "OTHER_STRUCTURED", "OTHER_STRUCTURED", 0.5)),
    ...halftime("1039756", GAME_A).map((m) => obs(m, "OTHER_STRUCTURED", "OTHER_STRUCTURED", 0.5)),
  ];
  const { b } = selectReservationT3AbDecisions(reservation({ source_lineage: lineageA }, idA), universe);
  assert.equal(b.selectedIdentity, null);
  // Positive control: the same universe plus a same-match supported SPREADS
  // sibling in its support region selects that sibling, never a derivative.
  const spread = obs(moreMarkets("1041677", GAME_A)[0], "SPREADS", "SPREAD", 0.52);
  const withSpread = selectReservationT3AbDecisions(reservation({ source_lineage: lineageA }, idA), [...universe, spread]).b;
  assert.equal(withSpread.selectedIdentity?.conditionId, spread.condition_id);
});

// ── Legacy (pre-gameId) Reservations must keep validating when their source
//    rows now carry a gameId (the producer writes providerEventContext.gameId).
const LEGACY_ID = "provider:polymarket:1039742:2026-10-01";
const GAME_ID_ID = `provider:polymarket:game:${GAME_A}:2026-10-01`;

test("PMEA-11: expected physical id follows the Reservation's own stored id format, never the row alone", () => {
  const row = { eventId: "1039742", eventStartIso: START, gameId: GAME_A };
  assert.equal(physicalIdUnderStoredFormat(LEGACY_ID, row), LEGACY_ID, "legacy Reservation ignores the row's gameId");
  assert.equal(physicalIdUnderStoredFormat(GAME_ID_ID, row), GAME_ID_ID);
  assert.equal(physicalIdUnderStoredFormat(GAME_ID_ID, { ...row, eventId: "1041677" }), GAME_ID_ID, "sibling provider event, same match");
  assert.notEqual(physicalIdUnderStoredFormat(GAME_ID_ID, { ...row, gameId: GAME_B }), GAME_ID_ID, "other match never matches");
});

const planningFor = (physicalEventId: string) => ({
  decision_version: "CONTRACT_A_DECISION_V1", contract_a_version: "CONTRACT_A_PLANNING_V1", status: "ACCEPTED",
  physical_event_id: physicalEventId, event_start_iso: START, event_start_iso_source: "source_row_game_start_iso",
  source_lineage: {}, rejection_trace: null,
}) as never;
const finalCandidate = { condition_id: "0xc", token_id: "tok", side: "Yes", market_slug: "m", canonical_market_key: null,
  event_slug: "e", diagnostics: { game_start_iso: START } } as never;
const finalDiag = (eventId: string, gameId: string | null) => ({
  gameStartIso: START, providerEventContext: { v: "v1", provider: "polymarket", eventId, eventStartIso: START, ...(gameId ? { gameId } : {}) },
});

test("PMEA-12: Final Identity — legacy Reservation + gameId-bearing row still accepted; game-based Reservation accepts same-match sibling only", () => {
  const legacy = buildContractAFinalIdentityDecision(planningFor(LEGACY_ID), finalCandidate, finalDiag("1039742", GAME_A));
  assert.equal(legacy.accepted, true, "existing legacy cohort must not regress");
  const legacyOtherEvent = buildContractAFinalIdentityDecision(planningFor(LEGACY_ID), finalCandidate, finalDiag("1041677", GAME_A));
  assert.equal(legacyOtherEvent.accepted, false, "legacy still binds to its provider event id");
  const sibling = buildContractAFinalIdentityDecision(planningFor(GAME_ID_ID), finalCandidate, finalDiag("1041677", GAME_A));
  assert.equal(sibling.accepted, true);
  const otherMatch = buildContractAFinalIdentityDecision(planningFor(GAME_ID_ID), finalCandidate, finalDiag("1039744", GAME_B));
  assert.equal(otherMatch.accepted, false);
  assert.equal(otherMatch.accepted === false && otherMatch.rejection.reason_code, "PHYSICAL_EVENT_ID_MISMATCH");
});

test("PMEA-13: legacy Reservation capture behaves as before (no claim, own markets captured even with no live-B family); no sibling reads", async () => {
  const res = reservation({ source_lineage: { provider_event_id: "1039742", provider_event_start_iso: START }, candidate_manifest: manifestA },
    LEGACY_ID);
  const { reads, run, observations } = await capture(res, { "1039742": exactScore("1039742", GAME_A) });
  assert.deepEqual(reads, ["1039742"]);
  assert.equal(run.failure_reason, null);
  assert.ok(observations.length > 0, "previously-successful capture is not turned into a failure");
});

test("PMEA-14: a claimed gameId must be confirmed by the exact-event payload (payload without gameId fails closed)", () => {
  const noGame = moneyline("1039742", GAME_A).map((m) => ({ ...m, provider_game_id: null }));
  assert.equal(providerEventIdentityContradiction({ gameId: GAME_A, marketType: "moneyline" }, noGame), "GAME_ID_MISMATCH");
});
