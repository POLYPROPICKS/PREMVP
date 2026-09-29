import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_REGISTRY,
  IMPLEMENTATIONS,
  LEGACY_UNREPRODUCIBLE_REFERENCES,
  decimalOdds,
  settledPnlU,
  roiPct,
  inEntryBand,
  buildRunContext,
  buildDatasetManifest,
  buildArtifacts,
  evaluateSelection,
  rankByPnl,
  renderCeoTable,
  reconcileLegacy,
  scoreStrategies,
  type RunContext,
  type DatasetManifest,
  type ScorecardRow,
} from "../../scripts/modeling/football-strategy-registry";
import type { SourceRow, OverlayRecord } from "../../scripts/modeling/build-football-denominator-reconciliation";

// ── synthetic fixtures ──────────────────────────────────────────────────────
let seq = 0;
interface Spec { ev: string; price: number; label: string; at: string; market?: string | null; sport?: string | null; }
function fixture(specs: Spec[]): { rows: SourceRow[]; overlay: OverlayRecord[] } {
  const rows: SourceRow[] = [];
  const overlay: OverlayRecord[] = [];
  for (const s of specs) {
    seq += 1;
    const condition_id = `0xc${seq}`;
    const selected_token_id = `t${seq}`;
    const model_date = s.at.slice(0, 10);
    rows.push({
      model_date, population_id: "P", condition_id, selected_token_id, decision_at: s.at,
      provider_event_id: s.ev, sport_family: "soccer", settlement_label: s.label, entry_price_num: s.price,
      canonical_row: { eventStart: "2026-09-30T00:00:00Z", sportFamily: "soccer", marketTypeRaw: s.market ?? null },
    });
    overlay.push({
      model_date, population_id: "P", provider_event_id: s.ev, condition_id, selected_token_id, decision_at: s.at,
      source_sport_family: "soccer", reconciled_sport_family: s.sport === undefined ? "soccer" : s.sport,
      sport_reconciliation_basis: "SPORT_EXPLICIT", provider_sport_code: null, source_market_type: s.market ?? null,
      reconciled_market_type: s.market === undefined ? "moneyline" : s.market, market_type_source: "MARKET_TYPE_CANONICAL",
      display_odds_available: true, settlement_available: true, lead_time_available: true, score_level_available: true,
      data_coverage_available: true, volume_available: true,
    } as OverlayRecord);
  }
  return { rows, overlay };
}
const ctxOf = (specs: Spec[]): RunContext => {
  const f = fixture(specs);
  return buildRunContext(f.rows, f.overlay, () => null);
};
const T = (h: number) => `2026-09-10T${String(h).padStart(2, "0")}:00:00Z`;
const run = (symbol: string, ctx: RunContext) => IMPLEMENTATIONS[symbol](ctx);
const sym = (id: string) => STRATEGY_REGISTRY.find((d) => d.strategy_id === id)!.implementation_symbol;

// ── registry structure ──────────────────────────────────────────────────────
test("registry has 9 unique executable IDs, each with a real implementation symbol", () => {
  assert.equal(STRATEGY_REGISTRY.length, 9);
  assert.equal(new Set(STRATEGY_REGISTRY.map((d) => d.strategy_id)).size, 9);
  for (const d of STRATEGY_REGISTRY) {
    assert.equal(typeof IMPLEMENTATIONS[d.implementation_symbol], "function", d.strategy_id);
    assert.equal(IMPLEMENTATIONS[d.implementation_symbol].name, d.implementation_symbol);
    assert.equal(d.executable, true);
    assert.equal(d.one_physical_event_max, true);
    assert.ok(!/P50_5[24]/.test(d.plain_language_rule), "no P50 shorthand in CEO-facing text");
  }
});

test("old 3835 baseline is metadata only, never executable", () => {
  const ref = LEGACY_UNREPRODUCIBLE_REFERENCES[0];
  assert.deepEqual(ref.legacy_reference, { selected: 3835, settled: 2522, open: 1313, pnl_u: -0.73, status: "LEGACY_UNREPRODUCIBLE_REFERENCE", executable: false });
  assert.equal(ref.executable, false);
  assert.ok(!STRATEGY_REGISTRY.some((d) => d.strategy_id === "FOOTBALL_ALL_BASELINE"));
  const base = STRATEGY_REGISTRY.find((d) => d.strategy_id === "FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER")!;
  assert.equal(base.status, "BASELINE");
  assert.deepEqual(base.legacy_reported_metrics, []);
});

// ── formulas ────────────────────────────────────────────────────────────────
test("odds conversion and PnL / ROI formulas on fixed examples", () => {
  assert.equal(decimalOdds(0.5), 2);
  assert.equal(decimalOdds(0.25), 4);
  assert.equal(settledPnlU("WIN", 0.5), 1);
  assert.equal(settledPnlU("WIN", 0.25), 3);
  assert.equal(settledPnlU("LOSS", 0.5), -1);
  assert.equal(roiPct(2, 8), 25);
  assert.equal(roiPct(0, 0), 0);
});

test("price-band boundaries: lower inclusive, upper exclusive", () => {
  assert.equal(inEntryBand(0.5, 0.5, 0.52), true);
  assert.equal(inEntryBand(0.52, 0.5, 0.52), false);
  assert.equal(inEntryBand(0.4999, 0.5, 0.52), false);
  const ctx = ctxOf([
    { ev: "a", price: 0.5, label: "WIN", at: T(1) },
    { ev: "b", price: 0.52, label: "WIN", at: T(2) },
    { ev: "c", price: 0.5199, label: "WIN", at: T(3) },
    { ev: "d", price: 0.54, label: "WIN", at: T(4) },
    { ev: "e", price: 0.4999, label: "WIN", at: T(5) },
  ]);
  assert.deepEqual(run(sym("FOOTBALL_ODDS_192_200_PRICE_BAND"), ctx).map((s) => s.physicalEventKey).sort(), ["a", "c"]);
  assert.deepEqual(run(sym("FOOTBALL_ODDS_185_200_PRICE_BAND"), ctx).map((s) => s.physicalEventKey).sort(), ["a", "b", "c"]);
});

test("odds-bucket boundaries: 1.75 inclusive, 2.00 exclusive", () => {
  const ctx = ctxOf([
    { ev: "lo", price: 1 / 1.75, label: "WIN", at: T(1) }, // odds exactly 1.75 -> in
    { ev: "hi", price: 0.5, label: "WIN", at: T(2) }, // odds exactly 2.00 -> out
    { ev: "mid", price: 0.53, label: "WIN", at: T(3) },
    { ev: "under", price: 0.58, label: "WIN", at: T(4) }, // odds 1.724 -> out
  ]);
  assert.deepEqual(run(sym("FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200"), ctx).map((s) => s.physicalEventKey).sort(), ["lo", "mid"]);
});

// ── ordinary baseline ───────────────────────────────────────────────────────
test("ordinary baseline excludes exact-score, unresolved and non-soccer", () => {
  const ctx = ctxOf([
    { ev: "ml", price: 0.6, label: "WIN", at: T(1), market: "moneyline" },
    { ev: "corn", price: 0.3, label: "LOSS", at: T(2), market: "total_corners" },
    { ev: "exact", price: 0.1, label: "WIN", at: T(3), market: "soccer_exact_score" },
    { ev: "unres", price: 0.4, label: "WIN", at: T(4), market: null },
    { ev: "ten", price: 0.4, label: "WIN", at: T(5), market: "moneyline", sport: "tennis" },
  ]);
  assert.deepEqual(run("selectFootballOrdinaryStructuredNoOddsFilter", ctx).map((s) => s.physicalEventKey).sort(), ["corn", "ml"]);
});

test("market scopes: moneyline/totals/spreads, corners, spreads-only", () => {
  const ctx = ctxOf([
    { ev: "ml", price: 0.51, label: "WIN", at: T(1), market: "moneyline" },
    { ev: "sp", price: 0.51, label: "WIN", at: T(2), market: "spreads" },
    { ev: "co", price: 0.51, label: "WIN", at: T(3), market: "total_corners" },
    { ev: "ex", price: 0.51, label: "WIN", at: T(4), market: "soccer_exact_score" },
  ]);
  assert.deepEqual(run(sym("FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200"), ctx).map((s) => s.physicalEventKey).sort(), ["ml", "sp"]);
  assert.deepEqual(run(sym("FOOTBALL_SPREADS_ODDS_185_200_AUDIT_REQUIRED"), ctx).map((s) => s.physicalEventKey), ["sp"]);
  const corners = ctxOf([
    { ev: "c1", price: 0.42, label: "WIN", at: T(1), market: "total_corners" },
    { ev: "c2", price: 0.5, label: "WIN", at: T(2), market: "total_corners" },
    { ev: "m1", price: 0.42, label: "WIN", at: T(3), market: "totals" },
  ]);
  assert.deepEqual(run(sym("FOOTBALL_TOTAL_CORNERS_ODDS_225_250"), corners).map((s) => s.physicalEventKey), ["c1"]);
});

// ── selection semantics ─────────────────────────────────────────────────────
test("one physical event max, chronological-first, predicate before settlement", () => {
  // Later row is a WIN, earlier qualifying row is a LOSS: result must not steer membership.
  const ctx = ctxOf([
    { ev: "e", price: 0.51, label: "WIN", at: T(9) },
    { ev: "e", price: 0.5, label: "LOSS", at: T(3) },
    { ev: "e", price: 0.505, label: "WIN", at: T(5) },
  ]);
  const sel = run("selectFootballOdds192200PriceBand", ctx);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].decisionTimestamp, T(3));
  const m = evaluateSelection(sel, ctx.settlement, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.wins, 0);
  // Flipping ONLY the labels must not change which row is selected.
  const flipped = ctxOf([
    { ev: "e", price: 0.51, label: "LOSS", at: T(9) },
    { ev: "e", price: 0.5, label: "WIN", at: T(3) },
    { ev: "e", price: 0.505, label: "LOSS", at: T(5) },
  ]);
  assert.equal(run("selectFootballOdds192200PriceBand", flipped)[0].decisionTimestamp, T(3));
});

test("OPEN and other nonterminal never become LOSS", () => {
  const ctx = ctxOf([
    { ev: "w", price: 0.5, label: "WIN", at: T(1) },
    { ev: "l", price: 0.5, label: "LOSS", at: T(2) },
    { ev: "o", price: 0.5, label: "OPEN", at: T(3) },
    { ev: "v", price: 0.5, label: "VOID", at: T(4) },
  ]);
  const m = evaluateSelection(run("selectFootballOdds192200PriceBand", ctx), ctx.settlement, 1);
  assert.equal(m.selected_n, 4);
  assert.equal(m.settled_n, 2);
  assert.equal(m.open_n, 1);
  assert.equal(m.other_nonterminal_n, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.pnl_u, 0); // +1 (win at 0.5) -1 (loss)
  assert.equal(m.roi_pct, 0);
});

test("MaxDD is chronological cumulative settled drawdown", () => {
  const ctx = ctxOf([
    { ev: "a", price: 0.5, label: "WIN", at: T(1) },
    { ev: "b", price: 0.5, label: "LOSS", at: T(2) },
    { ev: "c", price: 0.5, label: "LOSS", at: T(3) },
    { ev: "d", price: 0.5, label: "WIN", at: T(4) },
  ]);
  const m = evaluateSelection(run("selectFootballOdds192200PriceBand", ctx), ctx.settlement, 1);
  assert.equal(m.pnl_u, 0);
  assert.equal(m.max_dd_u, -2);
});

test("SAFE strategies select all-sport first, then keep the football subset", () => {
  // A non-soccer (unresolved sport) row claims the event slot first -> the later soccer row must NOT be selected.
  const f = fixture([
    { ev: "shared", price: 0.51, label: "WIN", at: T(1), sport: null },
    { ev: "shared", price: 0.51, label: "WIN", at: T(2) },
    { ev: "solo", price: 0.51, label: "WIN", at: T(3) },
  ]);
  const ctx = buildRunContext(f.rows, f.overlay, () => null);
  const safe = run(sym("FOOTBALL_ODDS_192_200_REPAIRED_SAFE"), ctx);
  assert.deepEqual(safe.map((s) => s.physicalEventKey), ["solo"]);
  // football-first strategy keeps the soccer row on the shared event
  assert.deepEqual(run(sym("FOOTBALL_ODDS_192_200_PRICE_BAND"), ctx).map((s) => s.physicalEventKey).sort(), ["shared", "solo"]);
});

// ── scorecard / artifacts ───────────────────────────────────────────────────
const dsFor = (ctx: RunContext): DatasetManifest => buildDatasetManifest(ctx, 3, "testcommit", (p) => Buffer.from(JSON.stringify({ OVERLAY_CONTENT_SHA256: "x", COMBINED: { stats: { canonical_soccer_physical_event_n: new Set(ctx.structural.map((c) => c.physicalEventKey)).size } } })));
const bigCtx = () => ctxOf([
  { ev: "a", price: 0.5, label: "WIN", at: T(1), market: "spreads" },
  { ev: "b", price: 0.51, label: "LOSS", at: T(2), market: "moneyline" },
  { ev: "c", price: 0.53, label: "WIN", at: T(3), market: "totals" },
  { ev: "d", price: 0.42, label: "OPEN", at: T(4), market: "total_corners" },
  { ev: "e", price: 0.6, label: "WIN", at: T(5), market: "moneyline" },
]);

test("every scorecard row links to the exact dataset manifest/hash", () => {
  const ctx = bigCtx();
  const ds = dsFor(ctx);
  const rows = scoreStrategies(ctx, ds);
  assert.equal(rows.length, 9);
  for (const r of rows) {
    assert.equal(r.dataset_id, ds.DATASET_ID);
    assert.equal(r.dataset_manifest_sha256, ds.MANIFEST_FILE_SHA256);
    assert.equal(r.dataset_overlay_sha256, ds.OVERLAY_SHA256);
    assert.equal(r.total_unique_football_matches, ds.UNIQUE_PHYSICAL_EVENT_N);
  }
});

test("output is deterministic and CEO table is sorted by common PnL descending", () => {
  const ctx = bigCtx();
  const ds = dsFor(ctx);
  const a = buildArtifacts(ctx, ds);
  const b = buildArtifacts(ctx, ds);
  assert.deepEqual(a.files, b.files);
  const ranked = rankByPnl(a.scorecard);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].metrics.pnl_u >= ranked[i].metrics.pnl_u);
  const md = renderCeoTable(a.scorecard, ds);
  const order = [...md.matchAll(/^\| (\d+) \| (FOOTBALL_[A-Z0-9_]+) \|/gm)].map((m) => m[2]);
  assert.deepEqual(order, ranked.map((r) => r.strategy_id));
  assert.match(md, /OPEN ≠ LOSS/);
  assert.ok(!/P50_5[24]/.test(md));
  assert.match(a.files["SHA256SUMS.txt"], /CEO_FOOTBALL_STRATEGIES\.md/);
});

test("legacy metrics cannot replace common metrics", () => {
  const ctx = bigCtx();
  const ds = dsFor(ctx);
  const { files, scorecard } = buildArtifacts(ctx, ds);
  const registry = JSON.parse(files["STRATEGY_REGISTRY.json"]);
  const safe1 = registry.STRATEGIES.find((s: { strategy_id: string }) => s.strategy_id === "FOOTBALL_ODDS_192_200_REPAIRED_SAFE");
  assert.equal(safe1.legacy_reported_metrics.at(-1).pnl_u, 182.8);
  const common = scorecard.find((r: ScorecardRow) => r.strategy_id === "FOOTBALL_ODDS_192_200_REPAIRED_SAFE")!;
  assert.deepEqual(safe1.common_corpus_metrics, common.metrics);
  assert.notEqual(common.metrics.pnl_u, 182.8);
  const recon = reconcileLegacy(scorecard).filter((r) => r.strategy_id === "FOOTBALL_ODDS_192_200_REPAIRED_SAFE");
  assert.ok(recon.every((r) => r.exact_match === null && r.same_span_and_settlement === false));
});
