import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Phase 3A (UI_recovery_plan1): WhyTrust isolated endpoint contract.
// WhyTrust / White Rust is an isolated block — its API/data path must be used
// only by WhyTrust and must never depend on the shared /api/signals/resolved
// contract (Top Weekly proof, Paywall proof, Latest Resolved, carousel).

const ROUTE_PATH = path.join(process.cwd(), "app/api/why-trust/track-record/route.ts");
const SECTION_PATH = path.join(process.cwd(), "components/why-trust/WhyTrustSection.tsx");

// ── 1. WhyTrustSection must fetch the isolated endpoint ───────────────────────

test("WhyTrustSection fetches /api/why-trust/track-record, not /api/signals/resolved", () => {
  const src = fs.readFileSync(SECTION_PATH, "utf8");
  assert.ok(
    src.includes("/api/why-trust/track-record"),
    "WhyTrustSection must fetch the isolated WhyTrust endpoint"
  );
  assert.ok(
    !src.includes("/api/signals/resolved"),
    "WhyTrustSection must not fetch the shared /api/signals/resolved contract"
  );
});

// ── 2. Endpoint source isolation ──────────────────────────────────────────────

test("WhyTrust endpoint is source-isolated: no dependency on /api/signals/resolved or forbidden UI files", () => {
  assert.ok(fs.existsSync(ROUTE_PATH), "isolated route file must exist");
  const src = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.ok(!src.includes("signals/resolved"), "route must not import from /api/signals/resolved");
  // 5. Forbidden shared-UI consumers must not be part of the WhyTrust contract.
  assert.ok(!src.includes("ResolvedSignalsCarousel"), "route must not reference ResolvedSignalsCarousel");
  assert.ok(!src.includes("PassOfferModal"), "route must not reference PassOfferModal");
  assert.ok(!src.includes("reconstruction"), "route must not reference app/reconstruction");
});

// ── Shared fixtures for contract tests ───────────────────────────────────────

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    window_days: 14,
    status: "insufficient_history",
    raw_shown_rows: 91,
    unique_matches: 86,
    resolved_unique_rows: 29,
    pending_unique_rows: 57,
    wins_count: 0,
    losses_count: 0,
    net_pnl_usd: 0,
    net_return_pct: 0,
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    source_row_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    shown_batch_day: "2026-06-27",
    event_title: "Team A vs Team B",
    market_question: "Will Team A win?",
    selected_outcome: "Team A",
    display_score_rank: 1,
    normalized_match_key: "team a vs team b",
    ...overrides,
  };
}

function pairRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    resolved_at: "2026-06-28T12:00:00.000Z",
    signal_result: "won",
    winning_outcome: "Team A",
    entry_price_num: 0.5,
    ...overrides,
  };
}

// ── 3 + 4. Contract shape and honest preview rows ─────────────────────────────

test("contract: weekResultsCard.trackRecordDisplayTable.rows present with window result rows", async () => {
  const mod = await import("../../app/api/why-trust/track-record/route");
  const card = mod.buildWhyTrustWeekResultsCard({
    windowDays: 14,
    limit: 25,
    summary: summaryRow({ status: "ready", wins_count: 1, losses_count: 0 }),
    windowRows: [
      {
        window_days: 14,
        source_row_id: "row-1",
        score_rank: 1,
        shown_batch_day: "2026-06-27",
        normalized_match_key: "team a vs team b",
        match_key: null,
        signal_key: null,
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
      },
    ],
    previewRows: [],
  });
  assert.equal(card.source, "why_trust_track_record");
  assert.ok(Array.isArray(card.trackRecordDisplayTable.rows), "trackRecordDisplayTable.rows must be an array");
  assert.equal(card.trackRecordDisplayTable.rows.length, 1);
  assert.equal(card.detailSource, "window_results");
});

test("contract: honest preview rows when track_record_window_results is empty", async () => {
  const mod = await import("../../app/api/why-trust/track-record/route");

  const preview = mod.buildPreviewRows(
    [
      historyRow(),
      historyRow({ source_row_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", event_title: "Team C vs Team D", normalized_match_key: "team c vs team d", shown_batch_day: null }),
      historyRow({ source_row_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", event_title: "Pending match", normalized_match_key: "pending match" }),
    ],
    [
      pairRow(),
      pairRow({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", signal_result: "lost", winning_outcome: "Team D", entry_price_num: 0.4 }),
      // third pair unresolved — must be excluded from preview
      pairRow({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", signal_result: null, resolved_at: null }),
    ]
  );

  // Only real resolved won/lost rows — never pending, never fabricated.
  assert.equal(preview.length, 2);
  const hit = preview.find((r: { displayStatus: string }) => r.displayStatus === "Hit");
  const miss = preview.find((r: { displayStatus: string }) => r.displayStatus === "Miss");
  assert.ok(hit, "won row maps to Hit");
  assert.ok(miss, "lost row maps to Miss");
  // Flat $100 stake: won at 0.5 → +$100; lost → -$100.
  assert.equal(hit.returnLabel, "+$100");
  assert.equal(miss.returnLabel, "-$100");
  // Date rule: shown_batch_day ?? resolved_at.
  assert.equal(hit.createdAt, "2026-06-27");
  assert.equal(miss.createdAt, "2026-06-28T12:00:00.000Z");

  const card = mod.buildWhyTrustWeekResultsCard({
    windowDays: 14,
    limit: 25,
    summary: summaryRow(),
    windowRows: [],
    previewRows: preview,
  });
  // Preview never masks insufficient_history as ready.
  assert.equal(card.status, "insufficient_history");
  assert.equal(card.detailSource, "preview_from_shown_history");
  assert.equal(card.trackRecordDisplayTable.rows.length, 2);
  // Funnel counters come from the summary table, untouched.
  assert.equal(card.rawShownRows, 91);
  assert.equal(card.uniqueMatches, 86);
  assert.equal(card.resolvedCount, 29);
  assert.equal(card.pendingCount, 57);
  // insufficient_history keeps zero headline PnL — no fabricated Net Return.
  assert.equal(card.netProfitUsd, 0);
});

test("contract: status never upgraded to ready without a ready summary", async () => {
  const mod = await import("../../app/api/why-trust/track-record/route");
  const card = mod.buildWhyTrustWeekResultsCard({
    windowDays: 14,
    limit: 25,
    summary: null,
    windowRows: [],
    previewRows: [],
  });
  assert.equal(card.status, "insufficient_history");
  assert.equal(card.trackRecordDisplayTable.rows.length, 0);
});
