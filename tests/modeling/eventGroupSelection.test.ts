import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_GROUP_KEY_FIELD_PRIORITY,
  buildEventGroupKey,
  groupRowsByEventGroup,
  selectFirstPerEventGroup,
} from "../../lib/modeling/eventGroupSelection";

test("EVENT_GROUP_KEY_FIELD_PRIORITY matches the Phase 3D.1 line-verified fallback chain", () => {
  assert.deepEqual(EVENT_GROUP_KEY_FIELD_PRIORITY, [
    "match_family_key",
    "canonical_event_key",
    "parent_event_key",
    "event_slug",
    "event_title",
    "market_slug",
    "condition_id",
  ]);
});

test("buildEventGroupKey uses match_family_key before all lower-priority fields", () => {
  const result = buildEventGroupKey({
    match_family_key: "Lakers-vs-Celtics",
    canonical_event_key: "canonical-1",
    event_slug: "slug-1",
    condition_id: "cond-1",
  });

  assert.equal(result.source, "match_family_key");
  assert.equal(result.key, "match:lakers-vs-celtics");
});

test("buildEventGroupKey falls back to canonical_event_key when match_family_key is absent", () => {
  const result = buildEventGroupKey({
    canonical_event_key: "Canonical Event 1",
    event_slug: "slug-1",
    condition_id: "cond-1",
  });

  assert.equal(result.source, "canonical_event_key");
  assert.equal(result.key, "canonical:canonical-event-1");
});

test("buildEventGroupKey falls back to canonical_event_key when match_family_key is a weak key", () => {
  const result = buildEventGroupKey({
    match_family_key: "weak_abc123",
    canonical_event_key: "canonical-2",
  });

  assert.equal(result.source, "canonical_event_key");
});

test("buildEventGroupKey falls back through parent_event_key, event_slug, event_title, market_slug to condition_id", () => {
  const conditionOnly = buildEventGroupKey({ condition_id: "0xabc" });
  assert.equal(conditionOnly.source, "condition_fallback");
  assert.equal(conditionOnly.key, "condition:0xabc");

  const parentOnly = buildEventGroupKey({ parent_event_key: "Parent Event", condition_id: "0xabc" });
  assert.equal(parentOnly.source, "parent_event_key");

  const slugOnly = buildEventGroupKey({ event_slug: "event-slug-1", condition_id: "0xabc" });
  assert.equal(slugOnly.source, "event_slug");

  const titleOnly = buildEventGroupKey({ event_title: "Some Match Title", condition_id: "0xabc" });
  assert.equal(titleOnly.source, "event_title");

  const marketOnly = buildEventGroupKey({ market_slug: "market-1", condition_id: "0xabc" });
  assert.equal(marketOnly.source, "market_slug_fallback");
});

test("groupRowsByEventGroup groups rows sharing the same computed key", () => {
  const rowA = { match_family_key: "same-event", signal_id: "a" };
  const rowB = { match_family_key: "same-event", signal_id: "b" };
  const rowC = { match_family_key: "other-event", signal_id: "c" };

  const groups = groupRowsByEventGroup([rowA, rowB, rowC]);

  assert.equal(groups.size, 2);
  const sameEventKey = buildEventGroupKey(rowA).key;
  const otherEventKey = buildEventGroupKey(rowC).key;
  assert.deepEqual(groups.get(sameEventKey), [rowA, rowB]);
  assert.deepEqual(groups.get(otherEventKey), [rowC]);
});

test("selectFirstPerEventGroup selects one row per group using caller comparator", () => {
  const rowA = { match_family_key: "event-1", signal_id: "a", score: 10 };
  const rowB = { match_family_key: "event-1", signal_id: "b", score: 90 };
  const rowC = { match_family_key: "event-2", signal_id: "c", score: 50 };

  const byScoreDesc = (a: typeof rowA, b: typeof rowA) => (b.score ?? 0) - (a.score ?? 0);

  const selected = selectFirstPerEventGroup([rowA, rowB, rowC], byScoreDesc);

  assert.equal(selected.length, 2);
  assert.ok(selected.includes(rowB));
  assert.ok(!selected.includes(rowA));
  assert.ok(selected.includes(rowC));
});

test("selectFirstPerEventGroup does not mutate original input order", () => {
  const rowA = { match_family_key: "event-1", signal_id: "a", score: 10 };
  const rowB = { match_family_key: "event-1", signal_id: "b", score: 90 };
  const rowC = { match_family_key: "event-2", signal_id: "c", score: 50 };
  const rows = [rowA, rowB, rowC];
  const rowsSnapshot = [...rows];

  selectFirstPerEventGroup(rows, (a, b) => (b.score ?? 0) - (a.score ?? 0));

  assert.deepEqual(rows, rowsSnapshot);
  assert.equal(rows[0], rowA);
  assert.equal(rows[1], rowB);
  assert.equal(rows[2], rowC);
});

test("selectFirstPerEventGroup preserves original row object references", () => {
  const rowA = { match_family_key: "event-1", signal_id: "a", score: 10 };
  const selected = selectFirstPerEventGroup([rowA], (a, b) => 0);

  assert.equal(selected[0], rowA);
});

test("empty input returns empty output", () => {
  assert.deepEqual(groupRowsByEventGroup([]), new Map());
  assert.deepEqual(selectFirstPerEventGroup([], () => 0), []);
});
