// PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1 — focused proof.
//   node --import tsx --test tests/contur3/precontractT20Research.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateApprovedMigrationRelease } from "../../scripts/control-plane/lib/premvp-application-migration-release.mjs";
import {
  AMERICAN_FOOTBALL_NOT_PROVEN, MAX_NEW_EVENTS_PER_TICK, MAX_RESEARCH_EVENTS_PER_DAY, MAX_RESEARCH_TOKEN_ROWS_PER_EVENT,
  EVENT_UNIVERSE_CEILING, PRECONTRACT_RESEARCH_SOURCE, RESEARCH_TICK_BUDGET_MS, compareUrgency, SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA, createResearchStore, admitResearchMarket, buildResearchEvents, captureResearchEvent,
  inT20Window, isAdmittedTargetSport, runPrecontractT20ResearchFailSoft, runPrecontractT20ResearchTick as realTick, selectResearchCohort,
  createResearchStartState, type ResearchTickDeps, type FetchProviderStarts, type ResearchStartState,
  T20_RESCHEDULE_HORIZON_MINUTES, MAX_START_RECHECK_BATCHES_PER_TICK, PROVIDER_START_MAX_AGE_MS, PROVIDER_START_SOURCE, PROVIDER_START_SOURCE_LEGACY, PROVIDER_START_REASONS,
  type EventCaptureOutcome, type ResearchEvent, type ResearchEventCandidateRow, type ResearchStore, type CohortSelection,
} from "../../lib/executor/precontractT20Research";
import { EARLY_CAPTURE_WINDOW_OPEN_MINUTES } from "../../lib/executor/reservationMarketBaseline";

// TELEMETRY-08C: the tick reconciles Gamma's current start before T20 eligibility. Existing tests model an UNCHANGED provider:
// the stub answers every requested id with the snapshot start it saw in the store, acquired at the tick time.
function runPrecontractT20ResearchTick(nowMs: number, deps: ResearchTickDeps) {
  const seen = new Map<string, { start: string; game: string | null }>();
  const store: ResearchStore = {
    ...deps.store,
    async loadEventCandidates(...a) {
      const rows = await deps.store.loadEventCandidates(...a);
      for (const r of rows) seen.set(r.provider_event_id, { start: r.event_start_iso, game: r.provider_game_id });
      return rows;
    },
  };
  return realTick(nowMs, {
    startState: createResearchStartState(),
    fetchProviderStarts: async (ids) => ({
      acquiredAtMs: nowMs, latencyMs: 1, requestedN: ids.length,
      events: ids.map((id) => ({ id, gameId: seen.get(id)?.game ?? null, startTime: seen.get(id)?.start ?? null, endDate: null, endDateIso: null })),
    }),
    ...deps, store,
  });
}

const DAY_START = Date.parse("2026-10-08T18:00:00.000Z");
const NOW = DAY_START - 15 * 60_000;
let seq = 0;
const ev = (family: string | null, volume: number | null, over: Partial<ResearchEvent> = {}): ResearchEvent => {
  const n = ++seq;
  return {
    physicalEventId: `provider:polymarket:game:${n}:2026-10-08`, providerEventId: String(1000 + n), providerGameId: String(n),
    eventStartIso: new Date(DAY_START + (n % 7) * 60_000).toISOString(), sportFamily: family, sportCode: family,
    sportSource: "structured_sports_tag", volume, volumeContradiction: false, sourceId: `generated_signal_research_snapshots:run-${n}`, ...over,
  };
};
const many = (family: string, n: number, base = 1000) => Array.from({ length: n }, (_, i) => ev(family, base + i));
const count = (sel: CohortSelection[], f: (s: CohortSelection) => boolean) => sel.filter(f).length;

test("1/4/12: cohort membership is ranked by parentEventVolume24hr only (no score/Contract A/Reservation input exists)", () => {
  const events = [ev("soccer", 10), ev("soccer", 90), ev("soccer", 50)];
  const { selected } = selectResearchCohort(events);
  assert.deepEqual(selected.map((s) => s.event.volume), [90, 50, 10]);
  assert.deepEqual(selected.map((s) => s.rank), [1, 2, 3]);
  assert.equal(selectResearchCohort.length, 1, "selector takes only events: no model-score or reservation parameter");
});

const cand = (over: Partial<ResearchEventCandidateRow> = {}): ResearchEventCandidateRow => ({
  provider_event_id: "11", provider_game_id: "G1", event_start_iso: new Date(DAY_START).toISOString(), snapshot_run_id: "r1",
  snapshot_at: "2026-10-08T17:00:00Z", provider_sport_family: "soccer", provider_sport_family_n: 1, provider_sport_code: "epl",
  provider_sport_code_n: 1, provider_sport_source: "structured_sports_tag", provider_sport_source_n: 1,
  parent_event_volume_24h: 500, volume_contradiction: false, ...over,
});

test("5: event-level candidates keep the physicalMatchId identity; a duplicate physical id is collapsed, never double counted", () => {
  const events = buildResearchEvents([cand(), cand({ provider_event_id: "12", snapshot_at: "2026-10-08T17:30:00Z", snapshot_run_id: "r2" })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].physicalEventId, "provider:polymarket:game:g1:2026-10-08");
  assert.equal(events[0].volume, 500);
  assert.equal(events[0].sourceId, "generated_signal_research_snapshots:r2", "newest snapshot wins");
  const noGame = buildResearchEvents([cand({ provider_game_id: null, provider_event_id: "77" })]);
  assert.equal(noGame[0].physicalEventId, "provider:polymarket:77:2026-10-08");
});

test("12b: server-flagged contradictory parent volumes exclude the event and are counted (never silently chosen)", () => {
  const events = buildResearchEvents([cand({ parent_event_volume_24h: null, volume_contradiction: true })]);
  assert.equal(events[0].volumeContradiction, true);
  const { selected, diagnostics } = selectResearchCohort(events);
  assert.equal(selected.length, 0);
  assert.equal(diagnostics.volume_contradiction_event_n, 1);
});

test("6/7/8/9: soccer 40, tennis 20, other 40, total never above 100", () => {
  const events = [...many("soccer", 90), ...many("tennis", 50), ...many("basketball", 30, 5000), ...many("baseball", 30, 4000), ...many("hockey", 30, 3000), ...many("cricket", 30, 2000)];
  const { selected, diagnostics } = selectResearchCohort(events);
  assert.equal(count(selected, (s) => s.event.sportFamily === "soccer"), 40);
  assert.equal(count(selected, (s) => s.event.sportFamily === "tennis"), 20);
  assert.equal(count(selected, (s) => !["soccer", "tennis"].includes(s.event.sportFamily as string)), 40);
  assert.equal(selected.length, 100);
  assert.ok(selected.length <= MAX_RESEARCH_EVENTS_PER_DAY);
  assert.equal(diagnostics.global_backfill_n, 0);
  assert.equal(new Set(selected.map((s) => s.event.physicalEventId)).size, selected.length);
});

test("10: other-sport floor is max 4 per supplied sport, then pure liquidity fill across the combined pool", () => {
  // basketball dominates liquidity; floor still guarantees 4 of each other sport that has supply.
  const events = [...many("basketball", 60, 100000), ...many("baseball", 10, 10), ...many("hockey", 2, 5), ...many("cricket", 10, 1)];
  const { selected, diagnostics } = selectResearchCohort(events);
  const other = selected.filter((s) => s.bucket.startsWith("OTHER"));
  assert.equal(other.length, 40);
  assert.equal(count(other, (s) => s.bucket === "OTHER_DIVERSITY_FLOOR"), 4 + 4 + 2 + 4);
  assert.equal(diagnostics.other_diversity_floor_n, 14);
  assert.equal(diagnostics.other_liquidity_fill_n, 26);
  assert.equal(count(other, (s) => s.event.sportFamily === "hockey"), 2, "unused hockey floor returns to the pool");
  assert.equal(count(other, (s) => s.event.sportFamily === "basketball"), 30, "4 floor + 26 pure-liquidity fill");
  const fill = other.filter((s) => s.bucket === "OTHER_LIQUIDITY_FILL").map((s) => s.event.volume as number);
  assert.deepEqual(fill, [...fill].sort((a, b) => b - a), "fill is volume-first");
});

test("11: quota underfill is explicit and global backfill stays volume-first", () => {
  const events = [...many("soccer", 10, 100), ...many("tennis", 5, 100), ...many("basketball", 80, 1000)];
  const { selected, diagnostics } = selectResearchCohort(events);
  assert.equal(diagnostics.soccer_quota_underfill_n, 30);
  assert.equal(diagnostics.tennis_quota_underfill_n, 15);
  assert.equal(diagnostics.global_backfill_n, 40, "backfill is bounded by the remaining eligible supply (40 basketball left)");
  assert.equal(selected.length, 95);
  const backfill = selected.filter((s) => s.bucket === "GLOBAL_BACKFILL").map((s) => s.event.volume as number);
  assert.deepEqual(backfill, [...backfill].sort((a, b) => b - a));
  assert.ok(selected.length <= 100);
  // never invents events: a tiny supply yields a tiny cohort, reported as underfilled
  const small = selectResearchCohort(many("soccer", 3));
  assert.equal(small.selected.length, 3);
  assert.equal(small.diagnostics.soccer_quota_underfill_n, 37);
});

test("13: all structured sport families are admitted; unknown/unstructured identity is not", () => {
  for (const f of ["soccer", "tennis", "basketball", "baseball", "hockey", "cricket"]) assert.equal(isAdmittedTargetSport(ev(f, 1)), true, f);
  assert.equal(isAdmittedTargetSport(ev("esports", 1)), false);
  assert.equal(isAdmittedTargetSport(ev(null, 1)), false);
});

test("14: American football is admitted only with exact structured authority; otherwise NOT_PROVEN is recorded", () => {
  assert.equal(isAdmittedTargetSport(ev("american-football", 1)), true);
  assert.equal(isAdmittedTargetSport(ev("american-football", 1, { sportSource: null })), false);
  assert.equal(isAdmittedTargetSport(ev("american-football", 1, { sportSource: "title_text" })), false);
  const none = selectResearchCohort(many("basketball", 3));
  assert.equal(none.diagnostics.american_football_identity_state, AMERICAN_FOOTBALL_NOT_PROVEN);
  const proven = selectResearchCohort([ev("american-football", 7)]);
  assert.equal(proven.diagnostics.american_football_selected_n, 1);
  // existing score authority is untouched: football never becomes american football by alias
  assert.match(readFileSync("lib/feed/sportScoreOwnership.ts", "utf8"), /football: "soccer"/);
});

test("NFL_STRUCTURED_CODE_PROOF: family NULL + code nfl + structured_sports_tag -> American football admitted; code stays nfl", () => {
  const nfl = (over: Partial<ResearchEventCandidateRow> = {}) => cand({ provider_game_id: "N1", provider_sport_family: null, provider_sport_family_n: 0, provider_sport_code: "nfl", ...over });
  const [e] = buildResearchEvents([nfl()]);
  assert.equal(e.sportFamily, "american-football");
  assert.equal(e.sportCode, "nfl", "provider code is persisted unchanged");
  assert.equal(e.sportSource, "structured_sports_tag");
  assert.equal(isAdmittedTargetSport(e), true);
  const sel = selectResearchCohort([e]);
  assert.equal(sel.selected.length, 1);
  assert.equal(sel.diagnostics.american_football_identity_state, "ADMITTED");
  assert.equal(buildResearchEvents([nfl({ provider_sport_code: "NFL" })])[0].sportFamily, "american-football", "code compare is case-insensitive");
  // rejected: non-structured / missing / ambiguous source, ambiguous code, contradictory or conflicting family
  for (const over of [
    { provider_sport_source: "title_text" }, { provider_sport_source: null, provider_sport_source_n: 0 }, { provider_sport_source_n: 2 },
    { provider_sport_code_n: 2 }, { provider_sport_code: "nflx" }, { provider_sport_family_n: 2, provider_sport_family: "soccer" },
  ] as Partial<ResearchEventCandidateRow>[]) {
    const [x] = buildResearchEvents([nfl(over)]);
    assert.equal(x.sportFamily, null, JSON.stringify(over));
    assert.equal(isAdmittedTargetSport(x), false, JSON.stringify(over));
  }
  const [other] = buildResearchEvents([nfl({ provider_sport_family: "soccer", provider_sport_family_n: 1 })]);
  assert.equal(other.sportFamily, "soccer", "an existing structured family is never overridden by the nfl code rule");
});

test("NFL_SCORE_MODEL_UNCHANGED: score ownership has no american football and the research module never imports it", () => {
  const ownership = readFileSync("lib/feed/sportScoreOwnership.ts", "utf8");
  assert.equal(/american-football|nfl/i.test(ownership), false);
  assert.equal(/sportScoreOwnership|fireModel/i.test(readFileSync("lib/executor/precontractT20Research.ts", "utf8")), false);
});

test("15/16/17: MONEYLINE/SPREAD/TOTAL via existing authority, soccer full-match TOTAL_CORNERS admitted, derivatives excluded", () => {
  assert.equal(admitResearchMarket("basketball", "moneyline", "x").type, "MONEYLINE");
  assert.equal(admitResearchMarket("basketball", "spreads", "x").admitted, true);
  assert.equal(admitResearchMarket("baseball", "totals", "x").admitted, true);
  assert.equal(admitResearchMarket("soccer", "total_corners", "soccer-epl-a-b-total-corners-9pt5").admitted, true);
  for (const slug of ["x-team-total-corners", "x-first-half-total-corners", "x-second-half-total-corners", "x-corners-odd-even", "x-first-corner", "x-last-corner", "x-home-corners"]) {
    assert.equal(admitResearchMarket("soccer", "total_corners", slug).admitted, false, slug);
  }
  assert.equal(admitResearchMarket("basketball", "total_corners", "x").admitted, false, "corners only for soccer");
  for (const raw of ["exact_score", "soccer_halftime_result", "player_props", "first_half_moneyline_x"]) assert.equal(admitResearchMarket("soccer", raw, "x").admitted, false, raw);
  // full event cannot be proven for tennis/cricket spread/total: skipped, never guessed
  assert.equal(admitResearchMarket("tennis", "totals", "x").admitted, false);
  assert.equal(admitResearchMarket("cricket", "spreads", "x").admitted, false);
  assert.equal(admitResearchMarket("tennis", "moneyline", "x").admitted, true);
});

test("T20 business window is 9 < minutes <= 20", () => {
  const at = (m: number) => new Date(NOW + m * 60_000).toISOString();
  assert.equal(inT20Window(at(9), NOW), false);
  assert.equal(inT20Window(at(9.01), NOW), true);
  assert.equal(inT20Window(at(20), NOW), true);
  assert.equal(inT20Window(at(20.01), NOW), false);
  assert.equal(inT20Window(at(40), NOW), false);
  assert.equal(inT20Window(at(3), NOW), false);
});

// ---- capture / tick with fakes ---------------------------------------------------------------------------------
const START = new Date(DAY_START).toISOString();
const mk = (eventId: string, gameId: string, type: string, slug: string, siblings: number, cond: string) => ({
  provider_event_id: eventId, event_start_iso: START, condition_id: cond, clob_token_ids: [`${cond}-a`, `${cond}-b`], outcomes: ["Yes", "No"],
  sports_market_type: type, provider_market_slug: slug, sibling_market_count: siblings, last_observed_at: START, provider_game_id: gameId,
});
const fakeBooks = async (ids: string[]) => ids.map((id) => ({
  ok: true as const, latencyMs: 1,
  book: { tokenId: id, bids: [{ price: 0.4, size: 100 }], asks: [{ price: 0.45, size: 100 }], tickSize: 0.01, minimumOrderSize: 1 },
}));
const noFee = async (tokenId: string) => ({ ok: false as const, tokenId, errorCode: "FEE_TEST", latencyMs: 0 });
const selection = (over: Partial<ResearchEvent> = {}): CohortSelection => ({ event: ev("soccer", 100, { providerEventId: "11", providerGameId: "G1", eventStartIso: START, ...over }), bucket: "SOCCER", rank: 1 });

test("3/16/17/18: capture writes scalar research rows only; corners derivatives excluded; >128 tokens fails closed", async () => {
  const markets = [
    mk("11", "G1", "moneyline", "m", 4, "c1"), mk("11", "G1", "total_corners", "soccer-x-total-corners-9pt5", 4, "c2"),
    mk("11", "G1", "total_corners", "soccer-x-team-total-corners", 4, "c3"), mk("11", "G1", "exact_score", "exact", 4, "c4"),
  ];
  const out = await captureResearchEvent(selection(), START, { readExactEvent: async () => markets, readGameEvents: async () => markets, fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never });
  assert.equal(out.kind, "CAPTURED");
  if (out.kind !== "CAPTURED") return;
  assert.deepEqual([...new Set(out.rows.map((r) => r.canonical_market_type))].sort(), ["MONEYLINE", "TOTAL_CORNERS"]);
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows.every((r) => r.observation_phase === "T_MINUS_10" && r.sampling_bucket === "SOCCER" && r.orderbook_fetch_status === "SUCCESS"), true);
  assert.equal(out.rows.some((r) => "reservation_id" in r || "raw" in r || "diagnostics" in r), false);
  assert.equal(out.rows[0].executable_full_stake, true);

  const big = Array.from({ length: 65 }, (_, i) => mk("11", "G1", "moneyline", `m${i}`, 65, `big${i}`));
  const over = await captureResearchEvent(selection(), START, { readExactEvent: async () => big, readGameEvents: async () => big, fetchBooks: fakeBooks as never });
  assert.equal(over.kind, "TOKEN_BUDGET_EXCEEDED");
  assert.equal(MAX_RESEARCH_TOKEN_ROWS_PER_EVENT, 128);
});

function fakeStore(rows: ResearchEventCandidateRow[], captured: Set<string> = new Set()) {
  const written: Record<string, unknown>[][] = [];
  const tables: string[] = [];
  const calls = { load: 0, purge: 0 };
  const store: ResearchStore = {
    async loadEventCandidates() { calls.load++; tables.push("generated_signal_research_snapshots"); return rows; },
    async capturedAmong(ids) { return new Set(ids.filter((i) => captured.has(i))); },
    async capturedEventCount() { return captured.size; },
    async writeRows(r) { tables.push("research_precontract_t20_observations"); written.push(r); },
    async purgeExpired(_c, limit) { calls.purge++; assert.ok(limit <= 1000); return 0; },
  };
  return { store, written, tables, calls };
}
const sourceRow = (n: number, vol: number, family = "soccer", startOffsetMin = 15): ResearchEventCandidateRow => cand({
  provider_event_id: String(n), provider_game_id: `G${n}`, snapshot_run_id: `run-${n}`, snapshot_at: new Date(NOW - 60_000).toISOString(),
  event_start_iso: new Date(NOW + startOffsetMin * 60_000).toISOString(), parent_event_volume_24h: vol, provider_sport_family: family, provider_sport_code: null, provider_sport_code_n: 0,
});
const gameMarkets = (eventId: string, gameId: string, startIso: string) => [{ ...mk(eventId, gameId, "moneyline", "m", 1, `c-${eventId}`), event_start_iso: startIso }];

test("1/2/3/9: non-reserved pre-Contract-A events are captured; <=5 new events/tick; only research tables touched; job evidence is aggregate", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => sourceRow(i + 1, 1000 - i));
  const { store, written, tables } = fakeStore(rows);
  const jobs: Record<string, unknown>[] = [];
  const result = await runPrecontractT20ResearchTick(NOW, {
    store, writeJobRun: async (j) => { jobs.push(j as never); },
    readExactEvent: async (id, start) => gameMarkets(id, `G${id}`, start), readGameEvents: async (g, start) => gameMarkets(g.slice(1), g, start),
    fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never,
  });
  assert.equal(result.status, "success");
  assert.equal(written.length, MAX_NEW_EVENTS_PER_TICK);
  assert.equal(result.diagnostics.captured_event_n, 5);
  assert.deepEqual(written.map((w) => w[0].parent_event_volume_24h), [1000, 999, 998, 997, 996], "highest liquidity first");
  assert.deepEqual([...new Set(tables)].sort(), ["generated_signal_research_snapshots", "research_precontract_t20_observations"]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, PRECONTRACT_RESEARCH_SOURCE);
  const blob = JSON.stringify(jobs[0].diagnostics);
  assert.equal(/provider:polymarket|"c-\d+/.test(blob), false, "no raw identities inside job_runs");
  for (const key of ["eligible_event_n", "soccer_selected_n", "soccer_quota_underfill_n", "token_rows_written_n", "unsupported_market_type_counts", "duration_ms"]) assert.ok(key in (jobs[0].diagnostics as object), key);
});

test("already-captured events are not re-captured and the daily cap blocks writes at 100", async () => {
  const rows = [sourceRow(1, 900)];
  const physical = buildResearchEvents(rows)[0].physicalEventId;
  const a = fakeStore(rows, new Set([physical]));
  const r1 = await runPrecontractT20ResearchTick(NOW, { store: a.store, readExactEvent: async () => [], readGameEvents: async () => [] });
  assert.equal(a.written.length, 0);
  assert.equal(r1.diagnostics.already_captured_event_n, 1);
  const full = new Set(Array.from({ length: 100 }, (_, i) => `other-${i}`));
  const b = fakeStore(rows, full);
  await runPrecontractT20ResearchTick(NOW, { store: b.store, readExactEvent: async (id, s) => gameMarkets(id, `G${id}`, s), readGameEvents: async (g, s) => gameMarkets(g.slice(1), g, s), fetchBooks: fakeBooks as never });
  assert.equal(b.written.length, 0, "daily cap of 100 events cannot be exceeded");
});

test("19: research failure or timeout never throws and leaves the live caller untouched", async () => {
  const throwing: ResearchStore = { ...fakeStore([]).store, loadEventCandidates: async () => { throw new Error("db down"); } };
  await assert.doesNotReject(runPrecontractT20ResearchFailSoft(NOW, { store: throwing }));
  await assert.doesNotReject(runPrecontractT20ResearchFailSoft(NOW, async () => { throw new Error("factory down"); }));
  const hanging: ResearchStore = { ...fakeStore([]).store, loadEventCandidates: () => new Promise(() => undefined) };
  const t0 = Date.now();
  const res = await runPrecontractT20ResearchTick(NOW, { store: hanging, budgetMs: 50 });
  assert.equal(res.status, "error");
  assert.ok(Date.now() - t0 < 1000);
  const src = readFileSync("lib/executor/eventExecutionQueue.ts", "utf8");
  const hook = src.slice(src.indexOf("PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1"), src.indexOf("const result = await runEventRebalance(nowMs, opts, {"));
  assert.match(hook, /try \{[\s\S]*runPrecontractT20ResearchFailSoft[\s\S]*\} catch \{/);
  assert.equal(/\bresult\b/.test(hook.replace(/\/\/.*$/gm, "")), false, "research hook never reads or writes the rebalance result");
});

test("2/3/20: module is isolated from Reservation/Queue/Ireland tables and Reservation T40 is unchanged", () => {
  const src = readFileSync("lib/executor/precontractT20Research.ts", "utf8").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["night_event_reservations", "reservation_market_", "reservation_strategy", "execution_queue", "eventExecutionQueue", "ireland", "contractAB2EventPolicy", "liveReservationAllocationPolicy", "scoreObservation"]) {
    assert.equal(src.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(EARLY_CAPTURE_WINDOW_OPEN_MINUTES, 40);
  const baseline = readFileSync("lib/executor/reservationMarketBaseline.ts", "utf8");
  assert.match(baseline, /const upper = new Date\(nowMs \+ EARLY_CAPTURE_WINDOW_OPEN_MINUTES \* 60_000\)/);
  assert.match(readFileSync("lib/executor/eventExecutionQueue.ts", "utf8"), /captureReservationMarketMilestones\(nowMs, \{ getClient: runtimeClient \}\)/);
});

test("21/22: CURRENT_STATE records the founder-approved 40/20/40 roadmap and the guide repeats it without becoming state authority", () => {
  const state = readFileSync("docs/ai-context/control-plane/CURRENT_STATE.yaml", "utf8");
  const guide = readFileSync("docs/ai-context/control-plane/PRECONTRACT_RESEARCH_TELEMETRY_GUIDE_V1.md", "utf8");
  assert.match(state, /PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1/);
  assert.match(state, /PRECONTRACT_RESEARCH_TELEMETRY_GUIDE_V1\.md/);
  assert.match(state, /soccer[\s\S]{0,20}40/);
  for (const needle of ["soccer 40", "tennis 20", "remaining sports 40", "parentEventVolume24hr", "T20", "100", "TOTAL_CORNERS", "DBClone", "Reservation T40", "AMERICAN_FOOTBALL_STRUCTURED_IDENTITY_NOT_PROVEN"]) {
    assert.ok(guide.includes(needle), needle);
  }
  assert.match(guide, /not a current-state authority/i);
});

// ---- complete daily event universe (no raw-row truncation) ----------------------------------------------------------
test("TOP100_COMPLETE_EVENT_UNIVERSE / RAW_5000_TRUNCATION_REMOVED: >5000 identity rows cannot hide a high-volume event", async () => {
  // The server emits one record per physical event: the 11k+ raw identities of one run are already reduced. Model the
  // production shape: 276 events, the highest-volume tennis event is NOT in any 'newest' slice.
  const events: ResearchEventCandidateRow[] = [];
  for (let i = 1; i <= 275; i++) events.push(sourceRow(i, 10 + (i % 50), i % 4 === 0 ? "tennis" : "soccer"));
  const hidden = sourceRow(9999, 9_000_000, "tennis");
  events.unshift(hidden);
  const universe = buildResearchEvents(events);
  assert.ok(universe.length > 276 - 1);
  const { selected } = selectResearchCohort(universe);
  const top = selected.find((s) => s.event.providerEventId === "9999");
  assert.ok(top, "qualifying high-volume tennis event is in the cohort");
  assert.equal(top?.rank, 1);
  const src = readFileSync("lib/executor/precontractT20Research.ts", "utf8");
  assert.equal(/CANDIDATE_ROW_READ_LIMIT|\.limit\(Math\.min\(limit, 5/.test(src), false, "raw 5000 read limit removed");
  assert.equal(/order\("snapshot_at"/.test(src), false, "no newest-first raw slice");
  const sql = readFileSync("supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql", "utf8");
  assert.match(sql, /research_precontract_t20_event_candidates/);
  assert.match(sql, /GROUP BY k\.physical_key/);
  assert.equal(/select\s+\*\s+from\s+public\.generated_signal_research_snapshots/i.test(sql), false);
  assert.equal(/event_slug|title/i.test(sql.split("CREATE OR REPLACE FUNCTION")[1] ?? ""), false, "no title/slug identity in the aggregation");
  // end to end through the tick: the store is asked for the whole day with an EVENT ceiling, and the hidden event is captured first
  const captures: string[] = [];
  const { store } = fakeStore(events.map((r) => ({ ...r, event_start_iso: new Date(NOW + 15 * 60_000).toISOString() })));
  const seenArgs: number[] = [];
  const wrapped: ResearchStore = { ...store, loadEventCandidates: async (f, t, c) => { seenArgs.push(c); return store.loadEventCandidates(f, t, c); } };
  await runPrecontractT20ResearchTick(NOW, {
    store: wrapped,
    capture: async (sel) => { captures.push(sel.event.providerEventId); return { kind: "FAILED", reason: "X", unsupported: {} }; },
  });
  assert.equal(captures[0], "9999");
  assert.deepEqual([...new Set(seenArgs)], [EVENT_UNIVERSE_CEILING]);
});

test("RAW_5000_TRUNCATION_REMOVED: the store reads the daily universe ONLY through the event-level function, never raw GSRS rows", async () => {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    from: (table: string) => { throw new Error(`raw table read forbidden: ${table}`); },
    rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return { data: [cand()], error: null }; },
  };
  const store = createResearchStore(() => client as never);
  const rows = await store.loadEventCandidates("2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z", EVENT_UNIVERSE_CEILING);
  assert.equal(rows.length, 1);
  assert.deepEqual(rpcCalls, [{ fn: "research_precontract_t20_event_candidates", args: { p_from: "2026-10-07T00:00:00.000Z", p_to: "2026-10-08T00:00:00.000Z", p_ceiling: EVENT_UNIVERSE_CEILING } }]);
  const failing = createResearchStore(() => ({ rpc: async () => ({ data: null, error: { message: "x" } }) }) as never);
  await assert.rejects(failing.loadEventCandidates("a", "b", 1), /RESEARCH_SOURCE_READ_FAILED/);
});

test("event-universe ceiling fails closed with an explicit diagnostic (no silent loss, no capture)", async () => {
  const rows = Array.from({ length: EVENT_UNIVERSE_CEILING + 1 }, (_, i) => sourceRow(i + 1, 1000 - i));
  const { store, written } = fakeStore(rows);
  let captured = 0;
  const res = await runPrecontractT20ResearchTick(NOW, { store, capture: async () => { captured++; return { kind: "FAILED", reason: "X", unsupported: {} }; } });
  assert.equal(captured, 0);
  assert.equal(written.length, 0);
  assert.equal(res.status, "error");
  assert.equal(res.diagnostics.event_universe_ceiling_exceeded_day_n, 1);
  assert.equal(res.diagnostics.event_universe_ceiling, EVENT_UNIVERSE_CEILING);
});

// ---- hard deadline ---------------------------------------------------------------------------------------------
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise((r) => setTimeout(r, 30));
const okOutcome = (): EventCaptureOutcome => ({ kind: "CAPTURED", rows: [{ id: "late" }], unsupported: {} });

test("TIMEOUT_NO_LATE_WRITE: a slow in-flight capture that settles after the deadline is discarded (writeRows stays 0)", async () => {
  const rows = [sourceRow(1, 900), sourceRow(2, 800)];
  const { store, written, calls } = fakeStore(rows);
  const slow = deferred<EventCaptureOutcome>();
  let captureStarts = 0;
  const t0 = Date.now();
  const res = await runPrecontractT20ResearchTick(NOW, { store, budgetMs: 40, softStartMinRemainingMs: 0, capture: () => { captureStarts++; return slow.promise; } });
  assert.equal(res.status, "error");
  assert.equal(res.diagnostics.captured_event_n, 0);
  assert.ok(Date.now() - t0 < 1000);
  slow.resolve(okOutcome());               // the old work now settles AFTER the tick returned
  await settle(); await settle();
  assert.equal(written.length, 0, "no research write after the deadline");
  assert.equal(captureStarts, 1, "no further event capture begins after the deadline");
  assert.equal(calls.purge, 0, "no retention delete after the deadline");
});

test("TIMEOUT_NO_NEW_WORK_AFTER_DEADLINE: expired capture starts no provider request; expired tick starts no DB read/write/purge", async () => {
  let exact = 0, game = 0, books = 0;
  const slowExact = deferred<never[]>();
  const sel = selection();
  let live = true;
  const pending = captureResearchEvent(sel, START, {
    isLive: () => live,
    readExactEvent: () => { exact++; return slowExact.promise as never; },
    readGameEvents: async () => { game++; return []; },
    fetchBooks: (async () => { books++; return []; }) as never,
  });
  live = false;                                     // deadline expires while the first provider request is in flight
  slowExact.resolve([mk("11", "G1", "moneyline", "m", 1, "c1")] as never);
  const out = await pending;
  assert.deepEqual([out.kind, exact, game, books], ["FAILED", 1, 0, 0], "late provider result starts no further provider request");
  // already-expired deadline: capture starts nothing at all
  const none = await captureResearchEvent(sel, START, { isLive: () => false, readExactEvent: async () => { exact++; return []; } });
  assert.equal(none.kind, "FAILED");
  assert.equal(exact, 1);
  // tick: a deadline that expires during the first DB read stops everything after it
  const slowLoad = deferred<ResearchEventCandidateRow[]>();
  const base = fakeStore([sourceRow(1, 900)]);
  let capturedCalls = 0, writes = 0;
  const store: ResearchStore = {
    ...base.store, loadEventCandidates: () => slowLoad.promise,
    capturedAmong: async () => { throw new Error("must not start"); }, writeRows: async () => { writes++; },
  };
  await runPrecontractT20ResearchTick(NOW, { store, budgetMs: 30, capture: async () => { capturedCalls++; return okOutcome(); } });
  slowLoad.resolve([sourceRow(1, 900)]);
  await settle();
  assert.deepEqual([capturedCalls, writes, base.calls.purge], [0, 0, 0]);
});

test("deadline hygiene: a normal tick still captures, writes and purges inside the budget", async () => {
  const { store, written, calls } = fakeStore([sourceRow(1, 900)]);
  const res = await runPrecontractT20ResearchTick(NOW, { store, capture: async () => okOutcome() });
  assert.equal(res.status, "success");
  assert.equal(written.length, 1);
  assert.equal(calls.purge, 1);
});

test("GSRS game_start_iso index migration: concurrent, partial, index-only; RPC range predicate and 40/20/40 unchanged", () => {
  const sql = readFileSync("supabase/migrations/20261007090500_gsrs_game_start_iso_index.sql", "utf8");
  assert.equal(/^-- pg-delta: transaction=false$/m.test(sql), true);
  assert.equal(sql.split("\n")[0], "-- pg-delta: transaction=false");
  assert.equal(/^-- PREMVP_APPLICATION_MIGRATION_V1$/m.test(sql), true);
  const migrationFile = "supabase/migrations/20261007090500_gsrs_game_start_iso_index.sql";
  const release = validateApprovedMigrationRelease({
    declaration: { mode: "PREMVP_APPLICATION_SCHEMA_MIGRATION_V1", migration_files: [migrationFile], safety_class: "ADDITIVE_COMPATIBLE", direct_raw_mutation: false, rollback_strategy: "COMPATIBILITY_RETAINED" },
    changedFiles: [migrationFile],
    readFile: () => sql,
  });
  assert.deepEqual(release, { ok: true, errors: [] });
  assert.equal(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsrs_game_start_iso\s+ON public\.generated_signal_research_snapshots \(game_start_iso\)\s+WHERE game_start_iso IS NOT NULL;/.test(sql), true);
  assert.equal(/ALTER\s+TABLE|\bDROP\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(sql), false);
  const rpc = readFileSync("supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql", "utf8");
  assert.equal(rpc.includes("g.game_start_iso >= p_from"), true);
  assert.equal(rpc.includes("g.game_start_iso < p_to"), true);
  assert.deepEqual([SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA], [40, 20, 40]);
});

// ---- soft budget guard (PRECONTRACT_T20_RESEARCH_BUDGET_AND_CONTINUATION_FIX_V1) ------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Store whose writes become visible to capturedAmong(), like the real table, so a second tick resumes correctly. */
function persistingStore(rows: ResearchEventCandidateRow[]) {
  const base = fakeStore(rows);
  const persisted = new Set<string>();
  const physicalByRow = new Map(buildResearchEvents(rows).map((e) => [e.providerEventId, e.physicalEventId]));
  const store: ResearchStore = {
    ...base.store,
    capturedAmong: async (ids) => new Set(ids.filter((i) => persisted.has(i))),
    capturedEventCount: async () => persisted.size,
    writeRows: async (r) => { await base.store.writeRows(r); persisted.add(String(r[0].physical_event_id)); },
  };
  return { ...base, store, persisted, physicalByRow };
}
const slowCapture = (ms: number, seen: string[] = []) => async (sel: CohortSelection): Promise<EventCaptureOutcome> => {
  seen.push(sel.event.providerEventId); await sleep(ms);
  return { kind: "CAPTURED", rows: [{ physical_event_id: sel.event.physicalEventId, id: `r-${sel.event.providerEventId}` }], unsupported: {} };
};
const SOFT = { budgetMs: 400, softStartMinRemainingMs: 50 };
const withJobs = () => { const jobs: Record<string, unknown>[] = []; return { jobs, writeJobRun: async (j: unknown) => { jobs.push(j as Record<string, unknown>); } }; };

test("SOFT-A: one event finishing inside the budget is SUCCESS with no deferral and no hard timeout", async () => {
  const { store, written } = persistingStore([sourceRow(1, 900)]);
  const res = await runPrecontractT20ResearchTick(NOW, { store, ...SOFT, capture: slowCapture(20) });
  assert.equal(res.status, "success");
  assert.equal(written.length, 1);
  assert.deepEqual([res.diagnostics.due_event_n, res.diagnostics.attempted_event_n, res.diagnostics.captured_event_n, res.diagnostics.deferred_budget_event_n, res.diagnostics.hard_timeout_hit, res.diagnostics.budget_deferred], [1, 1, 1, 0, false, false]);
  assert.equal(RESEARCH_TICK_BUDGET_MS, 8_000, "hard budget unchanged");
});

test("SOFT-B/F: first event captured, second cannot safely start => rows retained, second DEFERRED, SUCCESS, no hard timeout, rejectedCount untouched", async () => {
  const { store, written, persisted, calls } = persistingStore([sourceRow(1, 900), sourceRow(2, 800)]);
  const seen: string[] = [];
  const { jobs, writeJobRun } = withJobs();
  const res = await runPrecontractT20ResearchTick(NOW, { store, writeJobRun, ...SOFT, capture: slowCapture(250, seen) });
  assert.equal(res.status, "success");
  assert.equal(res.diagnostics.error, undefined);
  assert.deepEqual(seen, ["1"], "second event never started");
  assert.equal(written.length, 1, "first event rows retained");
  assert.equal(persisted.size, 1);
  assert.deepEqual([res.diagnostics.due_event_n, res.diagnostics.attempted_event_n, res.diagnostics.captured_event_n, res.diagnostics.failed_event_n, res.diagnostics.deferred_budget_event_n, res.diagnostics.token_rows_written_n, res.diagnostics.hard_timeout_hit, res.diagnostics.budget_deferred], [2, 1, 1, 0, 1, 1, false, true]);
  assert.equal(jobs[0].status, "success");
  assert.equal(jobs[0].errorMessage, undefined);
  assert.equal(jobs[0].generatedCount, 1);
  assert.equal(jobs[0].rejectedCount, 0, "a deferred event is not a rejected/failed event");
  assert.equal(calls.purge, 0, "no retention purge after a soft deferral (leftover budget is too small)");
});

test("SOFT-C: the next tick sees the first event captured and continues the deferred second event", async () => {
  const ps = persistingStore([sourceRow(1, 900), sourceRow(2, 800)]);
  const first = await runPrecontractT20ResearchTick(NOW, { store: ps.store, ...SOFT, capture: slowCapture(250) });
  assert.equal(first.diagnostics.deferred_budget_event_n, 1);
  const seen: string[] = [];
  const second = await runPrecontractT20ResearchTick(NOW + 60_000, { store: ps.store, ...SOFT, capture: slowCapture(20, seen) });
  assert.deepEqual(seen, ["2"], "only the deferred event is captured");
  assert.equal(second.status, "success");
  assert.equal(second.diagnostics.already_captured_event_n, 1);
  assert.deepEqual([second.diagnostics.captured_event_n, second.diagnostics.deferred_budget_event_n, second.diagnostics.hard_timeout_hit], [1, 0, false]);
  assert.equal(ps.written.length, 2);
});

test("SOFT-D/F: a real capture failure increments failed_event_n and is never mislabeled as deferred", async () => {
  const { store } = persistingStore([sourceRow(1, 900)]);
  const { jobs, writeJobRun } = withJobs();
  const res = await runPrecontractT20ResearchTick(NOW, { store, writeJobRun, ...SOFT, capture: async () => ({ kind: "FAILED", reason: "PROVIDER_DOWN", unsupported: {} }) });
  assert.deepEqual([res.diagnostics.failed_event_n, res.diagnostics.deferred_budget_event_n, res.diagnostics.budget_deferred, res.diagnostics.attempted_event_n], [1, 0, false, 1]);
  assert.equal(res.status, "empty", "zero durable progress keeps the existing failure semantics");
  assert.equal(jobs[0].rejectedCount, 1);
});

test("SOFT-E: the genuine hard timer expiry is still RESEARCH_TICK_TIMEOUT / error with hard_timeout_hit=true; earlier rows are kept", async () => {
  const { store, written } = persistingStore([sourceRow(1, 900), sourceRow(2, 800)]);
  const { jobs, writeJobRun } = withJobs();
  let n = 0;
  // soft guard disabled (0 floor) so the second event DOES start and the hard timer genuinely fires mid-capture
  const res = await runPrecontractT20ResearchTick(NOW, { store, writeJobRun, budgetMs: 120, softStartMinRemainingMs: 0, capture: async (sel) => { n++; return n === 1 ? slowCapture(10)(sel) : new Promise<EventCaptureOutcome>(() => undefined); } });
  assert.equal(res.status, "error");
  assert.equal(jobs[0].errorMessage, "RESEARCH_TICK_TIMEOUT");
  assert.equal(res.diagnostics.hard_timeout_hit, true);
  assert.equal(res.diagnostics.captured_event_n, 1);
  assert.equal(written.length, 1, "already-written rows preserved");
});

test("SOFT-ORDER: due events run earliest event_start first, then liquidity; the 40/20/40 cohort is untouched by the guard", async () => {
  const early = sourceRow(1, 10, "soccer", 11), late = sourceRow(2, 9_999, "soccer", 19), mid = sourceRow(3, 500, "soccer", 11);
  const rows = [late, early, mid];
  const seen: string[] = [];
  const { store } = persistingStore(rows);
  await runPrecontractT20ResearchTick(NOW, { store, budgetMs: 2_000, softStartMinRemainingMs: 10, capture: slowCapture(1, seen) });
  assert.deepEqual(seen, ["3", "1", "2"], "start asc (11,11,19); equal start -> higher volume first");
  const ev3 = buildResearchEvents([early])[0], ev4 = buildResearchEvents([late])[0];
  assert.ok(compareUrgency(ev3, ev4) < 0);
  // cohort membership/quotas identical whether or not the soft guard defers
  const full = persistingStore(rows), deferredRun = persistingStore(rows);
  const a = await runPrecontractT20ResearchTick(NOW, { store: full.store, budgetMs: 2_000, softStartMinRemainingMs: 10, capture: slowCapture(1) });
  const b = await runPrecontractT20ResearchTick(NOW, { store: deferredRun.store, ...SOFT, capture: slowCapture(250) });
  for (const k of ["eligible_event_n", "soccer_selected_n", "tennis_selected_n", "other_quota_underfill_n", "universe_event_n"]) assert.equal(a.diagnostics[k], b.diagnostics[k], k);
  assert.deepEqual([SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA], [40, 20, 40]);
});

test("SOFT-H: money-path code never reads research output; the soft guard imports no money/Queue module", () => {
  const src = readFileSync("lib/executor/precontractT20Research.ts", "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["T10_REAL_MONEY_EXECUTION_ENABLED", "execution_queue", "hard_cap", "settlement"]) assert.equal(code.includes(forbidden), false, forbidden);
  const consumers = ["lib/executor/eventExecutionQueue.ts", "lib/executor/reservationRebalanceContract.mjs", "lib/executor/contractADecisions.ts"];
  for (const f of consumers) {
    const text = readFileSync(f, "utf8");
    assert.equal(text.includes("research_precontract_t20_observations"), false, `${f} must not read the research table`);
  }
  const hook = readFileSync("lib/executor/eventExecutionQueue.ts", "utf8");
  assert.equal((hook.match(/runPrecontractT20ResearchFailSoft\(/g) ?? []).length, 1);
  assert.match(readFileSync("lib/executor/precontractT20Research.ts", "utf8"), /export const RESEARCH_TICK_BUDGET_MS = 8_000;/);
});

// ---- MISSION T20-01: candidate-RPC access path (partial index) -------------------------------------------------------------
test("T20-01: partial index migration is index-only, concurrent, matches the RPC eventId expression, and every safety cap is unchanged", () => {
  const file = "supabase/migrations/20261011100000_gsrs_t20_event_candidates_partial_index_v1.sql";
  const sql = readFileSync(file, "utf8");
  assert.equal(sql.split("\n")[0], "-- pg-delta: transaction=false");
  assert.deepEqual(validateApprovedMigrationRelease({
    declaration: { mode: "PREMVP_APPLICATION_SCHEMA_MIGRATION_V1", migration_files: [file], safety_class: "ADDITIVE_COMPATIBLE", direct_raw_mutation: false, rollback_strategy: "COMPATIBILITY_RETAINED" },
    changedFiles: [file], readFile: () => sql,
  }), { ok: true, errors: [] });
  const code = sql.replace(/--.*$/gm, "");
  assert.equal(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsrs_t20_event_candidates\s+ON public\.generated_signal_research_snapshots \(snapshot_run_id, game_start_iso\)\s+WHERE NULLIF\(btrim\(diagnostics -> 'providerEventContext' ->> 'eventId'\), ''\) IS NOT NULL;/.test(code), true);
  assert.equal(/ALTER\s+TABLE|\bDROP\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bFUNCTION\b/i.test(code), false);
  // The predicate is the exact expression the (unchanged) RPC already applies, so the planner can prove the implication.
  const rpc = readFileSync("supabase/migrations/20261007174425_research_snapshot_runs_two_generation_freshness_v1.sql", "utf8");
  assert.equal(rpc.includes("NULLIF(btrim(g.diagnostics -> 'providerEventContext' ->> 'eventId'), '')"), true);
  assert.equal(rpc.includes("WHERE s.event_id IS NOT NULL"), true);
  assert.equal(rpc.includes("g.snapshot_run_id IN (SELECT c.snapshot_run_id FROM completed_runs c)"), true);
  assert.deepEqual([RESEARCH_TICK_BUDGET_MS, EVENT_UNIVERSE_CEILING, MAX_RESEARCH_EVENTS_PER_DAY, SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA, MAX_NEW_EVENTS_PER_TICK, MAX_RESEARCH_TOKEN_ROWS_PER_EVENT],
    [8_000, 800, 100, 40, 20, 40, 5, 128]);
});

// ---- T20 business completeness: gameId-less MONEYLINE-only events + typed failure reasons ----------------------------
const gameless = (eventId: string, cond: string, type = "moneyline") => ({ ...mk(eventId, "", type, `s-${cond}`, 3, cond), provider_game_id: null });

test("T20-GAMELESS-A: a provider event with no gameId anywhere is captured from its own exact markets for cricket/tennis (MONEYLINE only)", async () => {
  const own = [gameless("77", "cm1"), gameless("77", "ct1", "cricket_toss_winner"), gameless("77", "cc1", "cricket_completed_match")];
  let discoveryCalls = 0;
  const deps = { readExactEvent: async () => own, readGameEvents: async () => { discoveryCalls++; return []; }, fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never };
  const out = await captureResearchEvent(selection({ sportFamily: "cricket", providerEventId: "77", providerGameId: null }), START, deps);
  assert.equal(out.kind, "CAPTURED");
  if (out.kind !== "CAPTURED") return;
  assert.deepEqual([...new Set(out.rows.map((r) => r.canonical_market_type))], ["MONEYLINE"]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows.every((r) => r.provider_game_id === null && r.provider_event_id === "77"), true);
  assert.equal(discoveryCalls, 0, "no gameId means no sibling discovery is attempted or invented");
  assert.deepEqual(out.unsupported, { OTHER_STRUCTURED: 2 });
  const tennis = await captureResearchEvent(selection({ sportFamily: "tennis", providerEventId: "77", providerGameId: null }), START, deps);
  assert.equal(tennis.kind, "CAPTURED");
});

test("T20-GAMELESS-B: every other gameId-less case still fails closed with the exact unresolved-identity reason", async () => {
  const own = [gameless("78", "sm1")];
  const base = { readExactEvent: async () => own, readGameEvents: async () => { throw new Error("must not be called"); }, fetchBooks: fakeBooks as never };
  // soccer (full multi-market family) with no gameId
  const soccer = await captureResearchEvent(selection({ sportFamily: "soccer", providerEventId: "78", providerGameId: null }), START, base);
  assert.deepEqual([soccer.kind, (soccer as { reason?: string }).reason], ["FAILED", "EVENT_GAME_IDENTITY_UNRESOLVED"]);
  // source states a gameId the provider event does not carry: unproven, not waved through
  const sourceGame = await captureResearchEvent(selection({ sportFamily: "cricket", providerEventId: "78", providerGameId: "G9" }), START, base);
  assert.deepEqual([sourceGame.kind, (sourceGame as { reason?: string }).reason], ["FAILED", "EVENT_GAME_IDENTITY_UNRESOLVED"]);
  // empty exact event
  const empty = await captureResearchEvent(selection({ sportFamily: "cricket", providerEventId: "78", providerGameId: null }), START, { ...base, readExactEvent: async () => [] });
  assert.deepEqual([empty.kind, (empty as { reason?: string }).reason], ["FAILED", "EVENT_GAME_IDENTITY_UNRESOLVED"]);
});

test("T20-REASON-A: a provider reschedule is a typed reason, not a generic outage; unknown errors stay generic and never leak raw text", async () => {
  const fail = (message: string) => captureResearchEvent(selection(), START, { readExactEvent: async () => { throw new Error(message); } });
  const mismatch = await fail("RESERVED_EVENT_START_MISMATCH");
  assert.deepEqual([mismatch.kind, (mismatch as { reason?: string }).reason], ["FAILED", "RESERVED_EVENT_START_MISMATCH"]);
  const ambiguous = await fail("PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS");
  assert.equal((ambiguous as { reason?: string }).reason, "PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS");
  const generic = await fail("socket hang up https://gamma-api.polymarket.com/events/1");
  assert.equal((generic as { reason?: string }).reason, "EVENT_MARKET_SET_UNAVAILABLE");
});

test("T20-REASON-B: job_runs diagnostics carry bounded aggregate failed_reason_counts (reasons only, no ids/payloads)", async () => {
  const { store } = persistingStore([sourceRow(1, 900), sourceRow(2, 800), sourceRow(3, 700)]);
  const { jobs, writeJobRun } = withJobs();
  const reasons = ["RESERVED_EVENT_START_MISMATCH", "RESERVED_EVENT_START_MISMATCH", "EVENT_GAME_IDENTITY_UNRESOLVED"];
  let i = 0;
  const res = await runPrecontractT20ResearchTick(NOW, { store, writeJobRun, ...SOFT, capture: async () => ({ kind: "FAILED", reason: reasons[i++], unsupported: {} }) });
  assert.equal(res.diagnostics.failed_event_n, 3);
  assert.deepEqual(res.diagnostics.failed_reason_counts, { RESERVED_EVENT_START_MISMATCH: 2, EVENT_GAME_IDENTITY_UNRESOLVED: 1 });
  assert.deepEqual(jobs[0].diagnostics?.failed_reason_counts, res.diagnostics.failed_reason_counts);
  assert.equal(JSON.stringify(res.diagnostics.failed_reason_counts).includes("sourceRow"), false);

  const failingWrite = persistingStore([sourceRow(4, 900)]);
  failingWrite.store.writeRows = async () => { throw new Error("db down detail"); };
  const w = await runPrecontractT20ResearchTick(NOW, { store: failingWrite.store, ...SOFT, capture: async () => ({ kind: "CAPTURED", rows: [{ id: "x" }], unsupported: {} }) });
  assert.deepEqual([w.diagnostics.failed_event_n, w.diagnostics.failed_reason_counts], [1, { RESEARCH_WRITE_FAILED: 1 }]);
});


// ---- TELEMETRY-08C: rescheduled events are recovered inside their ACTUAL T20 window ----------------------------------
const R_NOW = Date.parse("2026-10-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const min = (m: number) => m * 60_000;
const rrow = (n: number, vol: number, startMs: number, over: Partial<ResearchEventCandidateRow> = {}) => cand({
  provider_event_id: String(n), provider_game_id: `G${n}`, snapshot_run_id: `run-${n}`, snapshot_at: iso(R_NOW - 60_000),
  event_start_iso: iso(startMs), parent_event_volume_24h: vol, provider_sport_family: "tennis", provider_sport_code: null, provider_sport_code_n: 0, ...over,
});
type ProvOpts = {
  starts?: Record<string, string | null>; acquiredAtMs?: number; omit?: string[]; dup?: string[]; extra?: string[]; games?: Record<string, string>;
  endDates?: Record<string, string>; unavailable?: boolean; nowMs?: number;
};
function provider(rows: ResearchEventCandidateRow[], o: ProvOpts = {}) {
  const calls: string[][] = [];
  const fn: FetchProviderStarts = async (ids) => {
    calls.push([...ids]);
    if (o.unavailable) return null;
    const events = ids.filter((id) => !(o.omit ?? []).includes(id)).flatMap((id) => {
      const src = rows.find((r) => r.provider_event_id === id);
      const e = { id, gameId: o.games?.[id] ?? src?.provider_game_id ?? null,
        startTime: id in (o.starts ?? {}) ? o.starts![id] : src?.event_start_iso ?? null, endDate: o.endDates?.[id] ?? null, endDateIso: null };
      return (o.dup ?? []).includes(id) ? [e, e] : [e];
    });
    for (const id of o.extra ?? []) events.push({ id, gameId: null, startTime: null, endDate: null, endDateIso: null });
    return { acquiredAtMs: o.acquiredAtMs ?? (o.nowMs ?? R_NOW), latencyMs: 7, requestedN: ids.length, events };
  };
  return { fn, calls };
}
function boundedStore(rows: ResearchEventCandidateRow[], persisted: Set<string> = new Set()) {
  const written: Record<string, unknown>[][] = [];
  const loads: { from: string; to: string }[] = [];
  const store: ResearchStore = {
    async loadEventCandidates(from, to) { loads.push({ from, to }); return rows.filter((r) => r.event_start_iso >= from && r.event_start_iso < to); },
    async capturedAmong(ids) { return new Set(ids.filter((i) => persisted.has(i))); },
    async capturedEventCount() { return persisted.size; },
    async writeRows(r) { written.push(r); for (const x of r) persisted.add(String(x.physical_event_id)); },
    async purgeExpired() { return 0; },
  };
  return { store, written, loads, persisted };
}
async function resched(rows: ResearchEventCandidateRow[], o: ProvOpts & { now?: number; persisted?: Set<string>; state?: ResearchStartState; real?: boolean } = {}) {
  const now = o.now ?? R_NOW;
  const prov = provider(rows, { nowMs: now, ...o });
  const bs = boundedStore(rows, o.persisted);
  const captured: CohortSelection[] = [];
  const res = await realTick(now, {
    store: bs.store, startState: o.state ?? createResearchStartState(), fetchProviderStarts: prov.fn, budgetMs: 2_000, softStartMinRemainingMs: 10,
    ...(o.real ? { readExactEvent: async (id: string, start: string) => gameMarkets(id, `G${id}`, start), readGameEvents: async (g: string, start: string) => gameMarkets(g.slice(1), g, start), fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never }
      : { capture: async (sel: CohortSelection): Promise<EventCaptureOutcome> => { captured.push(sel); return { kind: "CAPTURED", rows: [{ physical_event_id: sel.event.physicalEventId }], unsupported: {} }; } }),
  });
  return { res, captured, prov, bs };
}

test("T20-08C-A: +5/+30/+90 minute LATER reschedules are captured once inside the ACTUAL window although the snapshot window is closed", async () => {
  for (const shift of [5, 30, 90]) {
    const actual = R_NOW + min(14);
    const source = actual - min(shift);
    assert.equal(inT20Window(iso(source), R_NOW), false, `old-start filter alone would LOSE the +${shift}min event`);
    const rows = [rrow(1, 500, source)];
    const { res, captured, bs } = await resched(rows, { starts: { "1": iso(actual) } });
    assert.equal(captured.length, 1, `+${shift}`);
    assert.equal(res.diagnostics.provider_start_rescheduled_into_window_event_n, 1);
    assert.equal(captured[0].event.eventStartIso, iso(source), "snapshot start preserved");
    assert.equal(captured[0].event.providerStart?.startIso, iso(actual));
    assert.equal(bs.written.length, 1);
    const again = await resched(rows, { starts: { "1": iso(actual) }, persisted: bs.persisted });
    assert.equal(again.captured.length, 0, "exactly once: a second tick does not capture again");
    assert.equal(again.res.diagnostics.already_captured_event_n, 1);
  }
});

test("T20-08C-B: earlier start, unchanged start, old window passed / new not yet open, and the strict 9 < m <= 20 bound on the ACTUAL start", async () => {
  const cases: [string, number, number, boolean][] = [
    ["earlier into window", R_NOW + min(70), R_NOW + min(14), true],
    ["unchanged inside window", R_NOW + min(14), R_NOW + min(14), true],
    ["earlier past the window", R_NOW + min(14), R_NOW + min(5), false],
    ["old window passed, new window not open", R_NOW - min(5), R_NOW + min(40), false],
    ["actual exactly 9min", R_NOW - min(30), R_NOW + min(9), false],
    ["actual 9.01min", R_NOW - min(30), R_NOW + min(9) + 600, true],
    ["actual exactly 20min", R_NOW - min(30), R_NOW + min(20), true],
    ["actual 20.01min", R_NOW - min(30), R_NOW + min(20) + 600, false],
  ];
  for (const [name, source, actual, want] of cases) {
    const { captured } = await resched([rrow(1, 500, source)], { starts: { "1": iso(actual) } });
    assert.equal(captured.length, want ? 1 : 0, name);
  }
  // the new window opens later: the same event is then captured by a later tick, once
  const rows = [rrow(1, 500, R_NOW - min(5))];
  const persisted = new Set<string>();
  const state = createResearchStartState();
  const early = await resched(rows, { starts: { "1": iso(R_NOW + min(40)) }, persisted, state });
  assert.equal(early.captured.length, 0);
  const later = await resched(rows, { starts: { "1": iso(R_NOW + min(40)) }, persisted, state, now: R_NOW + min(26) });
  assert.equal(later.captured.length, 1);
});

test("T20-08C-C: a verified start on a DIFFERENT UTC date than the snapshot fails closed (never charged to the wrong day); same-day reschedules still work", async () => {
  const now = Date.parse("2026-10-09T23:51:00.000Z");
  const source = Date.parse("2026-10-09T23:40:00.000Z");           // snapshot/physical day 2026-10-09
  const actual = Date.parse("2026-10-10T00:05:00.000Z");           // actual day 2026-10-10 (in window: 14 min)
  const rows = [rrow(1, 500, source)];
  const forward = await resched(rows, { now, starts: { "1": iso(actual) }, real: true });
  assert.equal(forward.bs.written.length, 0, "cross-date start is not captured");
  assert.equal(forward.res.diagnostics.provider_start_cross_utc_day_event_n, 1);
  assert.equal(forward.res.diagnostics.captured_event_n, 0);
  assert.equal(forward.bs.loads.length, 2, "band still spans two UTC days = the same two existing RPC calls");
  // the target day is already full (100) and the source day is at 99: neither day's allocation can be consumed by the move
  for (const full of [new Set(Array.from({ length: 100 }, (_, i) => `other-${i}`)), new Set(Array.from({ length: 99 }, (_, i) => `other-${i}`))]) {
    const capped = await resched(rows, { now, starts: { "1": iso(actual) }, real: true, persisted: full });
    assert.equal(capped.bs.written.length, 0);
    assert.equal(capped.bs.persisted.size, full.size, "no allocation consumed on either day");
  }
  // reverse direction: snapshot on D+1, moved EARLIER onto D
  const back = await resched([rrow(1, 500, Date.parse("2026-10-10T00:10:00.000Z"))], { now: Date.parse("2026-10-09T23:35:00.000Z"), starts: { "1": iso(Date.parse("2026-10-09T23:49:00.000Z")) }, real: true });
  assert.equal(back.bs.written.length, 0);
  assert.equal(back.res.diagnostics.provider_start_cross_utc_day_event_n, 1);
  // same-day +5/+30/+90 right before midnight still recovers on the snapshot day with its snapshot-day identity
  for (const shift of [5, 30, 90]) {
    const n2 = Date.parse("2026-10-09T22:00:00.000Z");
    const act = n2 + min(14);
    const ok = await resched([rrow(1, 500, act - min(shift))], { now: n2, starts: { "1": iso(act) }, real: true });
    assert.equal(ok.bs.written.length, 1, `same-day +${shift}`);
    assert.equal(ok.bs.written[0][0].physical_event_id, "provider:polymarket:game:g1:2026-10-09");
    assert.equal(ok.bs.written[0][0].provider_start_iso, iso(act));
  }

  // same match under two UTC-day keys (older generation D, newer generation D+1): exactly one snapshot, on the key owning the actual date
  const dup = [rrow(1, 500, source, { snapshot_run_id: "old", snapshot_at: iso(now - min(60)) }), rrow(1, 500, actual, { snapshot_run_id: "new", snapshot_at: iso(now - 60_000) })];
  const d = await resched(dup, { now, real: true, starts: { "1": iso(actual) } });
  assert.equal(d.bs.written.length, 1, "one physical match -> one snapshot");
  assert.equal(d.bs.written[0][0].physical_event_id, "provider:polymarket:game:g1:2026-10-10");
  assert.equal(d.res.diagnostics.provider_start_cross_utc_day_event_n, 1, "the stale-day key fails closed instead of duplicating");
  const done = await resched(dup, { now, real: true, starts: { "1": iso(actual) }, persisted: new Set(["provider:polymarket:game:g1:2026-10-09"]) });
  assert.equal(done.bs.written.length, 0, "a captured sibling key counts as captured");
  const third = await resched(dup, { now, real: true, starts: { "1": iso(actual + min(26 * 60)) } });
  assert.equal(third.bs.written.length, 0, "neither key owns the verified date");
});

test("T20-08C-D: provider disagreement, missing, duplicate, partial/unavailable batch, stale, anomalous or start-less response fail closed", async () => {
  const rows = [rrow(1, 500, R_NOW - min(30)), rrow(2, 400, R_NOW - min(30))];
  const move = { "1": iso(R_NOW + min(14)), "2": iso(R_NOW + min(14)) };
  const R = PROVIDER_START_REASONS;
  const cases: [string, ProvOpts, string, number][] = [
    ["missing event (partial batch)", { starts: move, omit: ["2"] }, R.EVENT_MISSING, 1],
    ["duplicate identity", { starts: move, dup: ["1", "2"] }, R.IDENTITY_AMBIGUOUS, 0],
    ["unavailable batch", { starts: move, unavailable: true }, R.BATCH_UNAVAILABLE, 0],
    ["stale response", { starts: move, acquiredAtMs: R_NOW - PROVIDER_START_MAX_AGE_MS - 1 }, R.STALE, 0],
    ["unrequested id poisons the batch", { starts: move, extra: ["999"] }, R.BATCH_ANOMALY, 0],
    ["gameId contradiction", { starts: move, games: { "1": "OTHER", "2": "OTHER" } }, R.IDENTITY_CONTRADICTION, 0],
    ["no startTime and no matching endDate", { starts: { "1": null, "2": null } }, R.MISSING, 0],
    ["no startTime, endDate differs", { starts: { "1": null, "2": null }, endDates: { "1": iso(R_NOW + min(14)), "2": iso(R_NOW + min(14)) } }, R.MISSING, 0],
  ];
  for (const [name, o, reason, expectCaptured] of cases) {
    const { captured, res } = await resched(rows, o);
    assert.equal(captured.length, expectCaptured, name);
    const counts = res.diagnostics.provider_start_failure_counts as Record<string, number>;
    assert.ok((counts[reason] ?? 0) >= 1, `${name}: ${reason}`);
    assert.equal(res.diagnostics.provider_start_unverified_event_n, 2 - expectCaptured, name);
  }
  // the exact-reader legacy match (no startTime, endDate == snapshot start) is preserved and labelled
  const legacy = await resched([rrow(1, 500, R_NOW + min(14))], { starts: { "1": null }, endDates: { "1": iso(R_NOW + min(14)) }, real: true });
  assert.equal(legacy.bs.written.length, 1);
  assert.equal(legacy.bs.written[0][0].provider_start_source, PROVIDER_START_SOURCE_LEGACY);
});

test("T20-08C-E: cohort membership, rank and volume stay SOURCE-based; provider state never promotes or demotes an event", async () => {
  // 150 soccer events by descending volume (only 100 fit the daily cap). #1 (top) and #130 (outside the cohort) both reschedule in.
  const rows = Array.from({ length: 150 }, (_, i) => rrow(i + 1, 10_000 - i, R_NOW + min(60), { provider_sport_family: "soccer" }));
  const actual = iso(R_NOW + min(14));
  const { captured, res } = await resched(rows, { starts: { "1": actual, "130": actual } });
  assert.deepEqual(captured.map((c) => [c.event.providerEventId, c.rank, c.bucket, c.event.volume]), [["1", 1, "SOCCER", 10_000]]);
  assert.equal(res.diagnostics.eligible_event_n, 150, "complete universe ranked");
  assert.equal(res.diagnostics.soccer_selected_n, 100, "40 quota + global backfill, capped at the unchanged 100");
});

test("T20-08C-F: persisted lineage — snapshot start/id/source immutable, verified provider start stored separately with acquisition time and authority", async () => {
  const source = R_NOW - min(30);
  const actual = R_NOW + min(14);
  const rows = [rrow(7, 500, source)];
  const before = JSON.stringify(rows);
  const seen: string[] = [];
  const prov = provider(rows, { starts: { "7": iso(actual) }, acquiredAtMs: R_NOW - 1_234 });
  const bs = boundedStore(rows);
  await realTick(R_NOW, { store: bs.store, startState: createResearchStartState(), fetchProviderStarts: prov.fn, budgetMs: 2_000, softStartMinRemainingMs: 10,
    readExactEvent: async (id, start) => { seen.push(`exact:${start}`); return gameMarkets(id, `G${id}`, start); },
    readGameEvents: async (g, start) => { seen.push(`game:${start}`); return gameMarkets(g.slice(1), g, start); }, fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never });
  assert.deepEqual(seen, [`exact:${iso(actual)}`, `game:${iso(actual)}`], "provider reads use the verified CURRENT start");
  const row = bs.written[0][0];
  assert.equal(row.event_start_iso, iso(source));
  assert.equal(row.source_id, "generated_signal_research_snapshots:run-7");
  assert.equal(row.physical_event_id, "provider:polymarket:game:g7:2026-10-09");
  assert.equal(row.provider_start_iso, iso(actual));
  assert.equal(row.provider_start_acquired_at, iso(R_NOW - 1_234));
  assert.equal(row.provider_start_source, PROVIDER_START_SOURCE);
  assert.equal(JSON.stringify(rows), before, "historical snapshot candidates are never modified");
  assert.equal(Object.keys(bs.store).some((k) => /update|delete(?!.)/i.test(k)), false);
});

test("T20-08C-G: provider load is bounded (<=20 ids/batch, <=2 batches/tick), reused within the TTL, and skipped for captured events", async () => {
  const rows = Array.from({ length: 55 }, (_, i) => rrow(i + 1, 1_000 - i, R_NOW - min(30), { provider_sport_family: "soccer" }));
  const state = createResearchStartState();
  const first = await resched(rows, { state, starts: {} });
  assert.equal(first.prov.calls.length, MAX_START_RECHECK_BATCHES_PER_TICK);
  assert.ok(first.prov.calls.every((c) => c.length <= 20));
  assert.equal(first.res.diagnostics.provider_start_refresh_deferred_n, 55 - 40 > 0 ? 55 - 40 : 0);
  const warm = await resched(rows, { state, now: R_NOW + 8_000 });
  assert.ok(warm.prov.calls.every((c) => c.every((id) => !first.prov.calls.flat().includes(id))), "fresh entries are not re-requested inside the TTL");
  assert.equal((await resched([], {})).prov.calls.length, 0, "no band candidates -> zero provider requests");
  // an already-captured event (memo) is not refreshed again
  const one = [rrow(1, 500, R_NOW - min(30))];
  const s2 = createResearchStartState();
  const a = await resched(one, { state: s2, starts: { "1": iso(R_NOW + min(14)) } });
  assert.equal(a.captured.length, 1);
  const b = await resched(one, { state: s2, now: R_NOW + 120_000, starts: { "1": iso(R_NOW + min(14)) } });
  assert.equal(b.prov.calls.length, 0);
});

test("T20-08C-H: every hard limit is unchanged and the reschedule band is explicit", async () => {
  assert.deepEqual([MAX_RESEARCH_EVENTS_PER_DAY, SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA, MAX_RESEARCH_TOKEN_ROWS_PER_EVENT, MAX_NEW_EVENTS_PER_TICK, RESEARCH_TICK_BUDGET_MS, EVENT_UNIVERSE_CEILING], [100, 40, 20, 40, 128, 5, 8_000, 800]);
  assert.equal(T20_RESCHEDULE_HORIZON_MINUTES, 120);
  const rows = Array.from({ length: 9 }, (_, i) => rrow(i + 1, 900 - i, R_NOW - min(40)));
  const starts = Object.fromEntries(rows.map((r) => [r.provider_event_id, iso(R_NOW + min(14))]));
  const { captured } = await resched(rows, { starts });
  assert.equal(captured.length, MAX_NEW_EVENTS_PER_TICK, "<=5 new events per tick even when many events were rescheduled into the window");
  // reschedules beyond the horizon are out of band: no provider request, no capture (explicit, bounded limit)
  const far = await resched([rrow(1, 500, R_NOW - min(T20_RESCHEDULE_HORIZON_MINUTES + 30))], { starts: { "1": iso(R_NOW + min(14)) } });
  assert.equal(far.captured.length, 0);
  assert.equal(far.prov.calls.length, 0);
});

// ---- TELEMETRY-08C review: slow / hung Gamma under the real tick deadline ----------------------------------------------
const settleMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Models the real exact reader: it only succeeds when the provider's CURRENT start equals the start it is asked to verify. */
const exactReaderFor = (providerStarts: Record<string, string>, reads: string[] = []) => async (id: string, start: string) => {
  reads.push(id);
  if (Date.parse(providerStarts[id]) !== Date.parse(start)) throw new Error("RESERVED_EVENT_START_MISMATCH");
  return gameMarkets(id, `G${id}`, start);
};

test("T20-08C-I: a HUNG Gamma batch under the real 8s tick: provider phase ends at its sub-deadline, ordinary T20 still captured, no late write, no new request", async () => {
  const unchanged = rrow(1, 900, R_NOW + min(14));
  const moved = rrow(2, 800, R_NOW - min(30));          // really rescheduled into the window, but unverifiable while Gamma hangs
  const rows = [unchanged, moved];
  const providerStarts = { "1": unchanged.event_start_iso, "2": iso(R_NOW + min(14)) };
  const calls: string[][] = [];
  let releaseHung!: (v: null) => void;
  const hung = new Promise<null>((r) => { releaseHung = r; });
  const bs = boundedStore(rows);
  const reads: string[] = [];
  const state = createResearchStartState();
  const t0 = Date.now();
  const res = await realTick(R_NOW, {
    store: bs.store, startState: state, fetchProviderStarts: async (ids) => { calls.push([...ids]); return hung; },   // REAL defaults: 8s budget
    readExactEvent: exactReaderFor(providerStarts, reads), readGameEvents: async (g, start) => gameMarkets(g.slice(1), g, start), fetchBooks: fakeBooks as never, fetchFeeSchedule: noFee as never,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < RESEARCH_TICK_BUDGET_MS, `tick returned in ${elapsed}ms < 8000ms`);
  assert.ok(elapsed >= 2_400 && elapsed < 4_500, `provider phase bounded by its own ~2.5s sub-deadline, not the tick budget (${elapsed}ms)`);
  assert.equal(res.diagnostics.hard_timeout_hit, false);
  assert.equal(res.status, "success");
  assert.equal(res.diagnostics.provider_start_phase_timeout_n, 1);
  assert.equal(res.diagnostics.captured_event_n, 1, "the ordinary unchanged T20 event is NOT starved");
  assert.deepEqual(bs.written.map((w) => w[0].provider_event_id), ["1"]);
  assert.equal(bs.written[0][0].provider_start_iso, null, "no batch verification was obtained for it");
  assert.equal(res.diagnostics.provider_start_unreconciled_snapshot_window_event_n, 1);
  assert.deepEqual(reads, ["1"], "the rescheduled-but-unverified event was never read or captured (fail closed)");
  assert.equal(calls.length, 1, "one bounded batch, never re-requested inside the tick");
  // after the deadline: a late Gamma answer changes nothing
  const writesBefore = bs.written.length;
  releaseHung(null);
  await settleMs(80);
  assert.equal(calls.length, 1, "no new provider request after the deadline");
  assert.equal(bs.written.length, writesBefore, "no late Production write");
  assert.equal([...state.starts.values()].some((e) => e.ok), false, "the hung batch never populated the provider-start cache");
});

test("T20-08C-J: a SLOW batch that finishes after the sub-deadline is discarded (never cached/used); an in-time one is used", async () => {
  const rows = [rrow(1, 900, R_NOW + min(14)), rrow(2, 800, R_NOW - min(30))];
  const starts = { "1": rows[0].event_start_iso, "2": iso(R_NOW + min(14)) };
  const slowFetch = (delay: number): FetchProviderStarts => async (ids) => {
    await settleMs(delay);
    return provider(rows, { starts, nowMs: R_NOW }).fn(ids);
  };
  const capturedIds: string[] = [];
  const run = (delay: number, state: ResearchStartState) => realTick(R_NOW, {
    store: boundedStore(rows).store, startState: state, fetchProviderStarts: slowFetch(delay), budgetMs: 1_000, softStartMinRemainingMs: 10, providerStartPhaseBudgetMs: 60,
    capture: async (sel) => { capturedIds.push(`${sel.event.providerEventId}:${sel.event.providerStart ? "verified" : "snapshot"}`); return { kind: "CAPTURED", rows: [{ physical_event_id: sel.event.physicalEventId }], unsupported: {} }; },
  });
  const late = createResearchStartState();
  const slow = await run(250, late);
  assert.deepEqual(capturedIds, ["1:snapshot"], "slow batch: only the unchanged snapshot-window event is captured");
  assert.equal(slow.diagnostics.provider_start_phase_timeout_n, 1);
  assert.equal(slow.diagnostics.hard_timeout_hit, false);
  await settleMs(300);
  assert.equal([...late.starts.values()].some((e) => e.ok), false, "late response discarded");
  capturedIds.length = 0;
  const fast = await run(5, createResearchStartState());
  assert.deepEqual(capturedIds.sort(), ["1:verified", "2:verified"], "in-time batch: both captured, rescheduled one on its verified start");
  assert.equal(fast.diagnostics.provider_start_phase_timeout_n, 0);
});

test("T20-08C-K: no budget left for the provider phase -> no provider request at all; snapshot-window events keep their pre-08C path", async () => {
  const rows = [rrow(1, 900, R_NOW + min(14)), rrow(2, 800, R_NOW - min(30))];
  const prov = provider(rows, { starts: { "2": iso(R_NOW + min(14)) } });
  const got: string[] = [];
  const res = await realTick(R_NOW, {
    store: boundedStore(rows).store, startState: createResearchStartState(), fetchProviderStarts: prov.fn, budgetMs: 1_000, softStartMinRemainingMs: 10, providerStartPhaseBudgetMs: 0,
    capture: async (sel) => { got.push(sel.event.providerEventId); return { kind: "CAPTURED", rows: [{ physical_event_id: sel.event.physicalEventId }], unsupported: {} }; },
  });
  assert.equal(prov.calls.length, 0);
  assert.deepEqual(got, ["1"]);
  assert.equal(res.diagnostics.provider_start_refresh_deferred_n, 2);
});

test("T20-08C-L: unreachable Gamma never starves ordinary capture, but provider CONTENT disagreement and a real reschedule still fail closed", async () => {
  const unchanged = rrow(1, 900, R_NOW + min(14));
  const providerStarts = { "1": iso(R_NOW + min(40)) };    // Gamma (via the exact reader) says it moved out of the window
  // unreachable batch: an event still in its snapshot window goes through the pre-08C path and the exact reader fails it closed if it moved
  const moved = await resched([unchanged], { unavailable: true, real: false });
  assert.equal(moved.captured.length, 1, "unavailable batch + unchanged snapshot window: ordinary capture continues");
  const reads: string[] = [];
  const mismatch = await realTick(R_NOW, {
    store: boundedStore([unchanged]).store, startState: createResearchStartState(), fetchProviderStarts: async () => null, budgetMs: 2_000, softStartMinRemainingMs: 10,
    readExactEvent: exactReaderFor(providerStarts, reads), readGameEvents: async () => [], fetchBooks: fakeBooks as never,
  });
  assert.equal(mismatch.diagnostics.captured_event_n, 0);
  assert.deepEqual(mismatch.diagnostics.failed_reason_counts, { RESERVED_EVENT_START_MISMATCH: 1 }, "reschedule detected by the exact reader: fail closed, typed");
  // stale cached answer behaves like unreachable; missing/duplicate/contradiction/anomaly (content) never fall back
  const stale = await resched([unchanged], { acquiredAtMs: R_NOW - PROVIDER_START_MAX_AGE_MS - 1 });
  assert.equal(stale.captured.length, 1);
  for (const o of [{ omit: ["1"] }, { dup: ["1"] }, { games: { "1": "OTHER" } }, { extra: ["999"] }] as ProvOpts[]) {
    const r = await resched([unchanged], o);
    assert.equal(r.captured.length, 0, JSON.stringify(o) + JSON.stringify(r.res.diagnostics.provider_start_failure_counts));
  }
  // two UTC-day keys of one match + unreachable Gamma: no duplicate snapshot
  const midnight = Date.parse("2026-10-09T23:46:00.000Z");
  const dup = [rrow(1, 900, Date.parse("2026-10-09T23:58:00.000Z"), { snapshot_run_id: "a" }), rrow(1, 900, Date.parse("2026-10-10T00:01:00.000Z"), { snapshot_run_id: "b" })];
  const both = await resched(dup, { unavailable: true, now: midnight });
  assert.equal(both.captured.length, 0);
  assert.equal(both.res.diagnostics.identity_ambiguous_event_n, 2, "both keys of the one match fail closed rather than duplicate");
});
