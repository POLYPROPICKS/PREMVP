// PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1 — focused proof.
//   node --import tsx --test tests/contur3/precontractT20Research.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AMERICAN_FOOTBALL_NOT_PROVEN, MAX_NEW_EVENTS_PER_TICK, MAX_RESEARCH_EVENTS_PER_DAY, MAX_RESEARCH_TOKEN_ROWS_PER_EVENT,
  PRECONTRACT_RESEARCH_SOURCE, admitResearchMarket, captureResearchEvent, collapsePhysicalEvents, inT20Window,
  isAdmittedTargetSport, runPrecontractT20ResearchFailSoft, runPrecontractT20ResearchTick, selectResearchCohort,
  type ResearchEvent, type ResearchSourceRow, type ResearchStore, type CohortSelection,
} from "../../lib/executor/precontractT20Research";
import { EARLY_CAPTURE_WINDOW_OPEN_MINUTES } from "../../lib/executor/reservationMarketBaseline";

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

test("5: physical events are deduplicated before ranking (derivative events of one game occupy ONE slot)", () => {
  const row = (run: string, eventId: string): ResearchSourceRow => ({
    snapshot_run_id: run, snapshot_at: "2026-10-08T17:00:00Z", game_start_iso: new Date(DAY_START).toISOString(), vol: 500, fam: "soccer", code: "epl",
    src: "structured_sports_tag", ctx: { eventId, gameId: "G1", eventStartIso: new Date(DAY_START).toISOString() },
  });
  const events = collapsePhysicalEvents([row("r1", "11"), row("r1", "12"), row("r1", "11")]);
  assert.equal(events.length, 1);
  assert.equal(events[0].physicalEventId, "provider:polymarket:game:g1:2026-10-08");
  assert.equal(events[0].volume, 500);
});

test("12b: contradictory non-null parent volumes exclude the event and are counted (never silently chosen)", () => {
  const row = (vol: number): ResearchSourceRow => ({
    snapshot_run_id: "r1", snapshot_at: "2026-10-08T17:00:00Z", game_start_iso: new Date(DAY_START).toISOString(), vol, fam: "soccer", code: null,
    src: "structured_sports_tag", ctx: { eventId: "11", gameId: "G1", eventStartIso: new Date(DAY_START).toISOString() },
  });
  const events = collapsePhysicalEvents([row(100), row(200)]);
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

function fakeStore(rows: ResearchSourceRow[], captured: Set<string> = new Set()) {
  const written: Record<string, unknown>[][] = [];
  const tables: string[] = [];
  const store: ResearchStore = {
    async loadSourceRows() { tables.push("generated_signal_research_snapshots"); return rows; },
    async capturedAmong(ids) { return new Set(ids.filter((i) => captured.has(i))); },
    async capturedEventCount() { return captured.size; },
    async writeRows(r) { tables.push("research_precontract_t20_observations"); written.push(r); },
    async purgeExpired(_c, limit) { assert.ok(limit <= 1000); return 0; },
  };
  return { store, written, tables };
}
const sourceRow = (n: number, vol: number, family = "soccer", startOffsetMin = 15): ResearchSourceRow => ({
  snapshot_run_id: `run-${n}`, snapshot_at: new Date(NOW - 60_000).toISOString(), game_start_iso: new Date(NOW + startOffsetMin * 60_000).toISOString(), vol, fam: family, code: null,
  src: "structured_sports_tag", ctx: { eventId: String(n), gameId: `G${n}`, eventStartIso: new Date(NOW + startOffsetMin * 60_000).toISOString() },
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
  const physical = collapsePhysicalEvents(rows)[0].physicalEventId;
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
  const throwing: ResearchStore = { ...fakeStore([]).store, loadSourceRows: async () => { throw new Error("db down"); } };
  await assert.doesNotReject(runPrecontractT20ResearchFailSoft(NOW, { store: throwing }));
  await assert.doesNotReject(runPrecontractT20ResearchFailSoft(NOW, async () => { throw new Error("factory down"); }));
  const hanging: ResearchStore = { ...fakeStore([]).store, loadSourceRows: () => new Promise(() => undefined) };
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
