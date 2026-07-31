// Read-only sports inventory funnel reporter tests (node:test via tsx):
//   npx tsx --test tests/reporting/sportsInventoryFunnelReport.test.ts
//
// Production-shaped fixtures only -- no fabricated FireModelCandidate. Every
// fixture models a real sports_event_market_inventory row shape and exercises
// the real row-to-group boundary (provider + provider_event_id +
// event_start_iso), never a title/team/slug fuzzy merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  analyzeSportsInventoryFunnel,
  loadSportsInventoryFunnelRows,
  SportsInventoryRowReadError,
  type SportsInventoryFunnelRow,
} from "../../lib/reporting/sportsInventoryFunnelReport";

const FIXED_NOW = "2026-07-31T00:00:00.000Z";
const HORIZON_HOURS = 48;

function row(overrides: Partial<SportsInventoryFunnelRow> = {}): SportsInventoryFunnelRow {
  return {
    provider: "polymarket",
    provider_event_id: "evt-1",
    provider_event_slug: "evt-1-slug",
    provider_market_id: "mkt-1",
    provider_market_slug: "mkt-1-slug",
    event_title: "Team A vs Team B",
    market_question: "Team A vs Team B Moneyline",
    event_start_iso: "2026-07-31T12:00:00.000Z",
    market_end_iso: "2026-07-31T14:00:00.000Z",
    condition_id: "0xcond-1",
    clob_token_ids: ["token-a", "token-b"],
    outcomes: ["Team A", "Team B"],
    outcome_prices: ["0.6", "0.4"],
    provider_tags: [],
    raw_category: "sports",
    league_hint: null,
    sports_market_type: null,
    volume_usd: 1000,
    volume_24hr_usd: 200,
    is_confirmed_sports: true,
    sports_confirmation_source: "specific_sports_tag",
    sibling_market_count: 1,
    first_observed_at: "2026-07-30T00:00:00.000Z",
    last_observed_at: "2026-07-30T00:00:00.000Z",
    expires_at: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

test("1. deterministic fixed-time output for identical rows/options", () => {
  const rows = [row()];
  const a = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  const b = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("2. sports-confirmed row gate excludes is_confirmed_sports=false rows", () => {
  const confirmed = row({ provider_event_id: "evt-confirmed" });
  const notConfirmed = row({
    provider_event_id: "evt-not-confirmed",
    is_confirmed_sports: false,
    sports_confirmation_source: "no_matching_sports_tag",
  });
  const report = analyzeSportsInventoryFunnel([confirmed, notConfirmed], {
    fixedNow: FIXED_NOW,
    horizonHours: HORIZON_HOURS,
  });
  assert.equal(report.source_counts.rows, 2);
  const confirmedStage = report.funnel_stages.find((s) => s.stage === "CONFIRMED_SPORTS")!;
  assert.equal(confirmedStage.input, 2);
  assert.equal(confirmedStage.output, 1);
  assert.equal(report.rejection_reasons.SPORTS_NOT_CONFIRMED, 1);
});

test("3. sports-confirmation metadata inconsistency is counted, never silently repaired", () => {
  const inconsistent = row({
    provider_event_id: "evt-inconsistent",
    is_confirmed_sports: false,
    sports_confirmation_source: "specific_sports_tag",
  });
  const report = analyzeSportsInventoryFunnel([inconsistent], {
    fixedNow: FIXED_NOW,
    horizonHours: HORIZON_HOURS,
  });
  assert.equal(report.rejection_reasons.SPORT_CONFIRMATION_METADATA_INCONSISTENT, 1);
  // Gate still trusts the raw boolean verbatim -- row is excluded, not "fixed" to pass.
  const confirmedStage = report.funnel_stages.find((s) => s.stage === "CONFIRMED_SPORTS")!;
  assert.equal(confirmedStage.output, 0);
});

test("4. exact occurrence grouping keys on provider + event id + event_start_iso", () => {
  const r1 = row({ provider_event_id: "evt-group", provider_market_id: "mkt-a", event_start_iso: "2026-07-31T12:00:00.000Z", sibling_market_count: 2 });
  const r2 = row({
    provider_event_id: "evt-group",
    provider_market_id: "mkt-b",
    market_question: "Team A vs Team B Spread -1.5",
    event_start_iso: "2026-07-31T12:00:00.000Z",
    sibling_market_count: 2,
  });
  const report = analyzeSportsInventoryFunnel([r1, r2], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.sibling_integrity.group_count, 1);
  assert.equal(report.sibling_integrity.group_size_distribution["2"], 1);
});

test("5. no title-based merge: identical titles under different provider_event_id stay separate groups", () => {
  const r1 = row({ provider_event_id: "evt-x", provider_market_id: "mkt-1", event_title: "Team A vs Team B" });
  const r2 = row({ provider_event_id: "evt-y", provider_market_id: "mkt-2", event_title: "Team A vs Team B" });
  const report = analyzeSportsInventoryFunnel([r1, r2], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.sibling_integrity.group_count, 2);
});

test("6. reschedule duplicates are measured, never reconciled into one row", () => {
  const r1 = row({
    provider_event_id: "evt-resched",
    provider_market_id: "mkt-resched",
    event_start_iso: "2026-07-31T12:00:00.000Z",
  });
  const r2 = row({
    provider_event_id: "evt-resched",
    provider_market_id: "mkt-resched",
    event_start_iso: "2026-07-31T18:00:00.000Z",
  });
  const report = analyzeSportsInventoryFunnel([r1, r2], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.reschedule_duplicates.duplicate_market_identity_count, 1);
  assert.equal(report.reschedule_duplicates.affected_provider_event_count, 1);
  // Not reconciled: both occurrences still form two separate physical groups.
  assert.equal(report.sibling_integrity.group_count, 2);
});

test("7. pure full-match group (moneyline + spread + total) passes strict policy", () => {
  const rows = [
    row({ provider_event_id: "evt-pure", provider_market_id: "mkt-ml", market_question: "Team A vs Team B Moneyline", sibling_market_count: 3 }),
    row({ provider_event_id: "evt-pure", provider_market_id: "mkt-sp", market_question: "Team A vs Team B Spread -1.5", sibling_market_count: 3 }),
    row({ provider_event_id: "evt-pure", provider_market_id: "mkt-tot", market_question: "Team A vs Team B Total Over/Under 45.5", sibling_market_count: 3 }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.group_policy_counts.GROUP_STRICT_FULL_EVENT_PASS, 1);
  assert.equal(report.group_policy_counts.groups_strictly_pure_full_event, 1);
});

test("8. mixed full-match + player-prop group fails strict policy", () => {
  const rows = [
    row({ provider_event_id: "evt-mixed", provider_market_id: "mkt-ml", market_question: "Team A vs Team B Moneyline", sibling_market_count: 2 }),
    row({ provider_event_id: "evt-mixed", provider_market_id: "mkt-prop", market_question: "Player A anytime scorer prop", sibling_market_count: 2 }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.group_policy_counts.GROUP_CONTAINS_PARTIAL_OR_PROP, 1);
  assert.equal(report.group_policy_counts.GROUP_STRICT_FULL_EVENT_PASS ?? 0, 0);
});

test("9. any-anchor count differs from strict-pure count", () => {
  const rows = [
    // pure group
    row({ provider_event_id: "evt-pure2", provider_market_id: "mkt-ml", market_question: "Team A vs Team B Moneyline" }),
    // mixed group: has an anchor but is not strictly pure
    row({ provider_event_id: "evt-mixed2", provider_market_id: "mkt-ml2", market_question: "Team A vs Team B Moneyline", sibling_market_count: 2 }),
    row({ provider_event_id: "evt-mixed2", provider_market_id: "mkt-prop2", market_question: "Player A anytime scorer prop", sibling_market_count: 2 }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.group_policy_counts.groups_with_any_allowed_full_event_anchor, 2);
  assert.equal(report.group_policy_counts.groups_strictly_pure_full_event, 1);
  assert.notEqual(
    report.group_policy_counts.groups_with_any_allowed_full_event_anchor,
    report.group_policy_counts.groups_strictly_pure_full_event,
  );
});

test("10. unknown taxonomy market fails closed (never treated as allowed)", () => {
  const rows = [
    row({ provider_event_id: "evt-unknown", provider_market_id: "mkt-ml", market_question: "Team A vs Team B Moneyline", sibling_market_count: 2 }),
    row({ provider_event_id: "evt-unknown", provider_market_id: "mkt-weird", market_question: "Special Bespoke Market XYZ", sibling_market_count: 2 }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.group_policy_counts.GROUP_CONTAINS_UNKNOWN_MARKET, 1);
  assert.equal(report.group_policy_counts.GROUP_STRICT_FULL_EVENT_PASS ?? 0, 0);
});

test("11. esports map/round-only group fails closed", () => {
  const rows = [
    row({
      provider_event_id: "evt-esports",
      provider_market_id: "mkt-map1",
      market_question: "CS2 Map 1 Winner",
      raw_category: "esports",
    }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.group_policy_counts.GROUP_STRICT_FULL_EVENT_PASS ?? 0, 0);
  assert.equal(report.group_policy_counts.groups_with_any_allowed_full_event_anchor ?? 0, 0);
});

test("12. three-way soccer market remains structurally score-ready when arrays align", () => {
  const rows = [
    row({
      provider_event_id: "evt-3way",
      provider_market_id: "mkt-3way",
      market_question: "Team A vs Team B Match Result",
      outcomes: ["Team A", "Draw", "Team B"],
      clob_token_ids: ["token-a", "token-draw", "token-b"],
      outcome_prices: ["0.4", "0.25", "0.35"],
    }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.score_readiness.score_input_structurally_ready_rows, 1);
  assert.equal(report.group_policy_counts.pre_score_candidate_groups, 1);
});

test("13. condition/token/price structural failures are separately counted", () => {
  const missingCondition = row({ provider_event_id: "evt-nocond", provider_market_id: "mkt-nocond", condition_id: null });
  const badTokens = row({ provider_event_id: "evt-badtok", provider_market_id: "mkt-badtok", clob_token_ids: ["only-one"] });
  const badPrices = row({
    provider_event_id: "evt-noprice",
    provider_market_id: "mkt-noprice",
    outcome_prices: ["not-a-number", "also-not"],
  });
  const report = analyzeSportsInventoryFunnel([missingCondition, badTokens, badPrices], {
    fixedNow: FIXED_NOW,
    horizonHours: HORIZON_HOURS,
  });
  assert.equal(report.score_readiness.reasons.CONDITION_ID_MISSING, 1);
  assert.equal(report.score_readiness.reasons.TOKEN_ARRAY_INVALID, 1);
  assert.equal(report.score_readiness.reasons.NO_VALID_ENTRY_PRICE, 1);
  assert.equal(report.score_readiness.score_input_structurally_ready_rows, 0);
});

test("14. liquidity metadata is never labeled as executability proof", () => {
  const report = analyzeSportsInventoryFunnel([row()], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.liquidity_metadata.label, "NON_AUTHORITATIVE_NOT_EXECUTABILITY_PROOF");
  assert.equal(report.liquidity_metadata.rows_with_volume_usd, 1);
});

test("15. pre-score candidate groups are never named planning/Reservation/executable candidates", () => {
  const report = analyzeSportsInventoryFunnel([row()], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  const serialized = JSON.stringify(report);
  assert.ok(!/planning candidate/i.test(serialized));
  assert.ok(!/reservation candidate/i.test(serialized));
  assert.ok(!/executable market/i.test(serialized));
  assert.equal(report.score_readiness.label, "STRUCTURAL_ONLY_NOT_SCORED");
});

test("16. sibling-count mismatch is counted against stored sibling_market_count", () => {
  const rows = [
    row({ provider_event_id: "evt-mismatch", provider_market_id: "mkt-1", sibling_market_count: 3 }),
    row({ provider_event_id: "evt-mismatch", provider_market_id: "mkt-2", market_question: "Team A vs Team B Spread", sibling_market_count: 3 }),
  ];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.sibling_integrity.mismatched_group_count, 1);
  assert.equal(report.rejection_reasons.SIBLING_COUNT_MISMATCH, 1);
});

test("17. Mermaid graph contains the same calculated counts as funnel_stages", () => {
  const rows = [row(), row({ provider_event_id: "evt-2", is_confirmed_sports: false, sports_confirmation_source: "no_matching_sports_tag" })];
  const report = analyzeSportsInventoryFunnel(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  for (const stage of report.funnel_stages) {
    assert.ok(report.mermaid.includes(`in:${stage.input} out:${stage.output}`), `mermaid missing counts for ${stage.stage}`);
  }
});

test("one event outside horizon is rejected with OUTSIDE_REPORT_HORIZON", () => {
  const outside = row({ provider_event_id: "evt-outside", event_start_iso: "2026-08-05T00:00:00.000Z" });
  const report = analyzeSportsInventoryFunnel([outside], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.rejection_reasons.OUTSIDE_REPORT_HORIZON, 1);
  const horizonStage = report.funnel_stages.find((s) => s.stage === "UPCOMING_HORIZON")!;
  assert.equal(horizonStage.output, 0);
});

test("invalid event start is rejected fail-closed", () => {
  const invalid = row({ provider_event_id: "evt-invalid-start", event_start_iso: "not-a-date" });
  const report = analyzeSportsInventoryFunnel([invalid], { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(report.rejection_reasons.INVALID_EVENT_START, 1);
});

test("18. pagination reads all pages via the injected reader", async () => {
  const totalRows = 25;
  const pageSize = 10;
  const reader = async ({ from, to }: { from: number; to: number }) => {
    const data: SportsInventoryFunnelRow[] = [];
    for (let i = from; i <= Math.min(to, totalRows - 1); i++) {
      data.push(row({ provider_event_id: `evt-${i}`, provider_market_id: `mkt-${i}` }));
    }
    return { data, error: null };
  };
  const result = await loadSportsInventoryFunnelRows(reader, { pageSize });
  assert.equal(result.rows.length, totalRows);
  assert.equal(result.pagesRead, 3);
  assert.equal(result.truncated, false);
});

test("19. hard-cap truncation fails closed instead of a misleading partial PASS", async () => {
  const pageSize = 10;
  const hardCap = 20;
  const reader = async ({ from, to }: { from: number; to: number }) => {
    const data: SportsInventoryFunnelRow[] = [];
    for (let i = from; i <= to; i++) {
      data.push(row({ provider_event_id: `evt-${i}`, provider_market_id: `mkt-${i}` }));
    }
    return { data, error: null };
  };
  const result = await loadSportsInventoryFunnelRows(reader, { pageSize, hardCap });
  assert.equal(result.rows.length, hardCap);
  assert.equal(result.truncated, true);
});

test("20. loader performs SELECT-only behavior: reader is called only with a range, and read failures surface as a typed error", async () => {
  const calls: Array<{ from: number; to: number }> = [];
  const reader = async ({ from, to }: { from: number; to: number }) => {
    calls.push({ from, to });
    return { data: null, error: { message: "permission denied" } };
  };
  await assert.rejects(
    () => loadSportsInventoryFunnelRows(reader, { pageSize: 5 }),
    (err: unknown) => err instanceof SportsInventoryRowReadError,
  );
  assert.deepEqual(calls, [{ from: 0, to: 4 }]);
});

test("22. CLI with no environment access fails closed: DB_AVAILABLE=false, exit 1", () => {
  const scriptPath = path.join(__dirname, "..", "..", "scripts", "report-sports-inventory-funnel.ts");
  const strippedEnv: NodeJS.ProcessEnv = { ...process.env };
  delete strippedEnv.SUPABASE_URL;
  delete strippedEnv.SUPABASE_SERVICE_ROLE_KEY;
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--fixed-now", FIXED_NOW, "--horizon-hours", "48"], {
    cwd: path.join(__dirname, "..", ".."),
    env: strippedEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.DB_AVAILABLE, false);
  assert.equal(parsed.verdict, "STOP_PRODUCTION_READ_UNAVAILABLE");
});
