// RESTORE_RESEARCH_CLONE_CURRENT_EVIDENCE_LINEAGE_V1 regression coverage.
//
// Proven incident: production migration
// supabase/migrations/20260908120000_make_current_money_state_gsp_independent.sql
// moved primary money-evidence publication off generated_signal_pairs (GSP)
// onto public.primary_evidence_outbox (lib/feed/persistPrimarySignalPopulation.ts
// gspWriteStatus DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX). The research-clone daily
// sync and the D-1 corpus factory read only GSP, so daily syncs kept reporting
// SUCCESS with zero new rows after ~2026-09-11 even though production evidence
// kept flowing — just through the new table. This suite proves
// readPrimaryEvidenceOutbox correctly flattens outbox envelopes into the same
// identity/diagnostics shape readSignalPairs produces from GSP, and that a
// bounded post-Sep-11 fixture with an EMPTY generated_signal_pairs window and a
// POPULATED primary_evidence_outbox window still yields non-zero materializable
// input — the exact corrected lineage the mission requires.

import { test } from "node:test";
import assert from "node:assert/strict";

import { keysetPage, readPrimaryEvidenceOutbox, readSignalPairs } from "../../../scripts/modeling/live-d1-research-corpus";

type OutboxRow = {
  observation_id: string;
  observed_at: string;
  evidence_rows: Record<string, unknown>[];
  evidence_row_count: number;
  [k: string]: unknown;
};

/** Minimal chainable fake mirroring the exact call shapes keysetPage issues. */
function makeFakeClient(rows: Record<string, unknown>[]) {
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
  return { client: { from: (t: string) => builder(t) } as any };
}

const T0 = Date.parse("2026-09-12T21:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function envelope(n: number, observedAtMs: number, rows: Record<string, unknown>[]): OutboxRow {
  return {
    observation_id: uuid(n),
    observed_at: iso(observedAtMs),
    evidence_rows: rows,
    evidence_row_count: rows.length,
  };
}

function evidenceRow(itemId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observation_id: itemId,
    condition_id: "0xcondition",
    selected_token_id: "token-1",
    formula_version: "v2-lite-growth-safe",
    metric_formula_version: "v2-lite-growth-safe",
    entry_price_num: 0.42,
    signal_result: null,
    pre_event_score_num: 61,
    diagnostics: {
      providerEventId: "polymarket-event-1",
      gameStartIso: "2026-09-13T00:00:00.000Z",
      marketType: "moneyline",
      marketFamily: "moneyline",
      providerSportCode: "SOCCER",
      providerSportFamily: "soccer",
      volumeUsd: 1000,
    },
    ...overrides,
  };
}

test("keysetPage: idField param generalizes id column for non-\"id\" primary keys", async () => {
  const rows = [
    { observation_id: uuid(1), observed_at: iso(T0) },
    { observation_id: uuid(2), observed_at: iso(T0) },
    { observation_id: uuid(3), observed_at: iso(T0 + 1) },
  ];
  const { client } = makeFakeClient(rows);

  const first = await keysetPage(
    client,
    "primary_evidence_outbox",
    "observed_at",
    "observation_id,observed_at",
    iso(T0 - 1),
    "",
    "observation_id",
  );
  assert.equal(first.source, "advance");
  assert.equal(first.rows.length, 3);

  const tie = await keysetPage(
    client,
    "primary_evidence_outbox",
    "observed_at",
    "observation_id,observed_at",
    iso(T0),
    uuid(1),
    "observation_id",
  );
  assert.equal(tie.source, "tie");
  assert.deepEqual((tie.rows as any[]).map((r) => r.observation_id), [uuid(2)]);
});

test("readPrimaryEvidenceOutbox: flattens envelope evidence_rows into GSP-shaped identity rows", async () => {
  const rows: OutboxRow[] = [
    envelope(1, T0, [evidenceRow(uuid(101)), evidenceRow(uuid(102), { selected_token_id: "token-2" })]),
  ];
  const { client } = makeFakeClient(rows as unknown as Record<string, unknown>[]);
  const { pairs, maxWatermark } = await readPrimaryEvidenceOutbox(client, iso(T0 - 1), iso(T0 + 1000));

  assert.equal(pairs.length, 2, "both items inside the one envelope are read as independent rows");
  assert.deepEqual(
    pairs.map((p) => p._id),
    [uuid(101), uuid(102)],
    "row identity is each item's own embedded observation_id, never the shared envelope id",
  );
  assert.equal(pairs[0].conditionId, "0xcondition");
  assert.equal(pairs[0].selectedTokenId, "token-1");
  assert.equal(pairs[0].providerEventId, "polymarket-event-1");
  assert.equal(pairs[0].providerSportFamily, "soccer");
  assert.equal(pairs[0].entryPriceNum, 0.42);
  assert.equal(pairs[0].decisionAt, iso(T0), "decisionAt is the publish envelope's observed_at");
  assert.equal(maxWatermark, `${iso(T0)}|${uuid(1)}`);
});

test("readPrimaryEvidenceOutbox: respects the window end and paginates across envelopes", async () => {
  const rows: OutboxRow[] = [
    envelope(1, T0, [evidenceRow(uuid(101))]),
    envelope(2, T0 + 1, [evidenceRow(uuid(102)), evidenceRow(uuid(103))]),
    envelope(3, T0 + 5000, [evidenceRow(uuid(104))]), // outside window
  ];
  const { client } = makeFakeClient(rows as unknown as Record<string, unknown>[]);
  const { pairs } = await readPrimaryEvidenceOutbox(client, iso(T0 - 1), iso(T0 + 1000));
  assert.equal(pairs.length, 3, "only envelopes strictly inside [start, end) are read");
  assert.deepEqual(
    pairs.map((p) => p._id),
    [uuid(101), uuid(102), uuid(103)],
  );
});

test(
  "post-Sep-11 lineage proof: empty generated_signal_pairs window + populated primary_evidence_outbox " +
    "window still yields non-zero materializable input (the corrected current-evidence lineage)",
  async () => {
    const gspClient = makeFakeClient([]).client; // GSP genuinely empty for this D-1 window, as observed in production
    const outboxRows: OutboxRow[] = [
      envelope(1, T0, [evidenceRow(uuid(201)), evidenceRow(uuid(202), { condition_id: "0xcondition2" })]),
    ];
    const outboxClient = makeFakeClient(outboxRows as unknown as Record<string, unknown>[]).client;

    const gsp = await readSignalPairs(gspClient, iso(T0 - 1), iso(T0 + 1000));
    const outbox = await readPrimaryEvidenceOutbox(outboxClient, iso(T0 - 1), iso(T0 + 1000));

    assert.equal(gsp.pairs.length, 0, "reproduces the proven incident: GSP contributes zero rows post-transition");
    assert.equal(outbox.pairs.length, 2, "current authoritative source still materializes real production evidence");

    const combined = [...gsp.pairs, ...outbox.pairs];
    assert.equal(combined.length, 2, "combined input to the compact materializer is non-zero under the corrected lineage");
  },
);
