// Contur3 canonical taxonomy corpus test (node:test, run via tsx like other suites):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Locks three things:
//  1. classifyMarketText matches the corpus expectation for every case.
//  2. Fail-closed helper semantics (forbidden wins; unknown/esports never live-allowed).
//  3. Monitor parity audit: the legacy classifyMarket in
//     scripts/contur3/lib/contur3LiveFunnelMonitor.mjs must agree with canonical
//     on every corpus case EXCEPT the explicitly documented legacy divergences
//     (boundary-after-strip \bdraw\b/\bou\b and `under` substring overmatch).
//     Any NEW undocumented divergence fails this suite.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyMarketText,
  isAllowedFullMatchMarketClass,
  isForbiddenMarketClass,
  isLiveAllowedFullMatch,
  normalizeMarketText,
  resolveMarketAnchorDecision,
} from "../../lib/contur3/taxonomy";
import { TAXONOMY_CORPUS } from "./fixtures/market-taxonomy-corpus";
// Legacy monitor classifier (parity audit only — monitor stays the .mjs runtime copy
// until it can safely import the canonical TS module).
import {
  classifyMarket as monitorClassifyMarket,
  norm as monitorNorm,
} from "../../scripts/contur3/lib/contur3LiveFunnelMonitor.mjs";

test("corpus: canonical classifyMarketText matches expected class for every case", () => {
  for (const c of TAXONOMY_CORPUS) {
    assert.equal(
      classifyMarketText(c.text),
      c.expected,
      `text=${JSON.stringify(c.text)}${c.note ? ` (${c.note})` : ""}`,
    );
  }
});

test("invariant: halftime total is forbidden (forbidden wins over allowed)", () => {
  assert.equal(classifyMarketText("Halftime total"), "forbidden_halftime");
  assert.equal(isLiveAllowedFullMatch("Halftime total"), false);
});

test("invariant: unknown market is fail-closed (never live-allowed)", () => {
  assert.equal(classifyMarketText("Weather in Doha"), "unknown");
  assert.equal(isLiveAllowedFullMatch("Weather in Doha"), false);
  assert.equal(isLiveAllowedFullMatch(""), false);
  assert.equal(isLiveAllowedFullMatch(null), false);
  assert.equal(isLiveAllowedFullMatch(undefined), false);
});

test("invariant: tennis Completed Match is not promoted by Main Draw", () => {
  const decision = resolveMarketAnchorDecision({
    providerMarketQuestion:
      "W35 Reus, Main Draw: Completed Match: Lucia Cortez Llorca vs Daria Yesypchuk",
    marketTitle: null,
    eventTitle: null,
    marketSlug: null,
    eventSlug: null,
    matchFamilyKey: null,
  });
  assert.deepEqual(decision, {
    market_class: "unknown",
    event_scope: "full_match",
    allowed: false,
    reason_code: "UNKNOWN_MARKET_CLASS",
    evidence_source: "structured",
  });
});

test("invariant: esports is an explicit non-policy class, not unknown, and not live-allowed", () => {
  assert.equal(classifyMarketText("CS2 major winner"), "esports_non_policy");
  assert.equal(isLiveAllowedFullMatch("CS2 major winner"), false);
});

test("helpers: class predicates are consistent and mutually exclusive", () => {
  for (const c of TAXONOMY_CORPUS) {
    const cls = classifyMarketText(c.text);
    const allowed = isAllowedFullMatchMarketClass(cls);
    const forbidden = isForbiddenMarketClass(cls);
    assert.equal(allowed && forbidden, false, `class ${cls} cannot be both`);
    assert.equal(
      isLiveAllowedFullMatch(c.text),
      allowed,
      `isLiveAllowedFullMatch must equal allowed-class predicate for ${JSON.stringify(c.text)}`,
    );
  }
});

test("normalizeMarketText: deterministic, diacritic-free, token-joined", () => {
  assert.equal(normalizeMarketText("Curaçao  vs Côte d’Ivoire!"), "curacao vs cote d ivoire");
  assert.equal(normalizeMarketText("  HALF-TIME  Result "), "half time result");
  assert.equal(normalizeMarketText(null), "");
});

test("monitor parity audit: legacy monitor agrees with canonical except documented divergences", () => {
  const undocumented: string[] = [];
  const confirmedDivergences: string[] = [];
  for (const c of TAXONOMY_CORPUS) {
    const legacy = monitorClassifyMarket(monitorNorm(c.text));
    if (legacy === c.expected) {
      assert.equal(
        c.monitorDivergence,
        undefined,
        `case ${JSON.stringify(c.text)} is documented as divergent but monitor agrees — remove stale divergence marker`,
      );
      continue;
    }
    if (c.monitorDivergence !== undefined) {
      assert.equal(
        legacy,
        c.monitorDivergence,
        `case ${JSON.stringify(c.text)}: documented legacy class drifted (expected legacy=${c.monitorDivergence}, got ${legacy})`,
      );
      confirmedDivergences.push(`${JSON.stringify(c.text)}: canonical=${c.expected} legacy=${legacy}`);
      continue;
    }
    undocumented.push(`${JSON.stringify(c.text)}: canonical=${c.expected} legacy=${legacy}`);
  }
  // Corpus-diff evidence for the PR report.
  console.log(`monitor-parity: documented legacy divergences = ${confirmedDivergences.length}`);
  for (const d of confirmedDivergences) console.log(`  DIVERGENCE(documented): ${d}`);
  assert.deepEqual(undocumented, [], "undocumented monitor/canonical divergences found");
});

// ---------------------------------------------------------------------------
// P1B_1 — structured provider type `total_corners` is the ONLY corners exception.
// ---------------------------------------------------------------------------
import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";

test("structured total_corners yields a distinct allowed full-match class", () => {
  const d = resolveMarketAnchorDecision({
    providerMarketQuestion: "total_corners",
    marketTitle: "Total Corners O/U 9.5",
    structuredMarketType: "total_corners",
  });
  assert.equal(d.allowed, true);
  assert.equal(d.market_class, "allowed_fullmatch_total_corners");
  assert.notEqual(d.market_class, "allowed_fullmatch_total");
  assert.equal(d.event_scope, "full_match");
  assert.equal(isAllowedFullMatchMarketClass(d.market_class), true);
});

test("generic/text corner wording stays forbidden without the structured type", () => {
  for (const text of [
    "Total Corners O/U 9.5",
    "corners",
    "First Half Total Corners",
    "Team Total Corners",
    "First Corner",
    "Last Corner",
    "Corner Handicap",
    "liverpool-vs-man-city-total-corners",
  ]) {
    assert.equal(isForbiddenMarketClass(classifyMarketText(text)), true, text);
    const d = resolveMarketAnchorDecision({ providerMarketQuestion: text });
    assert.equal(d.allowed, false, text);
    assert.equal(isLiveAllowedFullMatch(text), false, text);
  }
  // A slug/title alone can never earn the class, and other structured types do not either.
  for (const t of ["corners", "first_half_total_corners", "second_half_total_corners", "team_total_corners",
    "first_corner", "last_corner", "corner_handicap", "totals", null]) {
    const d = resolveMarketAnchorDecision({ providerMarketQuestion: "Total Corners O/U 9.5", structuredMarketType: t });
    assert.equal(d.allowed, false, String(t));
  }
});

test("structured total_corners: partial scope and derivatives still win", () => {
  for (const title of [
    "First Half Total Corners O/U 4.5",
    "2nd Half Total Corners",
    "Team Total Corners Over 4.5",
    "First Corner",
    "Last Corner",
    "Corner Handicap -1.5",
    "Anytime goalscorer corners",
  ]) {
    const d = resolveMarketAnchorDecision({ marketTitle: title, structuredMarketType: "total_corners" });
    assert.equal(d.allowed, false, title);
  }
});

test("existing moneyline/spread/total classes are unchanged", () => {
  assert.equal(classifyMarketText("Moneyline"), "allowed_fullmatch_moneyline");
  assert.equal(classifyMarketText("Spread -1.5"), "allowed_fullmatch_spread");
  assert.equal(classifyMarketText("Total Goals O/U 2.5"), "allowed_fullmatch_total");
  assert.equal(
    resolveMarketAnchorDecision({ providerMarketQuestion: "Total Goals O/U 2.5", structuredMarketType: "totals" }).market_class,
    "allowed_fullmatch_total",
  );
});
