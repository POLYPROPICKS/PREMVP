import { test } from "node:test";
import assert from "node:assert/strict";

import { researchMarketTimingDecision } from "../../lib/feed/discoverSportsMarkets";

const NOW = Date.parse("2026-08-11T12:00:00.000Z");

function structuredTiming(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    closed: false,
    nowMs: NOW,
    eventStartIso: "2026-08-11T16:00:00.000Z",
    marketEndIso: "2026-08-11",
    providerEventId: "773391",
    providerEventStartIso: "2026-08-11T16:00:00.000Z",
    title: "display text has no timing authority",
    question: "display question has no timing authority",
    slug: "display-slug-has-no-timing-authority",
    ...overrides,
  };
}

test("structured same-day soccer stays eligible when date-only market end parses before kickoff", () => {
  assert.deepEqual(researchMarketTimingDecision(structuredTiming()), {
    eligible: true,
    reason: "STRUCTURED_EVENT_START_ELIGIBLE",
  });
});

test("structured tennis stays eligible when tournament market end exceeds the research horizon", () => {
  assert.deepEqual(researchMarketTimingDecision(structuredTiming({
    providerEventId: "828488",
    eventStartIso: "2026-08-11T13:30:00.000Z",
    providerEventStartIso: "2026-08-11T13:30:00.000Z",
    marketEndIso: "2026-08-18",
  })), {
    eligible: true,
    reason: "STRUCTURED_EVENT_START_ELIGIBLE",
  });
});

test("authoritative event start remains fail-closed for past and outside-horizon occurrences", () => {
  assert.equal(researchMarketTimingDecision(structuredTiming({
    eventStartIso: "2026-08-11T11:59:59.999Z",
    providerEventStartIso: "2026-08-11T11:59:59.999Z",
  })).reason, "EVENT_START_OUTSIDE_RESEARCH_HORIZON");
  assert.equal(researchMarketTimingDecision(structuredTiming({
    eventStartIso: "2026-08-12T12:00:00.000Z",
    providerEventStartIso: "2026-08-12T12:00:00.000Z",
  })).reason, "EVENT_START_OUTSIDE_RESEARCH_HORIZON");
});

test("inactive and closed structured markets remain rejected", () => {
  assert.equal(researchMarketTimingDecision(structuredTiming({ active: false })).reason, "MARKET_INACTIVE_OR_CLOSED");
  assert.equal(researchMarketTimingDecision(structuredTiming({ closed: true })).reason, "MARKET_INACTIVE_OR_CLOSED");
});

test("display title, question, and slug cannot change timing eligibility", () => {
  const baseline = researchMarketTimingDecision(structuredTiming());
  const changed = researchMarketTimingDecision(structuredTiming({
    title: "completely different title",
    question: "completely different question",
    slug: "completely-different-slug",
  }));
  assert.deepEqual(changed, baseline);
});

test("non-structured fallback rows retain the existing market-end fail-closed checks", () => {
  assert.equal(researchMarketTimingDecision(structuredTiming({
    providerEventId: null,
    providerEventStartIso: null,
  })).reason, "MARKET_END_BEFORE_EVENT_START_OR_INVALID");
  assert.equal(researchMarketTimingDecision(structuredTiming({
    providerEventId: null,
    providerEventStartIso: null,
    marketEndIso: "2026-08-18",
  })).reason, "MARKET_END_AFTER_RESEARCH_HORIZON");
});
