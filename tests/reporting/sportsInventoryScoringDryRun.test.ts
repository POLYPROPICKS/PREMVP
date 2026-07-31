// Read-only scoring dry-run tests (node:test via tsx):
//   npx tsx --test tests/reporting/sportsInventoryScoringDryRun.test.ts
//
// Production-shaped inventory fixtures only -- never a FireModelCandidate.
// The scoring port is always injected: no test here reaches Supabase or
// Polymarket. selectDeterministicSample / runSportsInventoryScoringDryRun
// are exercised directly against in-memory rows and a fake scorer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSportsInventoryScoringDryRun,
  selectDeterministicSample,
  validateScoringDryRunOptions,
  HARD_MAX_GROUPS,
  HARD_MAX_MARKETS_PER_GROUP,
  HARD_MAX_CONCURRENCY,
  type ScoreMarketPort,
  type ScoreMarketPortResult,
} from "../../lib/reporting/sportsInventoryScoringDryRun";
import {
  computeSportsInventoryEligibleGroups,
  type SportsInventoryFunnelRow,
} from "../../lib/reporting/sportsInventoryFunnelReport";
import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";

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

const okScorer: ScoreMarketPort = async (_event, market) => ({
  ok: true,
  selected_outcome: "Team A",
  selected_token_id: "token-a",
  opposing_token_id: "token-b",
  entry_price: 0.6,
  score: 72,
  confidence: 68,
  data_coverage: 50,
});

test("1. deterministic group and market ordering", () => {
  const groups = computeSportsInventoryEligibleGroups(
    [
      row({ provider_event_id: "evt-b", event_start_iso: "2026-07-31T18:00:00.000Z" }),
      row({ provider_event_id: "evt-a", event_start_iso: "2026-07-31T12:00:00.000Z" }),
    ],
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS },
  );
  const sample = selectDeterministicSample(groups.eligibleGroups, { maxGroups: 10, maxMarketsPerGroup: 1 });
  assert.deepEqual(
    sample.map((g) => g.providerEventId),
    ["evt-a", "evt-b"],
  );
});

test("2. configured group cap is respected", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    row({ provider_event_id: `evt-${i}`, provider_market_id: `mkt-${i}`, event_start_iso: `2026-07-31T${10 + i}:00:00.000Z` }),
  );
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  const sample = selectDeterministicSample(groups.eligibleGroups, { maxGroups: 2, maxMarketsPerGroup: 1 });
  assert.equal(sample.length, 2);
});

test("3. configured per-group market cap is respected", () => {
  const rows = [
    row({ provider_event_id: "evt-multi", provider_market_id: "mkt-a", sibling_market_count: 3 }),
    row({ provider_event_id: "evt-multi", provider_market_id: "mkt-b", market_question: "Team A vs Team B Spread", sibling_market_count: 3 }),
    row({ provider_event_id: "evt-multi", provider_market_id: "mkt-c", market_question: "Team A vs Team B Total", sibling_market_count: 3 }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  const sample = selectDeterministicSample(groups.eligibleGroups, { maxGroups: 10, maxMarketsPerGroup: 2 });
  assert.equal(sample.length, 1);
  assert.equal(sample[0].markets.length, 2);
  assert.deepEqual(
    sample[0].markets.map((m) => m.row.provider_market_id),
    ["mkt-a", "mkt-b"],
  );
});

test("4. hard limit validation rejects values above the hard caps", () => {
  const base = { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 1, maxMarketsPerGroup: 1, concurrency: 1 };
  assert.equal(validateScoringDryRunOptions({ ...base, maxGroups: HARD_MAX_GROUPS + 1 }).ok, false);
  assert.equal(validateScoringDryRunOptions({ ...base, maxMarketsPerGroup: HARD_MAX_MARKETS_PER_GROUP + 1 }).ok, false);
  assert.equal(validateScoringDryRunOptions({ ...base, concurrency: HARD_MAX_CONCURRENCY + 1 }).ok, false);
  assert.equal(validateScoringDryRunOptions(base).ok, true);
});

test("5. only strict groups are sampled", () => {
  const rows = [
    row({ provider_event_id: "evt-strict", provider_market_id: "mkt-strict" }),
    row({
      provider_event_id: "evt-mixed",
      provider_market_id: "mkt-mixed-1",
      market_question: "Team A vs Team B Moneyline",
      sibling_market_count: 2,
    }),
    row({
      provider_event_id: "evt-mixed",
      provider_market_id: "mkt-mixed-2",
      market_question: "Player A anytime scorer prop",
      sibling_market_count: 2,
    }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 1);
  assert.equal(groups.eligibleGroups[0].providerEventId, "evt-strict");
  assert.ok((groups.excludedReasons.GROUP_NOT_STRICT_FULL_EVENT ?? 0) >= 1);
});

test("6. a derivative sibling makes a production-shaped group ineligible", () => {
  const rows = [
    row({
      provider_event_id: "evt-cricket-derivative",
      provider_market_id: "mkt-cricket-moneyline",
      market_question: "Upminster to win the match?",
      sibling_market_count: 2,
    }),
    row({
      provider_event_id: "evt-cricket-derivative",
      provider_market_id: "mkt-cricket-most-sixes",
      market_question: "Most Sixes Upminster Winner",
      sibling_market_count: 2,
    }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 0);
  assert.equal(groups.excludedReasons.GROUP_NOT_STRICT_FULL_EVENT, 1);
});

test("7. first-innings lead is rejected by the canonical event-scope decision", () => {
  const decision = resolveMarketAnchorDecision({ providerMarketQuestion: "First Innings Lead Winner" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.event_scope, "map_or_round");
  assert.equal(decision.reason_code, "PARTIAL_EVENT_SCOPE");
});

test("6. confirmed-sports gate is enforced", () => {
  const rows = [
    row({ provider_event_id: "evt-confirmed" }),
    row({ provider_event_id: "evt-not-confirmed", is_confirmed_sports: false, sports_confirmation_source: "no_matching_sports_tag" }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 1);
  assert.equal(groups.excludedReasons.SPORTS_NOT_CONFIRMED, 1);
});

test("7. metadata inconsistency is excluded", () => {
  const rows = [
    row({ provider_event_id: "evt-inconsistent", is_confirmed_sports: false, sports_confirmation_source: "specific_sports_tag" }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 0);
  assert.equal(groups.excludedReasons.SPORT_CONFIRMATION_METADATA_INCONSISTENT, 1);
});

test("8. reschedule-ambiguous provider event is fully excluded", () => {
  const rows = [
    row({ provider_event_id: "evt-resched", provider_market_id: "mkt-resched", event_start_iso: "2026-07-31T12:00:00.000Z" }),
    row({ provider_event_id: "evt-resched", provider_market_id: "mkt-resched", event_start_iso: "2026-07-31T18:00:00.000Z" }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 0);
  assert.ok((groups.excludedReasons.RESCHEDULE_IDENTITY_AMBIGUOUS ?? 0) >= 1);
});

test("9. sibling mismatch is excluded", () => {
  const rows = [
    row({ provider_event_id: "evt-mismatch", provider_market_id: "mkt-1", sibling_market_count: 5 }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 0);
  assert.equal(groups.excludedReasons.SIBLING_INTEGRITY_FAILED, 1);
});

test("10. structurally invalid row is excluded", () => {
  const rows = [row({ provider_event_id: "evt-nocond", condition_id: null })];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  assert.equal(groups.eligibleGroups.length, 0);
  assert.equal(groups.excludedReasons.STRUCTURAL_SCORE_INPUT_NOT_READY, 1);
});

test("11. adapter failure is reason-coded", async () => {
  // The reporter's structural-readiness rule only checks array LENGTHS match
  // and that at least one price is valid -- it never checks token content or
  // that every price is valid. A row with an empty second token therefore
  // still reaches the sample (array lengths align, one price is valid), but
  // the stricter adapter boundary must independently catch the empty token.
  const rows = [row({ provider_event_id: "evt-badtoken", clob_token_ids: ["token-a", ""] })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  assert.equal(report.market_results.length, 1);
  assert.equal(report.market_results[0].adapter_status, "TOKEN_MISSING");
  assert.equal(report.market_results[0].failure_reason, "TOKEN_MISSING");
  assert.equal(report.successfully_scored_markets, 0);
});

test("12. injected scorer success preserves exact IDs", async () => {
  const rows = [row({ provider_event_id: "evt-ids", provider_market_id: "mkt-ids", condition_id: "0xexact" })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  assert.equal(report.market_results.length, 1);
  const r = report.market_results[0];
  assert.equal(r.provider, "polymarket");
  assert.equal(r.provider_event_id, "evt-ids");
  assert.equal(r.provider_market_id, "mkt-ids");
  assert.equal(r.condition_id, "0xexact");
});

test("13. selected outcome/token/price come only from the scorer", async () => {
  const rows = [row({ provider_event_id: "evt-sel" })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  const r = report.market_results[0];
  assert.equal(r.selected_outcome, "Team A");
  assert.equal(r.selected_token_id, "token-a");
  assert.equal(r.opposing_token_id, "token-b");
  assert.equal(r.entry_price, 0.6);
});

test("14. score/confidence/coverage come only from the scorer", async () => {
  const rows = [row({ provider_event_id: "evt-score" })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  const r = report.market_results[0];
  assert.equal(r.score, 72);
  assert.equal(r.confidence, 68);
  assert.equal(r.data_coverage, 50);
});

test("15. scorer exception is isolated per market", async () => {
  const rows = [
    row({ provider_event_id: "evt-throws", provider_market_id: "mkt-throws" }),
    row({ provider_event_id: "evt-ok", provider_market_id: "mkt-ok" }),
  ];
  const flaky: ScoreMarketPort = async (event) => {
    if (event.id === "evt-throws") throw new Error("simulated network failure");
    return okScorer(event, {} as never);
  };
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 2 },
    flaky,
  );
  assert.equal(report.market_results.length, 2);
  const throwResult = report.market_results.find((r) => r.provider_event_id === "evt-throws")!;
  assert.equal(throwResult.failure_reason, "LIVE_ENRICHMENT_FAILED");
});

test("16. one failed market does not suppress later results", async () => {
  const rows = [
    row({ provider_event_id: "evt-fail", provider_market_id: "mkt-fail" }),
    row({ provider_event_id: "evt-succeed", provider_market_id: "mkt-succeed" }),
  ];
  const mixed: ScoreMarketPort = async (event) => {
    if (event.id === "evt-fail") return { ok: false, reasonCode: "LIVE_ENRICHMENT_EMPTY" };
    return okScorer(event, {} as never);
  };
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    mixed,
  );
  assert.equal(report.market_results.length, 2);
  assert.equal(report.successfully_scored_markets, 1);
  assert.equal(report.failed_market_reasons.LIVE_ENRICHMENT_EMPTY, 1);
});

test("17. no market-class preference is introduced (sample order is identity-only)", () => {
  const rows = [
    row({ provider_event_id: "evt-total", provider_market_id: "mkt-total", market_question: "Team A vs Team B Total", event_start_iso: "2026-07-31T10:00:00.000Z" }),
    row({ provider_event_id: "evt-money", provider_market_id: "mkt-money", market_question: "Team A vs Team B Moneyline", event_start_iso: "2026-07-31T09:00:00.000Z" }),
  ];
  const groups = computeSportsInventoryEligibleGroups(rows, { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS });
  const sample = selectDeterministicSample(groups.eligibleGroups, { maxGroups: 10, maxMarketsPerGroup: 1 });
  // Order follows event_start_iso only -- moneyline is not preferred over total.
  assert.deepEqual(sample.map((g) => g.providerEventId), ["evt-money", "evt-total"]);
});

test("18. results are deterministic when the injected scorer is deterministic", async () => {
  const rows = [row({ provider_event_id: "evt-det" })];
  const options = { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 };
  const a = await runSportsInventoryScoringDryRun(rows, options, okScorer);
  const b = await runSportsInventoryScoringDryRun(rows, options, okScorer);
  const stripDuration = (report: typeof a) => ({
    ...report,
    market_results: report.market_results.map((r) => ({ ...r, duration_ms: 0 })),
  });
  assert.deepEqual(stripDuration(a), stripDuration(b));
});

test("19. report never claims planning, Reservation or executability", async () => {
  const rows = [row({ provider_event_id: "evt-claim" })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  const serialized = JSON.stringify(report);
  assert.ok(!/planning candidate/i.test(serialized));
  assert.ok(!/reservation.?ready/i.test(serialized));
  assert.ok(!/executable/i.test(serialized));
  assert.ok(serialized.includes("SCORE_IS_NOT_EXECUTABILITY_PROOF"));
});

test("20/21/22. no Supabase mutation, product-feed writer, or Reservation/Queue module is imported by this module", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../lib/reporting/sportsInventoryScoringDryRun.ts", import.meta.url), "utf8"),
  );
  assert.ok(!/from ["']@\/lib\/supabase\/server["']/.test(src));
  assert.ok(!/writeGeneratedSignalPairs|cacheSportsEventMarketInventory|nightEventReservations|eventExecutionQueue/.test(src));
});

test("full token arrays are never printed in a market result", async () => {
  const rows = [row({ provider_event_id: "evt-notoken" })];
  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: FIXED_NOW, horizonHours: HORIZON_HOURS, maxGroups: 10, maxMarketsPerGroup: 1, concurrency: 1 },
    okScorer,
  );
  const serialized = JSON.stringify(report.market_results[0]);
  assert.ok(!serialized.includes('"token-a","token-b"'));
});
