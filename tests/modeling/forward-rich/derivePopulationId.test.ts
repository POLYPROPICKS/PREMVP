/**
 * RESEARCH_CORPUS_POPULATION_CLASSIFIER_CORRECTION_V1 — regression proof.
 *
 * The accepted `derivePopulationId` contained a `decisionAt month == 2026-08`
 * shortcut that pushed legitimate forward public-rich rows into the IMMUTABLE
 * `AUG_SHADOW_C4_V1` benchmark whenever a Europe/Minsk rolling day began in the
 * prior UTC month. Classification is now producer/predicate driven only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { derivePopulationId } from "@/lib/modeling/forward-rich/materializeForwardRichResearch";
import { buildCompactCorpus, type CompactCorpusSlice } from "@/lib/modeling/forward-rich/compactCorpus";
import type { ForwardRichSignalPair } from "@/lib/modeling/forward-rich/types";

function pair(p: Partial<ForwardRichSignalPair>): ForwardRichSignalPair {
  return {
    conditionId: "0xcond",
    selectedTokenId: "tok",
    decisionAt: "2026-09-01T12:00:00.000Z",
    sourceCreatedAt: "2026-09-01T12:00:00.000Z",
    entryPriceNum: 0.5,
    volumeUsd: null,
    formulaVersion: "trusted-initial-formula-v1.1",
    ...p,
  };
}

test("1. a true frozen August benchmark row (explicit populationId) stays AUG_SHADOW_C4_V1", () => {
  assert.equal(
    derivePopulationId(pair({ populationId: "AUG_SHADOW_C4_V1", decisionAt: "2026-08-12T09:00:00.000Z" })),
    "AUG_SHADOW_C4_V1",
  );
});

test("2. a shadow-strategic forward row is SEP_SHADOW_STRATEGIC_V1 in August UTC", () => {
  assert.equal(
    derivePopulationId(pair({ formulaVersion: "shadow-strategic-sports-v1", decisionAt: "2026-08-31T21:06:20.000Z" })),
    "SEP_SHADOW_STRATEGIC_V1",
  );
});

test("2b. a shadow-strategic forward row is SEP_SHADOW_STRATEGIC_V1 in September UTC too", () => {
  assert.equal(
    derivePopulationId(pair({ formulaVersion: "shadow-strategic-sports-v1", decisionAt: "2026-09-02T10:00:00.000Z" })),
    "SEP_SHADOW_STRATEGIC_V1",
  );
});

test("3. a valid public-rich forward row with a late-August UTC DECISION_AT is SEP_PUBLIC_RICH_V1, not AUG_SHADOW_C4_V1", () => {
  const p = pair({ formulaVersion: "trusted-initial-formula-v1.1", decisionAt: "2026-08-31T21:06:20.199579+00:00" });
  assert.equal(derivePopulationId(p), "SEP_PUBLIC_RICH_V1");
  assert.notEqual(derivePopulationId(p), "AUG_SHADOW_C4_V1");
});

test("4. the same public-rich producer lineage stays SEP_PUBLIC_RICH_V1 across the Aug -> Sep boundary", () => {
  for (const decisionAt of [
    "2026-08-25T12:00:00.000Z",
    "2026-08-31T23:59:59.000Z",
    "2026-09-01T00:00:01.000Z",
    "2026-09-02T18:45:00.000Z",
  ]) {
    assert.equal(derivePopulationId(pair({ decisionAt })), "SEP_PUBLIC_RICH_V1", decisionAt);
  }
});

test("4b. no forward public-rich row inside the frozen August benchmark window is misrouted", () => {
  for (let d = 5; d <= 25; d++) {
    const decisionAt = `2026-08-${String(d).padStart(2, "0")}T15:00:00.000Z`;
    assert.equal(derivePopulationId(pair({ decisionAt })), "SEP_PUBLIC_RICH_V1", decisionAt);
  }
});

test("5. the accepted 2026-09-02 D-1 partition population semantics are unchanged", () => {
  const dir = "modeling/evidence/research-corpus-factory-live-v1";
  const manifest = JSON.parse(readFileSync(`${dir}/MANIFEST_2026-09-02.json`, "utf8"));
  const byPop = Object.fromEntries(
    (manifest.POPULATIONS as Array<{ population_id: string; COMPACT_ROW_N: { value: number } }>).map((p) => [
      p.population_id,
      p.COMPACT_ROW_N.value,
    ]),
  );
  assert.deepEqual(byPop, { SEP_PUBLIC_RICH_V1: 501, SEP_SHADOW_STRATEGIC_V1: 636 });
  assert.equal(manifest.CANONICAL_CONTENT_SHA256, "0e06fd869462118b79138cf6741c188f2d58c551f3f8023eadbc6b18eb2d7287");
});

test("BOUNDARY PROBE: a Europe/Minsk day crossing late-August UTC no longer yields AUG_SHADOW_C4_V1", () => {
  // Minsk 2026-09-01 window = [2026-08-31T21:00Z, 2026-09-01T21:00Z); the burst
  // that previously mis-populated lands at 2026-08-31T21:06Z.
  const slice: CompactCorpusSlice = {
    sliceDateUtc: "2026-09-01",
    sinceCutoff: "2026-08-31T21:00:00.000Z",
    materializedAt: "2026-09-03T00:00:00.000Z",
    signalPairs: [
      pair({ conditionId: "0xa", selectedTokenId: "t1", decisionAt: "2026-08-31T21:06:20.199579+00:00", formulaVersion: "trusted-initial-formula-v1.1" }),
      pair({ conditionId: "0xb", selectedTokenId: "t2", decisionAt: "2026-08-31T21:06:41.000000+00:00", formulaVersion: "shadow-strategic-sports-v1" }),
    ],
    observations: [],
  };
  const { rows, populationRowCounts } = buildCompactCorpus(slice);
  assert.equal(populationRowCounts.AUG_SHADOW_C4_V1, 0);
  assert.equal(rows.find((r) => r.conditionId === "0xa")?.populationId, "SEP_PUBLIC_RICH_V1");
  assert.equal(rows.find((r) => r.conditionId === "0xb")?.populationId, "SEP_SHADOW_STRATEGIC_V1");
});
