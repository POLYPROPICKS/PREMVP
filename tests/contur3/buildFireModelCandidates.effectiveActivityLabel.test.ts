// EFFECTIVE ACTIVITY-LABEL CONSISTENCY — the market-policy probe must classify
// the SAME text it is told to trust.
//
// buildFireModelCandidates substitutes a meaningful fallback for `market_slug`
// when the raw provider value is a generic activity/volume placeholder
// ("Live market activity", "$66 matched activity") -- exactly the same
// fallback pattern buildIdentityText already uses. But it was still passing
// `activity_label_detected` computed from the ORIGINAL, uncorrected
// `row.market_slug` into resolveUpstreamMarketPolicy, whose very first branch
// vetoes on that flag before ever classifying the corrected text. A row whose
// real market description lives in `event_slug` ("Spread: Houston Astros
// (-2.5)") was discarded solely because its own `market_slug` field happened
// to be a generic placeholder -- even though its sport, scope and market type
// were all otherwise correctly and independently recognized.
//
// This suite pins the fix: activity-label status must be (re)computed from the
// EFFECTIVE text the policy actually classifies, not from a stale flag.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const KICKOFF_ISO = "2026-08-04T23:00:00.000Z";
const NOW_MS = Date.parse("2026-08-04T14:02:25.523Z");

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

function sourceRow(over: {
  id: string;
  event_slug: string;
  market_slug: string;
  shadowScope: string;
}) {
  return {
    id: over.id,
    condition_id: `cond-${over.id}`,
    selected_token_id: `tok-${over.id}`,
    selected_outcome: "Yes",
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-08-04T13:30:00.000Z",
    expires_at: "2026-08-04T15:02:00.000Z",
    signal_result: null,
    event_slug: over.event_slug,
    market_slug: over.market_slug,
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: over.shadowScope,
    },
  };
}

// Production-shaped: market_slug is a generic activity/volume placeholder,
// but event_slug is a clean, unambiguous full-match spread description.
const MLB_SPREAD_BEHIND_ACTIVITY_LABEL = sourceRow({
  id: "mlb-spread-behind-activity-label",
  event_slug: "Spread: Houston Astros (-2.5)",
  market_slug: "Live market activity",
  shadowScope: "mlb",
});

// A second, differently-shaped placeholder ("$X matched activity") over the
// same kind of real market, to prove the fix is not keyed to one exact string.
const MLB_SPREAD_BEHIND_DOLLAR_LABEL = sourceRow({
  id: "mlb-spread-behind-dollar-label",
  event_slug: "Spread: Boston Red Sox (-2.5)",
  market_slug: "$66 matched activity",
  shadowScope: "mlb",
});

// Genuine activity-label row: NEITHER market_slug NOR event_slug carries any
// real market description -- the fallback chain still lands on an
// activity-label-shaped string, so the row must remain rejected.
const GENUINE_ACTIVITY_LABEL_NO_FALLBACK = sourceRow({
  id: "genuine-activity-label",
  event_slug: "$412 matched activity",
  market_slug: "Live market activity",
  shadowScope: "mlb",
});

// Unrelated control: market_slug is already a real, non-generic description.
// Must be completely unaffected by this change.
const NON_GENERIC_SPREAD = sourceRow({
  id: "non-generic-spread",
  event_slug: "mlb-nyy-phi-2026-08-04",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Spread",
  shadowScope: "mlb",
});

async function planningCandidates(rows: unknown[]) {
  return at(NOW_MS, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildFireModelCandidates(100_000, "all", true, rows as any, "CONTRACT_A_PLANNING_V1")
  );
}

test("EAL-1: a full-match spread hidden behind a generic activity-label market_slug is admitted", async () => {
  const { candidates } = await planningCandidates([MLB_SPREAD_BEHIND_ACTIVITY_LABEL]);
  assert.equal(
    candidates.length,
    1,
    "the row was rejected even though its event_slug describes a real full-match spread market"
  );
  const policy = candidates[0].diagnostics.market_policy;
  assert.ok(policy, "admitted candidate carries no market_policy verdict");
  assert.equal(policy.allowed, true);
  assert.equal(policy.market_class, "allowed_fullmatch_spread");
  assert.equal(policy.event_scope, "full_match");
});

test("EAL-1b: a '$X matched activity' placeholder is corrected the same way", async () => {
  const { candidates } = await planningCandidates([MLB_SPREAD_BEHIND_DOLLAR_LABEL]);
  assert.equal(candidates.length, 1, "the dollar-amount placeholder variant was not corrected");
  assert.equal(candidates[0].diagnostics.market_policy?.allowed, true);
});

test("EAL-2: no identity is invented -- lineage on the admitted candidate is exactly the source row", async () => {
  const { candidates } = await planningCandidates([MLB_SPREAD_BEHIND_ACTIVITY_LABEL]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.condition_id, "cond-mlb-spread-behind-activity-label");
  assert.equal(c.token_id, "tok-mlb-spread-behind-activity-label");
  assert.equal(c.diagnostics.game_start_iso, KICKOFF_ISO, "event start must be preserved exactly, not invented");
});

test("EAL-3: a genuine activity-label row with no real market text anywhere remains rejected", async () => {
  const { candidates, rawDiagnostics } = await planningCandidates([GENUINE_ACTIVITY_LABEL_NO_FALLBACK]);
  assert.equal(
    candidates.length,
    0,
    "a row with no real market description anywhere must not become a planning candidate"
  );
  const reasons = Object.keys(rawDiagnostics?.rejected_before_planning_by_reason ?? {});
  assert.ok(
    reasons.some((r) => r.startsWith("MARKET_POLICY_")),
    `expected a structured MARKET_POLICY_* rejection, got: ${JSON.stringify(reasons)}`
  );
});

test("EAL-4: an already-non-generic market_slug is completely unaffected", async () => {
  const { candidates } = await planningCandidates([NON_GENERIC_SPREAD]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].market_slug, "New York Yankees vs. Philadelphia Phillies - Spread");
  assert.equal(candidates[0].diagnostics.market_policy?.allowed, true);
});

test("EAL-5: unrelated executor modes (live, non-planning) are unchanged by this fix", async () => {
  const liveRow = {
    ...MLB_SPREAD_BEHIND_ACTIVITY_LABEL,
    metric_formula_version: "v2-lite-growth-safe",
  };
  const { candidates } = await at(NOW_MS, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildFireModelCandidates(150, "all", false, [liveRow] as any, "CONTUR3_CURRENT")
  );
  // Live mode never runs the market-policy gate at all (planningMode === false);
  // no candidate in this mode ever carries a market_policy verdict.
  for (const c of candidates) {
    assert.equal(c.diagnostics.market_policy, undefined, "live mode must never attach a market_policy verdict");
  }
});
