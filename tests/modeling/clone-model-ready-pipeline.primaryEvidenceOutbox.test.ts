// RESTORE_RESEARCH_CLONE_CURRENT_EVIDENCE_LINEAGE_V1 — end-to-end lineage proof.
//
// Proves the corrected semantic path required by the mission:
//   CURRENT_PRODUCTION_EVIDENCE (primary_evidence_outbox)
//     -> RESEARCH_CLONE materialization (readPrimaryEvidenceOutbox + buildCompactCorpus)
//     -> research_model_ready_rows (toStoredModelRow)
// on a bounded fixture dated after the proven 2026-09-11 stall, with GSP
// contributing zero rows (reproducing the proven incident exactly) and the
// current authoritative source alone carrying the population through.
//
// UNIT: compact PIT feature rows, one per canonical (condition_id,
// selected_token_id) identity.
// SOURCE_STAGE (this test): INPUT_RAW (primary_evidence_outbox evidence_rows)
//   -> OUTPUT_COMPACT (buildCompactCorpus rows) -> MODEL_READY (toStoredModelRow).
// INPUT_DENOMINATOR / OUTPUT_DENOMINATOR are asserted explicitly below and are
// never pooled with any GSP-sourced count.

import test from "node:test";
import assert from "node:assert/strict";

import { readPrimaryEvidenceOutbox } from "../../scripts/modeling/live-d1-research-corpus";
import { buildCompactCorpus, type CompactCorpusSlice } from "../../lib/modeling/forward-rich/compactCorpus";
import { normalizeMaterializedSportFamily } from "../../scripts/modeling/clone-model-ready-pipeline";
import { toStoredModelRow } from "../../lib/research-clone/modelReady";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

function makeFakeClient(rows: Record<string, unknown>[]) {
  function builder() {
    const filters: Array<{ op: "eq" | "gt" | "in"; field: string; value: unknown }> = [];
    const orders: Array<{ field: string; ascending: boolean }> = [];
    const chain = {
      select() { return chain; },
      eq(field: string, value: unknown) { filters.push({ op: "eq", field, value }); return chain; },
      gt(field: string, value: unknown) { filters.push({ op: "gt", field, value }); return chain; },
      in(field: string, value: unknown[]) { filters.push({ op: "in", field, value }); return chain; },
      order(field: string, opts?: { ascending?: boolean }) { orders.push({ field, ascending: opts?.ascending !== false }); return chain; },
      limit(n: number) {
        let out = rows.filter((r) => filters.every((f) => {
          const v = r[f.field];
          if (f.op === "eq") return v === f.value;
          if (f.op === "gt") return (v as string) > (f.value as string);
          if (f.op === "in") return (f.value as unknown[]).includes(v);
          return true;
        }));
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.field] as string; const bv = b[o.field] as string;
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
  return { from: () => builder() } as any;
}

const D1 = "2026-09-12"; // day after the proven Sep-11 stall
const DECISION_AT = "2026-09-12T05:30:00.000Z";
const EVENT_START = "2026-09-12T18:00:00.000Z"; // 12.5h lead time

test("PROOF: post-Sep-11 primary_evidence_outbox evidence reaches research_model_ready_rows shape, with GSP contributing zero", async () => {
  const gspClient = makeFakeClient([]);
  const outboxClient = makeFakeClient([
    {
      observation_id: "30000000-0000-0000-0000-000000000001",
      observed_at: DECISION_AT,
      evidence_rows: [
        {
          observation_id: "30000000-0000-0000-0000-0000000000a1",
          condition_id: "0xproof-condition",
          selected_token_id: "proof-token",
          formula_version: "v2-lite-growth-safe",
          entry_price_num: 0.55,
          signal_result: null,
          pre_event_score_num: 58,
          diagnostics: {
            providerEventId: "polymarket-proof-event",
            gameStartIso: EVENT_START,
            marketType: "moneyline",
            marketFamily: "moneyline",
            providerSportCode: "SOCCER",
            providerSportFamily: "soccer",
            volumeUsd: 5000,
          },
        },
      ],
      evidence_row_count: 1,
    },
  ]);

  const { pairs: gspPairs } = await import("../../scripts/modeling/live-d1-research-corpus").then((m) =>
    m.readSignalPairs(gspClient, "2026-09-12T00:00:00.000Z", "2026-09-13T00:00:00.000Z"),
  );
  assert.equal(gspPairs.length, 0, "INPUT_DENOMINATOR (GSP) = 0, reproducing the proven post-Sep-11 stall exactly");

  const { pairs: outboxPairs } = await readPrimaryEvidenceOutbox(
    outboxClient,
    "2026-09-12T00:00:00.000Z",
    "2026-09-13T00:00:00.000Z",
  );
  assert.equal(outboxPairs.length, 1, "INPUT_DENOMINATOR (primary_evidence_outbox) = 1");

  // Gamma terminal state resolution happens in main() via the public Gamma API;
  // this bounded unit proof supplies the settlement label directly rather than
  // making a network call, and never claims a WIN/LOSS the source didn't carry.
  const pairsWithSettlement = outboxPairs.map((p) => {
    const { _createdAt, _id, _cloneSignalResultRaw, ...clean } = p;
    return { ...clean, gammaTerminal: "WIN" as const };
  });

  const slice: CompactCorpusSlice = {
    sliceDateUtc: D1,
    sinceCutoff: "2026-09-12T00:00:00.000Z",
    materializedAt: "2026-09-13T02:00:00.000Z",
    signalPairs: pairsWithSettlement,
    observations: [],
  };
  const corpus = buildCompactCorpus(slice);
  assert.equal(corpus.rows.length, 1, "OUTPUT_DENOMINATOR (compact rows) = 1 -- one canonical identity, zero loss");

  const compactRow = corpus.rows[0] as unknown as Record<string, unknown>;
  assert.equal(compactRow.populationId, "SEP_PUBLIC_RICH_V1");
  assert.equal(compactRow.conditionId, "0xproof-condition");
  assert.equal(compactRow.selectedTokenId, "proof-token");
  assert.equal(compactRow.providerEventId, "polymarket-proof-event");
  assert.equal(compactRow.label, "WIN");

  const scorecardRow: ScorecardReadyRow = {
    ...(compactRow as unknown as ScorecardReadyRow),
    sportFamily: normalizeMaterializedSportFamily(compactRow as { providerSportFamily?: unknown }),
    frozenLabel: compactRow.label as "WIN" | "LOSS",
    labelAsOf: compactRow.label as "WIN" | "LOSS",
  };
  assert.equal(scorecardRow.sportFamily, "soccer");

  const storedRow = toStoredModelRow(D1, scorecardRow);
  assert.equal(storedRow.model_date, D1);
  assert.equal(storedRow.population_id, "SEP_PUBLIC_RICH_V1");
  assert.equal(storedRow.condition_id, "0xproof-condition");
  assert.equal(storedRow.selected_token_id, "proof-token");
  assert.equal(storedRow.provider_event_id, "polymarket-proof-event");
  assert.equal(storedRow.settlement_label, "WIN", "no synthetic settlement -- WIN was supplied, not fabricated");
  assert.equal(storedRow.source_kind, "RESEARCH_CLONE");
  assert.ok(storedRow.canonical_row_sha256.length === 64, "deterministic content hash present");
  // Matches ops/research-clone/model-ready-schema.sql's declared settlement_label enum.
  assert.match(storedRow.settlement_label, /^(WIN|LOSS|VOID|OPEN|NO_MATCH|AMBIGUOUS)$/);
});
