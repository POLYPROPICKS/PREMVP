// One-command Historical Research Pipeline (Phase 4D.1 / D1).
//
// Orchestrates the five accepted upstream engines -- A1 extended
// decomposition, A2 extended dashboard, B1 score-component analysis, B2A
// bounded routing experiments, C1 hypothesis registry -- in one fixed order,
// calling their EXISTING exported pure build/serialize/render/manifest
// functions directly. No stage math is duplicated, no stage file is
// modified, no candidate/model/score-weight change happens here. This
// module is pure: no fs/env/network/Supabase, no mutation of input, no
// forward/post-cutoff data, no Champion, no model promotion.

import { createHash } from "node:crypto";
import {
  buildExtendedHistoricalDecomposition,
  serializeExtendedDecompositionJson,
  renderExtendedDecompositionSummaryHtml,
  buildExtendedDecompositionManifest,
  type ExtendedHistoricalDecomposition,
} from "./extendedHistoricalDecomposition";
import {
  buildExtendedHistoricalDashboard,
  serializeExtendedDashboardJson,
  renderExtendedHistoricalDashboardHtml,
  buildExtendedDashboardManifest,
  type ExtendedHistoricalDashboard,
} from "./extendedHistoricalDashboard";
import {
  buildScoreComponentAnalysis,
  serializeScoreComponentAnalysisJson,
  renderScoreComponentAnalysisHtml,
  buildScoreComponentAnalysisManifest,
  type ScoreComponentAnalysisResult,
} from "./scoreComponentAnalysis";
import {
  buildBoundedRoutingExperiments,
  serializeBoundedRoutingJson,
  renderBoundedRoutingHtml,
  buildBoundedRoutingManifest,
  type BoundedRoutingResult,
} from "./boundedRoutingExperiments";
import {
  buildHypothesisRegistry,
  serializeHypothesisRegistryJson,
  renderHypothesisRegistryHtml,
  buildHypothesisRegistryManifest,
  type HypothesisRegistryResult,
  type FrontierRow,
  type RegistrySummary,
} from "./hypothesisRegistry";
import { SCORECARD_MODEL_ORDER } from "./historicalModelScorecard";
import type { ExportRow } from "./generatedSignalPairsExportContract";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = ExportRow;

export const PIPELINE_SCHEMA_VERSION = 1 as const;
export const PIPELINE_ENGINE_VERSION = "4D.1-historical-research-pipeline-v1" as const;

export const PIPELINE_STAGES = [
  "STAGE_A1_DECOMPOSITION",
  "STAGE_A2_DASHBOARD",
  "STAGE_B1_COMPONENTS",
  "STAGE_B2A_EXPERIMENTS",
  "STAGE_C1_REGISTRY",
  "STAGE_D1_PACKET",
] as const;
export type PipelineStageId = (typeof PIPELINE_STAGES)[number];

// ------------------------------------------------------------- stage run

export interface RunPipelineStagesInput {
  rawRows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
}

export interface PipelineStageResults {
  a1: ExtendedHistoricalDecomposition;
  a2: ExtendedHistoricalDashboard;
  b1: ScoreComponentAnalysisResult;
  b2a: BoundedRoutingResult;
  c1: HypothesisRegistryResult;
}

function fail(msg: string): never {
  throw new Error(`historical research pipeline: ${msg}`);
}

/**
 * Explicit pipeline-level cross-stage lineage assertions. buildHypothesisRegistry
 * already fails closed on the A2/B2A/C1 lineage hashes and corpus/dedup
 * reconciliation (reused, not reimplemented) -- this adds the classifier-hash
 * check, which is only carried in-band by A1.
 */
function validateCrossStageLineage(stages: PipelineStageResults, classifier: ExecutableFunnelClassifier): void {
  const classifierSha256 = createHash("sha256").update(JSON.stringify(classifier)).digest("hex");
  if (stages.a1.classifierSha256 !== classifierSha256) {
    fail("classifier hash used for A1 does not match the classifier passed to the pipeline");
  }
}

/**
 * Runs the five fixed upstream stages (A1 -> A2 -> B1 -> B2A -> C1) in order,
 * reusing each stage's existing exported pure build function verbatim. No
 * stage is skipped, no dynamic stage is introduced, no stage math is
 * reimplemented. Input rows are never mutated.
 */
export function runPipelineStages(input: RunPipelineStagesInput): PipelineStageResults {
  if (!Array.isArray(input.rawRows) || input.rawRows.length === 0) {
    fail("input corpus must be a non-empty array of rows");
  }
  const variantIds = [...SCORECARD_MODEL_ORDER];

  const a1 = buildExtendedHistoricalDecomposition({
    rawRows: input.rawRows,
    classifier: input.classifier,
    requestedVariantIds: variantIds,
  });
  const a2 = buildExtendedHistoricalDashboard({ decomposition: a1 });
  // B1 must see the full canonical model set (not ALT4 alone) so its
  // uniqueCohorts can detect B1 exact cohort aliases across all 12 models --
  // an ALT4-only evidence set silently drops that alias/duplicate evidence
  // for C1 even though B2A candidate selection itself never depends on it.
  const b1 = buildScoreComponentAnalysis({
    rawRows: input.rawRows,
    classifier: input.classifier,
    requestedVariantIds: variantIds,
  });
  const b2a = buildBoundedRoutingExperiments({ rawRows: input.rawRows, classifier: input.classifier, evidence: b1 });
  const c1 = buildHypothesisRegistry({ decomposition: a1, dashboard: a2, components: b1, experiments: b2a });

  const stages: PipelineStageResults = { a1, a2, b1, b2a, c1 };
  validateCrossStageLineage(stages, input.classifier);
  return stages;
}

// ------------------------------------------------------------- packet types

/**
 * ACTUAL_ARTIFACT_SHA256: contentHash/jsonSha256/htmlSha256/manifestSha256
 * are real sha256 hashes of that stage's own written artifacts.
 * COMPOSITE_UPSTREAM_LINEAGE: those same fields instead carry a deterministic
 * hash of the five verified upstream stage contentHashes -- used ONLY for the
 * D1_PACKET self-row, since the packet's own bytes cannot hash themselves.
 * The packet's actual json/html sha256 always live in the top-level
 * historical_research_packet_manifest.json (jsonSha256/htmlSha256/artifactSha256s).
 */
export const HASH_SEMANTICS = ["ACTUAL_ARTIFACT_SHA256", "COMPOSITE_UPSTREAM_LINEAGE"] as const;
export type HashSemantics = (typeof HASH_SEMANTICS)[number];

export interface StageArtifactSummary {
  stageId: PipelineStageId;
  engineVersion: string;
  status: "PASS";
  contentHash: string;
  jsonSha256: string;
  htmlSha256: string;
  manifestSha256: string;
  hashSemantics: HashSemantics;
  artifactNames: string[];
}

export interface StageLineageEntry {
  stageId: PipelineStageId;
  dependsOn: PipelineStageId[];
  contentHash: string;
  verifiedAgainst: Record<string, string>;
}

export interface HistoricalAdvanceCandidate {
  candidateId: string;
  parentId: string;
  n: number;
  pnl: number | null;
  roi: number | null;
  maxDD: number;
  longestLosingStreak: number;
  selectionHash: string;
  promotionStatus: "NOT_PROMOTED";
  nextRequiredGate: "INDEPENDENT_VALIDATION";
}

export interface IndependentValidationQueueEntry {
  hypothesisId: string;
  title: string;
  type: string;
  candidateId: string | null;
}

export interface BlockedDataRequirement {
  hypothesisId: string;
  title: string;
  blockedReasons: string[];
}

export interface HistoricalResearchPacket {
  schemaVersion: typeof PIPELINE_SCHEMA_VERSION;
  engineVersion: typeof PIPELINE_ENGINE_VERSION;
  pipelineContract: { stages: readonly PipelineStageId[] };
  corpusSummary: { rawRowCount: number; strictDedupRowCount: number; strictDedupPolicy: string };
  classifierProvenance: { classifierSha256: string };
  stageResults: StageArtifactSummary[];
  stageLineage: StageLineageEntry[];
  historicalFrontier: FrontierRow[];
  registrySummary: RegistrySummary;
  historicalAdvanceCandidates: HistoricalAdvanceCandidate[];
  blockedDataRequirements: BlockedDataRequirement[];
  independentValidationQueue: IndependentValidationQueueEntry[];
  limitations: string[];
  contentHash: string;
}

// ------------------------------------------------------------- full build

export interface StageArtifacts<T> {
  result: T;
  json: string;
  html: string;
  manifest: string;
}

export interface FullPipelineArtifacts {
  a1: StageArtifacts<ExtendedHistoricalDecomposition>;
  a2: StageArtifacts<ExtendedHistoricalDashboard>;
  b1: StageArtifacts<ScoreComponentAnalysisResult>;
  b2a: StageArtifacts<BoundedRoutingResult>;
  c1: StageArtifacts<HypothesisRegistryResult>;
  packet: StageArtifacts<HistoricalResearchPacket>;
}

export const STAGE_ARTIFACT_NAMES: Record<Exclude<PipelineStageId, "STAGE_D1_PACKET">, string[]> = {
  STAGE_A1_DECOMPOSITION: ["extended_historical_decomposition.json", "extended_historical_decomposition_summary.html", "extended_historical_decomposition_manifest.json"],
  STAGE_A2_DASHBOARD: ["extended_historical_dashboard.json", "extended_historical_dashboard.html", "extended_historical_dashboard_manifest.json"],
  STAGE_B1_COMPONENTS: ["score_component_analysis.json", "score_component_analysis.html", "score_component_analysis_manifest.json"],
  STAGE_B2A_EXPERIMENTS: ["bounded_routing_experiments.json", "bounded_routing_experiments.html", "bounded_routing_experiments_manifest.json"],
  STAGE_C1_REGISTRY: ["hypothesis_registry.json", "hypothesis_registry.html", "hypothesis_registry_manifest.json"],
};

export const PACKET_ARTIFACT_NAMES = ["historical_research_packet.json", "historical_research_packet.html", "historical_research_packet_manifest.json"];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function round6(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Runs all five upstream stages and builds the D1 final packet, entirely in
 * memory (no fs). Every artifact's exact bytes are produced by that stage's
 * own accepted serialize/render/manifest function -- never reimplemented --
 * so the CLI only needs to write the strings this function already computed.
 */
export function buildFullPipeline(input: RunPipelineStagesInput): FullPipelineArtifacts {
  const stages = runPipelineStages(input);

  const a1Json = serializeExtendedDecompositionJson(stages.a1);
  const a1Html = renderExtendedDecompositionSummaryHtml(stages.a1);
  const a1Manifest = `${JSON.stringify(buildExtendedDecompositionManifest(stages.a1, a1Json, a1Html), null, 2)}\n`;

  const a2Json = serializeExtendedDashboardJson(stages.a2);
  const a2Html = renderExtendedHistoricalDashboardHtml(stages.a2);
  const a2Manifest = `${JSON.stringify(buildExtendedDashboardManifest(stages.a2, a1Json, a2Json, a2Html), null, 2)}\n`;

  const b1Json = serializeScoreComponentAnalysisJson(stages.b1);
  const b1Html = renderScoreComponentAnalysisHtml(stages.b1);
  const b1Manifest = `${JSON.stringify(buildScoreComponentAnalysisManifest(stages.b1, b1Json, b1Html), null, 2)}\n`;

  const inputSha256 = sha256(JSON.stringify(input.rawRows));
  const classifierSha256 = sha256(JSON.stringify(input.classifier));
  const b2aJson = serializeBoundedRoutingJson(stages.b2a);
  const b2aHtml = renderBoundedRoutingHtml(stages.b2a);
  const b2aManifest = `${JSON.stringify(
    buildBoundedRoutingManifest(stages.b2a, { inputSha256, classifierSha256, evidenceSha256: sha256(b1Json) }, b2aJson, b2aHtml),
    null,
    2,
  )}\n`;

  const c1Json = serializeHypothesisRegistryJson(stages.c1);
  const c1Html = renderHypothesisRegistryHtml(stages.c1);
  const c1Manifest = `${JSON.stringify(
    buildHypothesisRegistryManifest(
      stages.c1,
      { decompositionSha256: sha256(a1Json), dashboardSha256: sha256(a2Json), componentsSha256: sha256(b1Json), experimentsSha256: sha256(b2aJson) },
      c1Json,
      c1Html,
    ),
    null,
    2,
  )}\n`;

  const stageResults: StageArtifactSummary[] = [
    { stageId: "STAGE_A1_DECOMPOSITION", engineVersion: stages.a1.engineVersion, status: "PASS", contentHash: stages.a1.contentHash, jsonSha256: sha256(a1Json), htmlSha256: sha256(a1Html), manifestSha256: sha256(a1Manifest), hashSemantics: "ACTUAL_ARTIFACT_SHA256", artifactNames: STAGE_ARTIFACT_NAMES.STAGE_A1_DECOMPOSITION },
    { stageId: "STAGE_A2_DASHBOARD", engineVersion: stages.a2.engineVersion, status: "PASS", contentHash: stages.a2.contentHash, jsonSha256: sha256(a2Json), htmlSha256: sha256(a2Html), manifestSha256: sha256(a2Manifest), hashSemantics: "ACTUAL_ARTIFACT_SHA256", artifactNames: STAGE_ARTIFACT_NAMES.STAGE_A2_DASHBOARD },
    { stageId: "STAGE_B1_COMPONENTS", engineVersion: stages.b1.engineVersion, status: "PASS", contentHash: stages.b1.contentHash, jsonSha256: sha256(b1Json), htmlSha256: sha256(b1Html), manifestSha256: sha256(b1Manifest), hashSemantics: "ACTUAL_ARTIFACT_SHA256", artifactNames: STAGE_ARTIFACT_NAMES.STAGE_B1_COMPONENTS },
    { stageId: "STAGE_B2A_EXPERIMENTS", engineVersion: stages.b2a.engineVersion, status: "PASS", contentHash: stages.b2a.contentHash, jsonSha256: sha256(b2aJson), htmlSha256: sha256(b2aHtml), manifestSha256: sha256(b2aManifest), hashSemantics: "ACTUAL_ARTIFACT_SHA256", artifactNames: STAGE_ARTIFACT_NAMES.STAGE_B2A_EXPERIMENTS },
    { stageId: "STAGE_C1_REGISTRY", engineVersion: stages.c1.engineVersion, status: "PASS", contentHash: stages.c1.contentHash, jsonSha256: sha256(c1Json), htmlSha256: sha256(c1Html), manifestSha256: sha256(c1Manifest), hashSemantics: "ACTUAL_ARTIFACT_SHA256", artifactNames: STAGE_ARTIFACT_NAMES.STAGE_C1_REGISTRY },
  ];

  const stageLineage: StageLineageEntry[] = [
    { stageId: "STAGE_A1_DECOMPOSITION", dependsOn: [], contentHash: stages.a1.contentHash, verifiedAgainst: {} },
    { stageId: "STAGE_A2_DASHBOARD", dependsOn: ["STAGE_A1_DECOMPOSITION"], contentHash: stages.a2.contentHash, verifiedAgainst: { sourceDecompositionHash: stages.a1.contentHash } },
    { stageId: "STAGE_B1_COMPONENTS", dependsOn: [], contentHash: stages.b1.contentHash, verifiedAgainst: {} },
    { stageId: "STAGE_B2A_EXPERIMENTS", dependsOn: ["STAGE_B1_COMPONENTS"], contentHash: stages.b2a.contentHash, verifiedAgainst: { evidenceContentHash: stages.b1.contentHash } },
    {
      stageId: "STAGE_C1_REGISTRY",
      dependsOn: ["STAGE_A1_DECOMPOSITION", "STAGE_A2_DASHBOARD", "STAGE_B1_COMPONENTS", "STAGE_B2A_EXPERIMENTS"],
      contentHash: stages.c1.contentHash,
      verifiedAgainst: {
        decompositionContentHash: stages.a1.contentHash,
        dashboardContentHash: stages.a2.contentHash,
        componentsContentHash: stages.b1.contentHash,
        experimentsContentHash: stages.b2a.contentHash,
      },
    },
  ];

  const candidateHypById = new Map(stages.c1.hypotheses.filter((h) => h.scope === "B2A_BOUNDED_CANDIDATE").map((h) => [h.relatedModelIds[0], h]));
  const historicalAdvanceCandidates: HistoricalAdvanceCandidate[] = stages.b2a.candidateMetrics.map((m) => {
    const def = stages.b2a.candidateDefinitions.find((d) => d.id === m.id)!;
    const hyp = candidateHypById.get(m.id);
    return {
      candidateId: m.id,
      parentId: def.parentId,
      n: m.selectedObservations,
      pnl: m.flatUnitPnl,
      roi: m.flatUnitRoi,
      maxDD: m.maximumDrawdownUnits,
      longestLosingStreak: m.longestLosingStreak,
      selectionHash: m.selectionHash,
      promotionStatus: "NOT_PROMOTED",
      nextRequiredGate: hyp?.nextRequiredGate === "INDEPENDENT_VALIDATION" ? "INDEPENDENT_VALIDATION" : "INDEPENDENT_VALIDATION",
    };
  });

  const blockedDataRequirements: BlockedDataRequirement[] = stages.c1.hypotheses
    .filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA")
    .map((h) => ({ hypothesisId: h.hypothesisId, title: h.title, blockedReasons: h.blockedReasons }));

  // Order: historical frontier order first (for candidates that are also on
  // the frontier), then lexical hypothesis ID -- never ranked solely by ROI.
  const frontierOrder = new Map(stages.c1.historicalFrontier.map((f, i) => [f.candidateId, i]));
  const independentValidationQueue: IndependentValidationQueueEntry[] = stages.c1.hypotheses
    .filter((h) => h.nextRequiredGate === "INDEPENDENT_VALIDATION")
    .map((h) => ({ hypothesisId: h.hypothesisId, title: h.title, type: h.type, candidateId: h.relatedModelIds[0] ?? null }))
    .sort((a, b) => {
      const aRank = a.candidateId !== null ? (frontierOrder.get(a.candidateId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bRank = b.candidateId !== null ? (frontierOrder.get(b.candidateId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return a.hypothesisId.localeCompare(b.hypothesisId);
    });

  const limitations = [
    "HISTORICAL RESEARCH PIPELINE: orchestration only -- reuses A1/A2/B1/B2A/C1 engines verbatim, no stage math reimplemented",
    "no Champion, no model promotion, no automatic live-status transition",
    "no forward data, no walk-forward evaluation performed by this pipeline",
    "a failed stage fails the entire pipeline; no partial or invalid final packet is ever produced",
  ];

  // The D1_PACKET stage's own exact byte hashes (json/html) cannot be
  // included in this row without a circular hash -- the top-level
  // manifest's jsonSha256/htmlSha256 report those instead. This row's
  // contentHash is the hash of the five verified upstream stages combined,
  // proving D1 ran only after every upstream stage passed.
  const d1CompositeHash = createHash("sha256")
    .update([stages.a1.contentHash, stages.a2.contentHash, stages.b1.contentHash, stages.b2a.contentHash, stages.c1.contentHash].join("|"))
    .digest("hex");
  stageResults.push({
    stageId: "STAGE_D1_PACKET",
    engineVersion: PIPELINE_ENGINE_VERSION,
    status: "PASS",
    contentHash: d1CompositeHash,
    jsonSha256: d1CompositeHash,
    htmlSha256: d1CompositeHash,
    manifestSha256: d1CompositeHash,
    hashSemantics: "COMPOSITE_UPSTREAM_LINEAGE",
    artifactNames: PACKET_ARTIFACT_NAMES,
  });
  stageLineage.push({
    stageId: "STAGE_D1_PACKET",
    dependsOn: ["STAGE_A1_DECOMPOSITION", "STAGE_A2_DASHBOARD", "STAGE_B1_COMPONENTS", "STAGE_B2A_EXPERIMENTS", "STAGE_C1_REGISTRY"],
    contentHash: d1CompositeHash,
    verifiedAgainst: { allUpstreamStagesPass: "true" },
  });

  const packetPartial: Omit<HistoricalResearchPacket, "contentHash"> = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    engineVersion: PIPELINE_ENGINE_VERSION,
    pipelineContract: { stages: PIPELINE_STAGES },
    corpusSummary: {
      rawRowCount: stages.a1.rawRowCount,
      strictDedupRowCount: stages.a1.strictDedupRowCount,
      strictDedupPolicy: stages.a1.strictDedupPolicy,
    },
    classifierProvenance: { classifierSha256 },
    stageResults,
    stageLineage,
    historicalFrontier: stages.c1.historicalFrontier,
    registrySummary: stages.c1.registrySummary,
    historicalAdvanceCandidates: historicalAdvanceCandidates.map((c) => ({ ...c, pnl: round6(c.pnl), roi: round6(c.roi) })),
    blockedDataRequirements,
    independentValidationQueue,
    limitations,
  };
  const packetContentHash = createHash("sha256").update(JSON.stringify(packetPartial)).digest("hex");
  const packetResult: HistoricalResearchPacket = { ...packetPartial, contentHash: packetContentHash };

  const packetJson = serializeHistoricalResearchPacketJson(packetResult);
  const packetHtml = renderHistoricalResearchPacketHtml(packetResult);
  const packetManifest = `${JSON.stringify(
    buildHistoricalResearchPacketManifest(
      { a1: { result: stages.a1, json: a1Json, html: a1Html, manifest: a1Manifest }, a2: { result: stages.a2, json: a2Json, html: a2Html, manifest: a2Manifest }, b1: { result: stages.b1, json: b1Json, html: b1Html, manifest: b1Manifest }, b2a: { result: stages.b2a, json: b2aJson, html: b2aHtml, manifest: b2aManifest }, c1: { result: stages.c1, json: c1Json, html: c1Html, manifest: c1Manifest }, packet: { result: packetResult, json: packetJson, html: packetHtml, manifest: "" } },
      { inputSha256, classifierSha256 },
    ),
    null,
    2,
  )}\n`;

  return {
    a1: { result: stages.a1, json: a1Json, html: a1Html, manifest: a1Manifest },
    a2: { result: stages.a2, json: a2Json, html: a2Html, manifest: a2Manifest },
    b1: { result: stages.b1, json: b1Json, html: b1Html, manifest: b1Manifest },
    b2a: { result: stages.b2a, json: b2aJson, html: b2aHtml, manifest: b2aManifest },
    c1: { result: stages.c1, json: c1Json, html: c1Html, manifest: c1Manifest },
    packet: { result: packetResult, json: packetJson, html: packetHtml, manifest: packetManifest },
  };
}

// ------------------------------------------------------------- serializers

export function serializeHistoricalResearchPacketJson(result: HistoricalResearchPacket): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export interface HistoricalResearchPacketManifest {
  schemaVersion: number;
  engineVersion: string;
  inputSha256: string;
  classifierSha256: string;
  strictDedupPolicy: string;
  rawRowCount: number;
  strictDedupRowCount: number;
  a1ManifestSha256: string;
  a2ManifestSha256: string;
  b1ManifestSha256: string;
  b2aManifestSha256: string;
  c1ManifestSha256: string;
  a1ContentHash: string;
  a2ContentHash: string;
  b1ContentHash: string;
  b2aContentHash: string;
  c1ContentHash: string;
  pipelineContentHash: string;
  jsonSha256: string;
  htmlSha256: string;
  artifactSha256s: Record<string, string>;
}

export function buildHistoricalResearchPacketManifest(
  artifacts: FullPipelineArtifacts,
  sourceHashes: { inputSha256: string; classifierSha256: string },
): HistoricalResearchPacketManifest {
  const jsonSha256 = sha256(artifacts.packet.json);
  const htmlSha256 = sha256(artifacts.packet.html);
  return {
    schemaVersion: artifacts.packet.result.schemaVersion,
    engineVersion: artifacts.packet.result.engineVersion,
    inputSha256: sourceHashes.inputSha256,
    classifierSha256: sourceHashes.classifierSha256,
    strictDedupPolicy: artifacts.packet.result.corpusSummary.strictDedupPolicy,
    rawRowCount: artifacts.packet.result.corpusSummary.rawRowCount,
    strictDedupRowCount: artifacts.packet.result.corpusSummary.strictDedupRowCount,
    a1ManifestSha256: sha256(artifacts.a1.manifest),
    a2ManifestSha256: sha256(artifacts.a2.manifest),
    b1ManifestSha256: sha256(artifacts.b1.manifest),
    b2aManifestSha256: sha256(artifacts.b2a.manifest),
    c1ManifestSha256: sha256(artifacts.c1.manifest),
    a1ContentHash: artifacts.a1.result.contentHash,
    a2ContentHash: artifacts.a2.result.contentHash,
    b1ContentHash: artifacts.b1.result.contentHash,
    b2aContentHash: artifacts.b2a.result.contentHash,
    c1ContentHash: artifacts.c1.result.contentHash,
    pipelineContentHash: artifacts.packet.result.contentHash,
    jsonSha256,
    htmlSha256,
    artifactSha256s: {
      "historical_research_packet.json": jsonSha256,
      "historical_research_packet.html": htmlSha256,
    },
  };
}

// ---------------------------------------------------------------- HTML

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(value: number | null): string {
  return value === null ? "--" : String(value);
}

export function renderHistoricalResearchPacketHtml(result: HistoricalResearchPacket): string {
  const c = result;
  const stageRows = c.stageResults
    .map(
      (s) =>
        `<tr><td>${esc(s.stageId)}</td><td>${esc(s.engineVersion)}</td><td><strong>${esc(s.status)}</strong></td><td><code>${s.contentHash.slice(0, 16)}</code></td><td>${s.hashSemantics === "COMPOSITE_UPSTREAM_LINEAGE" ? "composite of upstream contentHashes (not an actual artifact hash -- see packet manifest for real json/html sha256)" : esc(s.hashSemantics)}</td></tr>`,
    )
    .join("");

  const lineageRows = c.stageLineage
    .map(
      (l) =>
        `<tr><td>${esc(l.stageId)}</td><td>${esc(l.dependsOn.join(", ") || "--")}</td><td><code>${l.contentHash.slice(0, 16)}</code></td><td>${Object.entries(l.verifiedAgainst).map(([k, v]) => `${esc(k)}=<code>${v.slice(0, 8)}</code>`).join(", ") || "--"}</td></tr>`,
    )
    .join("");

  const frontierRows = c.historicalFrontier
    .map((f) => `<tr><td>${esc(f.candidateId)}</td><td>${f.n}</td><td>${num(f.pnl)}</td><td>${num(f.roi)}</td><td>${num(f.maxDD)}</td><td>${esc(f.triage)}</td></tr>`)
    .join("");

  const candidateRows = c.historicalAdvanceCandidates
    .map(
      (h) =>
        `<div class="card"><h3>${esc(h.candidateId)}</h3><p class="meta">parent: ${esc(h.parentId)}</p><table><tr><th>N</th><th>PnL</th><th>ROI%</th><th>maxDD</th><th>lossStreak</th></tr><tr><td>${h.n}</td><td>${num(h.pnl)}</td><td>${num(h.roi)}</td><td>${num(h.maxDD)}</td><td>${h.longestLosingStreak}</td></tr></table><p>${esc(h.promotionStatus)} · next gate: ${esc(h.nextRequiredGate)}</p></div>`,
    )
    .join("");

  const summaryRows = Object.entries(c.registrySummary)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
    .join("");

  const queueRows = c.independentValidationQueue
    .map((q) => `<tr><td>${esc(q.hypothesisId)}</td><td>${esc(q.title)}</td><td>${esc(q.type)}</td></tr>`)
    .join("");

  const blockedRows = c.blockedDataRequirements
    .map((b) => `<tr><td>${esc(b.hypothesisId)}</td><td>${esc(b.title)}</td><td>${esc(b.blockedReasons.join(", "))}</td></tr>`)
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Historical Research Packet (D1)</title><style>
body{font-family:system-ui,Arial,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fafafa;}
.banner{background:#7a1020;color:#fff;padding:14px 18px;border-radius:8px;font-weight:700;margin-bottom:20px;}
.banner div{font-size:13px;opacity:.9;}
h1{font-size:22px;} h2{font-size:18px;margin-top:32px;border-bottom:2px solid #ddd;padding-bottom:4px;}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block;font-size:12px;margin:8px 0;}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:right;white-space:nowrap;}
th:first-child,td:first-child{text-align:left;}
code{background:#eee;padding:1px 4px;border-radius:3px;}
.card{border:1px solid #ccc;border-radius:8px;padding:12px;margin:12px 0;background:#fff;}
.meta{font-size:12px;color:#555;}
pre{white-space:pre-wrap;background:#eee;padding:8px;border-radius:6px;font-size:12px;}
@media (max-width:390px){body{padding:8px;} table{font-size:10px;}}
@media print{body{background:#fff;}}
</style></head><body>
<div class="banner">HISTORICAL RESEARCH PIPELINE<div>ALL STAGES VERIFIED</div><div>NO AUTOMATIC CHAMPION</div><div>NO MODEL PROMOTION</div><div>NO LIVE CHANGE</div></div>
<h1>Historical Research Packet</h1>

<h2>Pipeline Stage Status</h2>
<table><tr><th>stage</th><th>engine</th><th>status</th><th>contentHash</th><th>hash semantics</th></tr>${stageRows}</table>

<h2>Corpus and Classifier Provenance</h2>
<p>raw ${c.corpusSummary.rawRowCount} → strict-dedup ${c.corpusSummary.strictDedupRowCount} (${esc(c.corpusSummary.strictDedupPolicy)}) · classifierSha256 <code>${c.classifierProvenance.classifierSha256.slice(0, 16)}</code> · pipelineContentHash <code>${c.contentHash.slice(0, 16)}</code></p>

<h2>Artifact Lineage Graph</h2>
<table><tr><th>stage</th><th>depends on</th><th>contentHash</th><th>verified against</th></tr>${lineageRows}</table>

<h2>Historical Frontier</h2>
<table><tr><th>candidate</th><th>N</th><th>PnL</th><th>ROI%</th><th>maxDD</th><th>triage</th></tr>${frontierRows}</table>

<h2>Historical-Advance Candidates</h2>
${candidateRows}

<h2>Registry Summary</h2>
<table><tr><th>metric</th><th>value</th></tr>${summaryRows}</table>

<h2>Independent-Validation Queue</h2>
<table><tr><th>hypothesis</th><th>title</th><th>type</th></tr>${queueRows}</table>

<h2>Blocked Missing-Data Requirements</h2>
<table><tr><th>hypothesis</th><th>title</th><th>reasons</th></tr>${blockedRows}</table>

<h2>Limitations</h2>
<ul>${c.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>

<h2>Rerun Command Contract</h2>
<pre>node --import tsx scripts/modeling/strategies/run-historical-research-pipeline.ts --write-artifacts</pre>
</body></html>
`;
}
