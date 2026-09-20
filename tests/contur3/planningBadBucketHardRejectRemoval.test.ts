// PLANNING_BAD_BUCKET_HARD_REJECT_REMOVAL_V1
//   node --import tsx --test tests/contur3/planningBadBucketHardRejectRemoval.test.ts
//
// The legacy BAD_BUCKET_COV_PRICE hard reject (coverage 50-74 AND
// entry_price 0.44-0.58) is NOT part of the proven PORTFOLIO_BROAD research
// policy and was discarding otherwise model-valid Planning candidates before
// Reservation could apply the Decision Policy. This removes it as a hard
// admission reject ONLY for planningMode + selectorMode="CONTRACT_A_PLANNING_V1",
// replacing it with a telemetry-only shadow counter
// (bad_bucket_shadow_match_count). The non-Planning/live legacy path keeps
// the exact original hard-reject behavior. No other guard (coverage>=25,
// score>=50, identity, sport, market policy) is touched.
//
// nowMs is pinned explicitly (buildFireModelCandidates's own injected-clock
// parameter) rather than relying on the real wall clock, so fixture
// created_at/expires_at/gameStartIso values stay inside the 72h planning
// lookback and "must be in the future" windows regardless of when this test
// runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const NOW_MS = Date.parse("2026-07-22T00:00:00.000Z");
const CREATED_AT = "2026-07-21T12:00:00.000Z"; // 12h before NOW_MS -- well inside the 72h lookback
const GAME_START = "2026-07-23T00:00:00.000Z"; // after NOW_MS
const FUTURE_EXPIRES = "2026-07-24T00:00:00.000Z"; // after NOW_MS

// Values chosen to sit squarely inside the legacy BAD_BUCKET_COV_PRICE band:
// coverage 50-74 (60) AND entry_price 0.44-0.58 (0.52).
function planningRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "row-1",
    condition_id: "cond-bad-bucket-1",
    selected_token_id: "tok-bad-bucket-1",
    selected_outcome: "New York Yankees",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    event_slug: "evt-bad-bucket-1",
    entry_price_num: 0.52,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "baseball" },
    metric_formula_version: "v2-lite-growth-safe",
    created_at: CREATED_AT,
    expires_at: FUTURE_EXPIRES,
    signal_result: null,
    ...overrides,
  };
}

// ── A: Planning CONTRACT_A_PLANNING_V1, coverage=60/entryPrice=0.52 -> NOT rejected as BAD_BUCKET_COV_PRICE ──

test("A: a CONTRACT_A_PLANNING_V1 Planning candidate in the legacy bad-bucket band (coverage=60, entryPrice=0.52) is admitted, not rejected as BAD_BUCKET_COV_PRICE", async () => {
  const rows = [planningRow()];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(
    50,
    "all",
    true,
    rows,
    "CONTRACT_A_PLANNING_V1",
    NOW_MS,
  );
  assert.equal(candidates.length, 1, "must be admitted, not hard-rejected");
  assert.equal(
    rawDiagnostics?.rejected_before_planning_by_reason.BAD_BUCKET_COV_PRICE ?? 0,
    0,
    "BAD_BUCKET_COV_PRICE must never fire as an admission reject under Planning",
  );
});

// ── B: the same candidate still fails on coverage < 25 ─────────────────────

test("B: the same candidate still fails LOW_COVERAGE when coverage < 25, even though it is also in the bad-bucket price band", async () => {
  const rows = [planningRow({ diagnostics: { gameStartIso: GAME_START, dataCoverage: 20, shadowScope: "baseball" } })];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(
    50,
    "all",
    true,
    rows,
    "CONTRACT_A_PLANNING_V1",
    NOW_MS,
  );
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.LOW_COVERAGE, 1);
});

// ── C: the same candidate still fails an independent guard (GAME_STARTED_OR_INVALID) ─────
// (signal_confidence_num < 50 is not reachable here as a comparison case: the
// row-admission prefilter itself already requires signal_confidence_num >= 50
// before a row is even considered "scored", for both Planning and non-Planning,
// so LOW_SCORE cannot fire on an otherwise-admitted scored row in this harness.
// GAME_STARTED_OR_INVALID is independent of coverage/price and IS reachable.)

test("C: the same candidate still fails GAME_STARTED_OR_INVALID when the game has already started, even though it is also in the bad-bucket price band", async () => {
  const rows = [
    planningRow({
      diagnostics: { gameStartIso: "2026-07-20T00:00:00.000Z", dataCoverage: 60, shadowScope: "baseball" }, // before NOW_MS
    }),
  ];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(
    50,
    "all",
    true,
    rows,
    "CONTRACT_A_PLANNING_V1",
    NOW_MS,
  );
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.GAME_STARTED_OR_INVALID, 1);
});

// ── D: non-Planning behavior still hard-rejects the legacy bad-bucket combination ──

test("D: the exact same bad-bucket combination is still hard-rejected outside Planning (planningMode=false)", async () => {
  const rows = [planningRow()];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(50, "all", false, rows, "CONTUR3_CURRENT", NOW_MS);
  assert.equal(candidates.length, 0, "non-Planning path must preserve the legacy hard reject");
  // rawDiagnostics is only populated when planningMode=true -- absence here is
  // itself proof this ran the unmodified non-Planning branch.
  assert.equal(rawDiagnostics, null);
});

test("D2: the exact same bad-bucket combination is still hard-rejected under planningMode=true with a non-CONTRACT_A_PLANNING_V1 selectorMode (legacy behavior preserved)", async () => {
  const rows = [planningRow()];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(50, "all", true, rows, "CONTUR3_CURRENT", NOW_MS);
  assert.equal(candidates.length, 0, "the shadow-only exemption is scoped strictly to CONTRACT_A_PLANNING_V1");
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.BAD_BUCKET_COV_PRICE, 1);
});

// ── E: bad_bucket_shadow_match_count increments exactly for a matching Planning row ──

test("E: bad_bucket_shadow_match_count increments exactly once for a Planning row matching the legacy bucket, and not for one that doesn't", async () => {
  const matching = planningRow({ id: "row-match", condition_id: "cond-match", selected_token_id: "tok-match", event_slug: "evt-match" });
  const nonMatching = planningRow({
    id: "row-nomatch",
    condition_id: "cond-nomatch",
    selected_token_id: "tok-nomatch",
    event_slug: "evt-nomatch",
    entry_price_num: 0.7, // outside the 0.44-0.58 band
  });
  const { rawDiagnostics } = await buildFireModelCandidates(
    50,
    "all",
    true,
    [matching, nonMatching],
    "CONTRACT_A_PLANNING_V1",
    NOW_MS,
  );
  assert.equal(rawDiagnostics?.bad_bucket_shadow_match_count, 1);
});

// ── F: no candidate membership change outside Planning ──────────────────────

test("F: candidate membership for a row entirely outside the bad-bucket band is unaffected by this patch, under both Planning and non-Planning", async () => {
  const outsideBucket = planningRow({ entry_price_num: 0.7 });
  const planningResult = await buildFireModelCandidates(50, "all", true, [outsideBucket], "CONTRACT_A_PLANNING_V1", NOW_MS);
  assert.equal(planningResult.candidates.length, 1);
  assert.equal(planningResult.rawDiagnostics?.bad_bucket_shadow_match_count ?? 0, 0);

  const liveResult = await buildFireModelCandidates(50, "all", false, [outsideBucket], "CONTUR3_CURRENT", NOW_MS);
  assert.equal(liveResult.candidates.length, 1);
});
