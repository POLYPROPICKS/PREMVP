import test from "node:test";
import assert from "node:assert/strict";

import {
  FIXTURES,
  norm,
  matchesFixture,
  mismatchWarning,
  marketClass,
  admissionVerdict,
} from "../reservation-capacity-audit.tier-probe";

test("fixture matching does not map 'Paraguay vs Australia' to an 'Australia vs Egypt' row", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  const australiaVsEgyptText = norm("australia-vs-egypt-moneyline");
  assert.equal(
    matchesFixture(australiaVsEgyptText, paraguayVsAustralia),
    false,
    "a row containing only 'australia' (not 'paraguay') must not match the Paraguay vs Australia fixture",
  );
});

test("probe fixture list includes all corrected-log fixtures", () => {
  const ids = FIXTURES.map((f) => f.id);
  const expected = [
    "Paraguay vs Australia",
    "Argentina vs Cabo Verde - More Markets",
    "Türkiye vs United States",
    "Colombia vs Ghana - More Markets",
    "Egypt — Match Winner",
    "Switzerland — Match Winner",
    "Portugal — Match Winner",
    "Spain — Match Winner",
  ];
  for (const id of expected) {
    assert.ok(ids.includes(id), `expected fixture list to include "${id}"`);
  }
});

test("Layer B fixture matching finds rows for a title/slug containing 'Paraguay vs Australia' (no false raw=0)", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  const rows = [
    { event_slug: "paraguay-vs-australia", market_slug: "paraguay-vs-australia-moneyline", selected_outcome: "Paraguay" },
    { event_slug: "australia-vs-egypt", market_slug: "australia-vs-egypt-moneyline", selected_outcome: "Australia" },
  ];
  const matched = rows.filter((r) => {
    const tn = norm(`${r.event_slug ?? ""} ${r.market_slug ?? ""} ${r.selected_outcome ?? ""}`);
    return matchesFixture(tn, paraguayVsAustralia);
  });
  assert.equal(matched.length, 1, "exactly the true Paraguay vs Australia row must match");
  assert.equal(matched[0].event_slug, "paraguay-vs-australia");
});

test("single-team 'Match Winner' fixtures require both the team and the market hint", () => {
  const egyptMatchWinner = FIXTURES.find((f) => f.id === "Egypt — Match Winner")!;
  assert.equal(matchesFixture(norm("egypt-match-winner"), egyptMatchWinner), true);
  assert.equal(
    matchesFixture(norm("egypt-corners-total"), egyptMatchWinner),
    false,
    "team present but no 'match winner' market hint must not match",
  );
  assert.equal(
    matchesFixture(norm("morocco-match-winner"), egyptMatchWinner),
    false,
    "market hint present but wrong team must not match",
  );
});

test("mismatch_warning is false for a correctly matched row and true for a mismatched one (visible matched identity)", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  assert.equal(mismatchWarning(norm("paraguay-vs-australia-moneyline"), paraguayVsAustralia), false);
  assert.equal(mismatchWarning(norm("australia-vs-egypt-moneyline"), paraguayVsAustralia), true);
});

test("marketClass and admissionVerdict are unchanged pass-through helpers (regression guard)", () => {
  assert.equal(marketClass("Paraguay vs Australia Moneyline"), "ALLOWED_FULLMATCH");
  assert.equal(marketClass("Paraguay vs Australia Corners Total"), "BLOCKED");
  assert.equal(
    admissionVerdict({ diagnostics: { dataCoverage: 10 }, signal_confidence_num: 90 }),
    "LOW_COVERAGE",
  );
});
