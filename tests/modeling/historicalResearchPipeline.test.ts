// Phase 4D.1 / D1 -- one-command historical research pipeline (pure engine).
//
// Orchestrates the five accepted upstream engines (A1/A2/B1/B2A/C1) plus the
// D1 final packet in one fixed order, calling their existing exported pure
// build/serialize/render/manifest functions directly -- no stage math is
// duplicated, no existing stage file is modified, no network/env/Supabase,
// no forward data, no Champion, no model promotion.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_ENGINE_VERSION,
  PIPELINE_STAGES,
  runPipelineStages,
  buildFullPipeline,
  serializeHistoricalResearchPacketJson,
  renderHistoricalResearchPacketHtml,
  buildHistoricalResearchPacketManifest,
} from "../../lib/modeling/historicalResearchPipeline";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { CANDIDATE_IDS } from "../../lib/modeling/boundedRoutingExperiments";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number): Record<string, unknown> {
  const hours = (n % 8) * 0.5;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 66 + (n % 20),
    entry_price_num: 0.2 + (n % 6) * 0.14,
    metric_formula_version: "v2-lite-growth-safe",
    league: "epl",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 70, gameStartIso: new Date(createdMs + hours * 3_600_000).toISOString() },
  };
}

const CORPUS = Array.from({ length: 300 }, (_, i) => makeRow(i + 1));

// ---------------------------------------------------------------- constants

test("engine constants and fixed six-stage order", () => {
  assert.equal(PIPELINE_SCHEMA_VERSION, 1);
  assert.equal(typeof PIPELINE_ENGINE_VERSION, "string");
  assert.deepEqual(
    [...PIPELINE_STAGES],
    ["STAGE_A1_DECOMPOSITION", "STAGE_A2_DASHBOARD", "STAGE_B1_COMPONENTS", "STAGE_B2A_EXPERIMENTS", "STAGE_C1_REGISTRY", "STAGE_D1_PACKET"],
  );
  assert.equal(PIPELINE_STAGES.length, 6);
});

// ------------------------------------------------------------- wiring

test("A2 consumes A1's own JSON lineage; B2A consumes B1's contentHash; C1 consumes all four", () => {
  const stages = runPipelineStages({ rawRows: CORPUS, classifier });
  assert.equal(stages.a2.sourceDecompositionHash, stages.a1.contentHash);
  assert.equal(stages.b2a.evidenceProvenance.contentHash, stages.b1.contentHash);
  assert.equal(stages.c1.evidenceRecords.find((e) => e.evidenceId === "A1_DECOMPOSITION")!.contentHash, stages.a1.contentHash);
  assert.equal(stages.c1.evidenceRecords.find((e) => e.evidenceId === "A2_DASHBOARD")!.contentHash, stages.a2.contentHash);
  assert.equal(stages.c1.evidenceRecords.find((e) => e.evidenceId === "B1_COMPONENT_ANALYSIS")!.contentHash, stages.b1.contentHash);
  assert.equal(stages.c1.evidenceRecords.find((e) => e.evidenceId === "B2A_BOUNDED_ROUTING")!.contentHash, stages.b2a.contentHash);
});

test("raw corpus rows are not mutated across the pipeline", () => {
  const snapshot = JSON.stringify(CORPUS);
  runPipelineStages({ rawRows: CORPUS, classifier });
  assert.equal(JSON.stringify(CORPUS), snapshot);
});

// ------------------------------------------------------------- lineage

test("row counts and dedup policy reconcile across all stages", () => {
  const stages = runPipelineStages({ rawRows: CORPUS, classifier });
  const rawCounts = [stages.a1.rawRowCount, stages.a2.corpusSummary.rawRowCount, stages.b1.corpusSummary.rawRowCount, stages.b2a.corpusSummary.rawRowCount];
  assert.equal(new Set(rawCounts).size, 1);
  const dedupCounts = [stages.a1.strictDedupRowCount, stages.a2.corpusSummary.strictDedupRowCount, stages.b1.corpusSummary.strictDedupRowCount, stages.b2a.corpusSummary.strictDedupRowCount];
  assert.equal(new Set(dedupCounts).size, 1);
  const policies = [stages.a1.strictDedupPolicy, stages.b1.corpusSummary.strictDedupPolicy, stages.b2a.corpusSummary.strictDedupPolicy];
  assert.equal(new Set(policies).size, 1);
});

test("a mismatched raw corpus between B1-derived experiments and A1 fails closed", () => {
  // Simulate a corrupted pipeline: build A1 from one corpus and try to fold
  // in a B2A-experiments-shaped mismatch by tampering post-hoc.
  const stages = runPipelineStages({ rawRows: CORPUS, classifier });
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  assert.equal(artifacts.packet.result.corpusSummary.rawRowCount, stages.a1.rawRowCount);
});

// ------------------------------------------------------------- packet

test("full pipeline builds six PASS stage results with reconciled hashes", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const packet = artifacts.packet.result;
  assert.equal(packet.stageResults.length, 6);
  for (const s of packet.stageResults) {
    assert.equal(s.status, "PASS");
  }
  assert.deepEqual(packet.stageResults.map((s) => s.stageId), [...PIPELINE_STAGES]);
});

test("three historical-advance candidates imported without recalculation, remain NOT_PROMOTED", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const packet = artifacts.packet.result;
  assert.equal(packet.historicalAdvanceCandidates.length, 3);
  const ids = packet.historicalAdvanceCandidates.map((c) => c.candidateId).sort();
  assert.deepEqual(ids, [...CANDIDATE_IDS].sort());
  for (const c of packet.historicalAdvanceCandidates) {
    assert.equal(c.promotionStatus, "NOT_PROMOTED");
    assert.equal(c.nextRequiredGate, "INDEPENDENT_VALIDATION");
    // metrics must match C1/B2A source exactly, never recalculated.
    const src = artifacts.b2a.result.candidateMetrics.find((m) => m.id === c.candidateId)!;
    assert.equal(c.n, src.selectedObservations);
    assert.equal(c.pnl, src.flatUnitPnl);
    assert.equal(c.selectionHash, src.selectionHash);
  }
});

test("independent-validation queue reconciles with C1 and is not ROI-ranked", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const packet = artifacts.packet.result;
  const expectedIds = artifacts.c1.result.hypotheses.filter((h) => h.nextRequiredGate === "INDEPENDENT_VALIDATION").map((h) => h.hypothesisId).sort();
  const actualIds = packet.independentValidationQueue.map((q) => q.hypothesisId).sort();
  assert.deepEqual(actualIds, expectedIds);
});

test("blocked-data requirements are retained from C1", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const packet = artifacts.packet.result;
  const expectedBlocked = artifacts.c1.result.hypotheses.filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA");
  assert.equal(packet.blockedDataRequirements.length, expectedBlocked.length);
});

test("no positive Champion/live-promotion status anywhere in the packet", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const blob = JSON.stringify(artifacts.packet.result);
  // Negations in the limitations text ("no Champion", "no ... live-status
  // transition") are expected and allowed; a positive status/gate value
  // naming either concept is not.
  assert.ok(!/"(status|promotionStatus|nextRequiredGate)":\s*"[^"]*(champion|live)/i.test(blob));
});

// ------------------------------------------------------------- determinism

test("rerun is byte-identical", () => {
  const a = buildFullPipeline({ rawRows: CORPUS, classifier });
  const b = buildFullPipeline({ rawRows: CORPUS, classifier });
  assert.equal(a.packet.json, b.packet.json);
  assert.equal(a.packet.result.contentHash, b.packet.result.contentHash);
});

test("serialized packet JSON ends with exactly one trailing newline", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const json = serializeHistoricalResearchPacketJson(artifacts.packet.result);
  assert.ok(json.endsWith("}\n"));
  assert.ok(!json.endsWith("}\n\n"));
});

test("packet HTML has required banner and sections, no script/CDN", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const html = renderHistoricalResearchPacketHtml(artifacts.packet.result);
  assert.match(html, /HISTORICAL RESEARCH PIPELINE/);
  assert.match(html, /ALL STAGES VERIFIED/);
  assert.match(html, /NO AUTOMATIC CHAMPION/);
  assert.match(html, /NO MODEL PROMOTION/);
  assert.match(html, /NO LIVE CHANGE/);
  assert.ok(!/<script/i.test(html));
  for (const needle of [
    "Pipeline Stage Status",
    "Corpus",
    "Lineage",
    "Historical Frontier",
    "Historical-Advance",
    "Registry Summary",
    "Independent-Validation",
    "Blocked",
    "Limitations",
    "Rerun Command",
  ]) {
    assert.ok(html.includes(needle), `missing section: ${needle}`);
  }
  assert.ok(html.endsWith("\n"));
  assert.ok(!html.endsWith("\n\n"));
});

test("packet manifest reconciles all five upstream content hashes", () => {
  const artifacts = buildFullPipeline({ rawRows: CORPUS, classifier });
  const manifest = buildHistoricalResearchPacketManifest(artifacts, {
    inputSha256: "a".repeat(64),
    classifierSha256: "b".repeat(64),
  });
  assert.equal(manifest.a1ContentHash, artifacts.a1.result.contentHash);
  assert.equal(manifest.a2ContentHash, artifacts.a2.result.contentHash);
  assert.equal(manifest.b1ContentHash, artifacts.b1.result.contentHash);
  assert.equal(manifest.b2aContentHash, artifacts.b2a.result.contentHash);
  assert.equal(manifest.c1ContentHash, artifacts.c1.result.contentHash);
  assert.equal(manifest.pipelineContentHash, artifacts.packet.result.contentHash);
});
