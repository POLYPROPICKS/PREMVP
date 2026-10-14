import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVED_SCORED_FORMULA, attachModelDecisions, buildCohortReceipt, buildExecutableLiquidityCohort, cohortDigest, confirmProviderCondition,
  liveQueueView, measureResearchLiquidity, reduceSourceRows, RESEARCH_LIQUIDITY_CONTRACT, selectPhysicalEventCohort,
  type InventoryToken, type MeasuredToken, type ModelAuthority, type ProviderMarket, type SourceCandidate, type SourceRow,
} from "../../lib/research/executableLiquidityCohortT90";
import { QUEUE_MAX_ENTRY_PRICE } from "../../lib/executor/executorQueueTypes";
import { buildExecutableSiblingColumns } from "../../lib/executor/t10ExecutableSiblingTelemetry";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";

// Fixtures prove selection LOGIC only. They are not evidence of any real cohort, BET or liquidity.
const REF = Date.parse("2026-10-14T10:00:00.000Z");
const H = 3_600_000;
const TIMING = { dbIngestWatermarkMs: REF - 60_000, referenceMs: REF };
const startIn = (hours: number) => new Date(REF + hours * H).toISOString();

function row(over: Partial<SourceRow> & { n: number }): SourceRow {
  const { n, ...rest } = over;
  return {
    observation_id: `obs-${n}`, item_observation_id: `item-${n}`, observed_at: new Date(REF - 3 * H).toISOString(), ingested_at: new Date(REF - 2 * H).toISOString(),
    condition_id: `0xc${n}`, selected_token_id: `tok-${n}-a`, selected_outcome: "Yes", metric_formula_version: APPROVED_SCORED_FORMULA,
    provider_event_id: `ev-${n}`, provider_sport_family: "soccer", market_type: "moneyline", game_start_iso: startIn(10),
    entry_price_num: 0.5, pre_event_score_num: 70, ...rest,
  };
}

// ── source causality ──────────────────────────────────────────────────────────────────────────────────────────────
test("reduceSourceRows: availability is DB ingested_at inside the snapshot watermark and before T-90", () => {
  const { candidates, rejected } = reduceSourceRows([
    row({ n: 1 }),
    row({ n: 2, ingested_at: new Date(REF).toISOString() }),                                  // after DB watermark
    row({ n: 3, game_start_iso: startIn(1.4), ingested_at: new Date(REF - H).toISOString() }), // inside T-90 at reference
    row({ n: 4, game_start_iso: startIn(3), observed_at: startIn(-0.1), ingested_at: new Date(REF - 30_000 - H * 0).toISOString() }),
    row({ n: 5, metric_formula_version: "shadow-firemodel1_1_research_v0" }),
    row({ n: 6, game_start_iso: startIn(30) }),
    row({ n: 7, provider_sport_family: "esports" }),
    row({ n: 8, observed_at: new Date(REF - H).toISOString(), ingested_at: new Date(REF - 2 * H).toISOString() }),
  ], TIMING);
  assert.deepEqual(candidates.map((c) => c.conditionId), ["0xc1"]);
  const reasons = Object.fromEntries(rejected.map((r) => [r.subject, r.reason]));
  assert.equal(reasons["0xc2"], "SOURCE_INGESTED_AFTER_SNAPSHOT_WATERMARK");
  assert.equal(reasons["0xc3"], "EVENT_NOT_AFTER_T90_AT_REFERENCE");
  assert.equal(reasons["0xc4"], "SOURCE_INGESTED_AFTER_SNAPSHOT_WATERMARK");
  assert.equal(reasons["0xc5"], "FORMULA_NOT_APPROVED");
  assert.equal(reasons["0xc6"], "EVENT_BEYOND_CYCLE_HORIZON");
  assert.equal(reasons["0xc7"], "SPORT_FAMILY_NOT_TARGET");
  assert.equal(reasons["0xc8"], "SOURCE_OBSERVED_AFTER_INGESTED");
});

test("reduceSourceRows: a row available after T-90 never counts; condition identity contradictions reject the condition", () => {
  const ok = row({ n: 1, game_start_iso: startIn(4) });
  const lateForT90 = row({ n: 1, item_observation_id: "item-1b", game_start_iso: startIn(4), ingested_at: new Date(REF - 60_000).toISOString() });
  // start +4h => cutoff +2.5h; both rows qualify, newest wins
  assert.equal(reduceSourceRows([ok, lateForT90], TIMING).candidates[0].itemObservationId, "item-1b");
  const evClash = reduceSourceRows([row({ n: 3 }), row({ n: 3, item_observation_id: "i2", provider_event_id: "ev-other" })], TIMING);
  assert.equal(evClash.candidates.length, 0);
  assert.equal(evClash.rejected[0].reason, "CONDITION_PROVIDER_EVENT_CONTRADICTION");
  const sportClash = reduceSourceRows([row({ n: 4 }), row({ n: 4, item_observation_id: "i3", provider_sport_family: "tennis" })], TIMING);
  assert.equal(sportClash.rejected[0].reason, "CONDITION_SPORT_FAMILY_CONTRADICTION");
  // DB watermark ahead of the local reference (clock skew): DB possession after the cutoff still never counts
  const skew = { dbIngestWatermarkMs: REF + H, referenceMs: REF };
  const late = reduceSourceRows([row({ n: 5, game_start_iso: startIn(2), ingested_at: new Date(REF + 0.6 * H).toISOString(), observed_at: new Date(REF).toISOString() })], skew);
  assert.equal(late.rejected[0].reason, "SOURCE_AVAILABLE_AFTER_T90");
});

// ── provider identity ────────────────────────────────────────────────────────────────────────────────────────────
const providerMarket = (over: Partial<ProviderMarket> = {}): ProviderMarket => ({
  provider_event_id: "ev-1", event_start_iso: startIn(10), condition_id: "0xc1", clob_token_ids: ["tok-1-a", "tok-1-b"], outcomes: ["Home", "Away"],
  sports_market_type: "moneyline", provider_market_slug: "m-1", sibling_market_count: 3, last_observed_at: startIn(0), provider_game_id: "g1", ...over,
});
const source = (over: Partial<SourceCandidate> = {}): SourceCandidate => ({
  conditionId: "0xc1", tokenId: "tok-1-a", outcome: "Home", providerEventId: "ev-1", eventStartIso: startIn(10), sportFamily: "soccer", sourceMarketType: "moneyline",
  observationId: "o", itemObservationId: "i", observedAt: startIn(-3), ingestedAt: startIn(-2), entryPrice: 0.5, score: 70, sourceRowN: 1, sourceItemObservationIds: ["i"], ...over,
});

test("confirmProviderCondition: BOTH provider tokens enter the inventory as distinct identities; any conflict rejects the whole condition", () => {
  const ok = confirmProviderCondition([source()], [providerMarket(), providerMarket({ condition_id: "0xother" })]);
  assert.ok(Array.isArray(ok));
  const [a, b] = ok as InventoryToken[];
  assert.deepEqual([a.tokenId, b.tokenId], ["tok-1-a", "tok-1-b"]);
  assert.equal(a.sourceSelected, true); assert.equal(b.sourceSelected, false); assert.equal(b.source, null);
  assert.equal(a.oppositeTokenId, "tok-1-b"); assert.equal(b.oppositeTokenId, "tok-1-a");
  assert.match(a.physicalEventId, /^provider:polymarket:game:g1:/);
  const reason = (r: unknown) => (r as { reason: string }).reason;
  assert.equal(reason(confirmProviderCondition([source()], [])), "CONDITION_NOT_IN_PROVIDER_EVENT");
  assert.equal(reason(confirmProviderCondition([source(), source({ tokenId: "typo" })], [providerMarket()])), "SOURCE_TOKEN_NOT_IN_PROVIDER_PAIR");
  assert.equal(reason(confirmProviderCondition([source()], [providerMarket({ clob_token_ids: ["tok-1-a", "tok-1-b", "c"], outcomes: ["a", "b", "c"] })])), "PROVIDER_TOKEN_PAIR_NOT_BINARY");
  assert.equal(reason(confirmProviderCondition([source()], [providerMarket({ sports_market_type: "soccer_first_half_total_corners" })])), "MARKET_TYPE_NOT_ADMITTED");
  assert.equal(reason(confirmProviderCondition([source({ sourceMarketType: "spreads" })], [providerMarket()])), "SOURCE_PROVIDER_MARKET_TYPE_CONTRADICTION");
  assert.equal(reason(confirmProviderCondition([source()], [providerMarket(), providerMarket()])), "CONDITION_DUPLICATED_IN_PROVIDER_EVENT");
});

// ── research liquidity measurement ──────────────────────────────────────────────────────────────────────────────
const SNAP = REF;
const book = (tokenId: string, asks: Array<[number, number]>, opts: { completedAt?: number; providerTs?: number | null; minOrder?: number | null } = {}): FetchOrderBookResult => {
  const completedAt = opts.completedAt ?? REF + 60_000;
  return {
    ok: true, tokenId, latencyMs: 10, requestStartedAtMs: completedAt - 10, responseCompletedAtMs: completedAt,
    book: {
      tokenId, bids: [], asks: asks.map(([price, size]) => ({ price, size })), tickSize: 0.01,
      minimumOrderSize: opts.minOrder === undefined ? 5 : opts.minOrder, providerTimestampMs: opts.providerTs === undefined ? completedAt - 5 : opts.providerTs,
    },
  };
};
const tok = (tokenId = "tok-1-a", eventStartIso = startIn(10)) => ({ conditionId: "0xc1", tokenId, outcome: "Home", eventStartIso });

test("venue 5-share minimum: $2.50 executes at 0.50, is min-order blocked just above, and 0.565 is outside the benchmark limit", () => {
  const at050 = measureResearchLiquidity(tok(), book("tok-1-a", [[0.5, 1000]]), SNAP);
  assert.equal(at050.state, "EXECUTABLE"); assert.equal(at050.shares, 5); assert.equal(at050.rankingDepthUsd, 500);
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.52, 1000]]), SNAP).state, "BLOCKED_VENUE_MIN_ORDER");    // 4.81 shares
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.555, 1000]]), SNAP).state, "BLOCKED_VENUE_MIN_ORDER");   // 4.50 shares
  const at0565 = measureResearchLiquidity(tok(), book("tok-1-a", [[0.565, 1000]]), SNAP);
  assert.equal(at0565.state, "BLOCKED_DEPTH_AT_LIMIT"); assert.equal(at0565.executable, false); assert.equal(at0565.rankingDepthUsd, null);
  // Raising a ceiling alone would NOT cure 0.565: the same canonical walk at 0.60 is still min-order blocked (4.42 shares).
  const hypothetical = buildExecutableSiblingColumns({ token: { conditionId: "0xc1", tokenId: "tok-1-a", side: "Home" }, result: book("tok-1-a", [[0.565, 1000]]), fee: null, hardCap: 0.6 });
  assert.equal(hypothetical.executable_full_stake_state, "NOT_EXECUTABLE_MIN_ORDER_SIZE");
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.5, 1000]], { minOrder: null }), SNAP).state, "UNKNOWN_MIN_ORDER_SIZE");
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.5, 3]]), SNAP).state, "BLOCKED_DEPTH_AT_LIMIT");          // $1.50 depth
});

test("unapproved stake adjustment or ceiling is UNAUTHORIZED_CONTRACT, never executable", () => {
  const b = book("tok-1-a", [[0.55, 1000]]);
  for (const contract of [
    { ...RESEARCH_LIQUIDITY_CONTRACT, stakeUsd: 2.75 }, { ...RESEARCH_LIQUIDITY_CONTRACT, stakeUsd: 4.0 }, { ...RESEARCH_LIQUIDITY_CONTRACT, priceLimit: 0.6 },
  ]) {
    const m = measureResearchLiquidity(tok(), b, SNAP, contract);
    assert.equal(m.state, "UNAUTHORIZED_CONTRACT"); assert.equal(m.executable, false); assert.equal(m.rankingDepthUsd, null);
  }
  assert.equal(RESEARCH_LIQUIDITY_CONTRACT.stakeUsd, 2.5);
  assert.equal(RESEARCH_LIQUIDITY_CONTRACT.adaptiveHeadroom, "NOT_USED");
});

test("missing / stale / non-causal quotes never become executable", () => {
  assert.equal(measureResearchLiquidity(tok(), null, SNAP).state, "UNKNOWN_BOOK_MISSING");
  assert.equal(measureResearchLiquidity(tok(), { ok: false, tokenId: "tok-1-a", latencyMs: 1, errorCode: "TIMEOUT" }, SNAP).state, "UNKNOWN_BOOK_MISSING");
  assert.equal(measureResearchLiquidity(tok(), book("other", [[0.5, 1000]]), SNAP).state, "UNKNOWN_BOOK_MISSING");             // wrong token book
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.5, 1000]], { providerTs: null }), SNAP).state, "UNKNOWN_QUOTE_TIMESTAMP");
  const noCompletion = book("tok-1-a", [[0.5, 1000]]); delete noCompletion.responseCompletedAtMs;
  assert.equal(measureResearchLiquidity(tok(), noCompletion, SNAP).state, "UNKNOWN_QUOTE_TIMESTAMP");
  // A book from before the source snapshot (e.g. reused/cached) is not causal evidence for this snapshot.
  assert.equal(measureResearchLiquidity(tok(), book("tok-1-a", [[0.5, 1000]], { completedAt: SNAP - 1 }), SNAP).state, "QUOTE_BEFORE_SOURCE_SNAPSHOT");
  // A present-day book cannot reconstruct an earlier decision: completion or provider timestamp after the cutoff.
  const nearStart = tok("tok-1-a", startIn(1.6)); // cutoff = REF + 0.1h
  assert.equal(measureResearchLiquidity(nearStart, book("tok-1-a", [[0.5, 1000]], { completedAt: REF + 0.2 * H }), SNAP).state, "QUOTE_AFTER_T90");
  assert.equal(measureResearchLiquidity(nearStart, book("tok-1-a", [[0.5, 1000]], { completedAt: REF + 60_000, providerTs: REF + 0.2 * H }), SNAP).state, "QUOTE_AFTER_T90");
});

test("LIVE Queue view is computed from the Queue's own constants and is not the research verdict", () => {
  const b = book("tok-1-a", [[0.5, 1000]]);
  const lq = liveQueueView(tok(), b);
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.555);
  assert.equal(lq.state, "EXECUTABLE"); assert.equal(lq.adaptiveHeadroom, "NOT_EVALUATED");
});

// ── selection fixtures ──────────────────────────────────────────────────────────────────────────────────────────
let seq = 0;
/** One physical event with one binary condition: token a has `depthA` executable depth at 0.50, token b at `priceB`. */
function event(sport: string, depthA: number, over: { priceB?: number; depthB?: number; minOrderB?: number; start?: string; pid?: string } = {}): MeasuredToken[] {
  const n = ++seq;
  const start = over.start ?? startIn(10);
  const pid = over.pid ?? `phys-${String(n).padStart(4, "0")}`;
  const mk = (side: "a" | "b", asks: Array<[number, number]>, minOrder = 5): MeasuredToken => {
    const t: InventoryToken = {
      conditionId: `0xe${n}`, tokenId: `tok-${n}-${side}`, outcome: side === "a" ? "Home" : "Away", oppositeTokenId: `tok-${n}-${side === "a" ? "b" : "a"}`,
      physicalEventId: pid, providerEventId: `ev${n}`, providerGameId: `g${n}`, eventStartIso: start, sportFamily: sport,
      providerMarketType: "MONEYLINE", providerMarketFamily: "MONEYLINE", providerMarketSlug: null,
      sourceSelected: side === "a", source: side === "a" ? source({ conditionId: `0xe${n}`, tokenId: `tok-${n}-a`, sportFamily: sport }) : null,
    };
    const b = book(t.tokenId, asks, { minOrder });
    return { ...t, research: measureResearchLiquidity(t, b, SNAP), liveQueue: liveQueueView(t, b) };
  };
  return [mk("a", [[0.5, depthA / 0.5]]), mk("b", [[over.priceB ?? 0.52, (over.depthB ?? 100) / (over.priceB ?? 0.52)]], over.minOrderB)];
}

function fullPool(): MeasuredToken[] {
  seq = 0;
  const pool: MeasuredToken[] = [];
  for (let i = 0; i < 70; i++) pool.push(...event("soccer", 100 + i));
  for (let i = 0; i < 40; i++) pool.push(...event("tennis", 1000 + i));     // deeper than soccer: must NOT be globally outranked
  for (const f of ["basketball", "baseball", "hockey", "cricket", "american-football"]) for (let i = 0; i < 8; i++) pool.push(...event(f, 50 + i * (f === "basketball" ? 10 : 1)));
  return pool;
}

test("selection: 50/25/25, per-sport rank, other floor then in-pool fill, deterministic under reordering", () => {
  const pool = fullPool();
  const a = selectPhysicalEventCohort(pool);
  const b = selectPhysicalEventCohort([...pool].reverse());
  assert.equal(cohortDigest(a), cohortDigest(b));
  assert.deepEqual(a.selected.map((s) => [s.physicalEventId, s.sportRank, s.bucket]), b.selected.map((s) => [s.physicalEventId, s.sportRank, s.bucket]));
  const d = a.diagnostics as Record<string, number>;
  assert.equal(d.soccer_selected_n, 50); assert.equal(d.tennis_selected_n, 25); assert.equal(d.other_selected_n, 25);
  assert.equal(a.selected.length, 100);
  assert.equal(new Set(a.selected.map((s) => s.physicalEventId)).size, 100);
  // one anchor per event, the deepest executable token (token b is min-order blocked at 0.52)
  for (const s of a.selected) { assert.ok(s.anchor.tokenId.endsWith("-a")); assert.equal(s.inventory.length, 2); }
  // per-sport ranking: top soccer is the deepest soccer event
  assert.equal(a.selected.filter((s) => s.bucket === "SOCCER")[0].anchor.rankingDepthUsd, 169);
  const other = a.selected.filter((s) => s.bucket.startsWith("OTHER"));
  // floor 4 per family (20), then the 5 fill slots go to the deepest remaining "other" events by depth:
  // basketball 80/70/60, then two tie-broken 57s (start, physical id) — never a soccer/tennis backfill
  assert.equal(other.filter((s) => s.sportFamily === "basketball").length, 7);
  assert.equal(other.filter((s) => s.bucket === "OTHER_LIQUIDITY_FILL").length, 5);
  assert.deepEqual(["baseball", "hockey", "cricket", "american-football"].map((f) => other.filter((s) => s.sportFamily === f).length).sort(), [4, 4, 5, 5]);
  assert.equal(a.excludedByQuota.filter((e) => e.sportFamily === "soccer").length, 20);
});

test("no cross-sport global backfill: tennis shortage stays an underfill", () => {
  seq = 0;
  const pool: MeasuredToken[] = [];
  for (let i = 0; i < 80; i++) pool.push(...event("soccer", 100 + i));
  for (let i = 0; i < 3; i++) pool.push(...event("tennis", 10 + i));
  const c = selectPhysicalEventCohort(pool);
  const d = c.diagnostics as Record<string, number>;
  assert.equal(d.soccer_selected_n, 50); assert.equal(d.tennis_selected_n, 3); assert.equal(d.tennis_quota_underfill_n, 22);
  assert.equal(d.other_quota_underfill_n, 25); assert.equal(d.global_backfill_n, 0);
  assert.equal(c.selected.length, 53);
});

test("unknown / blocked inventory makes an event ineligible; anchor uses only the common research measurement", () => {
  seq = 0;
  const blocked = event("soccer", 1, { depthB: 1 });                 // both sides < $2.50 depth
  const c = selectPhysicalEventCohort(blocked);
  assert.equal(c.selected.length, 0);
  assert.match(c.rejected[0].reason, /^NO_RESEARCH_EXECUTABLE_TOKEN:/);
  // opposite token deeper and executable (price 0.45) becomes the anchor; both tokens stay distinct in the inventory
  seq = 0;
  const flip = event("soccer", 20, { priceB: 0.45, depthB: 900 });
  const s = selectPhysicalEventCohort(flip).selected[0];
  assert.equal(s.anchor.tokenId, "tok-1-b"); assert.equal(s.anchor.rankingDepthUsd, 900);
  assert.deepEqual(s.inventory.map((t) => [t.tokenId, t.research.state]), [["tok-1-a", "EXECUTABLE"], ["tok-1-b", "EXECUTABLE"]]);
  assert.notEqual(s.inventory[0].tokenId, s.inventory[0].oppositeTokenId);
});

test("physical identity conflicts reject the event, never merge it", () => {
  seq = 0;
  const x = event("soccer", 300, { pid: "phys-same" });
  const y = event("tennis", 400, { pid: "phys-same" });
  const c = selectPhysicalEventCohort([...x, ...y]);
  assert.equal(c.selected.length, 0);
  assert.equal(c.rejected[0].reason, "PHYSICAL_EVENT_SPORT_CONTRADICTION");
  seq = 0;
  const z = selectPhysicalEventCohort([...event("soccer", 300, { pid: "p" }), ...event("soccer", 300, { pid: "p", start: startIn(11) })]);
  assert.equal(z.rejected[0].reason, "PHYSICAL_EVENT_START_CONTRADICTION");
});

// ── model independence ──────────────────────────────────────────────────────────────────────────────────────────
const NO_MODELS: ModelAuthority | undefined = undefined;
const ALL_SKIP: ModelAuthority = () => [{ strategyId: "P50_52_SAFE", strategyVersion: "v1", decision: "SKIP", tokenId: null }];
const ONE_BET: ModelAuthority = (e) => [{ strategyId: "QUALITY_FILL_D_SAFE", strategyVersion: "v1", decision: "BET", tokenId: e.tokens[e.tokens.length - 1].tokenId }];
const CONFLICTING: ModelAuthority = (e) => [
  { strategyId: "P50_52_SAFE", strategyVersion: "v1", decision: "BET", tokenId: e.tokens[0].tokenId },
  { strategyId: "TENNIS_P50_52_SAFE", strategyVersion: "v1", decision: "BET", tokenId: e.tokens[1].tokenId },
  { strategyId: "PORTFOLIO_BROAD_SAFE", strategyVersion: "v1", decision: "BET", tokenId: "token-outside-inventory" },
];

/**
 * Scenario that broke V1: a soccer event whose ONLY executable book is at 0.58 (outside the common limit) would have been
 * rescued into the ranking by a model BET carrying its own 0.60 ceiling (book executable there: 1-share venue minimum),
 * displacing the two shallowest soccer events. Reproduced against V1 head 1f2e4c9 (OLD FAIL) in the PR evidence.
 */
function modelRescueScenario(): MeasuredToken[] {
  seq = 0;
  const pool: MeasuredToken[] = [];
  for (let i = 0; i < 50; i++) pool.push(...event("soccer", 100 + i));
  for (let i = 0; i < 2; i++) pool.push(...event("soccer", 1, { priceB: 0.58, depthB: 5000, minOrderB: 1 }));
  return pool;
}

test("OLD FAIL / NEW PASS: the physical cohort is identical under no models, all SKIP, one BET and conflicting BETs", () => {
  const pool = modelRescueScenario();
  const digests = [NO_MODELS, ALL_SKIP, ONE_BET, CONFLICTING].map((authority) => {
    const cohort = selectPhysicalEventCohort(pool);          // the selector has no model input at all
    const before = cohortDigest(cohort);
    const decisions = attachModelDecisions(cohort, authority);
    assert.equal(cohortDigest(cohort), before, "attaching model decisions must not change the cohort");
    if (authority === CONFLICTING) {
      assert.ok(decisions.some((d) => d.status === "MODEL_TOKEN_NOT_IN_INVENTORY"));
      // different frozen models may choose different tokens of the SAME selected event; the anchor is not locked for them
      const perEvent = decisions.filter((d) => d.physicalEventId === cohort.selected[0].physicalEventId && d.status === "RECORDED");
      assert.equal(new Set(perEvent.map((d) => d.tokenId)).size, 2);
    }
    return { digest: before, ids: cohort.selected.map((s) => [s.physicalEventId, s.sportRank, s.bucket]) };
  });
  for (const d of digests) assert.deepEqual(d, digests[0]);
  // the 0.58-only events are not rescued and the 50 executable soccer events fill the quota
  const cohort = selectPhysicalEventCohort(pool);
  assert.equal(cohort.selected.length, 50);
  assert.ok(cohort.selected.every((s) => s.inventory.some((t) => t.research.executable)));
  const deep058 = pool.filter((t) => t.tokenId.endsWith("-b") && t.research.bestAsk === 0.58);
  assert.deepEqual(deep058.map((t) => t.research.state), ["BLOCKED_DEPTH_AT_LIMIT", "BLOCKED_DEPTH_AT_LIMIT"]);
  assert.ok(deep058.every((t) => !cohort.selected.some((s) => s.physicalEventId === t.physicalEventId)));
});

test("a model authority cannot mutate the frozen cohort", () => {
  const cohort = selectPhysicalEventCohort(modelRescueScenario());
  const before = cohortDigest(cohort);
  const evil: ModelAuthority = (e) => { (e.tokens as unknown as unknown[]).length = 0; return []; };
  assert.throws(() => attachModelDecisions(cohort, evil));
  assert.throws(() => { (cohort.selected as unknown[]).pop(); });
  assert.equal(cohortDigest(cohort), before);
});

test("the selector source has no model, strategy or Queue-headroom dependency", () => {
  const src = readFileSync(new URL("../../lib/research/executableLiquidityCohortT90.ts", import.meta.url), "utf8");
  const selector = src.slice(src.indexOf("export function selectPhysicalEventCohort"), src.indexOf("// ── canonical digest"));
  assert.doesNotMatch(selector, /ModelAuthority|authority|strategy|QUEUE_|liveQueue\.|hardCap/);
  const measure = src.slice(src.indexOf("export function measureResearchLiquidity"), src.indexOf("export function liveQueueView"));
  assert.doesNotMatch(measure, /hardCap/);
  assert.match(measure, /buildExecutableSiblingColumns\(\{ token: \{[^}]*\}, result, fee: null \}\)/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /QUEUE_ADAPTIVE|parentEventVolume24hr|4\.00?\b/);
});

// ── orchestration + receipt ─────────────────────────────────────────────────────────────────────────────────────
function deps(rows: SourceRow[], markets: Record<string, ProviderMarket[]>, books: (ids: string[]) => FetchOrderBookResult[]) {
  return {
    readSource: async () => ({ rows, timing: { ...TIMING, httpDateProxyMs: REF + 1_000, snapshotReadCompletedLocalMs: SNAP } }),
    readProviderEvent: async (eventId: string) => markets[eventId] ?? [],
    fetchBooks: async (ids: string[]) => books(ids),
    fetchFee: async () => ({ ok: true as const, takerRate: 0.01, formulaVersion: "f" }) as never,
  };
}

test("runner path: inventory expansion, real selector, receipt faithfully represents selector output without raw payloads", async () => {
  const rows = [row({ n: 1 }), row({ n: 2, provider_sport_family: "tennis", market_type: "moneyline" }), row({ n: 3, selected_token_id: "tok-3-typo" })];
  const markets: Record<string, ProviderMarket[]> = {
    "ev-1": [providerMarket()],
    "ev-2": [providerMarket({ provider_event_id: "ev-2", condition_id: "0xc2", clob_token_ids: ["tok-2-a", "tok-2-b"], provider_game_id: "g2" })],
    "ev-3": [providerMarket({ provider_event_id: "ev-3", condition_id: "0xc3", clob_token_ids: ["tok-3-a", "tok-3-x"], provider_game_id: "g3" })],
  };
  // tok-1-b (not source-selected) is the deepest side of event 1; event 3 source token is outside the provider pair
  const depth: Record<string, Array<[number, number]>> = { "tok-1-a": [[0.5, 100]], "tok-1-b": [[0.45, 2000]], "tok-2-a": [[0.5, 400]], "tok-2-b": [[0.6, 400]] };
  const run = await buildExecutableLiquidityCohort(deps(rows, markets, (ids) => ids.map((id) => ({ ...book(id, depth[id] ?? []), book: { ...book(id, depth[id] ?? []).book!, raw: { secret: "RAW" } } }))));
  assert.equal(run.funnel.inventory_tokens, 4);
  assert.equal(run.funnel.inventory_tokens_not_source_selected, 2);
  assert.equal(run.rejected.find((r) => r.subject === "0xc3")?.reason, "SOURCE_TOKEN_NOT_IN_PROVIDER_PAIR");
  const receipt = buildCohortReceipt(run, REF + 120_000);
  assert.equal(receipt.cohort_digest, cohortDigest(run.cohort));
  assert.deepEqual(receipt.selected.map((s) => [s.physical_event_id, s.sport_rank, s.anchor.token_id]), run.cohort.selected.map((s) => [s.physicalEventId, s.sportRank, s.anchor.tokenId]));
  const soccer = receipt.selected.find((s) => s.sport === "soccer")!;
  assert.equal(soccer.anchor.token_id, "tok-1-b"); assert.equal(soccer.anchor.is_betting_side, false);
  assert.deepEqual(soccer.inventory.map((t) => [t.token_id, t.source.selected_by_source, t.research.state]), [["tok-1-a", true, "EXECUTABLE"], ["tok-1-b", false, "EXECUTABLE"]]);
  const tennis = receipt.selected.find((s) => s.sport === "tennis")!;
  assert.equal(tennis.inventory.find((t) => t.token_id === "tok-2-b")!.research.state, "BLOCKED_DEPTH_AT_LIMIT");
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /RAW|apikey|Bearer|service_role/i);
  // timing labels: no proxy or local time is presented as DB decision_at
  assert.equal(receipt.timing.db_decision_at, null);
  assert.match(receipt.timing.http_date_proxy_kind, /PROXY_NOT_DECISION_AT/);
  assert.match(receipt.timing.db_source_ingest_watermark_kind, /NOT_DECISION_AT/);
  assert.match(receipt.timing.first_broken_timing_edge, /^DB_OWNED_DECISION_AT/);
  assert.match(receipt.status, /^PARTIAL_NOT_PROVEN_AUTHORITY/);
  assert.equal(receipt.unresolved_authority.research_price_limit_independent_of_live_queue, "NOT_PROVEN");
  assert.equal(receipt.is_db_persistence, false);
});

test("runner wiring: the script uses the real selector and receipt builder, fail-closed clone identity, GET only", () => {
  const src = readFileSync(new URL("../../scripts/research-t90-liquidity-cohort.ts", import.meta.url), "utf8");
  assert.match(src, /buildExecutableLiquidityCohort\(\{ readSource \}\)/);
  assert.match(src, /buildCohortReceipt\(run,/);
  assert.match(src, /REFUSING_NON_CLONE_TARGET/);
  assert.match(src, /CLONE_REF = "nppznoujvnyjargjkmnv"/);
  assert.match(src, /ingested_at=lte\./);
  assert.doesNotMatch(src, /method:\s*"(POST|PATCH|PUT|DELETE)"|modelAuthority|SELECT \*|select=\*/);
});
