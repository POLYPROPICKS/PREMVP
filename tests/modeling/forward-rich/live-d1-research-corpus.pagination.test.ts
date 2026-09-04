// FIX_D1_FACTORY_TIE_DRAIN_EARLY_TERMINATION_V1 regression coverage.
//
// Proven failing shape (production clone, generated_signal_pairs,
// 2026-09-03 window): a 1,000-row advance page followed by a 304-row
// same-timestamp tie-drain page caused the old reader to stop at 1,304
// rows, silently dropping ~45,470 later rows. A short tie-drain page means
// only "no more ids at this exact timestamp" — it must never end the scan.
// Only a short *advance* page (no later timestamp at all) may end it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { keysetPage, readSignalPairs } from "../../../scripts/modeling/live-d1-research-corpus";

type FakeRow = { id: string; created_at: string; [k: string]: unknown };

/** Minimal chainable fake mirroring the exact call shapes keysetPage/readObservations issue. */
function makeFakeClient(rows: FakeRow[]) {
  const calls: Array<{ table: string; op: "tie" | "advance" }> = [];
  function builder(table: string) {
    const filters: Array<{ op: "eq" | "gt" | "in"; field: string; value: unknown }> = [];
    const orders: Array<{ field: string; ascending: boolean }> = [];
    const chain = {
      select(_cols: string) {
        return chain;
      },
      eq(field: string, value: unknown) {
        filters.push({ op: "eq", field, value });
        return chain;
      },
      gt(field: string, value: unknown) {
        filters.push({ op: "gt", field, value });
        return chain;
      },
      in(field: string, value: unknown[]) {
        filters.push({ op: "in", field, value });
        return chain;
      },
      order(field: string, opts?: { ascending?: boolean }) {
        orders.push({ field, ascending: opts?.ascending !== false });
        return chain;
      },
      limit(n: number) {
        const isTie = filters.some((f) => f.op === "eq");
        calls.push({ table, op: isTie ? "tie" : "advance" });
        let out = rows.filter((r) =>
          filters.every((f) => {
            const v = r[f.field];
            if (f.op === "eq") return v === f.value;
            if (f.op === "gt") return (v as string) > (f.value as string);
            if (f.op === "in") return (f.value as unknown[]).includes(v);
            return true;
          }),
        );
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.field] as string;
            const bv = b[o.field] as string;
            if (av < bv) return o.ascending ? -1 : 1;
            if (av > bv) return o.ascending ? 1 : -1;
          }
          return 0;
        });
        return Promise.resolve({ data: out.slice(0, n), error: null });
      },
    };
    return chain;
  }
  return { client: { from: (t: string) => builder(t) } as any, calls };
}

const T0 = Date.parse("2026-09-02T21:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `id-${String(n).padStart(8, "0")}`;

test("1: normal multi-page strictly increasing timestamps — full conservation, no dup/skip", async () => {
  const rows: FakeRow[] = Array.from({ length: 2_500 }, (_, i) => ({
    id: id(i),
    created_at: iso(T0 + i), // one ms apart, all distinct
  }));
  const { client } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(T0 + 3_000));
  assert.equal(pairs.length, 2_500, "all rows across 3 pages (1000/1000/500) are read");
  assert.deepEqual(
    pairs.map((p) => p._id),
    rows.map((r) => r.id),
    "exact id order preserved, no duplicates, no gaps",
  );
});

test("2: multiple rows sharing one timestamp mid-stream (within a single page) read correctly", async () => {
  const rows: FakeRow[] = [];
  for (let i = 0; i < 20; i++) rows.push({ id: id(i), created_at: iso(T0 + i) });
  // 5 rows share one timestamp in the middle — no page boundary involved.
  for (let i = 0; i < 5; i++) rows.push({ id: id(100 + i), created_at: iso(T0 + 10) });
  for (let i = 20; i < 40; i++) rows.push({ id: id(i), created_at: iso(T0 + i) });
  const { client } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(T0 + 1_000));
  assert.equal(pairs.length, rows.length, "tie cluster mid-stream causes no loss");
  assert.equal(new Set(pairs.map((p) => p._id)).size, rows.length, "no duplicates");
});

test("3: full tie page (== PAGE) then short tie-drain (< PAGE) then later timestamps — does not stop early", async () => {
  const rows: FakeRow[] = [];
  // Page 0: 1000 rows at T0 (advance page, exactly PAGE, source=advance).
  for (let i = 0; i < 1_000; i++) rows.push({ id: id(i), created_at: iso(T0) });
  // Page 1: next 1000 rows ALSO at T0 (tie-drain page, exactly PAGE, source=tie).
  for (let i = 1_000; i < 2_000; i++) rows.push({ id: id(i), created_at: iso(T0) });
  // Page 2: remaining 500 rows at T0 (tie-drain page, SHORT, source=tie) — the
  // exact shape the old code mistook for end-of-data.
  for (let i = 2_000; i < 2_500; i++) rows.push({ id: id(i), created_at: iso(T0) });
  // Page 3: 3 rows at a strictly later timestamp (advance page, short, genuine end).
  for (let i = 0; i < 3; i++) rows.push({ id: id(3_000 + i), created_at: iso(T0 + 1) });

  const { client } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(T0 + 10));
  assert.equal(pairs.length, 2_503, "reads past the short tie-drain page into the later timestamp");
  assert.notEqual(pairs.length, 2_500, "must not stop exactly where the tie cluster ends");
  assert.equal(new Set(pairs.map((p) => p._id)).size, 2_503, "no duplicate rows");
});

test("4: the exact proven failing shape — 1000 advance + 304 short tie-drain + later rows", async () => {
  const rows: FakeRow[] = [];
  // 1000 distinct-timestamp rows: page 0 is a full ADVANCE page.
  for (let i = 0; i < 1_000; i++) rows.push({ id: id(i), created_at: iso(T0 + i) });
  // 304 more rows sharing the LAST timestamp of page 0 (T0+999): a short
  // TIE-DRAIN page — this is the exact burst size observed against the
  // research clone for 2026-09-03.
  for (let i = 0; i < 304; i++) rows.push({ id: id(1_000 + i), created_at: iso(T0 + 999) });
  // 2 rows at a strictly later timestamp — must still be reached.
  rows.push({ id: id(2_000), created_at: iso(T0 + 1_000) });
  rows.push({ id: id(2_001), created_at: iso(T0 + 1_001) });

  const { client } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(T0 + 5_000));

  assert.notEqual(pairs.length, 1_304, "must not terminate at the old, wrong stop point");
  assert.equal(pairs.length, 1_306, "1000 advance + 304 tie-drain + 2 later rows, all read");
  assert.deepEqual(
    pairs.slice(-2).map((p) => p._id),
    [id(2_000), id(2_001)],
    "the later-timestamp rows are the final two rows read, in order",
  );
});

test("5: no duplicate rows and no skipped rows across several tie-to-advance transitions", async () => {
  const rows: FakeRow[] = [];
  let n = 0;
  let t = T0;
  // Interleave clusters of varying size (including some > PAGE) with single rows.
  const clusterSizes = [1, 1500, 3, 1000, 7, 250, 1, 1];
  for (const size of clusterSizes) {
    for (let i = 0; i < size; i++) rows.push({ id: id(n++), created_at: iso(t) });
    t += 1;
  }
  const { client } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(t + 10));
  assert.equal(pairs.length, rows.length, "every row across all clusters is read exactly once");
  assert.deepEqual(
    pairs.map((p) => p._id),
    rows.map((r) => r.id),
    "chronological id order preserved end to end",
  );
});

test("6: a genuinely short advance page correctly ends the scan (no extra round-trip)", async () => {
  const rows: FakeRow[] = Array.from({ length: 3 }, (_, i) => ({
    id: id(i),
    created_at: iso(T0 + i),
  }));
  const { client, calls } = makeFakeClient(rows);
  const { pairs } = await readSignalPairs(client, iso(T0 - 1), iso(T0 + 1_000));
  assert.equal(pairs.length, 3);
  assert.equal(calls.length, 1, "a single short advance page ends the scan immediately");
});

test("keysetPage: reports source=\"tie\" only for the eq(timestamp) branch, \"advance\" otherwise", async () => {
  const rows: FakeRow[] = [
    { id: id(0), created_at: iso(T0) },
    { id: id(1), created_at: iso(T0) },
    { id: id(2), created_at: iso(T0 + 1) },
  ];
  const { client } = makeFakeClient(rows);

  const first = await keysetPage(client, "generated_signal_pairs", "created_at", "id,created_at", iso(T0 - 1), "");
  assert.equal(first.source, "advance", "first call (no afterId) always advances");
  assert.equal(first.rows.length, 3);

  const tieOnly = await keysetPage(client, "generated_signal_pairs", "created_at", "id,created_at", iso(T0), id(0));
  assert.equal(tieOnly.source, "tie", "afterId set + rows remain at the same timestamp -> tie");
  assert.deepEqual(tieOnly.rows.map((r: any) => r.id), [id(1)]);

  const advanceAfterTieExhausted = await keysetPage(
    client,
    "generated_signal_pairs",
    "created_at",
    "id,created_at",
    iso(T0),
    id(1),
  );
  assert.equal(advanceAfterTieExhausted.source, "advance", "tie exhausted -> falls through to advance");
  assert.deepEqual(advanceAfterTieExhausted.rows.map((r: any) => r.id), [id(2)]);
});
