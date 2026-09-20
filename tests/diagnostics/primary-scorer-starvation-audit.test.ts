import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEventFairOrder, type KeyedCandidate } from "../../scripts/diagnostics/primary-scorer-starvation-audit";
import type { CandidateMarket } from "../../lib/feed/buildLandingCards";

// Minimal synthetic CandidateMarket stand-ins: only `key` matters to
// buildEventFairOrder(), the candidate payload is just an identity tag.
function candidate(tag: string): CandidateMarket {
  return { tag } as unknown as CandidateMarket;
}

function group(eventKey: string, identityTags: string[]): KeyedCandidate[] {
  return identityTags.map((tag) => ({ candidate: candidate(tag), key: eventKey }));
}

test("first breadth pass takes exactly one identity per event, in first-appearance order", () => {
  // A has 100 identities, B has 3, C has 1, D has 2 -- current order A,B,C,D.
  const keyed: KeyedCandidate[] = [
    ...group("A", Array.from({ length: 100 }, (_, i) => `A${i + 1}`)),
    ...group("B", ["B1", "B2", "B3"]),
    ...group("C", ["C1"]),
    ...group("D", ["D1", "D2"]),
  ];
  const fair = buildEventFairOrder(keyed);
  const firstFour = fair.slice(0, 4).map((k) => (k.candidate as unknown as { tag: string }).tag);
  assert.deepEqual(firstFour, ["A1", "B1", "C1", "D1"]);
});

test("identity order inside each event is preserved across every round-robin pass", () => {
  const keyed: KeyedCandidate[] = [
    ...group("A", Array.from({ length: 100 }, (_, i) => `A${i + 1}`)),
    ...group("B", ["B1", "B2", "B3"]),
    ...group("C", ["C1"]),
    ...group("D", ["D1", "D2"]),
  ];
  const fair = buildEventFairOrder(keyed);
  const tagsByEvent = new Map<string, string[]>();
  for (const item of fair) {
    const tag = (item.candidate as unknown as { tag: string }).tag;
    const evt = tag[0];
    const list = tagsByEvent.get(evt) ?? [];
    list.push(tag);
    tagsByEvent.set(evt, list);
  }
  assert.deepEqual(tagsByEvent.get("A"), Array.from({ length: 100 }, (_, i) => `A${i + 1}`));
  assert.deepEqual(tagsByEvent.get("B"), ["B1", "B2", "B3"]);
  assert.deepEqual(tagsByEvent.get("C"), ["C1"]);
  assert.deepEqual(tagsByEvent.get("D"), ["D1", "D2"]);
});

test("candidate membership is exactly conserved (same set, only order changes)", () => {
  const keyed: KeyedCandidate[] = [
    ...group("A", Array.from({ length: 100 }, (_, i) => `A${i + 1}`)),
    ...group("B", ["B1", "B2", "B3"]),
    ...group("C", ["C1"]),
    ...group("D", ["D1", "D2"]),
  ];
  const fair = buildEventFairOrder(keyed);
  assert.equal(fair.length, keyed.length);
  const originalTags = new Set(keyed.map((k) => (k.candidate as unknown as { tag: string }).tag));
  const fairTags = new Set(fair.map((k) => (k.candidate as unknown as { tag: string }).tag));
  assert.deepEqual(fairTags, originalTags);
});

test("unkeyed candidates are placed last, preserving their original relative order", () => {
  const keyed: KeyedCandidate[] = [
    { candidate: candidate("U1"), key: null },
    ...group("A", ["A1", "A2"]),
    { candidate: candidate("U2"), key: null },
    ...group("B", ["B1"]),
  ];
  const fair = buildEventFairOrder(keyed);
  const tags = fair.map((k) => (k.candidate as unknown as { tag: string }).tag);
  assert.deepEqual(tags.slice(-2), ["U1", "U2"]);
  assert.deepEqual(tags.slice(0, -2), ["A1", "B1", "A2"]);
});

test("determinism: repeated calls on the same input produce byte-identical output", () => {
  const keyed: KeyedCandidate[] = [
    ...group("A", Array.from({ length: 100 }, (_, i) => `A${i + 1}`)),
    ...group("B", ["B1", "B2", "B3"]),
    ...group("C", ["C1"]),
    ...group("D", ["D1", "D2"]),
  ];
  const first = buildEventFairOrder(keyed).map((k) => (k.candidate as unknown as { tag: string }).tag);
  const second = buildEventFairOrder(keyed).map((k) => (k.candidate as unknown as { tag: string }).tag);
  assert.deepEqual(first, second);
});
