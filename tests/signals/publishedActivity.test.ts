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
  mapWindowResultRowToCarouselSignal,
  normalizeMatchKey,
  buildLegacySevenDayProofFromRows,
  LEGACY_SEVEN_DAY_PROOF_SOURCE,
  type DbRow as LegacyDbRow,
  type ResolvedPairRow,
  type RealResolvedRow,
  type WindowResultRow,
} from "../../app/api/signals/resolved/route";

function windowResultRow(overrides: Partial<WindowResultRow> = {}): WindowResultRow {
  return {
    window_days: 7,
    source_row_id: "11111111-1111-1111-1111-111111111111",
    score_rank: 1,
    shown_batch_day: "2026-06-27",
    normalized_match_key: "team a vs team b",
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

// ── shown-history refresh strategy (migration file, text-contract checks) ────

const migrationSource = fs.readFileSync(
  path.join(__dirname, "../../supabase/migrations/20260702_track_record_window_results.sql"),
  "utf8"
);

test("migration does not force a target win/loss split — no floor(60%) sizing logic", () => {
  assert.ok(!/target_wins/i.test(migrationSource));
  assert.ok(!/target_losses/i.test(migrationSource));
  assert.ok(!/target_count/i.test(migrationSource));
  assert.ok(!/floor\([a-z_]*\s*\*\s*0\.60\)/i.test(migrationSource));
});

test("migration persists shown rows into track_record_shown_signal_history and windows from it", () => {
  assert.ok(migrationSource.includes("INSERT INTO public.track_record_shown_signal_history"));
  assert.ok(migrationSource.includes("FROM public.track_record_display_signals d"));
  assert.ok(migrationSource.includes("JOIN public.track_record_shown_signal_history h"));
  assert.ok(migrationSource.includes("shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)"));
  assert.ok(migrationSource.includes("h.shown_batch_day <  a.anchor_date"));
});

test("migration never fills from global generated_signal_pairs — every join is per shown source_row_id", () => {
  const joins = (migrationSource.match(/^[^\n-]*public\.generated_signal_pairs[^\n]*$/gm) ?? [])
    .filter((line) => /FROM|JOIN/i.test(line));
  assert.ok(joins.length > 0, "expected joins to generated_signal_pairs");
  for (const j of joins) {
    assert.ok(
      j.includes("LEFT JOIN public.generated_signal_pairs g ON g.id = s.source_row_id"),
      `generated_signal_pairs must only be joined by shown source_row_id, got: ${j}`
    );
  }
});

test("migration's final_rows selects ALL resolved deduped rows for ready windows, filtered only by is_resolved_row + readiness", () => {
  assert.ok(migrationSource.includes("final_rows AS ("));
  assert.ok(migrationSource.includes("FROM deduped d"));
  assert.ok(migrationSource.includes("JOIN counts c ON c.window_days = d.window_days"));
  assert.ok(migrationSource.includes("WHERE d.is_resolved_row"));
  assert.ok(migrationSource.includes("AND c.resolved_unique_rows >= c.min_resolved"));
  assert.ok(migrationSource.includes("DISTINCT ON (window_days, normalized_match_key)"));
});

test("migration no longer selects/drops rows by won/lost bucket — no per-bucket rank or bucket-based WHERE", () => {
  assert.ok(!migrationSource.includes("bucket_rank"));
  assert.ok(!migrationSource.includes("bucket_total"));
  assert.ok(!/WHERE \(r\.result_bucket/.test(migrationSource));
});

test("migration gates result rows on readiness thresholds (7D>=20, 14D>=40) with insufficient_history fallback", () => {
  assert.ok(migrationSource.includes("(VALUES (7, 20), (14, 40))"));
  assert.ok(migrationSource.includes("'insufficient_history'"));
  assert.ok(migrationSource.includes("t.is_ready"));
});

test("migration uses no TEMP TABLE, no 'No cherry picking' text, and no projected_* realized results", () => {
  assert.ok(!/TEMP TABLE/i.test(migrationSource));
  assert.ok(!/no cherry.?pick/i.test(migrationSource));
  assert.ok(!/projected_return_usd\s*[,)]?\s*AS\s*real/i.test(migrationSource));
});

test("migration labels the rule via source_model = shown-history-all-resolved", () => {
  assert.ok(migrationSource.includes("'shown-history-all-resolved'"));
  assert.ok(!migrationSource.includes("'shown-history-strict-resolved-6-4'"));
});

// ── normalized match key: keeps teams, drops sport prefix / suffix ───────────

test("normalizeMatchKey keeps team names for Valorant titles", () => {
  assert.equal(
    normalizeMatchKey("Valorant: Team Vitality vs Karmine Corp (BO3) - Esports World Cup Group B"),
    "team vitality vs karmine corp"
  );
});

test("normalizeMatchKey keeps team names for Dota 2 titles", () => {
  assert.equal(
    normalizeMatchKey("Dota 2: LGD Gaming vs Virtus.pro - Game 1 Winner"),
    "lgd gaming vs virtus.pro"
  );
});

test("normalizeMatchKey strips market suffix from football titles", () => {
  assert.equal(
    normalizeMatchKey("Argentina vs. Cabo Verde - More Markets"),
    "argentina vs. cabo verde"
  );
});

test("normalizeMatchKey never collapses to a bare sport label", () => {
  const a = normalizeMatchKey("Dota 2: LGD Gaming vs Virtus.pro - Game 1 Winner");
  const b = normalizeMatchKey("Dota 2: Team Spirit vs Tundra - Game 2 Winner");
  assert.notEqual(a, b);
  assert.notEqual(a, "dota 2");
});

// ── API status contract: insufficient_history, never fabricated PnL ──────────

test("API derives status from track_record_window_summary and defaults to insufficient_history", () => {
  assert.ok(routeSource.includes('.from("track_record_window_summary")'));
  assert.ok(routeSource.includes('windowSummary?.status === "ready" ? "ready" : "insufficient_history"'));
});

test("API keeps read-model rows and PnL even when status is not ready, as long as the read-model actually returned rows (July 4 fix: status no longer erases real resolved rows)", () => {
  assert.ok(routeSource.includes("hasRows ? rowsSummary.netProfitUsd : 0"));
  assert.ok(routeSource.includes("const windowRows = (((windowResultsRes.data ?? []) as unknown) as WindowResultRow[]);"));
  assert.ok(!routeSource.includes('trackStatus === "ready"\n      ? (((windowResultsRes.data ?? []) as unknown) as WindowResultRow[])\n      : []'));
});

test("weekResultsCard exposes status, rawShownRows and uniqueMatches", () => {
  assert.ok(routeSource.includes("status: trackStatus"));
  assert.ok(routeSource.includes("rawShownRows,"));
  assert.ok(routeSource.includes("uniqueMatches,"));
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

  const summaryLine = routeSource.indexOf("const rowsSummary = computeWindowResultsSummary(windowRows)");
  assert.ok(summaryLine !== -1, "summary must be computed from the unsliced window row set");
});

test("ledger limit clamp uses MAX_LIMIT (25), not the 7-card carousel cap, even in mode=latest", () => {
  const limitBlockStart = routeSource.indexOf("const rawLimit = parseInt");
  const limitBlockEnd = routeSource.indexOf(";", routeSource.indexOf("Math.min(Math.max(rawLimit"));
  const limitBlock = routeSource.slice(limitBlockStart, limitBlockEnd);
  assert.ok(
    !limitBlock.includes("isLatestMode ? LATEST_MAX_CARDS : MAX_LIMIT"),
    "ledger `limit` must not be clamped to the carousel's LATEST_MAX_CARDS in latest mode"
  );
  assert.ok(limitBlock.includes("MAX_LIMIT"), "ledger limit must still be clamped against MAX_LIMIT");
});

test("orderedForLedger.slice(0, limit) can yield up to 25 ledger rows when the window has enough rows", () => {
  const rows: WindowResultRow[] = Array.from({ length: 47 }, (_, i) =>
    windowResultRow({ source_row_id: `row-${i}`, score_rank: i + 1 })
  );
  const limit = 25;
  const ledgerRows = rows.slice(0, limit).map(mapWindowResultRowToTrackRecordRow);
  assert.equal(ledgerRows.length, 25);
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 47, "summary must not be truncated by the ledger limit");
});

test("nullable fields (entry_price_num, decimal_odds, real_pnl_usd, resolved_at, score_rank) do not crash ledger mapping", () => {
  const pendingRow = windowResultRow({
    signal_result: null,
    display_status: "Pending",
    is_resolved: false,
    resolved_at: null,
    entry_price_num: null,
    decimal_odds: null,
    real_pnl_usd: null,
    score_rank: null,
    return_label: "—",
  });
  assert.doesNotThrow(() => mapWindowResultRowToLedgerRow(pendingRow));
  assert.doesNotThrow(() => mapWindowResultRowToTrackRecordRow(pendingRow));
});

test("API source remains track_record_window_results regardless of ledger limit value", () => {
  assert.ok(routeSource.includes("source: WINDOW_RESULTS_SOURCE"));
  assert.ok(!routeSource.includes('source: RESOLVED_RESULTS_SOURCE'));
});

// ── safe logging: fields present, no raw rows / secrets ─────────────────────

test("safe log includes required fields and never logs secrets/env/raw rows", () => {
  const logStart = routeSource.indexOf('console.log("[weekResultsCard]"');
  const logEnd = routeSource.indexOf("});", logStart);
  const logBlock = routeSource.slice(logStart, logEnd);

  for (const field of [
    "source",
    "status",
    "rawShownRows",
    "uniqueMatches",
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

test("WhyTrustSection no longer contains the 'No cherry-picking' copy", () => {
  assert.ok(!/no cherry.?pick/i.test(whyTrustSource));
});

test("WhyTrustSection shows the honest insufficient_history state and gates the resolved-track-record claim", () => {
  assert.ok(whyTrustSource.includes("insufficient_history"));
  assert.ok(whyTrustSource.includes("Shown signals are being tracked until enough results resolve"));
  assert.ok(whyTrustSource.includes("deriveTrackingMetrics"));
  assert.ok(whyTrustSource.includes("Resolved track record from actual shown signals only. No global fill, no projected PnL."));
  // The resolved-track-record claim is used only when the window is ready.
  assert.ok(whyTrustSource.includes("insufficient ? [] : [RESOLVED_TRACK_RECORD_RULE]"));
});

test("WhyTrustSection no longer claims a strict 6/4 (or any forced) Hit/Miss ratio", () => {
  assert.ok(!/6 Hit \/ 4 Miss/i.test(whyTrustSource));
  assert.ok(!/STRICT_FILTER_RULE/.test(whyTrustSource));
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
    "sourceRowId", "windowDays", "scoreRank", "shownBatchDay", "normalizedMatchKey",
    "resolvedAt", "eventTitle", "marketQuestion",
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

test("mapWindowResultRowToTrackRecordRow: createdAt uses shown_batch_day, not resolved_at", () => {
  const row = mapWindowResultRowToTrackRecordRow(
    windowResultRow({ shown_batch_day: "2026-06-18", resolved_at: "2026-07-02T12:00:00.000Z" })
  );
  assert.equal(row.createdAt, "2026-06-18");
  assert.notEqual(row.createdAt, "2026-07-02T12:00:00.000Z");
});

test("mapWindowResultRowToTrackRecordRow: createdAt falls back to resolved_at when shown_batch_day is null", () => {
  const row = mapWindowResultRowToTrackRecordRow(
    windowResultRow({ shown_batch_day: null, resolved_at: "2026-07-02T12:00:00.000Z" })
  );
  assert.equal(row.createdAt, "2026-07-02T12:00:00.000Z");
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

// ── docs: all-resolved read-model flow documented ────────────────────────────

test("docs describe the all-resolved read-model flow with the three-table roles, no forced split", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(docs.includes("track_record_window_results"));
  assert.ok(docs.includes("generated_signal_pairs"));
  assert.ok(docs.includes("track_record_display_signals"));
  assert.ok(docs.includes("No synthetic balancing"));
  assert.ok(docs.includes("shown-history-all-resolved"));
  assert.ok(!docs.includes("floor(target_count * 0.60)"));
});

test("docs state the current expected 7D insufficient_history / 14D 44 resolved (29 win, 15 loss) values", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(docs.includes("resolved_unique_rows = 44"));
  assert.ok(docs.includes("wins_count = 29"));
  assert.ok(docs.includes("losses_count = 15"));
  assert.ok(docs.includes("+364.46"));
  assert.ok(docs.includes("+8.28"));
});

test("docs no longer contain the old 'No cherry picking / pending stay visible' wording", () => {
  const docsPath = path.join(__dirname, "../../docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md");
  const docs = fs.readFileSync(docsPath, "utf8");
  assert.ok(!/no cherry.?pick/i.test(docs));
});

// ── all-resolved read-model: no forced split, actual distribution (pure contract) ─

test("all resolved unique shown rows are included when the readiness threshold is met — no target count caps the row set", () => {
  // 44 resolved rows (29 win / 15 loss) is the actual PR #23 production shape —
  // not a 6/4 (60/40) ratio. All 44 must be tracked, none dropped to fit a ratio.
  const rows: WindowResultRow[] = [];
  for (let i = 0; i < 29; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `w-${i}`, score_rank: i + 1, entry_price_num: 0.5, real_pnl_usd: 100 }));
  for (let i = 0; i < 15; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `l-${i}`, score_rank: 100 + i, signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }));
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 44);
  assert.equal(summary.winsCount, 29);
  assert.equal(summary.lossesCount, 15);
  assert.equal(summary.pendingCount, 0);
});

test("wins are not dropped to force a 6/4 (60/40) ratio — 29/15 (~66% win rate) is preserved as-is", () => {
  const winRatio = 29 / (29 + 15);
  assert.ok(Math.abs(winRatio - 0.6) > 0.05, "fixture must not coincidentally match the old forced 60% ratio");
  const rows: WindowResultRow[] = [];
  for (let i = 0; i < 29; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `w-${i}`, score_rank: i + 1, entry_price_num: 0.5, real_pnl_usd: 100 }));
  for (let i = 0; i < 15; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `l-${i}`, score_rank: 100 + i, signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }));
  const summary = computeWindowResultsSummary(rows);
  // 29 wins at +$100, 15 losses at -$100 => net +$1400 over $4400 stake.
  assert.equal(summary.netProfitUsd, 1400);
  assert.equal(summary.totalStakeUsd, 4400);
  assert.ok(summary.netProfitUsd > 0, "actual resolved distribution must not be forced negative by a synthetic selection stage");
});

test("14D summary can show a non-6/4 actual result distribution (29 win / 15 loss, ~66% not 60%)", () => {
  const rows: WindowResultRow[] = [];
  for (let i = 0; i < 29; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `w-${i}`, score_rank: i + 1, entry_price_num: 0.5, real_pnl_usd: 100 }));
  for (let i = 0; i < 15; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `l-${i}`, score_rank: 100 + i, signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }));
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.winsCount + summary.lossesCount, 44);
  assert.notEqual(summary.winsCount, Math.floor(44 * 0.6), "wins must reflect the actual resolved count, not a forced floor(60%) target");
});

test("projected fields are never used to compute realized PnL (no projected_return_usd / projected_win_probability in the summary path)", () => {
  const fnStart = routeSource.indexOf("export function computeWindowResultsSummary");
  const fnEnd = routeSource.indexOf("\n}", fnStart);
  const fnBody = routeSource.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes("projected_return_usd"));
  assert.ok(!fnBody.includes("projected_pnl_units"));
  assert.ok(!fnBody.includes("projected_win_probability"));
});

test("insufficient_history with real resolved rows still surfaces the actual PnL (contract: summary gates on row presence, not the status label)", () => {
  assert.ok(routeSource.includes("hasRows ? rowsSummary.netProfitUsd : 0"));
  const rows: WindowResultRow[] = [
    windowResultRow({ window_days: 7, source_row_id: "1", entry_price_num: 0.5, real_pnl_usd: 100 }),
  ];
  const summary = computeWindowResultsSummary(rows);
  // The read-model already returned a real resolved row — the July 4 fix
  // means this value is trusted (hasRows === true) regardless of whether
  // track_record_window_summary.status is "ready" or "insufficient_history".
  assert.equal(summary.netProfitUsd, 100);
});

// ── /api/signals/resolved: single read-model source, no legacy live query ──

test("route.ts queries generated_signal_pairs live only inside the isolated legacy 7D proof block", () => {
  // Exactly one live query, and only after the gated legacy block starts —
  // the read-model weekResultsCard section above it stays free of legacy data.
  const occurrences = routeSource.split('.from("generated_signal_pairs")').length - 1;
  assert.equal(occurrences, 1, "generated_signal_pairs may only be queried once, for the legacy 7D proof");
  const legacyBlockStart = routeSource.indexOf("// ── Legacy 7D proof (mode=latest&days=7 only)");
  const queryIndex = routeSource.indexOf('.from("generated_signal_pairs")');
  assert.ok(legacyBlockStart > 0 && queryIndex > legacyBlockStart, "legacy query must live inside the gated legacy block");
});

test("route.ts selectionRule appears only in the legacy 7D proof contract, never in the read-model card/summary", () => {
  const legacyBuilderStart = routeSource.indexOf("// ── Legacy 7D proof (generated_signal_pairs)");
  assert.ok(legacyBuilderStart > 0);
  const beforeLegacy = routeSource.slice(0, legacyBuilderStart);
  assert.ok(
    !beforeLegacy.includes("selectionRule"),
    "selectionRule must not appear in the read-model sections of the route"
  );
});

test("route.ts signals array is built from orderedForLedger via mapWindowResultRowToCarouselSignal (the same rows as weekResultsCard)", () => {
  assert.ok(routeSource.includes("orderedForLedger.map(mapWindowResultRowToCarouselSignal)"));
});

test("route.ts non-legacy top-level summary fields are assigned from read-model values (summary.resolvedCount/winsCount/lossesCount, rawShownRows), not a legacy recompute", () => {
  // The legacy branch (mode=latest&days=7) uses legacyProof.summary; every
  // other request keeps the read-model summary values.
  const responseStart = routeSource.indexOf("return NextResponse.json", routeSource.indexOf("// ── Response"));
  const block = routeSource.slice(responseStart);
  assert.ok(block.includes("? legacyProof.summary"));
  assert.ok(block.includes("uniqueResolved: summary.resolvedCount"));
  assert.ok(block.includes("snapshotRows: rawShownRows"));
  assert.ok(block.includes("won: summary.winsCount"));
  assert.ok(block.includes("lost: summary.lossesCount"));
});

test("mapWindowResultRowToCarouselSignal maps a resolved won row to the legacy ApiResolvedSignal shape with correct returnPct/odds", () => {
  const row = windowResultRow({
    source_row_id: "row-won",
    event_title: "Team A vs Team B",
    selected_outcome: "Team A",
    winning_outcome: "Team A",
    signal_result: "won",
    display_status: "Hit",
    is_resolved: true,
    resolved_at: "2026-06-28T00:00:00.000Z",
    entry_price_num: 0.5,
    decimal_odds: 2,
    real_pnl_usd: 100,
    return_label: "+$100",
  });
  const signal = mapWindowResultRowToCarouselSignal(row);
  assert.equal(signal.id, "row-won");
  assert.equal(signal.eventTitle, "Team A vs Team B");
  assert.equal(signal.pick, "Team A");
  assert.equal(signal.winner, "Team A");
  assert.equal(signal.result, "won");
  assert.equal(signal.returnPct, 100);
  assert.equal(signal.europeanOdds, 2);
  assert.equal(signal.americanOdds, "+100");
  assert.equal(signal.resolvedAt, "2026-06-28T00:00:00.000Z");
});

test("mapWindowResultRowToCarouselSignal maps a resolved lost row to returnPct=-100", () => {
  const row = windowResultRow({
    signal_result: "lost",
    display_status: "Miss",
    entry_price_num: 0.4,
    real_pnl_usd: -100,
    return_label: "-$100",
  });
  const signal = mapWindowResultRowToCarouselSignal(row);
  assert.equal(signal.result, "lost");
  assert.equal(signal.returnPct, -100);
});

test("14D ready: signals/ledger both come from the same 44-row (29 win / 15 loss) read-model set — no legacy uniqueResolved=10/won=4/lost=6 shape", () => {
  const rows: WindowResultRow[] = [];
  for (let i = 0; i < 29; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `w-${i}`, score_rank: i + 1, entry_price_num: 0.5, real_pnl_usd: 100 }));
  for (let i = 0; i < 15; i++) rows.push(windowResultRow({ window_days: 14, source_row_id: `l-${i}`, score_rank: 100 + i, signal_result: "lost", display_status: "Miss", entry_price_num: 0.4, real_pnl_usd: -100, return_label: "-$100" }));

  const summary = computeWindowResultsSummary(rows);
  const carouselSignals = rows.map(mapWindowResultRowToCarouselSignal);

  // read-model-derived top-level summary fields the route now assigns:
  assert.equal(summary.resolvedCount, 44);
  assert.equal(summary.winsCount, 29);
  assert.equal(summary.lossesCount, 15);
  assert.notEqual(summary.resolvedCount, 10, "must not match the old legacy uniqueResolved=10 shape");
  assert.notEqual(summary.winsCount, 4, "must not match the old legacy won=4 shape");
  assert.notEqual(summary.lossesCount, 6, "must not match the old legacy lost=6 shape");

  // signals array carries the same 44 rows the ledger/summary are built from.
  assert.equal(carouselSignals.length, 44);
  assert.equal(carouselSignals.filter((s) => s.result === "won").length, 29);
  assert.equal(carouselSignals.filter((s) => s.result === "lost").length, 15);
});

test("7D insufficient_history: an empty read-model fetch still yields zero PnL/rows (windowRows only empty when the query actually returned nothing)", () => {
  assert.ok(routeSource.includes("const windowRows = (((windowResultsRes.data ?? []) as unknown) as WindowResultRow[]);"));
  // With windowRows = [] (an actually-empty read-model fetch), orderedForLedger and carouselSignals are also [].
  const rows: WindowResultRow[] = [];
  const summary = computeWindowResultsSummary(rows);
  const carouselSignals = rows.map(mapWindowResultRowToCarouselSignal);
  assert.equal(summary.resolvedCount, 0);
  assert.equal(summary.winsCount, 0);
  assert.equal(summary.lossesCount, 0);
  assert.equal(summary.netProfitUsd, 0);
  assert.equal(carouselSignals.length, 0);
});

test("limit affects signals/ledger rows only — top-level summary counts are computed from the full window row set", () => {
  const rows: WindowResultRow[] = Array.from({ length: 44 }, (_, i) =>
    windowResultRow({ window_days: 14, source_row_id: `row-${i}`, score_rank: i + 1, real_pnl_usd: i < 29 ? 100 : -100, signal_result: i < 29 ? "won" : "lost", display_status: i < 29 ? "Hit" : "Miss" })
  );
  const summary = computeWindowResultsSummary(rows);
  const limitedSignals = rows.slice(0, 25).map(mapWindowResultRowToCarouselSignal);
  assert.equal(summary.resolvedCount, 44, "summary must reflect all 44 rows regardless of ledger limit");
  assert.equal(limitedSignals.length, 25, "signals/ledger rows are capped by limit");
});

// ── Legacy 7D proof contract (restored after PR #22 regression) ──────────────
// PR #22 routed the days=7 consumers (PassOfferModal, reconstruction top-feed
// card) to the read-model, which has no ready 7D window — the UI rendered
// +0% / 0% rate / avg odds 0.00. The legacy generated_signal_pairs proof is
// restored as an isolated builder driving only top-level summary/signals and
// legacyWeekResultsCard for mode=latest&days=7.

function legacyDbRow(overrides: Partial<LegacyDbRow> = {}): LegacyDbRow {
  return {
    id: "gsp-1",
    created_at: "2026-06-28T10:00:00.000Z",
    resolved_at: "2026-06-29T12:00:00.000Z",
    condition_id: "cond-1",
    selected_outcome: "Team A",
    winning_outcome: "Team A",
    signal_result: "won",
    realized_return_pct: 80,
    metric_formula_version: null,
    entry_price_num: 0.5,
    premium_signal: { eventTitle: "Team A vs Team B" },
    diagnostics: { totalVolume: 5000 },
    ...overrides,
  };
}

test("legacy 7D proof: builder returns usable top-level summary/signals from generated_signal_pairs rows", () => {
  const rows = [
    legacyDbRow(),
    legacyDbRow({ id: "gsp-2", condition_id: "cond-2", selected_outcome: "Team C", winning_outcome: "Team D", signal_result: "lost", realized_return_pct: null, entry_price_num: 0.4, resolved_at: "2026-06-28T12:00:00.000Z" }),
  ];
  const proof = buildLegacySevenDayProofFromRows(rows, 7);
  assert.equal(proof.source, LEGACY_SEVEN_DAY_PROOF_SOURCE);
  assert.equal(proof.summary.source, "generated_signal_pairs_legacy_7d_proof");
  assert.equal(proof.summary.selectionRule, "last_7d_highest_activity_max_two_loss");
  assert.equal(proof.summary.uniqueResolved, 2);
  assert.equal(proof.summary.won, 1);
  assert.equal(proof.summary.lost, 1);
  assert.equal(proof.signals.length, 2);
  assert.equal(proof.signals[0].marketActivityScore, 5000);
  // Old consumer signal shape fields are present again.
  assert.ok("trustMetrics" in proof.signals[0]);
  assert.ok("signalConfidence" in proof.signals[0]);
});

test("legacy 7D proof: card carries real non-zero metrics (no +0% / 0.00 avg odds regression)", () => {
  const rows = [
    legacyDbRow(),
    legacyDbRow({ id: "gsp-2", condition_id: "cond-2", signal_result: "lost", realized_return_pct: null, entry_price_num: 0.4, resolved_at: "2026-06-28T12:00:00.000Z" }),
  ];
  const proof = buildLegacySevenDayProofFromRows(rows, 7);
  const card = proof.card;
  assert.ok(card, "card must exist when usable rows exist");
  assert.equal(card.source, LEGACY_SEVEN_DAY_PROOF_SOURCE);
  assert.equal(card.schemaVersion, "week-results-v1-legacy-proof");
  assert.equal(card.window.days, 7);
  assert.ok(card.avgDecimalOdds > 0, "avg odds must be real, not 0.00");
  assert.equal(card.avgDecimalOdds, 2.25); // avg(2, 2.5)
  assert.equal(card.winsCount, 1);
  assert.equal(card.lossesCount, 1);
  assert.equal(card.projectedWinRatePct, 50);
  // Cumulative proof like the pre-PR#22 paywall chart: +80% then -100% = -20%.
  assert.equal(card.projectedRoiPct, -20);
  assert.equal(card.netProfitUsd, -20);
  assert.equal(card.trackRecordDisplayTable.rows.length, 2);
  assert.equal(card.trackRecordDisplayTable.rows[0].returnLabel, "-100%");
  assert.equal(card.trackRecordDisplayTable.rows[1].returnLabel, "+80%");
});

test("legacy 7D proof: no rows => null card and empty signals, never fabricated zeros", () => {
  const proof = buildLegacySevenDayProofFromRows([], 7);
  assert.equal(proof.card, null);
  assert.equal(proof.signals.length, 0);
  assert.equal(proof.summary.uniqueResolved, 0);
  assert.equal(proof.summary.sampleSizeStatus, "empty");
  assert.equal(proof.summary.showPerformanceClaim, false);
});

test("legacy 7D proof: push results excluded and losses capped at 2 in displayed signals", () => {
  const rows = [
    legacyDbRow({ id: "p1", condition_id: "c-p", signal_result: "push" }),
    ...Array.from({ length: 4 }, (_, i) =>
      legacyDbRow({ id: `l${i}`, condition_id: `c-l${i}`, signal_result: "lost", realized_return_pct: null })
    ),
    legacyDbRow({ id: "w1", condition_id: "c-w1" }),
  ];
  const proof = buildLegacySevenDayProofFromRows(rows, 7);
  assert.equal(proof.signals.filter((s) => s.result === "lost").length, 2);
  assert.equal(proof.signals.filter((s) => s.result === "push").length, 0);
});

test("route: legacy proof is isolated — only mode=latest&days=7, weekResultsCard never reassigned from legacy", () => {
  assert.ok(routeSource.includes("isLatestMode && windowDays === LEGACY_PROOF_WINDOW_DAYS"));
  // Legacy card ships under its own key; weekResultsCard field stays unconditional read-model.
  assert.ok(routeSource.includes("legacyWeekResultsCard: legacyProof.card"));
  assert.ok(!/weekResultsCard\s*[:=]\s*legacyProof/.test(routeSource), "weekResultsCard must never be fed from legacyProof");
});

test("route: no selectionRule inside the read-model weekResultsCard block", () => {
  const start = routeSource.indexOf("const weekResultsCard: WeekResultsCard = {");
  const end = routeSource.indexOf("// ── Legacy 7D proof (mode=latest&days=7 only)");
  assert.ok(start > 0 && end > start);
  const block = routeSource.slice(start, end);
  assert.ok(!block.includes("selectionRule"), "read-model weekResultsCard must not carry selectionRule");
});

test("route: legacy generated_signal_pairs query lives below the read-model block (existing weekResultsCard purity test stays meaningful)", () => {
  const readModelStart = routeSource.indexOf("// ── weekResultsCard: read-model");
  const legacyQueryStart = routeSource.indexOf("let query = supabase");
  assert.ok(readModelStart > 0);
  assert.ok(legacyQueryStart > readModelStart, "legacy query must come after the read-model block");
});
