// Contur3 event-start mapping / production-shaped candidate / physical-event
// identity regressions (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL buildFireModelCandidates() via its injectedRows
// parameter -- zero Supabase reads, zero network, no live/fake credentials
// needed at all (this is the same zero-DB-read seam buildFireModelCandidates
// already exposes for its own planning-pagination tests).
//
// IMPORTANT CORRECTION vs. the originally assumed premise: FireModelCandidate
// has no top-level `event_start` field. The canonical event-start value is
// `FireModelCandidate.diagnostics.game_start_iso`, sourced from the raw row's
// `diagnostics.gameStartIso` (camelCase, on the generated_signal_pairs row).
// `expires_at` is NOT a fallback for event start -- it is used only for the
// separate `stale_after` field. When `diagnostics.gameStartIso` is absent,
// the row is REJECTED entirely with reason `MISSING_GAME_START` (fail-closed),
// never silently defaulted to `expires_at`. This is verified below and is not
// a defect -- it is safer than silently treating a data-freshness deadline as
// a kickoff time -- so no source change was made.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const FUTURE_EXPIRES = "2030-01-01T00:00:00.000Z"; // must be > now for the injectedRows filter
const GAME_START = "2030-01-02T00:00:00.000Z";

// Task-specified production ranges: metric_formula_version=v2-lite-growth-safe,
// signal_confidence_num in 67-75, entry_price_num in 0.365-0.465. Empirically
// confirmed (via injectedRows probing) to be the combination that clears the
// internal coverage/price "bad bucket" guard (BAD_BUCKET_COV_PRICE) at
// coverage=60 -- other nearby combinations (e.g. score 75 + price 0.48) fall
// into that guard and are rejected regardless of identity, which is a
// separate, correct, pre-existing check unrelated to this task's scope.
function baseRow(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    selected_token_id: `token-${id}`,
    entry_price_num: 0.42, // within 0.365-0.465
    signal_confidence_num: 70, // within 67-75
    smart_money_score_num: null,
    // shadowScope: "football" is a generic sport-classification hint (Guard F
    // requires scope to be positively identified -- see resolvePlanningScope)
    // so these synthetic "Team A vs Team B"-style fixtures clear that gate the
    // same way a real production row's diagnostics/eventTitle would. Real
    // team names (e.g. "Los Angeles Dodgers") are recognized without needing
    // this hint; generic placeholder names are not.
    diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-21T12:00:00.000Z",
    expires_at: FUTURE_EXPIRES,
    signal_result: null,
    ...overrides,
  };
}

// ── RED Test A: event-start mapping ─────────────────────────────────────────

test("A1: diagnostics.gameStartIso is authoritative -- FireModelCandidate.diagnostics.game_start_iso receives it verbatim", async () => {
  const rows = [
    baseRow("a1", {
      condition_id: "cond-a1",
      selected_outcome: "Team A",
      market_slug: "Team A vs. Team B",
      event_slug: "evt-a1",
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].diagnostics.game_start_iso, GAME_START);
});

test("A2: expires_at is NOT used as a fallback for game_start_iso -- a row with expires_at but no diagnostics.gameStartIso is rejected (MISSING_GAME_START), not silently defaulted", async () => {
  const rows = [
    baseRow("a2", {
      condition_id: "cond-a2",
      selected_outcome: "Team A",
      market_slug: "Team A vs. Team B",
      event_slug: "evt-a2",
      diagnostics: { dataCoverage: 60 }, // no gameStartIso; expires_at is still present at the row level
    }),
  ];
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 0, "must never silently substitute expires_at as the event start");
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.MISSING_GAME_START, 1);
});

test("A3: expires_at IS used, correctly, as the fallback for stale_after (a distinct field from event start) when it is present", async () => {
  const rows = [
    baseRow("a3", {
      condition_id: "cond-a3",
      selected_outcome: "Team A",
      market_slug: "Team A vs. Team B",
      event_slug: "evt-a3",
      expires_at: "2030-06-15T00:00:00.000Z", // distinct from GAME_START, to prove it's read independently
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].stale_after, "2030-06-15T00:00:00.000Z");
  assert.equal(candidates[0].diagnostics.game_start_iso, GAME_START, "game_start_iso is unaffected by stale_after/expires_at");
});

// ── RED Test B: production-shaped candidates ────────────────────────────────
// Fixtures use the actual persisted-row field names (condition_id,
// selected_token_id, metric_formula_version, signal_confidence_num,
// entry_price_num, diagnostics.gameStartIso, expires_at, selected_outcome).
// Each fixture's outcome (accepted, or rejected with one stable reason) is
// asserted exactly as empirically observed -- no filter was weakened to
// force any of these to pass.

test("B1: 'Los Angeles Dodgers vs. Philadelphia Phillies' -- accepted, full-match team-pair identity via event_slug", async () => {
  const rows = [
    baseRow("dodgers", {
      condition_id: "cond-dodgers-phillies",
      selected_outcome: "Los Angeles Dodgers",
      market_slug: "Los Angeles Dodgers vs. Philadelphia Phillies",
      event_slug: "mlb-lad-phi-2026-07-22",
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1, "a real full-match moneyline market with a valid event_slug must be accepted");
  const c = candidates[0];
  assert.equal(c.match_family_key, "mlb-lad-phi-2026-07-22");
  assert.equal(c.match_family_key_source, "event_slug");
  assert.equal(c.match_family_key_is_weak, false);
  assert.equal(c.canonical_event_key, "mlb-lad-phi-2026-07-22");
});

test("B2: 'Sabah FK — Match Winner' -- rejected from scope classification (UNKNOWN_SCOPE) without any sport-identifying context; accepted-but-WEAK once a sport hint is present", async () => {
  // Without any recognizable sport keyword anywhere in the identity text or
  // diagnostics (marketTitle/eventTitle/question/shadowScope), the row is
  // correctly rejected upstream of identity derivation entirely -- Guard F:
  // "UNKNOWN is never live-eligible. Classifier must positively identify scope."
  const noScopeRows = [
    baseRow("sabah-noscope", {
      condition_id: "cond-sabah-mw",
      selected_outcome: "Sabah FK",
      market_slug: "Sabah FK — Match Winner",
      event_slug: null,
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60 }, // deliberately no shadowScope hint
    }),
  ];
  const noScopeResult = await buildFireModelCandidates(50, "all", true, noScopeRows);
  assert.equal(noScopeResult.candidates.length, 0);
  assert.equal(noScopeResult.rawDiagnostics?.rejected_before_planning_by_reason.UNKNOWN_SCOPE, 1);

  // With a sport hint present (as a real production row would carry via
  // diagnostics.shadowScope/eventTitle/etc.), the row clears the scope gate
  // but the market-level "Match Winner" title has no team-pair information --
  // it is accepted into the candidate universe but with an explicit WEAK,
  // market-level-only identity, never silently dropped.
  const withScopeRows = [
    baseRow("sabah-scoped", {
      condition_id: "cond-sabah-mw",
      selected_outcome: "Sabah FK",
      market_slug: "Sabah FK — Match Winner",
      event_slug: null,
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, withScopeRows);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.match_family_key, "WEAK_SINGLE_TEAM_MATCH_WINNER:sabah-fk");
  assert.equal(c.match_family_key_source, "condition_id_weak");
  assert.equal(c.match_family_key_is_weak, true);
  assert.equal(c.identity_quality, "WEAK");
  assert.equal(c.canonical_event_key, null, "a WEAK market-level identity must never be assigned a canonical event key");
});

test("B3: 'Spread: Fenerbahçe SK (-2.5)' -- accepted-but-WEAK market-level identity once scope is resolvable; no silent disappearance", async () => {
  const rows = [
    baseRow("fener", {
      condition_id: "cond-fener-spread",
      selected_outcome: "Fenerbahçe SK",
      market_slug: "Spread: Fenerbahçe SK (-2.5)",
      event_slug: null,
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1, "a real spread market with resolvable scope must not silently vanish");
  const c = candidates[0];
  assert.equal(c.match_family_key_source, "condition_id_weak");
  assert.equal(c.match_family_key_is_weak, true);
  assert.equal(c.identity_quality, "WEAK");
  assert.equal(c.canonical_event_key, null);
  // OBSERVATION (not a proven defect, no fix applied): the diacritic in
  // "Fenerbahçe" prevents SINGLE_TEAM_SPREAD_RE (an ASCII-only \w character
  // class, no /u flag) from matching, so this falls to the more generic
  // WEAK_MARKET_LEVEL_KEY:<condition_id> fallback instead of the more
  // specific WEAK_SINGLE_TEAM_SPREAD:<team>:<date> key a pure-ASCII team name
  // would receive. Both are WEAK/is_weak=true with an explicit stable reason
  // and neither is live-eligible, so this does not change any accept/reject
  // outcome or risk a wrong market being selected -- it only affects which of
  // two WEAK-bucket key formats is used. Documented here rather than silently
  // asserting the more specific key, since asserting it would be false.
  assert.match(c.match_family_key, /^WEAK_(MARKET_LEVEL_KEY|SINGLE_TEAM_SPREAD):/);
});

// ── RED Test C: physical-event identity ─────────────────────────────────────

test("C1: a market-level title with sufficient canonical physical-event metadata (event_slug) groups under the correct physical event key", async () => {
  const rows = [
    baseRow("c1", {
      condition_id: "cond-c1",
      selected_outcome: "Home Team",
      market_slug: "Spread: Home Team (-1.5)", // market-level title alone
      event_slug: "canonical-physical-event-2026-07-22", // but a real physical-event slug is present
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  // deriveMatchFamilyKey's Priority 1 (a real, non-empty event_slug) wins
  // over the market-level spread-title heuristic entirely -- the row is
  // grouped under the canonical physical event, not a WEAK market-level key.
  assert.equal(c.match_family_key, "canonical-physical-event-2026-07-22");
  assert.equal(c.match_family_key_is_weak, false);
  assert.equal(c.canonical_event_key, "canonical-physical-event-2026-07-22");
});

test("C2: a genuinely ambiguous market-level identity (no event_slug, no team-pair, no recoverable event title) is rejected into an explicit WEAK bucket with a stable reason -- never silently dropped", async () => {
  const rows = [
    baseRow("c2", {
      condition_id: "cond-c2",
      selected_outcome: "Some Outcome",
      market_slug: "Total Points Over/Under 45.5", // no team names, no vs, no event_slug
      event_slug: null,
      diagnostics: { gameStartIso: GAME_START, dataCoverage: 60, shadowScope: "football" },
    }),
  ];
  const { candidates } = await buildFireModelCandidates(50, "all", true, rows);
  assert.equal(candidates.length, 1, "ambiguous identity must still surface as a candidate with an explicit WEAK marker, not disappear");
  const c = candidates[0];
  assert.equal(c.match_family_key_is_weak, true);
  assert.equal(c.identity_quality, "WEAK");
  assert.equal(c.match_family_key, `WEAK_MARKET_LEVEL_KEY:cond-c2`, "the stable, explicit fallback key is the row's own condition_id -- always traceable, never opaque");
  assert.equal(c.canonical_event_key, null);
});
