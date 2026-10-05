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
  PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS,
  PHYSICAL_EVENT_GAME_ID_UNRESOLVED,
  PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION,
  captureReservationMarketObservation,
  sameGameLiveUniverse,
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

// Live Gamma shape for ONE game: main (moneyline), more-markets (spreads/totals/corners),
// halftime and exact-score events — all carrying the same gameId and start.
const gameEvents = (gameId: string, extra: Mkt[] = []): Mkt[] => [
  ...moneyline("1039742", gameId), ...moreMarkets("1041677", gameId),
  ...halftime("1039756", gameId), ...exactScore("1039754", gameId), ...extra,
];
const withCount = (markets: Mkt[]): Mkt[] => {
  const per = new Map<string, number>();
  markets.forEach((m) => per.set(m.provider_event_id!, (per.get(m.provider_event_id!) ?? 0) + 1));
  return markets.map((m) => ({ ...m, sibling_market_count: per.get(m.provider_event_id!)! }));
};

async function capture(
  res: NightEventReservationRow,
  byEvent: Record<string, Mkt[]>,
  game: Mkt[] | Error = [],
) {
  const reads: string[] = [];
  const gameReads: string[] = [];
  let run: Record<string, unknown> = {};
  let observations: Record<string, unknown>[] = [];
  await captureReservationMarketObservation(res, "T_MINUS_30", {
    observedAt: "2026-10-01T16:20:00Z",
    alreadyCaptured: async () => false,
    readExactEvent: async (id) => { reads.push(id); const m = byEvent[id]; if (!m) throw new Error("unavailable"); return m; },
    readGameEvents: async (gameId) => { gameReads.push(gameId); if (game instanceof Error) throw game; return game; },
    fetchBooks: async (tokens: string[]) => tokens.map(() => ({ ok: false, errorCode: "NO_BOOK", latencyMs: 1 })) as never,
    write: async (r, o) => { run = r; observations = o; },
  });
  return { reads, gameReads, run, observations };
}

const idA = physicalMatchId({ eventId: "1039754", eventStartIso: START, gameId: GAME_A });
const legacyIdA = "provider:polymarket:1039754:2026-10-01";
const legacyIdHalf = "provider:polymarket:1039756:2026-10-01";
const lineageA = { provider_event_id: "1039754", provider_event_start_iso: START, provider_game_id: GAME_A, provider_market_type: "moneyline" };
const legacyLineage = { provider_event_id: "1039754", provider_event_start_iso: START }; // predates gameId authority
// Frozen Planning evidence only; live capture must never read it (it lists an OTHER-match event on purpose).
const manifestA = [
  { provider_event_id: "1039742", provider_game_id: GAME_A },
  { provider_event_id: "1039744", provider_game_id: GAME_B },
];
const fams = (obs: Record<string, unknown>[]) => [...new Set(obs.map((o) => o.canonical_market_family))].sort();

test("LSG-A: legacy Reservation on a derivative exact-score event — gameId derived from the exact lineage event, same-game discovery supplies moneyline/spreads/totals/corners, derivatives excluded", async () => {
  const res = reservation({ source_lineage: legacyLineage }, legacyIdA);
  const { reads, gameReads, run, observations } = await capture(res, { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(gameEvents(GAME_A)));
  assert.deepEqual(reads, ["1039754"], "only the exact lineage event is read by id");
  assert.deepEqual(gameReads, [GAME_A], "one bounded same-game query, gameId derived from the lineage event");
  assert.equal(run.failure_reason, null);
  assert.equal(run.capture_status, "COMPLETE", "multi-event same-game capture is complete when each event supplied all its markets");
  assert.equal(run.capture_complete, true);
  assert.deepEqual(fams(observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.equal(observations.some((o) => /exact_score|halftime/.test(String(o.provider_market_type_raw))), false);
  assert.ok(observations.every((o) => o.physical_event_id === legacyIdA && o.reservation_id === res.id), "all observations stay bound to the ONE existing Reservation");
  assert.equal(res.physical_event_id, legacyIdA, "persisted Reservation identity is not rewritten");
});

test("LSG-B: legacy halftime lineage behaves the same", async () => {
  const res = reservation({ source_lineage: { provider_event_id: "1039756", provider_event_start_iso: START } }, legacyIdHalf);
  const { observations, run } = await capture(res, { "1039756": withCount(halftime("1039756", GAME_A)) }, withCount(gameEvents(GAME_A)));
  assert.equal(run.failure_reason, null);
  assert.deepEqual(fams(observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.equal(observations.some((o) => /halftime/.test(String(o.provider_market_type_raw))), false);
});

test("LSG-C/D: a one-entry old candidate_manifest does not limit discovery, and a missing candidate_manifest does not block it", async () => {
  const one = await capture(reservation({ source_lineage: legacyLineage, candidate_manifest: [{ provider_event_id: "1039754", provider_game_id: GAME_A }] }, legacyIdA),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(gameEvents(GAME_A)));
  const none = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(gameEvents(GAME_A)));
  for (const r of [one, none]) {
    assert.equal(r.run.failure_reason, null);
    assert.deepEqual(fams(r.observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  }
});

test("LSG-E/F: a sibling with another gameId, or the same gameId at a different start, is rejected; never substituted", async () => {
  const otherGame = withCount([...gameEvents(GAME_A), ...moneyline("1039744", GAME_B), ...moreMarkets("1041676", GAME_B)]);
  const e = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA), { "1039754": withCount(exactScore("1039754", GAME_A)) }, otherGame);
  assert.ok(e.observations.length > 0);
  assert.ok(e.observations.every((o) => !String(o.condition_id).includes("1039744") && !String(o.condition_id).includes("1041676")), "GAME_B events excluded");

  const lateStart: Mkt[] = moneyline("1039799", GAME_A).map((m) => ({ ...m, event_start_iso: "2026-10-01T19:00:00Z" }));
  const f = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount([...gameEvents(GAME_A), ...lateStart]));
  assert.ok(f.observations.every((o) => !String(o.condition_id).includes("1039799")), "same gameId, different start excluded");
  assert.deepEqual(fams(f.observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
});

test("LSG-G: gameId discovery ambiguity fails closed with a typed reason and captures nothing", async () => {
  const ambiguous = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, new Error(PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS));
  assert.equal(ambiguous.run.failure_reason, PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS);
  assert.equal(ambiguous.run.capture_status, "CAPTURE_FAILED");
  assert.equal(ambiguous.observations.length, 0, "no fallback to the lineage event alone");

  const mixed = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA),
    { "1039754": [...exactScore("1039754", GAME_A).slice(0, 1), ...exactScore("1039754", GAME_B).slice(0, 1)] }, withCount(gameEvents(GAME_A)));
  assert.equal(mixed.run.failure_reason, PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS);

  const noGame = await capture(reservation({ source_lineage: legacyLineage }, legacyIdA),
    { "1039754": exactScore("1039754", GAME_A).map((m) => ({ ...m, provider_game_id: null })) }, withCount(gameEvents(GAME_A)));
  assert.equal(noGame.run.failure_reason, PHYSICAL_EVENT_GAME_ID_UNRESOLVED);
  assert.equal(noGame.observations.length, 0);
});

test("LSG-H: a game-based Reservation validates its stored gameId against the provider and fails closed on disagreement", async () => {
  const ok = await capture(reservation({ source_lineage: lineageA }, idA), { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(gameEvents(GAME_A)));
  assert.equal(ok.run.failure_reason, null);
  assert.deepEqual(fams(ok.observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.ok(ok.observations.every((o) => o.physical_event_id === idA));

  const bad = await capture(reservation({ source_lineage: { ...lineageA, provider_game_id: GAME_B } }, physicalMatchId({ eventId: "1039754", eventStartIso: START, gameId: GAME_B })),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(gameEvents(GAME_A)));
  assert.equal(bad.run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
  assert.equal(bad.observations.length, 0);
  assert.deepEqual(bad.gameReads, [], "no discovery is run for a contradicted identity");
});

test("LSG-derivative-only: a game whose only supported universe is absent fails closed with the typed contradiction", async () => {
  const exactOnly = await capture(reservation({ source_lineage: lineageA }, idA),
    { "1039754": withCount(exactScore("1039754", GAME_A)) }, withCount(exactScore("1039754", GAME_A)));
  assert.equal(exactOnly.run.capture_status, "CAPTURE_FAILED");
  assert.equal(exactOnly.run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
  assert.equal(exactOnly.observations.length, 0);
});

test("LSG-pure: sameGameLiveUniverse rejects non-numeric ids, other gameIds and other starts, and reports incomplete event sets", () => {
  const good = withCount(gameEvents(GAME_A));
  const junk: Mkt[] = [
    ...moneyline("abc", GAME_A), ...moneyline("1", GAME_B),
    ...moneyline("2", GAME_A).map((m) => ({ ...m, event_start_iso: "2026-10-01T20:00:00Z" })),
  ];
  const u = sameGameLiveUniverse(GAME_A, START, [], [...good, ...junk]);
  assert.deepEqual([...new Set(u.markets.map((m) => m.provider_event_id))].sort(), ["1039742", "1041677"]);
  assert.equal(u.eventSetsComplete, true);
  const partial = sameGameLiveUniverse(GAME_A, START, [], good.map((m) => ({ ...m, sibling_market_count: m.sibling_market_count + 1 })));
  assert.equal(partial.eventSetsComplete, false);
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
    capture_run_id: "run", reservation_id: "77777777-7777-4777-8777-777777777777", observation_phase: "T_MINUS_10", physical_event_id: idA, event_start_iso: START, condition_id: m.condition_id!,
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

test("PMEA-13: legacy Reservation (no stored gameId) keeps its persisted identity; gameId is derived live from the lineage event and discovery is same-game only", async () => {
  const res = reservation({ source_lineage: { provider_event_id: "1039742", provider_event_start_iso: START }, candidate_manifest: manifestA }, LEGACY_ID);
  const { reads, gameReads, run, observations } = await capture(res, { "1039742": withCount(moneyline("1039742", GAME_A)) }, withCount(gameEvents(GAME_A)));
  assert.deepEqual(reads, ["1039742"], "the stale manifest's other-game sibling is never read");
  assert.deepEqual(gameReads, [GAME_A]);
  assert.equal(run.failure_reason, null);
  assert.deepEqual(fams(observations), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.ok(observations.every((o) => o.physical_event_id === LEGACY_ID));
});

test("PMEA-14: a claimed gameId must be confirmed by the exact-event payload (payload without gameId fails closed)", () => {
  const noGame = moneyline("1039742", GAME_A).map((m) => ({ ...m, provider_game_id: null }));
  assert.equal(providerEventIdentityContradiction({ gameId: GAME_A, marketType: "moneyline" }, noGame), "GAME_ID_MISMATCH");
});

// ── Same-game T3 universe → B (live capture no longer depends on frozen manifest siblings) ──
async function captureT3(res: NightEventReservationRow, askFor: (tokenId: string) => number) {
  let run: Record<string, unknown> = {};
  let observations: Record<string, unknown>[] = [];
  await captureReservationMarketObservation(res, "T_MINUS_10", {
    observedAt: "2026-10-01T16:42:00Z", alreadyCaptured: async () => false,
    readExactEvent: async () => withCount(exactScore("1039754", GAME_A)),
    readGameEvents: async () => withCount(gameEvents(GAME_A)),
    fetchBooks: async (ids: string[]) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1,
      book: { tokenId, bids: [{ price: askFor(tokenId) - 0.02, size: 100 }], asks: [{ price: askFor(tokenId), size: 100 }], raw: {} } })) as never,
    fetchFeeSchedule: async (tokenId) => ({ ok: false, tokenId, errorCode: "FEE_TEST_OFFLINE", latencyMs: 0 }),
    readT30Universe: async () => [],
    write: async (r, o) => { run = r; observations = o; },
  });
  return { run, observations: observations as unknown as FinalT3MarketObservation[] };
}

test("LSG-I/J/K: B selects ONE qualifying same-game observation from the captured T3 universe; no Planning score is created", async () => {
  const res = reservation({ source_lineage: legacyLineage }, legacyIdA);
  // Only the main-event MONEYLINE token sits in B's support region (odds 1.85–2.00).
  const ml = await captureT3(res, (t) => (t.includes("ml-home") ? 0.52 : 0.8));
  assert.equal(ml.run.capture_status, "COMPLETE");
  const mlB = selectReservationT3AbDecisions(res, ml.observations).b;
  assert.ok(mlB.selectedIdentity, "a same-game MONEYLINE sibling qualifies");
  const picked = ml.observations.filter((o) => o.condition_id === mlB.selectedIdentity!.conditionId && o.token_id === mlB.selectedIdentity!.tokenId);
  assert.equal(picked.length, 1, "exactly one economic instruction for the Reservation");
  assert.equal(picked[0].canonical_market_family, "MONEYLINE");
  assert.match(String(picked[0].condition_id), /1039742/, "selected market comes from the same-game main event, not the exact-score lineage event");
  assert.equal(picked[0].reservation_id, res.id);
  assert.equal(picked[0].physical_event_id, legacyIdA);

  // SPREADS outranks MONEYLINE when both qualify (B priority unchanged).
  const both = await captureT3(res, (t) => (t.includes("ml-home") || t.includes("spread-home") ? 0.52 : 0.8));
  const bothB = selectReservationT3AbDecisions(res, both.observations).b;
  assert.equal(both.observations.find((o) => o.condition_id === bothB.selectedIdentity!.conditionId)!.canonical_market_family, "SPREADS");

  // No Planning/model score is synthesized for any discovered sibling.
  const keys = new Set(ml.observations.flatMap((o) => Object.keys(o)).concat(Object.keys(ml.run)));
  assert.equal([...keys].some((k) => /score|confidence|rank|signal_pair/i.test(k)), false);
});
