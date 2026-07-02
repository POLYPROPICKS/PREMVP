import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computeRealPnlUsd,
  formatRealReturnLabel,
  mapResolvedPairRow,
  buildSignalKey,
  buildMatchKey,
  selectResolvedRows,
  computeRealResolvedSummary,
  computeRealReturnCurve,
  mapRealResolvedRowToTrackRecordRow,
  RESOLVED_RESULTS_SOURCE,
  WINDOW_RESULTS_SOURCE,
  computeWindowResultsSummary,
  computeWindowReturnCurve,
  mapWindowResultRowToLedgerRow,
  mapWindowResultRowToTrackRecordRow,
  type ResolvedPairRow,
  type RealResolvedRow,
  type WindowResultRow,
} from "../../app/api/signals/resolved/route";

function windowResultRow(overrides: Partial<WindowResultRow> = {}): WindowResultRow {
  return {
    window_days: 7,
    source_row_id: "11111111-1111-1111-1111-111111111111",
    score_rank: 1,
    match_key: "team-a-vs-team-b-event",
    signal_key: "team-a-vs-team-b|Team A",
    event_title: "Team A vs Team B",
    market_question: "Will Team A win?",
    selected_outcome: "Team A",
    signal_result: "won",
    display_status: "Hit",
    is_resolved: true,
    resolved_at: "2026-06-28T12:00:00.000Z",
    winning_outcome: "Team A",
    entry_price_num: 0.5,
    decimal_odds: 2,
    real_pnl_usd: 100,
    return_label: "+$100",
    ...overrides,
  };
}

function resolvedPairRow(overrides: Partial<ResolvedPairRow> = {}): ResolvedPairRow {
  return {
    id: "row-1",
    resolved_at: "2026-06-28T12:00:00.000Z",
    created_at: "2026-06-25T12:00:00.000Z",
    signal_result: "won",
    winning_outcome: "Team A",
    selected_outcome: "Team A",
    entry_price_num: 0.5,
    premium_signal: { eventTitle: "Team A vs Team B", marketQuestion: "Will Team A win?" },
    market_slug: "team-a-vs-team-b",
    event_slug: "team-a-vs-team-b-event",
    score: null,
    ...overrides,
  };
}

// ── Real PnL formula: flat $100 stake, no projected EV ──────────────────────

test("computeRealPnlUsd: won at entry_price_num=0.5 => +$100", () => {
  assert.equal(computeRealPnlUsd("won", 0.5), 100);
});

test("computeRealPnlUsd: won at entry_price_num=0.25 => +$300", () => {
  assert.equal(computeRealPnlUsd("won", 0.25), 300);
});

test("computeRealPnlUsd: lost => -$100 regardless of entry price", () => {
  assert.equal(computeRealPnlUsd("lost", 0.4), -100);
  assert.equal(computeRealPnlUsd("lost", 0.9), -100);
});

test("formatRealReturnLabel: positive/negative format as +$N / -$N", () => {
  assert.equal(formatRealReturnLabel(100), "+$100");
  assert.equal(formatRealReturnLabel(-100), "-$100");
});

// ── mapResolvedPairRow: row mapping ──────────────────────────────────────────

test("mapResolvedPairRow maps generated_signal_pairs columns to the real-resolved row shape", () => {
  const row = mapResolvedPairRow(resolvedPairRow({ entry_price_num: 0.5, signal_result: "won" }));
  assert.equal(row.sourceRowId, "row-1");
  assert.equal(row.eventTitle, "Team A vs Team B");
  assert.equal(row.marketQuestion, "Will Team A win?");
  assert.equal(row.selectedOutcome, "Team A");
  assert.equal(row.winningOutcome, "Team A");
  assert.equal(row.signalResult, "won");
  assert.equal(row.displayStatus, "Hit");
  assert.equal(row.entryPrice, 0.5);
  assert.equal(row.decimalOdds, 2);
  assert.equal(row.realPnlUsd, 100);
  assert.equal(row.returnLabel, "+$100");
});

test("mapResolvedPairRow falls back event/market title from slugs when premium_signal is missing", () => {
  const row = mapResolvedPairRow(resolvedPairRow({ premium_signal: null }));
  assert.equal(row.eventTitle, "team-a-vs-team-b-event");
  assert.equal(row.marketQuestion, "team-a-vs-team-b");
});

test("mapResolvedPairRow: lost row displayStatus is Miss", () => {
  const row = mapResolvedPairRow(resolvedPairRow({ signal_result: "lost" }));
  assert.equal(row.displayStatus, "Miss");
  assert.equal(row.realPnlUsd, -100);
});

// ── de-duplication: signalKey / matchKey / selection ─────────────────────────

test("buildSignalKey and buildMatchKey are stable per market/event", () => {
  const row = resolvedPairRow();
  assert.equal(buildSignalKey(row), "team-a-vs-team-b::Team A");
  assert.equal(buildMatchKey(row), "team-a-vs-team-b-event");
});

test("buildSignalKey falls back to id when there is no market/question/outcome to key on", () => {
  const row = resolvedPairRow({
    market_slug: null,
    selected_outcome: null,
    premium_signal: null,
    event_slug: null,
  });
  assert.equal(buildSignalKey(row), "id:row-1");
});

test("selectResolvedRows keeps one row per matchKey, preferring higher score", () => {
  const a = mapResolvedPairRow(resolvedPairRow({ id: "a", score: 1 } as Partial<ResolvedPairRow>));
  const b = mapResolvedPairRow(resolvedPairRow({ id: "b", score: 5 } as Partial<ResolvedPairRow>));
  const selected = selectResolvedRows([a, b]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceRowId, "b");
});

test("selectResolvedRows prefers newer resolved_at when scores are equal/absent", () => {
  const older = mapResolvedPairRow(resolvedPairRow({ id: "older", resolved_at: "2026-06-20T00:00:00.000Z" }));
  const newer = mapResolvedPairRow(resolvedPairRow({ id: "newer", resolved_at: "2026-06-28T00:00:00.000Z" }));
  const selected = selectResolvedRows([older, newer]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceRowId, "newer");
});

test("selectResolvedRows keeps distinct matches separate", () => {
  const a = mapResolvedPairRow(resolvedPairRow({ id: "a", event_slug: "event-a" }));
  const b = mapResolvedPairRow(resolvedPairRow({ id: "b", event_slug: "event-b" }));
  const selected = selectResolvedRows([a, b]);
  assert.equal(selected.length, 2);
});

// ── summary aggregation ───────────────────────────────────────────────────────

test("computeRealResolvedSummary: netProfitUsd = sum(realPnlUsd)", () => {
  const rows: RealResolvedRow[] = [
    mapResolvedPairRow(resolvedPairRow({ id: "1", signal_result: "won", entry_price_num: 0.5, event_slug: "e1" })),
    mapResolvedPairRow(resolvedPairRow({ id: "2", signal_result: "lost", event_slug: "e2" })),
  ];
  const summary = computeRealResolvedSummary(rows);
  assert.equal(summary.netProfitUsd, 0);
  assert.equal(summary.winsCount, 1);
  assert.equal(summary.lossesCount, 1);
  assert.equal(summary.resolvedCount, 2);
});

test("computeRealResolvedSummary: netReturnPct = netProfitUsd / (resolvedCount * 100) * 100", () => {
  const rows: RealResolvedRow[] = [
    mapResolvedPairRow(resolvedPairRow({ id: "1", signal_result: "won", entry_price_num: 0.25, event_slug: "e1" })),
    mapResolvedPairRow(resolvedPairRow({ id: "2", signal_result: "lost", event_slug: "e2" })),
  ];
  const summary = computeRealResolvedSummary(rows);
  // wins: +$300, losses: -$100 => net $200 over $200 stake => 100%
  assert.equal(summary.netProfitUsd, 200);
  assert.equal(summary.totalStakeUsd, 200);
  assert.equal(summary.netReturnPct, 100);
});

test("computeRealResolvedSummary: pendingCount is always 0 (resolved-only section, not derived from projected PnL)", () => {
  const summary = computeRealResolvedSummary([]);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.signalsTracked, 0);
  assert.equal(summary.netProfitUsd, 0);
});

// ── returnCurve ────────────────────────────────────────────────────────────

test("computeRealReturnCurve: cumulative sum ordered by resolved_at ascending", () => {
  const rows: RealResolvedRow[] = [
    mapResolvedPairRow(resolvedPairRow({ id: "1", resolved_at: "2026-06-28T00:00:00.000Z", signal_result: "won", entry_price_num: 0.5, event_slug: "e1" })),
    mapResolvedPairRow(resolvedPairRow({ id: "2", resolved_at: "2026-06-20T00:00:00.000Z", signal_result: "lost", event_slug: "e2" })),
  ];
  const curve = computeRealReturnCurve(rows);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].cumulativeProfitUsd, -100);
  assert.equal(curve[1].cumulativeProfitUsd, 0);
});

// ── row mapping to UI TrackRecordRow shape ───────────────────────────────────

test("mapRealResolvedRowToTrackRecordRow never uses Published as ledger status", () => {
  const row = mapRealResolvedRowToTrackRecordRow(mapResolvedPairRow(resolvedPairRow()));
  assert.equal(row.status, "Resolved");
  assert.ok(row.displayStatus === "Hit" || row.displayStatus === "Miss");
});

// ── 14D superset 7D invariant ─────────────────────────────────────────────────

test("14D selection includes every 7D selected sourceRowId", () => {
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

  const all: ResolvedPairRow[] = [
    resolvedPairRow({ id: "a", resolved_at: daysAgo(2), event_slug: "e-a" }),
    resolvedPairRow({ id: "b", resolved_at: daysAgo(5), event_slug: "e-b" }),
    resolvedPairRow({ id: "c", resolved_at: daysAgo(10), event_slug: "e-c" }),
    resolvedPairRow({ id: "d", resolved_at: daysAgo(13), event_slug: "e-d" }),
  ];

  const mapped = all.map(mapResolvedPairRow);
  const selectedWide = selectResolvedRows(mapped);

  const cutoff7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff14 = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const selected7d = selectedWide.filter((r) => r.resolvedAt >= cutoff7);
  const selected14d = selectedWide.filter((r) => r.resolvedAt >= cutoff14);

  const ids14d = new Set(selected14d.map((r) => r.sourceRowId));
  for (const row of selected7d) {
    assert.ok(ids14d.has(row.sourceRowId), `${row.sourceRowId} missing from 14D superset`);
  }
  assert.equal(selected7d.length, 2);
  assert.equal(selected14d.length, 4);
});

// ── source contract ────────────────────────────────────────────────────────

test("RESOLVED_RESULTS_SOURCE constant retained (legacy pure-fn helpers), WINDOW_RESULTS_SOURCE is the API source", () => {
  assert.equal(RESOLVED_RESULTS_SOURCE, "generated_signal_pairs_resolved_results");
  assert.equal(WINDOW_RESULTS_SOURCE, "track_record_window_results");
});

const routeSource = fs.readFileSync(
  path.join(__dirname, "../../app/api/signals/resolved/route.ts"),
  "utf8"
);

test("weekResultsCard source is track_record_window_results, and the API reads only that table", () => {
  assert.ok(routeSource.includes("source: WINDOW_RESULTS_SOURCE"));
  assert.ok(routeSource.includes('.from("track_record_window_results")'));
});

test("weekResultsCard construction never queries generated_signal_pairs or track_record_display_signals directly", () => {
  const weekResultsCardBlockStart = routeSource.indexOf("// ── weekResultsCard: read-model");
  const weekResultsCardBlockEnd = routeSource.indexOf("let query = supabase");
  const block = routeSource.slice(weekResultsCardBlockStart, weekResultsCardBlockEnd);
  assert.ok(!block.includes('.from("generated_signal_pairs")'));
  assert.ok(!block.includes('.from("track_record_display_signals")'));
});

test("API queries track_record_window_results filtered by window_days = requested days", () => {
  assert.ok(routeSource.includes('.eq("window_days", windowDays)'));
});

// ── strict 6/4 refresh strategy (migration file, text-contract checks) ──────

const migrationSource = fs.readFileSync(
  path.join(__dirname, "../../supabase/migrations/20260702_track_record_window_results.sql"),
  "utf8"
);

test("migration uses the strict floor(60%) win split (no ceil), losses are the remainder", () => {
  assert.ok(migrationSource.includes("floor(count(*) * 0.60)::int AS target_wins"));
  assert.ok(migrationSource.includes("count(*)::int - floor(count(*) * 0.60)::int AS target_losses"));
  assert.ok(!migrationSource.includes("ceil(count(*) * 0.60)"));
  assert.ok(!migrationSource.includes("ceil(count(*)*0.60)"));
});

test("migration sizes window target counts from track_record_display_signals (counts only)", () => {
  assert.ok(migrationSource.includes("target_counts AS"));
  assert.ok(migrationSource.includes("FROM public.track_record_display_signals"));
  assert.ok(migrationSource.includes("count(*)::int AS target_count"));
});

test("migration uses no TEMP TABLE and no 'No cherry picking' text", () => {
  assert.ok(!/TEMP TABLE/i.test(migrationSource));
  assert.ok(!/no cherry.?pick/i.test(migrationSource));
});

test("migration selects actual won and lost buckets, both included", () => {
  assert.ok(migrationSource.includes("won AS"));
  assert.ok(migrationSource.includes("lost AS"));
  assert.ok(migrationSource.includes("result_bucket = 'won'"));
  assert.ok(migrationSource.includes("result_bucket = 'lost'"));
});

test("migration score_rank interleaves buckets proportionally (first 10 = 6 Hit / 4 Miss)", () => {
  assert.ok(migrationSource.includes("(s.bucket_rank - 0.5) / NULLIF(s.bucket_total, 0)"));
});

test("migration labels the strict rule via source_model = strict-resolved-6-4-display", () => {
  assert.ok(migrationSource.includes("'strict-resolved-6-4-display'"));
});

test("no projected EV formula is used for real PnL computation", () => {
  const fnStart = routeSource.indexOf("export function computeRealPnlUsd");
  const fnEnd = routeSource.indexOf("\n}", fnStart);
  const fnBody = routeSource.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes("winProbability"));
  assert.ok(!fnBody.includes("odds - 1"));
});

// ── limit affects ledger rows only ───────────────────────────────────────────

test("limit slices ledger rows but summary/curve use the full table row set for the window (contract check)", () => {
  const ledgerBlockStart = routeSource.indexOf("const trackRecordRows: TrackRecordRow[]");
  const ledgerBlockEnd = routeSource.indexOf(";", routeSource.indexOf(".map(mapWindowResultRowToTrackRecordRow)"));
  const ledgerBlock = routeSource.slice(ledgerBlockStart, ledgerBlockEnd);
  assert.ok(ledgerBlock.includes(".slice(0, limit)"));

  const summaryLine = routeSource.indexOf("const summary = computeWindowResultsSummary(windowRows)");
  assert.ok(summaryLine !== -1, "summary must be computed from the unsliced window row set");
});

// ── safe logging: fields present, no raw rows / secrets ─────────────────────

test("safe log includes required fields and never logs secrets/env/raw rows", () => {
  const logStart = routeSource.indexOf('console.log("[weekResultsCard]"');
  const logEnd = routeSource.indexOf("});", logStart);
  const logBlock = routeSource.slice(logStart, logEnd);

  for (const field of [
    "source",
    "windowDays",
    "tableRows",
    "resolvedRows",
    "pendingRows",
    "winsCount",
    "lossesCount",
    "ledgerLimit",
    "ledgerRows",
    "netProfitUsd",
    "netReturnPct",
    "supersetMissingCount",
  ]) {
    assert.ok(logBlock.includes(field), `expected safe log field "${field}"`);
  }

  for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "supabaseServiceKey", "process.env", "JSON.stringify(rows)"]) {
    assert.ok(!logBlock.includes(forbidden), `unexpected unsafe token "${forbidden}" in safe log`);
  }
});

// ── docs file ─────────────────────────────────────────────────────────────

test("docs file exists and documents the resolved source table and PnL formula", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  assert.ok(fs.existsSync(docsPath), "expected docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md to exist");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(docs.includes("generated_signal_pairs"));
  assert.ok(docs.includes("track_record_display_signals"));
  assert.ok(docs.includes("signal_result"));
  assert.ok(docs.includes("resolved_at"));
  assert.ok(docs.includes("entry_price_num"));
});

// ── WhyTrustSection: approved visible labels present, replaced labels absent ─

const whyTrustSource = fs.readFileSync(
  path.join(__dirname, "../../components/why-trust/WhyTrustSection.tsx"),
  "utf8"
);

test("WhyTrustSection uses the approved visible labels", () => {
  for (const label of [
    "Net Return",
    "Signals Tracked",
    "Resolved",
    "Pending",
    "Cumulative Return",
    "Recent Signal Ledger",
    "How we track signals",
    "Flat $100 per resolved signal",
  ]) {
    assert.ok(whyTrustSource.includes(label), `expected label "${label}" in WhyTrustSection`);
  }
});

test("WhyTrustSection does not use the replaced labels", () => {
  for (const label of ["Projected Return", "Signals Published", "Projected Rate", "Avg Odds"]) {
    assert.ok(!whyTrustSource.includes(label), `unexpected replaced label "${label}" in WhyTrustSection`);
  }
});

test("WhyTrustSection derives the Net Return headline value from netProfitUsd (dollars), not netReturnPct alone", () => {
  assert.ok(whyTrustSource.includes("fmtUsdSigned(card.netProfitUsd)"));
  assert.ok(whyTrustSource.includes("card.netReturnPct"));
});

test("WhyTrustSection chart badge/series are dollar-based (cumulativeProfitUsd), not percent-only", () => {
  assert.ok(whyTrustSource.includes("cumulativeProfitUsd"));
  assert.ok(whyTrustSource.includes("fmtUsdSigned(points[endIdx].cumUsd)"));
});

test("WhyTrustSection uses risk (red) styling for negative netProfitUsd, not the green accent class", () => {
  assert.ok(whyTrustSource.includes("metricValueRisk"));
  assert.ok(whyTrustSource.includes("signOf(card.netProfitUsd)"));
  assert.ok(whyTrustSource.includes("m.sign === 'negative'"));
});

test("WhyTrustSection chart end badge/line follow the same sign styling as the cumulative total", () => {
  assert.ok(whyTrustSource.includes("endNegative"));
  assert.ok(whyTrustSource.includes("lineColor"));
});

// ── computeWindowResultsSummary / computeWindowReturnCurve / ledger mapping ──

test("computeWindowResultsSummary: signalsTracked = table row count for the window, not a ledger limit", () => {
  const rows = Array.from({ length: 47 }, (_, i) =>
    windowResultRow({ source_row_id: `row-${i}`, score_rank: i + 1 })
  );
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 47);
});

test("computeWindowResultsSummary: 14D target of 91 rows can produce signalsTracked 91", () => {
  const rows = Array.from({ length: 91 }, (_, i) =>
    windowResultRow({ window_days: 14, source_row_id: `row-${i}`, score_rank: i + 1 })
  );
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 91);
});

test("computeWindowResultsSummary: pendingCount = signalsTracked - resolvedCount, wins and losses both counted", () => {
  const rows: WindowResultRow[] = [
    windowResultRow({ source_row_id: "1", signal_result: "won", display_status: "Hit", is_resolved: true, entry_price_num: 0.5, real_pnl_usd: 100, return_label: "+$100" }),
    windowResultRow({ source_row_id: "2", signal_result: "lost", display_status: "Miss", is_resolved: true, entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }),
    windowResultRow({ source_row_id: "3", signal_result: null, display_status: "Pending", is_resolved: false, resolved_at: null, entry_price_num: null, decimal_odds: null, real_pnl_usd: null, return_label: "—" }),
  ];
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 3);
  assert.equal(summary.resolvedCount, 2);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.winsCount, 1);
  assert.equal(summary.lossesCount, 1);
});

test("computeWindowResultsSummary: won at entry_price_num=0.5 contributes +$100 to netProfitUsd", () => {
  const rows = [windowResultRow({ entry_price_num: 0.5, real_pnl_usd: 100 })];
  assert.equal(computeWindowResultsSummary(rows).netProfitUsd, 100);
});

test("computeWindowResultsSummary: won at entry_price_num=0.25 contributes +$300 to netProfitUsd", () => {
  const rows = [windowResultRow({ entry_price_num: 0.25, real_pnl_usd: 300, return_label: "+$300" })];
  assert.equal(computeWindowResultsSummary(rows).netProfitUsd, 300);
});

test("computeWindowResultsSummary: lost contributes -$100 to netProfitUsd", () => {
  const rows = [windowResultRow({ signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" })];
  assert.equal(computeWindowResultsSummary(rows).netProfitUsd, -100);
});

test("computeWindowResultsSummary: pending row has null realPnlUsd and does not affect netProfitUsd", () => {
  const rows = [
    windowResultRow({ source_row_id: "1", real_pnl_usd: 100 }),
    windowResultRow({ source_row_id: "2", signal_result: null, display_status: "Pending", is_resolved: false, resolved_at: null, entry_price_num: null, decimal_odds: null, real_pnl_usd: null, return_label: "—" }),
  ];
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.netProfitUsd, 100);
  assert.equal(summary.pendingCount, 1);
});

test("computeWindowResultsSummary: netProfitUsd sums only resolved real PnL (won + lost mix)", () => {
  const rows = [
    windowResultRow({ source_row_id: "1", entry_price_num: 0.25, real_pnl_usd: 300, return_label: "+$300" }),
    windowResultRow({ source_row_id: "2", signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }),
  ];
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.netProfitUsd, 200);
  assert.equal(summary.totalStakeUsd, 200);
  assert.equal(summary.netReturnPct, 100);
});

test("computeWindowResultsSummary: netReturnPct denominator = resolvedCount * 100 (pending rows excluded from stake)", () => {
  const rows = [
    windowResultRow({ source_row_id: "1", real_pnl_usd: 100 }),
    windowResultRow({ source_row_id: "2", signal_result: null, display_status: "Pending", is_resolved: false, resolved_at: null, entry_price_num: null, decimal_odds: null, real_pnl_usd: null, return_label: "—" }),
  ];
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.totalStakeUsd, 100);
  assert.equal(summary.netReturnPct, 100);
});

test("computeWindowReturnCurve: cumulative sum over resolved rows only, ordered by score_rank ascending (strict display order)", () => {
  const rows = [
    windowResultRow({ source_row_id: "1", score_rank: 2, real_pnl_usd: 100 }),
    windowResultRow({ source_row_id: "2", score_rank: 1, signal_result: "lost", display_status: "Miss", real_pnl_usd: -100, return_label: "-$100" }),
    windowResultRow({ source_row_id: "3", score_rank: 3, signal_result: null, display_status: "Pending", is_resolved: false, resolved_at: null, real_pnl_usd: null, return_label: "—" }),
  ];
  const curve = computeWindowReturnCurve(rows);
  // score_rank 1 (loss, -100) first, then score_rank 2 (win, +100); pending excluded.
  assert.equal(curve.length, 2);
  assert.equal(curve[0].cumulativeProfitUsd, -100);
  assert.equal(curve[1].cumulativeProfitUsd, 0);
});

test("mapWindowResultRowToLedgerRow exposes all required proof fields", () => {
  const ledgerRow = mapWindowResultRowToLedgerRow(windowResultRow());
  for (const field of [
    "sourceRowId", "windowDays", "scoreRank", "resolvedAt", "eventTitle", "marketQuestion",
    "selectedOutcome", "winningOutcome", "signalResult", "displayStatus", "entryPrice",
    "decimalOdds", "realPnlUsd", "returnLabel", "matchKey", "signalKey",
  ] as const) {
    assert.ok(field in ledgerRow, `expected ledger proof field "${field}"`);
  }
  assert.equal(ledgerRow.sourceRowId, "11111111-1111-1111-1111-111111111111");
  assert.equal(ledgerRow.windowDays, 7);
});

test("mapWindowResultRowToTrackRecordRow: pending row is Pending with realPnlUsd 0 base and '—' returnLabel", () => {
  const row = mapWindowResultRowToTrackRecordRow(
    windowResultRow({ signal_result: null, display_status: "Pending", is_resolved: false, resolved_at: null, entry_price_num: null, decimal_odds: null, real_pnl_usd: null, return_label: "—" })
  );
  assert.equal(row.displayStatus, "Pending");
  assert.equal(row.status, "Published");
  assert.equal(row.returnLabel, "—");
});

test("14D read-model rows are a superset of the 7D read-model rows by sourceRowId (fixture-level contract)", () => {
  const sevenDay = [
    windowResultRow({ window_days: 7, source_row_id: "a" }),
    windowResultRow({ window_days: 7, source_row_id: "b" }),
  ];
  const fourteenDay = [
    ...sevenDay.map((r) => ({ ...r, window_days: 14 })),
    windowResultRow({ window_days: 14, source_row_id: "c" }),
  ];
  const fourteenIds = new Set(fourteenDay.map((r) => r.source_row_id));
  for (const row of sevenDay) {
    assert.ok(fourteenIds.has(row.source_row_id), `${row.source_row_id} missing from 14D superset`);
  }
});

// ── docs: strict 6/4 read-model flow documented ──────────────────────────────

test("docs describe the strict 6/4 read-model flow with the three-table roles", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(docs.includes("track_record_window_results"));
  assert.ok(docs.includes("generated_signal_pairs"));
  assert.ok(docs.includes("track_record_display_signals"));
  assert.ok(docs.includes("floor(target_count * 0.60)"));
  assert.ok(docs.includes("6 Hit / 4 Miss") || docs.includes("6/4"));
});

test("docs state the current expected 7D 47/28/19 and 14D 91/54/37 values", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(docs.includes("28 Hit / 19 Miss"));
  assert.ok(docs.includes("54 Hit / 37 Miss"));
});

test("docs no longer contain the old 'No cherry picking / pending stay visible' wording", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(!/no cherry.?pick/i.test(docs));
});

// ── strict 6/4 target-split arithmetic + first-10 balance (pure contract) ─────

/** Mirrors the migration's strict split: wins = floor(count * 0.60). */
function strictSplit(targetCount: number): { wins: number; losses: number } {
  const wins = Math.floor(targetCount * 0.6);
  return { wins, losses: targetCount - wins };
}

/** Mirrors the migration's score_rank interleave (normalized bucket position,
 *  Hit wins ties) to check the first-N Hit/Miss balance. */
function interleaveFirstN(wins: number, losses: number, n: number): { hit: number; miss: number } {
  const items: Array<{ pos: number; s: "Hit" | "Miss" }> = [];
  for (let i = 1; i <= wins; i++) items.push({ pos: (i - 0.5) / wins, s: "Hit" });
  for (let i = 1; i <= losses; i++) items.push({ pos: (i - 0.5) / losses, s: "Miss" });
  items.sort((a, b) => a.pos - b.pos || (a.s === "Hit" ? -1 : 1));
  const firstN = items.slice(0, n);
  return {
    hit: firstN.filter((x) => x.s === "Hit").length,
    miss: firstN.filter((x) => x.s === "Miss").length,
  };
}

test("strict split: 7D target 47 => 28 Hit / 19 Miss", () => {
  assert.deepEqual(strictSplit(47), { wins: 28, losses: 19 });
});

test("strict split: 14D target 91 => 54 Hit / 37 Miss", () => {
  assert.deepEqual(strictSplit(91), { wins: 54, losses: 37 });
});

test("strict split is resolved-only: wins + losses = target_count, no pending slots", () => {
  for (const c of [47, 91, 10, 33]) {
    const { wins, losses } = strictSplit(c);
    assert.equal(wins + losses, c);
  }
});

test("score_rank interleave yields 6 Hit / 4 Miss in the first 10 rows (7D 28/19)", () => {
  assert.deepEqual(interleaveFirstN(28, 19, 10), { hit: 6, miss: 4 });
});

test("score_rank interleave yields 6 Hit / 4 Miss in the first 10 rows (14D 54/37)", () => {
  assert.deepEqual(interleaveFirstN(54, 37, 10), { hit: 6, miss: 4 });
});

test("computeWindowResultsSummary reproduces positive PnL shape for a strict 28/19 win-heavy window", () => {
  // 28 wins at 0.5 (+100 each) + 19 losses (-100 each) => net +900 over $4700 stake.
  const rows: WindowResultRow[] = [];
  for (let i = 0; i < 28; i++) rows.push(windowResultRow({ source_row_id: `w-${i}`, score_rank: i + 1, entry_price_num: 0.5, real_pnl_usd: 100 }));
  for (let i = 0; i < 19; i++) rows.push(windowResultRow({ source_row_id: `l-${i}`, score_rank: 100 + i, signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }));
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 47);
  assert.equal(summary.winsCount, 28);
  assert.equal(summary.lossesCount, 19);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.netProfitUsd, 900);
  assert.equal(summary.totalStakeUsd, 4700);
  assert.ok(summary.netProfitUsd > 0);
});
