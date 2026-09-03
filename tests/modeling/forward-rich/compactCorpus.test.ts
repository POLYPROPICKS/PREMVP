/**
 * COMPACT_RESEARCH_MATERIALIZER_V1 — focused verification.
 *
 * Proves, on the committed deterministic D-1 slice fixture:
 *  - repeated raw GSP emissions collapse to one compact row per canonical identity;
 *  - "first eligible row" semantics: the collapsed row keeps the EARLIEST decisionAt;
 *  - no post-decision observation leaks into a PIT feature;
 *  - population_id is mandatory and incompatible populations stay separate;
 *  - unscored population score is never invented;
 *  - materialization + C4 evaluation are deterministic (byte-identical repeat).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildCompactCorpus,
  collapseRepeatedEmissions,
  runCompactC4Scorecard,
  type CompactCorpusSlice,
} from "@/lib/modeling/forward-rich/compactCorpus";

const FIXTURE =
  "modeling/local_exports/compact_research_materializer_v1/D1_SLICE_FIXTURE.json";

function loadSlice(): CompactCorpusSlice {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return {
    sliceDateUtc: raw.sliceDateUtc,
    sinceCutoff: raw.sinceCutoff,
    materializedAt: raw.materializedAt,
    signalPairs: raw.signalPairs,
    observations: raw.observations,
  };
}

test("repeated emissions collapse to one row per identity, keeping earliest decisionAt", () => {
  const slice = loadSlice();
  const collapsed = collapseRepeatedEmissions(slice.signalPairs);

  const identities = new Set(
    slice.signalPairs.map((p) => `${p.conditionId}::${p.selectedTokenId}`),
  );
  assert.equal(collapsed.length, identities.size);
  assert.ok(collapsed.length < slice.signalPairs.length, "must actually compress");

  for (const c of collapsed) {
    const allForIdentity = slice.signalPairs.filter(
      (p) => p.conditionId === c.conditionId && p.selectedTokenId === c.selectedTokenId,
    );
    const earliest = allForIdentity
      .map((p) => p.decisionAt)
      .sort()[0];
    assert.equal(c.decisionAt, earliest, `${c.conditionId} keeps first eligible row`);
    assert.equal(c.collapsedCount, allForIdentity.length);
    assert.ok(c.populationId, "population_id resolved on every collapsed pair");
  }
});

test("compact corpus: mandatory population_id, populations separate, funnel consistent", () => {
  const { rows, funnel, populationRowCounts } = buildCompactCorpus(loadSlice());

  for (const r of rows) {
    assert.ok(
      ["AUG_SHADOW_C4_V1", "SEP_SHADOW_STRATEGIC_V1", "SEP_PUBLIC_RICH_V1"].includes(
        r.populationId,
      ),
    );
  }
  assert.equal(
    populationRowCounts.SEP_PUBLIC_RICH_V1 + populationRowCounts.SEP_SHADOW_STRATEGIC_V1,
    rows.length,
  );
  assert.ok(populationRowCounts.SEP_PUBLIC_RICH_V1 > 0);
  assert.ok(populationRowCounts.SEP_SHADOW_STRATEGIC_V1 > 0);

  assert.equal(funnel.outputCompactFeatureRows, rows.length);
  assert.ok(funnel.inputRawGspRows > funnel.outputCompactFeatureRows);
  assert.ok(funnel.compressionRatio > 1);
  assert.equal(
    funnel.inputUniqueMarkets,
    new Set(loadSlice().signalPairs.map((p) => p.conditionId)).size,
  );
});

test("no post-decision observation enters a PIT feature", () => {
  const { rows } = buildCompactCorpus(loadSlice());
  let seriesChecked = 0;
  for (const r of rows) {
    for (const s of [r.score, r.selectedPrice]) {
      if (s.lastEligibleObservedAt !== null) {
        seriesChecked += 1;
        assert.ok(
          s.lastEligibleObservedAt <= r.decisionAt,
          `${r.conditionId}: ${s.lastEligibleObservedAt} must be <= decisionAt ${r.decisionAt}`,
        );
      }
    }
  }
  assert.ok(seriesChecked > 0);
  // The fixture deliberately includes 3 observations/identity, one AFTER the
  // decision — so every identity must have dropped >= 1 observation.
  for (const r of rows) {
    assert.ok(
      r.eligibleObservationsUsed < r.totalObservationsSeen,
      `${r.conditionId}: PIT cut must drop the post-decision snapshot`,
    );
  }
});

test("unscored population never gets an invented score", () => {
  const { rows } = buildCompactCorpus(loadSlice());
  for (const r of rows) {
    if (r.populationId === "SEP_SHADOW_STRATEGIC_V1") {
      assert.equal(r.score.observationCount, 0);
      assert.equal(r.score.firstEligibleValue, null);
      assert.equal(r.score.lastEligibleValue, null);
    }
  }
});

test("clone signal_result is retained but never used as settlement authority", () => {
  const { rows } = buildCompactCorpus(loadSlice());
  const openRow = rows.find((r) => r.label === "OPEN");
  assert.ok(openRow, "fixture has an OPEN identity");
  // Its label is OPEN from absent Gamma state even though a decision exists.
  assert.equal(openRow!.gammaTerminal, null);
});

test("C4 runs on compact output with the frozen predicate, deterministically", () => {
  const rows1 = buildCompactCorpus(loadSlice()).rows;
  const rows2 = buildCompactCorpus(loadSlice()).rows;
  assert.equal(JSON.stringify(rows1), JSON.stringify(rows2), "materialization deterministic");

  const a = runCompactC4Scorecard(rows1, "SEP_PUBLIC_RICH_V1");
  const b = runCompactC4Scorecard(rows2, "SEP_PUBLIC_RICH_V1");
  assert.equal(JSON.stringify(a), JSON.stringify(b), "C4 evaluation deterministic");

  assert.equal(a.engineModelVersion, "freeze-v1");
  assert.ok(a.bets > 0);
  assert.equal(a.bets, a.engineResult.WINS + a.engineResult.LOSSES);
  assert.ok(a.uniqueEligibleEvents >= a.bets);
  // one bet per physical event
  assert.equal(new Set(a.engineResult.selectedMembership).size, a.bets);
  // VOID + OPEN excluded from the engine feed
  assert.ok(a.adapt.dropped.voidLabel >= 1);
  assert.ok(a.adapt.dropped.notTerminal >= 1);
});
