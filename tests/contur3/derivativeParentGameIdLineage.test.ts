// DERIVATIVE_PARENT_GAME_ID_LINEAGE_V1 — a `... - Total Corners` derivative event carries NO gameId of its own but
// DOES carry the provider-authored parentEventId of its main event (live Gamma 2026-10-09: 1116100 -> 1116007
// gameId 74299684; 1082327 -> 1082182 gameId 90106176). The exact parent is fetched BY ID; its gameId is the only
// accepted game authority. No title/slug/start-time inference. The Reservation's persisted identity is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PHYSICAL_EVENT_GAME_ID_UNRESOLVED,
  PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION,
  captureReservationMarketObservation,
  defaultExactEventReader,
} from "../../lib/executor/reservationMarketBaseline";
import { isLiveMoneyFamilyEligible } from "../../lib/executor/liveMoneyFamilyAuthority";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import type { PolymarketRawEvent } from "../../lib/feed/types";

const START = "2026-10-09T05:00:00Z";
const CHILD = "1082327";
const PARENT = "1082182";
const GAME = "90106176";
const LEGACY_ID = "provider:polymarket:1082327:2026-10-09";

const rawMarket = (slug: string, type: string, n: number) => ({
  id: `m${n}`, conditionId: `0xc${n}`, slug, sportsMarketType: type,
  clobTokenIds: [`t${n}a`, `t${n}b`], outcomes: ["Over", "Under"],
}) as never;
const child = (over: Record<string, unknown> = {}): PolymarketRawEvent => ({
  id: CHILD, slug: "kor-dae1-jeo-2026-10-09-total-corners", title: "x - Total Corners", startTime: START, endDate: START,
  parentEventId: Number(PARENT), active: true, closed: false,
  markets: [rawMarket("kor-dae1-jeo-2026-10-09-total-corners-9pt5", "total_corners", 1)], ...over,
}) as unknown as PolymarketRawEvent;
const parent = (over: Record<string, unknown> = {}): PolymarketRawEvent => ({
  id: PARENT, slug: "kor-dae1-jeo-2026-10-09", title: "x", startTime: START, endDate: START, gameId: Number(GAME),
  active: true, closed: false, markets: [rawMarket("kor-dae1-jeo-2026-10-09", "moneyline", 2)], ...over,
}) as unknown as PolymarketRawEvent;

const fetcher = (events: Record<string, PolymarketRawEvent | null>, calls: string[] = []) => async (id: string) => {
  calls.push(id); return events[id] ?? null;
};
const gameIds = (markets: { provider_game_id?: string | null }[]) => [...new Set(markets.map((m) => m.provider_game_id ?? null))];

test("PGL-A: exact derivative event — gameId missing, parentEventId present, parent has valid gameId + same start => game authority derived", async () => {
  const calls: string[] = [];
  const own = await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child(), [PARENT]: parent() }, calls));
  assert.deepEqual(calls, [CHILD, PARENT], "exact child by id, then exact parent by id — nothing else");
  assert.deepEqual(gameIds(own), [GAME]);
  assert.equal(own[0].provider_event_id, CHILD, "the lineage event itself is unchanged (still the corners event)");
});

test("PGL-A2: capture — legacy corners Reservation keeps its persisted physical id, derives the gameId and runs bounded game discovery", async () => {
  const res = ({ id: "77777777-7777-4777-8777-777777777777", plan_run_id: "plan", physical_event_id: LEGACY_ID, event_start_iso: START,
    diagnostics: { source_lineage: { provider_event_id: CHILD, provider_event_start_iso: START, provider_market_type: "total_corners" } } }) as unknown as NightEventReservationRow;
  const gameReads: string[] = [];
  let run: Record<string, unknown> = {}; let observations: Record<string, unknown>[] = [];
  const f = fetcher({ [CHILD]: child(), [PARENT]: parent() });
  await captureReservationMarketObservation(res, "T_MINUS_10", {
    observedAt: "2026-10-09T04:50:00Z", alreadyCaptured: async () => false,
    readExactEvent: (id, start) => defaultExactEventReader(id, start, f),
    readGameEvents: async (g) => { gameReads.push(g); return []; },
    fetchBooks: async (tokens: string[]) => tokens.map(() => ({ ok: false, errorCode: "NO_BOOK", latencyMs: 1 })) as never,
    fetchFeeSchedule: async (tokenId) => ({ ok: false, tokenId, errorCode: "T", latencyMs: 0 }) as never,
    write: async (r, o) => { run = r; observations = o; },
  });
  assert.deepEqual(gameReads, [GAME]);
  assert.notEqual(run.failure_reason, PHYSICAL_EVENT_GAME_ID_UNRESOLVED);
  assert.equal(run.physical_event_id, LEGACY_ID, "historical Reservation identity is not rewritten");
  assert.ok(observations.length > 0 && observations.every((o) => o.canonical_market_family === "TOTAL_CORNERS"));
});

test("PGL-B: parent missing (not found / not fetchable) => fail closed, no gameId", async () => {
  assert.deepEqual(gameIds(await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child() }))), [null]);
  const throwing = async (id: string) => { if (id === PARENT) throw new Error("boom"); return child(); };
  assert.deepEqual(gameIds(await defaultExactEventReader(CHILD, START, throwing)), [null]);
});

test("PGL-C: parent without gameId (absent / null / blank) => fail closed", async () => {
  for (const gameId of [undefined, null, "", "  "]) {
    const p = parent({ gameId });
    assert.deepEqual(gameIds(await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child(), [PARENT]: p }))), [null]);
  }
});

test("PGL-D: parent start mismatch => fail closed", async () => {
  const p = parent({ startTime: "2026-10-09T06:00:00Z", endDate: "2026-10-09T06:00:00Z" });
  assert.deepEqual(gameIds(await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child(), [PARENT]: p }))), [null]);
});

test("PGL-D2: other malformed lineage fails closed — non-numeric parent id, self parent, wrong id returned, parent that is itself a derivative", async () => {
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ parentEventId: "abc" }, {}], [{ parentEventId: CHILD }, {}], [{}, { id: "999" }], [{}, { parentEventId: 1 }],
  ];
  for (const [c, p] of cases) {
    assert.deepEqual(gameIds(await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child(c), [PARENT]: parent(p) }))), [null]);
  }
});

test("PGL-E: parent gameId contradicting the Reservation's claimed gameId => fail closed with the typed contradiction", async () => {
  const res = ({ id: "77777777-7777-4777-8777-777777777777", plan_run_id: "plan", event_start_iso: START,
    physical_event_id: `provider:polymarket:game:90000000:2026-10-09`,
    diagnostics: { source_lineage: { provider_event_id: CHILD, provider_event_start_iso: START, provider_game_id: "90000000", provider_market_type: "total_corners" } } }) as unknown as NightEventReservationRow;
  let run: Record<string, unknown> = {}; let gameReads = 0;
  const f = fetcher({ [CHILD]: child(), [PARENT]: parent() });
  await captureReservationMarketObservation(res, "T_MINUS_10", {
    observedAt: "2026-10-09T04:50:00Z", alreadyCaptured: async () => false,
    readExactEvent: (id, start) => defaultExactEventReader(id, start, f),
    readGameEvents: async () => { gameReads++; return []; },
    fetchBooks: async () => [] as never, write: async (r) => { run = r; },
  });
  assert.equal(run.failure_reason, PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION);
  assert.equal(gameReads, 0, "no discovery after a contradiction");
});

test("PGL-F: an event that states its own gameId is unchanged — no parent fetch, own gameId wins even over a different parent", async () => {
  const calls: string[] = [];
  const own = await defaultExactEventReader(CHILD, START, fetcher({
    [CHILD]: child({ gameId: 555 }), [PARENT]: parent({ gameId: 666 }),
  }, calls));
  assert.deepEqual(calls, [CHILD]);
  assert.deepEqual(gameIds(own), ["555"]);
  const noParent = await defaultExactEventReader(PARENT, START, fetcher({ [PARENT]: parent() }));
  assert.deepEqual(gameIds(noParent), [GAME]);
  const noParentNoGame = await defaultExactEventReader(CHILD, START, fetcher({ [CHILD]: child({ parentEventId: undefined }) }));
  assert.deepEqual(gameIds(noParentNoGame), [null], "no parentEventId => still UNRESOLVED, no other inference");
});

test("PGL-G: no title / slug / start-time inference was introduced", () => {
  const src = readFileSync(new URL("../../lib/executor/reservationMarketBaseline.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function parentProvidedGameId");
  const body = src.slice(start, src.indexOf("export async function defaultExactEventReader", start));
  assert.ok(body.length > 0);
  assert.ok(!/\.(title|slug|description)\b/.test(body), "parent derivation reads neither title nor slug");
  assert.ok(!/fetchPolymarketEventsByGameId|search|includes\(|startsWith\(|match\(/.test(body), "no search / fuzzy matching");
});

test("PGL-H: TOTAL_CORNERS stays live-money eligible; SPREADS stays observation-only", () => {
  assert.equal(isLiveMoneyFamilyEligible("TOTAL_CORNERS"), true);
  assert.equal(isLiveMoneyFamilyEligible("MONEYLINE"), true);
  assert.equal(isLiveMoneyFamilyEligible("TOTALS"), true);
  assert.equal(isLiveMoneyFamilyEligible("SPREADS"), false);
});
