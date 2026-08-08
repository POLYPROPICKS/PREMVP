import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchEventsKeysetCompleteSafe,
  fetchEventsByTagSlugSafe,
  fetchPolymarketEventsByTagSafe,
  fetchActiveEventsByStartWindowKeysetSafe,
  KEYSET_PAGE_SIZE,
} from "../../lib/feed/polymarketClient";

// ── Complete provider enumeration contract ─────────────────────────────────
// The enumeration boundary itself is NEVER mocked here: the real cursor
// walker in polymarketClient runs unmodified. Only the network transport
// (globalThis.fetch) is replaced by an in-memory Gamma stub that reproduces
// the provider's real `/events/keyset` semantics: `limit` + `after_cursor`
// in, `{ events, next_cursor }` out, `next_cursor: null` on the final page.
//
// Run with: node --import tsx --test tests/feed/providerCompleteEnumeration.test.ts

type StubPage = { events: Record<string, unknown>[]; next_cursor: string | null };

const realFetch = globalThis.fetch;

interface StubState {
  /** Every URL the client requested, in order. */
  requests: string[];
}

let stub: StubState;

/** Build a Gamma stub that serves `events` through real cursor pagination. */
function serveKeyset(
  eventsByPartition: Record<string, Record<string, unknown>[]>,
  opts?: {
    /** Force next_cursor to repeat, simulating a stalled provider cursor. */
    stallCursorAtPage?: number;
    /** Return an HTTP failure at this 1-based page number. */
    failAtPage?: number;
  },
) {
  const pageCounters = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    stub.requests.push(url.toString());

    // The partition key is whatever filter the caller passed through.
    const partition =
      url.searchParams.get("tag_slug") ??
      url.searchParams.get("tag_id") ??
      url.searchParams.get("start_time_min") ??
      "default";

    const all = eventsByPartition[partition] ?? [];
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const after = url.searchParams.get("after_cursor");
    const offset = after ? Number(after.replace("cursor-", "")) : 0;

    const pageNo = (pageCounters.get(partition) ?? 0) + 1;
    pageCounters.set(partition, pageNo);

    if (opts?.failAtPage === pageNo) {
      return new Response("upstream boom", { status: 502 });
    }

    const slice = all.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    let nextCursor: string | null = nextOffset >= all.length ? null : `cursor-${nextOffset}`;
    if (opts?.stallCursorAtPage === pageNo) nextCursor = after ?? "cursor-0";

    const body: StubPage = { events: slice, next_cursor: nextCursor };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function events(n: number, prefix = "evt"): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, title: `Event ${i}` }));
}

beforeEach(() => {
  stub = { requests: [] };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a partition of 287 events is enumerated completely across multiple cursor pages, ending on a short final page", async () => {
  serveKeyset({ nba: events(287) });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "nba" });

  // REGRESSION: the old single-shot helper issued exactly ONE request with a
  // hardcoded limit (50 for tag_slug, 100 for tag_id) and returned that first
  // page as if it were the whole partition. 287 > 100 > 50, so any
  // first-page-bounded implementation fails this assertion.
  assert.equal(result.events.length, 287, "every provider page must be consumed");
  assert.equal(result.complete, true, "natural termination must be reported as complete");
  assert.equal(result.incompleteReason, null);
  assert.equal(result.pagesFetched, 3, "287 events at page size 100 is 3 pages");

  // Short final page: 100 + 100 + 87.
  assert.equal(stub.requests.length, 3);
  assert.ok(
    stub.requests.every((u) => new URL(u).searchParams.get("limit") === String(KEYSET_PAGE_SIZE)),
    "page size must be the provider maximum, not a caller-supplied bound",
  );

  // Cursor progression: page 1 carries no cursor, later pages carry distinct ones.
  const cursors = stub.requests.map((u) => new URL(u).searchParams.get("after_cursor"));
  assert.deepEqual(cursors, [null, "cursor-100", "cursor-200"]);
});

test("records beyond the old first-page limits are present, not just the head of the partition", async () => {
  serveKeyset({ nba: events(287) });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "nba" });
  const ids = new Set(result.events.map((e) => e.id));

  // Entries past the old 50-record tag_slug bound and the old 100-record
  // tag_id bound must all be present.
  assert.ok(ids.has("evt-50"), "record beyond the old 50-entry bound must be enumerated");
  assert.ok(ids.has("evt-100"), "record beyond the old 100-entry bound must be enumerated");
  assert.ok(ids.has("evt-286"), "the final record of the partition must be enumerated");
});

test("overlapping partitions dedupe on exact provider event ID, deterministically first-wins", async () => {
  // Two partitions sharing ids shared-0..shared-9 plus their own tails.
  const shared = events(10, "shared");
  const a = [...shared, ...events(5, "only-a")];
  const b = [...shared, ...events(5, "only-b")];
  serveKeyset({ "tag-a": a, "tag-b": b });

  const ra = await fetchEventsKeysetCompleteSafe({ tag_id: "tag-a" });
  const rb = await fetchEventsKeysetCompleteSafe({ tag_id: "tag-b" });

  const merged = new Map<string, Record<string, unknown>>();
  for (const ev of [...ra.events, ...rb.events]) {
    if (!merged.has(String(ev.id))) merged.set(String(ev.id), ev);
  }
  assert.equal(merged.size, 20, "10 shared + 5 a-only + 5 b-only");
  assert.equal(ra.complete && rb.complete, true);
});

test("duplicate provider event IDs inside one partition are collapsed and counted", async () => {
  const dupes = [...events(120), ...events(120)]; // every id repeated
  serveKeyset({ dup: dupes });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "dup" });

  assert.equal(result.events.length, 120, "exact event-ID dedupe must collapse repeats");
  assert.equal(result.duplicatesDropped, 120);
  assert.equal(result.complete, true);
});

test("a stalled provider cursor terminates explicitly as incomplete, never as success", async () => {
  serveKeyset({ stall: events(500) }, { stallCursorAtPage: 2 });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "stall" });

  assert.equal(result.complete, false, "cursor non-progress must not report completeness");
  assert.match(result.incompleteReason ?? "", /KEYSET_CURSOR_NON_PROGRESS/);
  assert.ok(result.pagesFetched < 10, "the walker must not loop on a repeating cursor");
});

test("a mid-partition transport failure is reported as incomplete, not as a complete universe", async () => {
  serveKeyset({ boom: events(500) }, { failAtPage: 3 });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "boom" });

  // Two good pages were collected -- but the partition is NOT complete, and
  // the result says so explicitly instead of presenting 200 of 500 events as
  // the whole official universe.
  assert.equal(result.events.length, 200);
  assert.equal(result.complete, false);
  assert.match(result.incompleteReason ?? "", /KEYSET_PAGE_FAILED/);
  assert.equal(result.truncated, true, "back-compat truncated flag must track !complete");
});

test("the page cap is an explicit incompleteness, not a silent truncation", async () => {
  serveKeyset({ huge: events(1000) });

  const result = await fetchEventsKeysetCompleteSafe({ tag_slug: "huge" }, { maxPages: 4 });

  assert.equal(result.events.length, 400);
  assert.equal(result.complete, false);
  assert.match(result.incompleteReason ?? "", /KEYSET_PAGE_CAP_REACHED/);
});

test("the production tag helpers enumerate completely and never issue an offset request", async () => {
  serveKeyset({ esports: events(230), "745": events(230) });

  const bySlug = await fetchEventsByTagSlugSafe("esports");
  const byTag = await fetchPolymarketEventsByTagSafe("745");

  // Old behaviour: 50 (tag_slug) and 100 (tag_id) respectively.
  assert.equal(bySlug.length, 230, "tag_slug enumeration must not stop at the old 50-entry page");
  assert.equal(byTag.length, 230, "tag_id enumeration must not stop at the old 100-entry page");

  // Keyset cursors only -- deep-offset pagination past provider limits is
  // never used.
  assert.ok(
    stub.requests.every((u) => new URL(u).pathname === "/events/keyset"),
    "enumeration must go through the keyset endpoint",
  );
  assert.ok(
    stub.requests.every((u) => !new URL(u).searchParams.has("offset")),
    "no offset-based pagination is permitted",
  );
});

test("the official start-window universe helper keeps its authoritative start semantics", async () => {
  const startIso = "2030-01-01T00:00:00.000Z";
  const endIso = "2030-01-03T00:00:00.000Z";
  serveKeyset({ [startIso]: events(150) });

  const result = await fetchActiveEventsByStartWindowKeysetSafe(startIso, endIso);

  assert.equal(result.events.length, 150);
  assert.equal(result.complete, true);

  const first = new URL(stub.requests[0]);
  // The window is expressed with the provider's authoritative start fields --
  // listing startDate is never substituted for fixture kickoff here.
  assert.equal(first.searchParams.get("start_time_min"), startIso);
  assert.equal(first.searchParams.get("start_time_max"), endIso);
  assert.equal(first.searchParams.get("active"), "true");
  assert.equal(first.searchParams.get("closed"), "false");
});
