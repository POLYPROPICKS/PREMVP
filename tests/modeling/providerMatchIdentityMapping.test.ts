import test from "node:test";
import assert from "node:assert/strict";
import { canonicalProviderEventKeyFromEvent } from "../../lib/feed/buildLandingCards";

test("several markets from one provider event receive the same canonical key", () => {
  const providerEvent = { id: "gamma-event-123", markets: [{ slug: "winner" }, { slug: "totals" }] };
  assert.equal(canonicalProviderEventKeyFromEvent(providerEvent), "gamma-event-123");
  assert.equal(canonicalProviderEventKeyFromEvent(providerEvent), "gamma-event-123");
});

test("different provider events receive different canonical keys", () => {
  assert.notEqual(canonicalProviderEventKeyFromEvent({ id: "gamma-event-123" }), canonicalProviderEventKeyFromEvent({ id: "gamma-event-456" }));
});

test("market slug differences do not change the provider event key", () => {
  assert.equal(canonicalProviderEventKeyFromEvent({ id: "gamma-event-123", marketSlug: "winner" }), canonicalProviderEventKeyFromEvent({ id: "gamma-event-123", marketSlug: "spread" }));
});

test("missing provider event id remains fail-closed", () => {
  assert.equal(canonicalProviderEventKeyFromEvent({ marketSlug: "winner" }), null);
  assert.equal(canonicalProviderEventKeyFromEvent({ id: "   ", conditionId: "condition-fallback-forbidden" }), null);
});
