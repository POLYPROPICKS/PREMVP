// SPORTS UNIVERSE SOURCE-COVERAGE FUNNEL — pure analyzer contract.
//   npx tsx --test tests/contur3/sourceCoverageFunnel.test.ts
//
// Baseline this report exists to quantify (production planning preview,
// 2026-07-30, night-plan shaped run):
//
//   source_rows                   = 2408
//   market_policy_eligible_rows   =  111   (4.6%)
//   physical_event_groups         =   27   (26 esports + 1 orphan MLB spread)
//   fullmatch_anchor_candidates   =    0
//   reservations_proposed         =    0
//
// The inspect-only trace proved the dominant loss is a SURFACE-SELECTION bug,
// not a policy decision. buildIdentityText() (lib/executor/buildFireModelCandidates.ts
// :352-391) prefers providerEventContext.eventTitle over .marketQuestion, so a
// fail-closed MARKET-class taxonomy is applied to EVENT-title text that by
// construction carries no market vocabulary:
//
//   eventTitle     "Rangers vs Rays"            -> unknown                     (DROP)
//   marketQuestion "Moneyline: Rangers vs Rays"  -> allowed_fullmatch_moneyline (ALLOW)
//
// This analyzer MEASURES that delta. It does not fix it. The production
// classifier (classifyMarketText / resolveMarketAnchorDecision) and the
// production sport normalizer (normalizeSport) are CALLED, never reimplemented,
// so the report can never disagree with the pipeline it audits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeSourceCoverage,
  type CoverageSourceRow,
  type CoverageTarget,
} from "../../lib/contur3/sourceCoverageFunnel";

const NOW = "2026-07-30T18:45:00.000Z";

/** Build a production-shaped source row with sane defaults. */
function row(overrides: Partial<CoverageSourceRow> & { row_id: string }): CoverageSourceRow {
  return {
    provider_event_id: null,
    provider_event_slug: null,
    provider_market_id: null,
    provider_market_question: null,
    provider_event_title: null,
    event_start_iso: "2026-07-30T23:00:00.000Z",
    observed_at_iso: "2026-07-30T18:00:00.000Z",
    league_or_sport_hint: null,
    market_slug: null,
    event_slug: null,
    ...overrides,
  };
}

/** A fully identity-complete fixture row for sport `hint`. */
function fixture(
  id: string,
  hint: string,
  eventTitle: string,
  marketQuestion: string,
  extra: Partial<CoverageSourceRow> = {}
): CoverageSourceRow {
  return row({
    row_id: id,
    provider_event_id: `evt-${id}`,
    provider_event_slug: `slug-${id}`,
    provider_market_id: `mkt-${id}`,
    provider_event_title: eventTitle,
    provider_market_question: marketQuestion,
    league_or_sport_hint: hint,
    ...extra,
  });
}

function analyze(rows: CoverageSourceRow[], targets: CoverageTarget[] = []) {
  return analyzeSourceCoverage({
    rows,
    nowIso: NOW,
    freshnessHours: 72,
    horizonHours: 48,
    targets,
  });
}

type SportCoverage = ReturnType<typeof analyze>["coverage_by_sport"][number];
type RowAnalysis = ReturnType<typeof analyze>["rows"][number];

function sportOf(report: ReturnType<typeof analyze>, sport: string): SportCoverage {
  const found = report.coverage_by_sport.find((s) => s.normalized_sport === sport);
  if (!found) throw new Error(`expected coverage row for sport=${sport}`);
  return found;
}

/** Indexed access that fails loudly instead of yielding undefined. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected item at index ${index}`);
  return item;
}

function rowAt(report: ReturnType<typeof analyze>, index: number): RowAnalysis {
  return at(report.rows, index);
}

// ---------------------------------------------------------------------------
// 1. MLB moneyline — THE headline surface-selection loss.
// ---------------------------------------------------------------------------

test("MLB moneyline: eventTitle classifies unknown, marketQuestion recovers it", () => {
  const report = analyze([
    fixture("mlb1", "mlb", "Rangers vs Rays", "Moneyline: Rangers vs Rays"),
  ]);

  const r = rowAt(report, 0);
  assert.equal(r.event_title_market_class, "unknown");
  assert.equal(r.market_question_market_class, "allowed_fullmatch_moneyline");
  assert.equal(r.surface_recovery, true);
  assert.equal(r.current_surface_policy_eligible, false);
  assert.equal(r.market_question_policy_eligible, true);
  assert.equal(r.current_first_rejection_stage, "market_policy_eligible");
  assert.equal(r.current_first_rejection_code, "UNKNOWN_MARKET_CLASS");

  const baseball = sportOf(report, "baseball");
  assert.equal(baseball.current_surface_policy_eligible_count, 0);
  assert.equal(baseball.market_question_policy_eligible_count, 1);
  assert.equal(baseball.surface_recoverable_row_count, 1);
});

// ---------------------------------------------------------------------------
// 2. MLB spread + total equivalents.
// ---------------------------------------------------------------------------

test("MLB spread and total recover on the market-question surface", () => {
  const report = analyze([
    fixture("mlb2", "mlb", "Rangers vs Rays", "Spread: Rangers (-1.5)"),
    fixture("mlb3", "mlb", "Rangers vs Rays", "Total Runs: Over 8.5"),
  ]);

  assert.equal(rowAt(report, 0).market_question_market_class, "allowed_fullmatch_spread");
  assert.equal(rowAt(report, 1).market_question_market_class, "allowed_fullmatch_total");
  for (const r of report.rows) {
    assert.equal(r.event_title_market_class, "unknown");
    assert.equal(r.surface_recovery, true);
  }
  assert.equal(sportOf(report, "baseball").surface_recoverable_row_count, 2);
});

test("a self-describing spread title survives the current surface (the orphan Mets shape)", () => {
  // This is why the sole surviving MLB group was a one-sided spread with no
  // opponent: the word "Spread" is inside the title itself, so it passes the
  // gate its moneyline sibling fails.
  const report = analyze([
    fixture("mets", "mlb", "Spread: New York Mets (-2.5)", "Spread: New York Mets (-2.5)"),
  ]);
  const r = rowAt(report, 0);
  assert.equal(r.event_title_market_class, "allowed_fullmatch_spread");
  assert.equal(r.current_surface_policy_eligible, true);
  assert.equal(r.surface_recovery, false); // already eligible — nothing to recover
  assert.equal(r.current_first_rejection_stage, null);
});

// ---------------------------------------------------------------------------
// 3. Soccer bare fixture title + all three market questions.
// ---------------------------------------------------------------------------

test("soccer bare fixture title drops on all three market families and recovers on question", () => {
  const report = analyze([
    fixture("soc1", "soccer", "AFC Bournemouth vs FC Augsburg", "Moneyline: AFC Bournemouth"),
    fixture("soc2", "soccer", "AFC Bournemouth vs FC Augsburg", "Handicap: FC Augsburg (+0.5)"),
    fixture("soc3", "soccer", "AFC Bournemouth vs FC Augsburg", "Total Goals: Over 2.5"),
  ]);

  assert.deepEqual(
    report.rows.map((r) => r.market_question_market_class),
    ["allowed_fullmatch_moneyline", "allowed_fullmatch_spread", "allowed_fullmatch_total"]
  );
  assert.ok(report.rows.every((r) => r.event_title_market_class === "unknown"));
  assert.ok(report.rows.every((r) => r.surface_recovery === true));

  const soccer = sportOf(report, "soccer");
  assert.equal(soccer.source_row_count, 3);
  assert.equal(soccer.current_surface_policy_eligible_count, 0);
  assert.equal(soccer.market_question_policy_eligible_count, 3);
  assert.equal(soccer.first_zero_stage, "current_surface_policy_eligible_count");
});

// ---------------------------------------------------------------------------
// 4-8. Remaining sports the Founder observed.
// ---------------------------------------------------------------------------

test("tennis match-winner recovers on the market-question surface", () => {
  const report = analyze([
    fixture("ten1", "atp", "Bastian Malla vs Alvaro Frutos Alonso", "Match Winner: Bastian Malla"),
  ]);
  assert.equal(sportOf(report, "tennis").surface_recoverable_row_count, 1);
  assert.equal(rowAt(report, 0).market_question_market_class, "allowed_fullmatch_moneyline");
});

test("basketball moneyline, spread and total all recover", () => {
  const report = analyze([
    fixture("bas1", "wnba", "New York Liberty vs Las Vegas Aces", "Moneyline: New York Liberty"),
    fixture("bas2", "wnba", "Connecticut Sun vs Chicago Sky", "Spread: Chicago Sky (+6.5)"),
    fixture("bas3", "wnba", "Minnesota Lynx vs Toronto Tempo", "Total Points: Under 160.5"),
  ]);
  const basketball = sportOf(report, "basketball");
  assert.equal(basketball.source_row_count, 3);
  assert.equal(basketball.surface_recoverable_row_count, 3);
  assert.equal(basketball.fullmatch_candidate_count, 3);
});

test("cricket match-winner recovers", () => {
  const report = analyze([
    fixture("cri1", "cricket", "India vs Australia", "Match Winner: India"),
  ]);
  assert.equal(sportOf(report, "cricket").surface_recoverable_row_count, 1);
});

test("NFL football moneyline normalizes to american_football and recovers", () => {
  const report = analyze([
    fixture("nfl1", "nfl", "Chiefs vs Bills", "Moneyline: Chiefs"),
  ]);
  // NOTE: production normalizeSport() maps the bare token "football" to soccer
  // (association football), so american_football must be reached via a league
  // alias or the report would silently merge two different sports.
  assert.equal(sportOf(report, "american_football").surface_recoverable_row_count, 1);
});

test("CFL and pickleball fall to UNKNOWN — production normalizeSport has no alias", () => {
  // A SECOND, independent coverage gap, recorded honestly and NOT patched:
  // normalizeSport() is production (lib/liquidity/marketGates.ts) and a
  // forbidden file for this task. Even after the surface-selection fix, CFL and
  // pickleball rows would land in the UNKNOWN bucket rather than a first-class
  // sport. The report's job is to surface that, not to hide it behind a patch.
  const report = analyze([
    fixture("cfl1", "cfl", "British Columbia Lions vs Winnipeg Blue Bombers", "Moneyline: BC Lions"),
    fixture("pkl1", "pickleball", "Phoenix Flames vs Brooklyn Pickleball Team", "Match Winner: Phoenix Flames"),
  ]);
  const unknown = sportOf(report, "UNKNOWN");
  assert.equal(unknown.source_row_count, 2);
  assert.equal(unknown.surface_recoverable_row_count, 2);
  assert.equal(
    report.coverage_by_sport.length,
    1,
    "both must collapse into the single UNKNOWN bucket"
  );
});

// ---------------------------------------------------------------------------
// 9-10. Esports: clean full match allowed, per-map line stays partial.
// ---------------------------------------------------------------------------

test("clean esports full-match moneyline is a full-match candidate", () => {
  const report = analyze([
    fixture("esp1", "cs2", "Team Vitality vs KC", "Moneyline: Team Vitality"),
  ]);
  const r = rowAt(report, 0);
  assert.equal(r.market_question_policy_eligible, true);
  assert.equal(r.event_scope, "full_match");
  assert.equal(sportOf(report, "esports").fullmatch_candidate_count, 1);
});

test("esports 'Map 1 Total Rounds' stays PARTIAL on both surfaces", () => {
  const report = analyze([
    fixture("esp2", "cs2", "Team Vitality vs KC", "Map 1 Total Rounds: Over 21.5"),
  ]);
  const r = rowAt(report, 0);
  assert.equal(r.event_scope, "map_or_round");
  assert.equal(r.market_question_policy_eligible, false);
  assert.equal(r.market_question_rejection_code, "PARTIAL_EVENT_SCOPE");
  assert.equal(r.surface_recovery, false, "a partial-scope line must never be 'recovered'");

  const esports = sportOf(report, "esports");
  assert.equal(esports.partial_candidate_count, 1);
  assert.equal(esports.fullmatch_candidate_count, 0);
});

// ---------------------------------------------------------------------------
// 11-12. Identity and horizon gates.
// ---------------------------------------------------------------------------

test("missing provider event id or start time is identity-incomplete and NOT_PROVEN", () => {
  const report = analyze([
    row({
      row_id: "noid",
      provider_event_title: "Cubs vs Cardinals",
      provider_market_question: "Moneyline: Cubs",
      provider_market_id: "mkt-noid",
      league_or_sport_hint: "mlb",
      provider_event_id: null,
      provider_event_slug: null,
    }),
    row({
      row_id: "nostart",
      provider_event_id: "evt-nostart",
      provider_market_id: "mkt-nostart",
      provider_event_title: "Cubs vs Cardinals",
      provider_market_question: "Moneyline: Cubs",
      league_or_sport_hint: "mlb",
      event_start_iso: null,
    }),
  ]);

  assert.ok(report.rows.every((r) => r.event_identity_complete === false));
  assert.ok(report.rows.every((r) => r.identity_verdict === "NOT_PROVEN"));
  assert.equal(rowAt(report, 0).current_first_rejection_stage, "identity_complete");

  const baseball = sportOf(report, "baseball");
  assert.equal(baseball.source_row_count, 2);
  assert.equal(baseball.identity_complete_row_count, 0);
  assert.equal(baseball.first_zero_stage, "identity_complete_row_count");
});

test("an event starting beyond the horizon is excluded at the horizon stage", () => {
  const report = analyze([
    fixture("far", "mlb", "Royals vs Twins", "Moneyline: Royals", {
      event_start_iso: "2026-08-30T23:00:00.000Z", // ~31 days out, horizon is 48h
    }),
  ]);
  const r = rowAt(report, 0);
  assert.equal(r.inside_horizon, false);
  assert.equal(r.current_first_rejection_stage, "inside_horizon");
  assert.equal(r.current_first_rejection_code, "OUTSIDE_PLANNING_HORIZON");
  assert.equal(sportOf(report, "baseball").inside_horizon_event_count, 0);
});

test("a row observed before the freshness window is excluded at the freshness stage", () => {
  const report = analyze([
    fixture("stale", "mlb", "Yankees vs White Sox", "Moneyline: Yankees", {
      observed_at_iso: "2026-07-20T18:00:00.000Z", // 10 days back, window is 72h
    }),
  ]);
  assert.equal(rowAt(report, 0).fresh, false);
  assert.equal(rowAt(report, 0).current_first_rejection_stage, "fresh_rows");
  assert.equal(sportOf(report, "baseball").fresh_row_count, 0);
});

// ---------------------------------------------------------------------------
// 13. Dedup by PERSISTED PROVIDER IDENTITY ONLY.
// ---------------------------------------------------------------------------

test("distinct provider events dedupe on provider identity, never on title text", () => {
  const report = analyze([
    fixture("d1", "mlb", "Rangers vs Rays", "Moneyline: Rangers"),
    // Same provider event, different market -> ONE distinct provider event.
    row({
      row_id: "d2",
      provider_event_id: "evt-d1",
      provider_event_slug: "slug-d1",
      provider_market_id: "mkt-d2",
      provider_event_title: "Rangers vs Rays",
      provider_market_question: "Spread: Rangers (-1.5)",
      league_or_sport_hint: "mlb",
    }),
    // Identical title, DIFFERENT provider event -> a second distinct event.
    // Title text must never collapse these.
    row({
      row_id: "d3",
      provider_event_id: "evt-other",
      provider_event_slug: "slug-other",
      provider_market_id: "mkt-d3",
      provider_event_title: "Rangers vs Rays",
      provider_market_question: "Moneyline: Rangers",
      league_or_sport_hint: "mlb",
    }),
  ]);

  const baseball = sportOf(report, "baseball");
  assert.equal(baseball.source_row_count, 3);
  assert.equal(baseball.distinct_provider_event_count, 2);
});

test("rows without persisted provider identity are never deduplicated together", () => {
  const report = analyze([
    row({
      row_id: "u1",
      provider_event_title: "Cubs vs Cardinals",
      provider_market_question: "Moneyline: Cubs",
      league_or_sport_hint: "mlb",
    }),
    row({
      row_id: "u2",
      provider_event_title: "Cubs vs Cardinals",
      provider_market_question: "Moneyline: Cubs",
      league_or_sport_hint: "mlb",
    }),
  ]);
  // Identical text, no provider ids: we cannot PROVE they are the same event.
  assert.equal(sportOf(report, "baseball").distinct_provider_event_count, 0);
  assert.equal(sportOf(report, "baseball").source_row_count, 2);
});

// ---------------------------------------------------------------------------
// 14. Per-sport aggregation + overall funnel.
// ---------------------------------------------------------------------------

test("per-sport counts aggregate independently and roll into the overall funnel", () => {
  const report = analyze([
    fixture("a1", "mlb", "Rangers vs Rays", "Moneyline: Rangers"),
    fixture("a2", "mlb", "Cubs vs Cardinals", "Moneyline: Cubs"),
    fixture("a3", "soccer", "Tobyl FK vs FK Panevezys", "Moneyline: Tobyl FK"),
    fixture("a4", "cs2", "Team Vitality vs KC", "Map 1 Total Rounds: Over 21.5"),
  ]);

  assert.equal(sportOf(report, "baseball").source_row_count, 2);
  assert.equal(sportOf(report, "soccer").source_row_count, 1);
  assert.equal(sportOf(report, "esports").source_row_count, 1);

  assert.equal(report.overall_funnel.source_row_count, 4);
  assert.equal(report.overall_funnel.current_surface_policy_eligible_count, 0);
  assert.equal(report.overall_funnel.market_question_policy_eligible_count, 3);
  assert.equal(report.surface_selection_loss.surface_recoverable_row_count, 3);
  assert.equal(report.largest_loss_stage, "current_surface_policy_eligible_count");
});

test("surface_selection_loss reports the measured recovery ratio", () => {
  const report = analyze([
    fixture("s1", "mlb", "Rangers vs Rays", "Moneyline: Rangers"),
    fixture("s2", "mlb", "Spread: New York Mets (-2.5)", "Spread: New York Mets (-2.5)"),
  ]);
  const loss = report.surface_selection_loss;
  assert.equal(loss.current_surface_policy_eligible_count, 1);
  assert.equal(loss.market_question_policy_eligible_count, 2);
  assert.equal(loss.surface_recoverable_row_count, 1);
  assert.equal(loss.recovery_multiple, 2); // 2x eligible rows on the correct surface
});

// ---------------------------------------------------------------------------
// 15. Determinism.
// ---------------------------------------------------------------------------

test("output ordering is deterministic and input-order independent", () => {
  const rows = [
    fixture("z", "cs2", "Team Vitality vs KC", "Moneyline: Team Vitality"),
    fixture("a", "mlb", "Rangers vs Rays", "Moneyline: Rangers"),
    fixture("m", "soccer", "Tobyl FK vs FK Panevezys", "Moneyline: Tobyl FK"),
  ];
  const forward = analyze(rows);
  const reversed = analyze([...rows].reverse());

  assert.deepEqual(
    forward.coverage_by_sport.map((s) => s.normalized_sport),
    ["baseball", "esports", "soccer"]
  );
  assert.deepEqual(
    forward.coverage_by_sport.map((s) => s.normalized_sport),
    reversed.coverage_by_sport.map((s) => s.normalized_sport)
  );
  assert.deepEqual(forward.overall_funnel, reversed.overall_funnel);
});

// ---------------------------------------------------------------------------
// Target-event matrix.
// ---------------------------------------------------------------------------

test("target discovery locates rows by title but proves identity by provider id", () => {
  const targets: CoverageTarget[] = [
    { target_label: "Rangers vs Rays", match_tokens: ["rangers", "rays"] },
    { target_label: "Royals vs Twins", match_tokens: ["royals", "twins"] },
  ];
  const report = analyze(
    [fixture("t1", "mlb", "Rangers vs Rays", "Moneyline: Rangers")],
    targets
  );

  const rangers = at(report.target_event_matrix, 0);
  const royals = at(report.target_event_matrix, 1);
  assert.equal(rangers.target_label, "Rangers vs Rays");
  assert.equal(rangers.found_by_discovery, true);
  assert.deepEqual(rangers.provider_event_ids, ["evt-t1"]);
  assert.deepEqual(rangers.provider_market_ids, ["mkt-t1"]);
  assert.equal(rangers.identity_verdict, "PROVEN");
  assert.equal(rangers.normalized_sport, "baseball");
  assert.equal(rangers.event_title_market_class, "unknown");
  assert.deepEqual(rangers.market_question_market_classes, ["allowed_fullmatch_moneyline"]);
  assert.equal(rangers.surface_recovery_possible, true);
  assert.equal(rangers.source_row_count, 1);
  assert.equal(rangers.latest_observed_at, "2026-07-30T18:00:00.000Z");

  // Absent from source storage — must NOT be claimed absent from Polymarket.
  assert.equal(royals.found_by_discovery, false);
  assert.equal(royals.identity_verdict, "NOT_PROVEN");
  assert.deepEqual(royals.provider_event_ids, []);
  assert.equal(royals.source_row_count, 0);
});

test("target matrix keeps declared target order regardless of row order", () => {
  const targets: CoverageTarget[] = [
    { target_label: "B target", match_tokens: ["bbb"] },
    { target_label: "A target", match_tokens: ["aaa"] },
  ];
  const report = analyze(
    [
      fixture("r2", "mlb", "aaa vs zzz", "Moneyline: aaa"),
      fixture("r1", "mlb", "bbb vs yyy", "Moneyline: bbb"),
    ],
    targets
  );
  assert.deepEqual(
    report.target_event_matrix.map((t) => t.target_label),
    ["B target", "A target"]
  );
});

// ---------------------------------------------------------------------------
// Analyzer purity.
// ---------------------------------------------------------------------------

test("analyzer is pure: identical input yields byte-identical JSON", () => {
  const rows = [fixture("p1", "mlb", "Rangers vs Rays", "Moneyline: Rangers")];
  const a = JSON.stringify(analyze(rows));
  const b = JSON.stringify(analyze(rows));
  assert.equal(a, b);
});

test("empty input produces a well-formed zero report, not a crash", () => {
  const report = analyze([]);
  assert.equal(report.overall_funnel.source_row_count, 0);
  assert.deepEqual(report.coverage_by_sport, []);
  assert.equal(report.largest_loss_stage, null);
  assert.equal(report.surface_selection_loss.recovery_multiple, null);
});

// ---------------------------------------------------------------------------
// CLI ENV BOOTSTRAP — regression guard.
//
// The coverage CLI reads production Supabase through lib/supabase/server.ts,
// which throws at MODULE EVALUATION time when SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are absent from process.env. A repo .env.local is
// NOT loaded automatically by `npx tsx`, so a Founder with valid local
// credentials still got:
//
//   Missing required environment variable: SUPABASE_URL
//   DB_AVAILABLE=false
//
// Fix (the pattern already proven by the LC6 reporter,
// 450f089:scripts/report-live-contour6-runtime.ts:23/167/194): call
// loadEnvConfig(process.cwd()) BEFORE dynamically importing the Supabase helper.
//
// These assertions read the CLI SOURCE rather than executing it, because the
// property under test is import ORDER — a runtime test would need real
// credentials, which this suite must never require.
// ---------------------------------------------------------------------------

const CLI_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/contur3/source-coverage-funnel.ts"),
  "utf8"
);

test("CLI imports loadEnvConfig from @next/env", () => {
  assert.match(
    CLI_SOURCE,
    /import\s*\{\s*loadEnvConfig\s*\}\s*from\s*["']@next\/env["']/,
    "CLI must use the proven @next/env bootstrap, not a hand-rolled dotenv parser"
  );
});

test("loadEnvConfig(process.cwd()) runs BEFORE the Supabase dynamic import", () => {
  const bootstrapIndex = CLI_SOURCE.indexOf("loadEnvConfig(process.cwd())");
  const supabaseImportIndex = CLI_SOURCE.indexOf('await import("../../lib/supabase/server")');

  assert.ok(bootstrapIndex !== -1, "CLI must call loadEnvConfig(process.cwd())");
  assert.ok(supabaseImportIndex !== -1, "CLI must dynamically import lib/supabase/server");
  assert.ok(
    bootstrapIndex < supabaseImportIndex,
    "env must be loaded before lib/supabase/server.ts is evaluated, or the helper throws on missing SUPABASE_URL"
  );
});

test("the Supabase helper stays DYNAMICALLY imported (never at module scope)", () => {
  // A static import would evaluate the helper before loadEnvConfig could run,
  // reintroducing the exact failure this patch fixes.
  assert.doesNotMatch(
    CLI_SOURCE,
    /^\s*import\s+[^;]*from\s*["'][^"']*lib\/supabase\/server["']/m,
    "lib/supabase/server must never be statically imported by this CLI"
  );
  assert.match(CLI_SOURCE, /await import\("\.\.\/\.\.\/lib\/supabase\/server"\)/);
});

test("no new env names and no fallback secrets are introduced", () => {
  const envNames = [...CLI_SOURCE.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(envNames)].sort(),
    [],
    "the CLI must read no environment variable directly — lib/supabase/server owns that"
  );
  // No inline credential fallbacks of any shape.
  assert.doesNotMatch(CLI_SOURCE, /SUPABASE_SERVICE_ROLE_KEY\s*(\|\||\?\?|=)/);
  assert.doesNotMatch(CLI_SOURCE, /SUPABASE_URL\s*(\|\||\?\?|=)/);
});

test("env bootstrap adds no mutation or write path", () => {
  assert.doesNotMatch(
    CLI_SOURCE,
    /\.(insert|update|delete|upsert|rpc)\(|writeFileSync|appendFileSync|mkdirSync/,
    "the coverage CLI must remain strictly read-only"
  );
  // .env.local is loaded by @next/env, never read or echoed by this script.
  assert.doesNotMatch(CLI_SOURCE, /readFileSync\([^)]*\.env/);
});

test("fail-closed reporting contract is preserved", () => {
  assert.match(CLI_SOURCE, /"DB_AVAILABLE": false|DB_AVAILABLE: false/);
  assert.match(CLI_SOURCE, /STOP_PRODUCTION_READ_UNAVAILABLE/);
});
