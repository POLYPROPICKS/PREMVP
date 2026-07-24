// R0E reservation/rebalance executable-identity parity tests (node:test via tsx):
//   node --import tsx --test tests/contur3/reservationIdentityParity.test.ts
//
// Proves the earliest-boundary fix for production plan
// night-plan:2026-07-24:1700-minsk (15 Reservations -> 14 SKIPPED with
// CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE). Root cause: planning
// (CONTRACT_A_PLANNING_V1, broad universe) reserved physical events that had
// NO identity-complete authoritative (CONTRACT_A_V1) representative, so every
// such reservation was dead-on-arrival at rebalance. The fix makes planning
// apply the SAME executable-identity contract rebalance uses, before it
// reserves a slot.
//
// These tests inject the planning universe (fetchCandidates) and the
// authoritative universe (fetchAuthoritativeCandidates) directly into
// buildReservationPlan — no live Supabase, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import {
  decidePlanningReservationExecutableIdentity,
} from "../../lib/executor/eventExecutionQueue";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";

const ANCHOR_NOW_MS = Date.parse("2026-07-19T14:00:00.000Z"); // 17:00 Minsk
const KICKOFF_ISO = "2026-07-19T19:00:00.000Z"; // T-5h, within the 18h horizon

// A CONTRACT_A_PLANNING_V1 planning-universe candidate.
function planningCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return {
    signal_id: "44444444-4444-4444-8444-444444444444", // gsp.id lineage (best_snapshot_id)
    generated_signal_pair_id: "44444444-4444-4444-8444-444444444444",
    strategy: "TIER1_CORE_STRICT_72_COV50",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    match_family_key: "pair:team-a-vs-team-b:2026-07-19",
    match_family_key_source: "event_slug",
    match_family_key_is_weak: false,
    event_slug: "nba-team-a-vs-team-b",
    condition_id: "cond-plan-a",
    token_id: "tok-plan-a",
    side: "TEAM_A",
    selected_outcome: "TEAM_A",
    inferred_sport: "basketball",
    market_family: "allowed_fullmatch_moneyline",
    strategic_scope: "OTHER",
    timing_bucket: "T_2_6H",
    identity_quality: "STRONG",
    identity_warning_codes: [],
    canonical_event_key: "pair:team-a-vs-team-b:2026-07-19",
    canonical_market_key: "cond-plan-a",
    activity_label_detected: false,
    sport_classification_confidence: "HIGH",
    live_eligible: true,
    live_rejection_reason: null,
    side_mapping_status: "PROVEN_BY_TOKEN_ID",
    live_block_reason: null,
    live_policy_version: "v1",
    paper_eligible: true,
    max_entry_price: 0.55,
    stake_usd: 1.1,
    max_order_usd: 1.1,
    max_spread: 0.03,
    one_order_only: true,
    executor_mode_allowed: "dry_run_only",
    first_live_test_allowed: true,
    stale_after: KICKOFF_ISO,
    no_trade_after: KICKOFF_ISO,
    idempotency_key: "idem-plan-a",
    model_rule_id: "v1",
    created_at: "2026-07-19T12:00:00.000Z",
    source: "FireModel1",
    rank: 1,
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 80,
      coverage: 100,
      smart_money: null,
      entry_price: 0.5,
      game_start_iso: KICKOFF_ISO,
      hours_to_start_now: 5,
      fire_model_alias: "ContractA",
      version: "v2",
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
    },
    ...overrides,
  } as FireModelCandidate;
}

// A CONTRACT_A_V1 authoritative-universe candidate (identity-complete + executable).
function authoritativeCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return {
    ...planningCandidate(),
    signal_id: "cond-plan-a::tok-plan-a", // observationId shape on the CA_V1 path
    generated_signal_pair_id: "44444444-4444-4444-8444-444444444444", // lineage joins the planning row
    live_eligible: true,
    live_rejection_reason: null,
    diagnostics: {
      ...planningCandidate().diagnostics,
      selector_id: "FROZEN_MODEL_V2",
      contract_a_stage: "FINAL_AUTHORITATIVE",
      authoritative_condition_id: "cond-plan-a",
      authoritative_token_id: "tok-plan-a",
      authoritative_side: "TEAM_A",
      authoritative_observation_id: "cond-plan-a::tok-plan-a",
      authoritative_event_key: "pair:team-a-vs-team-b:2026-07-19",
    },
    ...overrides,
  } as FireModelCandidate;
}

async function plan(
  planningUniverse: FireModelCandidate[],
  authoritativeUniverse: FireModelCandidate[],
) {
  return buildReservationPlan(ANCHOR_NOW_MS, {
    selectorMode: "CONTRACT_A_PLANNING_V1",
    fetchCandidates: async () => ({ candidates: planningUniverse }),
    fetchAuthoritativeCandidates: async () => ({ candidates: authoritativeUniverse }),
  });
}

// ── Shared contract (unit) ────────────────────────────────────────────────

test("Contract-1: identity-complete executable authoritative candidate -> allowed=EXECUTABLE", () => {
  const decision = decidePlanningReservationExecutableIdentity(
    { best_snapshot_id: "44444444-4444-4444-8444-444444444444", event_slug: "nba-team-a-vs-team-b", match_family_key: "pair:team-a-vs-team-b:2026-07-19" },
    [authoritativeCandidate()],
    "PLANNING",
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason_code, "EXECUTABLE");
  assert.equal(decision.condition_id, "cond-plan-a");
});

test("Contract-2: no authoritative representative -> allowed=false, NO_IDENTITY_COMPLETE_REPRESENTATIVE", () => {
  const decision = decidePlanningReservationExecutableIdentity(
    { best_snapshot_id: "no-such-lineage", event_slug: "esports-only-slug", match_family_key: "pair:liquid-vs-fnatic:2026-07-19" },
    [authoritativeCandidate()], // exists but does not join
    "PLANNING",
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, "NO_IDENTITY_COMPLETE_REPRESENTATIVE");
  assert.equal(decision.candidate, null);
});

test("Contract-3: authoritative candidate present but market anchor rejected -> MARKET_ANCHOR_REJECTED", () => {
  const malformed = authoritativeCandidate({ live_eligible: false, live_rejection_reason: "CONTRACT_A_ACTIVITY_LABEL_MARKET" });
  const decision = decidePlanningReservationExecutableIdentity(
    { best_snapshot_id: "44444444-4444-4444-8444-444444444444", event_slug: "nba-team-a-vs-team-b", match_family_key: "pair:team-a-vs-team-b:2026-07-19" },
    [malformed],
    "PLANNING",
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, "MARKET_ANCHOR_REJECTED");
});

// ── Planning admission (integration through buildReservationPlan) ──────────

test("Parity-1: a physical event with NO authoritative representative is not reserved (no dead-on-arrival slot)", async () => {
  // Esports-shaped planning event; authoritative universe excludes it (empty join).
  const esports = planningCandidate({
    signal_id: "esp-liquid-fnatic",
    generated_signal_pair_id: "esp-liquid-fnatic",
    event_slug: "valorant-team-liquid-vs-fnatic",
    match_family_key: "pair:liquid-vs-fnatic:2026-07-19",
    inferred_sport: "esport",
  });
  const p = await plan([esports], []); // authoritative universe empty
  assert.equal(p.reservations.length, 0, "esports event with no authoritative representative must not be reserved");
  assert.equal(p.diagnostics.skipped_no_authoritative_identity, 1);
});

test("Parity-2: an identity-complete representation wins over an identity-incomplete one for the same event", async () => {
  // Same physical event (same pair key), two planning representations. The
  // higher-quality one (score 95) joins the authoritative universe by NO method
  // — distinct lineage, distinct slug; the lower one (score 70) joins by
  // lineage. The scan must skip the non-joining top rep and reserve via the
  // joining one, not skip the whole event.
  const incomplete = planningCandidate({
    signal_id: "lineage-X-no-auth",
    generated_signal_pair_id: "lineage-X-no-auth",
    event_slug: "nba-team-a-vs-team-b-variant-x",
    diagnostics: { ...planningCandidate().diagnostics, score: 95 },
  });
  const complete = planningCandidate({
    signal_id: "lineage-Y-has-auth",
    generated_signal_pair_id: "lineage-Y-has-auth",
    event_slug: "nba-team-a-vs-team-b-variant-y",
    diagnostics: { ...planningCandidate().diagnostics, score: 70 },
  });
  // Authoritative candidate joins ONLY the complete rep (by lineage). Its slug
  // and match_family_key match neither planning rep, so the incomplete rep has
  // no join path at all.
  const auth = authoritativeCandidate({
    generated_signal_pair_id: "lineage-Y-has-auth",
    event_slug: "nba-team-a-vs-team-b-variant-y",
    match_family_key: "authoritative-only-key",
  });
  const p = await plan([incomplete, complete], [auth]);
  assert.equal(p.reservations.length, 1, "the event is reserved via its identity-complete representation");
  assert.equal(p.reservations[0].best_snapshot_id, "lineage-Y-has-auth", "reservation lineage must be the joining representation");
});

test("Parity-3: a reserved planning event survives unchanged-source rebalance identity check", async () => {
  const p = await plan([planningCandidate()], [authoritativeCandidate()]);
  assert.equal(p.reservations.length, 1);
  const r = p.reservations[0];
  // The exact contract rebalance applies, on the unchanged authoritative universe.
  const decision = decidePlanningReservationExecutableIdentity(
    { best_snapshot_id: r.best_snapshot_id, event_slug: r.event_slug, match_family_key: r.match_family_key },
    [authoritativeCandidate()],
    "REBALANCE",
  );
  assert.equal(decision.allowed, true, "a planned reservation MUST pass the unchanged-source rebalance identity check");
});

test("Parity-4: malformed authoritative market (activity-label) does not produce a reservation", async () => {
  const malformedAuth = authoritativeCandidate({ live_eligible: false, live_rejection_reason: "CONTRACT_A_ACTIVITY_LABEL_MARKET" });
  const p = await plan([planningCandidate()], [malformedAuth]);
  assert.equal(p.reservations.length, 0, "an event whose only authoritative market is malformed must not be reserved");
  assert.equal(p.diagnostics.skipped_no_authoritative_identity, 1);
});

test("Parity-5: a valid full-match event with a good authoritative representative is still reserved", async () => {
  const p = await plan([planningCandidate()], [authoritativeCandidate()]);
  assert.equal(p.reservations.length, 1, "a genuinely executable event must still be reserved after the fix");
  assert.equal(p.reservations[0].event_tier, "TIER1");
});
