#!/usr/bin/env -S node --import tsx
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";
import { buildExecutionWaterfall, type ExecutionCandidate, type WaterfallModelPolicyId } from "../../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import { minskNightKey } from "../../../lib/modeling/stakeReferenceSchedule";
import {
  bootstrapCapitalRisk,
  buildCapitalPolicyGrid,
  buildMinskOperatingDaySplit,
  FIXED_STAKE_USD,
  replayScientificCapitalPolicy,
  selectCapitalPolicy,
  selectDevelopmentParetoPolicies,
  selectFinalArchitectureCells,
  stableHash,
  type BootstrapRiskSummary,
  type CapitalCurvePoint,
  type CapitalLedgerRow,
  type CapitalPolicyScore,
  type FinalArchitectureCell,
  type ScientificCapitalReplay,
  type ScientificCapitalPolicy,
} from "../../../lib/modeling/scientificCapitalArchitecture";
import { renderScientificArchitectureDashboard, renderScientificFounderReport } from "../../../lib/modeling/scientificArchitectureReport";

const DATASET_SHA = "b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45";
const ORACLE_VERSION = "8.0.0";
const ORACLE_COMMIT = "ee08e4293285b1ab78b56bfc067877b7ebd4bbc5";
const ORACLE_EVIDENCE_MANIFEST_FILE_SHA256 = "061a6784cbbb9f516bf57693f3fd67fd9c5758dec23b6bfb4dc32da879d61d80";
const POSITIONS = [30, 36, 40, 45, 50, 60] as const;
const EXPOSURES = [.8, .85, .9, .95, 1] as const;
const DRAWDOWN_CEILING_USD = 40.35199895 * 100;
const MAX_ACCEPTED_PER_OPERATING_DAY = 100;
const FILTER_CONTRACTS: Record<WaterfallModelPolicyId, string> = {
  B2_PRICE_FLOOR_030_TIMING_WITHIN_120M: "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS + entry_price>=0.30 + hours_until_start in [0,120] at T-90",
  B2_TIMING_WITHIN_120M: "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS + hours_until_start in [0,120] at T-90",
  B2_PRICE_FLOOR_030: "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS + entry_price>=0.30 at T-90",
  ALT2_TS_SCORE_GE_65: "ALT2_TS_SCORE_GE_65 exact frozen registry at T-90",
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const write = (root: string, name: string, value: unknown) => { const content = typeof value === "string" ? value : json(value); writeFileSync(path.join(root, name), content); return sha(content); };
const compact = <T extends Record<string, unknown>>(value: T, omit: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !omit.includes(key)));
const byBlocks = (candidates: readonly ExecutionCandidate[], blocks: ReadonlySet<string>) => candidates.filter((candidate) => blocks.has(minskNightKey(Date.parse(candidate.decisionAtIso))));
const blockValues = (replay: { blockPnl: Record<string, number> }, blocks: readonly string[], loss = false) => blocks.map((block) => (loss ? -1 : 1) * (replay.blockPnl[block] ?? 0));
const GENERATED_ARTIFACTS = new Set(["capital_policy_frontier.json", "final_model_stake_matrix.json", "winner_execution_ledger.json", "winner_capital_curve.json", "final_selection.json", "founder_report_ru.md", "scientific_architecture_dashboard.html", "manifest.json", "freeze_registry.json"]);
function prepareOutputRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(root)) if (GENERATED_ARTIFACTS.has(name) || /^oracle_[A-Za-z0-9_]+_(input|output)\.json$/.test(name)) unlinkSync(path.join(root, name));
}

interface OracleOutput {
  input_sha256: string;
  output_sha256: string;
  runtime?: { arch?: string };
  results: { b_sb?: number; b_cb?: number; pvalues?: { lower: number; consistent: number; upper: number }; better_models_at_0_10?: number[] };
}
interface OracleResult { inputArtifactSha256: string; outputArtifactSha256: string; inputCanonicalSha256: string; outputCanonicalSha256: string; output: OracleOutput }
function runOracle(root: string, python: string, oracleScript: string, name: string, input: unknown): OracleResult {
  const inputName = `oracle_${name}_input.json`, outputName = `oracle_${name}_output.json`, inputText = json(input);
  writeFileSync(path.join(root, inputName), inputText);
  const result = spawnSync(python, [oracleScript, "--input", path.join(root, inputName), "--output", path.join(root, outputName)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`oracle ${name} failed: ${result.stderr.trim()}`);
  const outputText = readFileSync(path.join(root, outputName), "utf8"), output = JSON.parse(outputText) as OracleOutput;
  if (output.runtime?.arch !== ORACLE_VERSION) throw new Error("oracle version mismatch");
  if (!/^[a-f0-9]{64}$/.test(output.input_sha256) || !/^[a-f0-9]{64}$/.test(output.output_sha256)) throw new Error("oracle hashes are invalid");
  return { inputArtifactSha256: sha(inputText), outputArtifactSha256: sha(outputText), inputCanonicalSha256: output.input_sha256, outputCanonicalSha256: output.output_sha256, output };
}

function policyDevelopmentSummary(candidates: readonly ExecutionCandidate[], policy: ScientificCapitalPolicy, blocks: readonly string[]) {
  const replay = replayScientificCapitalPolicy(candidates, policy, { maxOpenPositions: 36, maxOpenExposurePct: 1, maxAcceptedPerOperatingDay: MAX_ACCEPTED_PER_OPERATING_DAY });
  const walkForward = blocks.slice(12).map((block, index) => ({ priorBlocks: 12 + index, block, pnl: replay.blockPnl[block] ?? 0 }));
  let capital = 0, peak = 0, maximumFall = 0;
  for (const row of walkForward) { capital += row.pnl; peak = Math.max(peak, capital); maximumFall = Math.max(maximumFall, peak - capital); }
  return { policy, developmentPnl: walkForward.reduce((sum, row) => sum + row.pnl, 0), maximumFall, skippedPositions: replay.skippedPositions, endingVault: replay.endingVault, walkForward };
}

function evaluateCapitalSequence(root: string, label: string, candidates: readonly ExecutionCandidate[], python: string, oracleScript: string) {
  const blocks = [...new Set(candidates.map((candidate) => minskNightKey(Date.parse(candidate.decisionAtIso))))].sort(), split = buildMinskOperatingDaySplit(blocks), developmentSet = new Set(split.development), confirmationSet = new Set(split.confirmation), developmentCandidates = byBlocks(candidates, developmentSet), confirmationCandidates = byBlocks(candidates, confirmationSet);
  const coarse = buildCapitalPolicyGrid([]), coarseDevelopment = coarse.map((policy) => policyDevelopmentSummary(developmentCandidates, policy, split.development));
  const paretoSeeds = selectDevelopmentParetoPolicies(coarseDevelopment);
  const lockedPolicies = buildCapitalPolicyGrid(paretoSeeds), development = lockedPolicies.map((policy) => policyDevelopmentSummary(developmentCandidates, policy, split.development));
  const confirmation = lockedPolicies.map((policy) => ({ policy, replay: replayScientificCapitalPolicy(confirmationCandidates, policy, { maxOpenPositions: 36, maxOpenExposurePct: 1, maxAcceptedPerOperatingDay: MAX_ACCEPTED_PER_OPERATING_DAY }) }));
  const controlDevelopment = development.find((row) => row.policy.family === "NO_VAULT_FIXED100");
  if (!controlDevelopment || controlDevelopment.walkForward.length < 2) throw new Error(`${label} has insufficient one-block-ahead development evidence`);
  const blockOracle = runOracle(root, python, oracleScript, `${label}_block_length`, { schema_version: 1, fixture_id: `${label}_BLOCK_LENGTH`, operation: "optimal_block_length", series: controlDevelopment.walkForward.map((row) => row.pnl) });
  const bSb = blockOracle.output.results.b_sb;
  const bCb = blockOracle.output.results.b_cb;
  if (!Number.isFinite(bSb) || !Number.isFinite(bCb)) throw new Error("oracle block lengths are invalid");
  const blockSize = Math.max(1, Math.ceil(bSb!)), alternatives = development.filter((row) => row.policy.family !== "NO_VAULT_FIXED100");
  const spaOracle = runOracle(root, python, oracleScript, `${label}_spa`, { schema_version: 1, fixture_id: `${label}_SPA`, operation: "spa", benchmark: controlDevelopment.walkForward.map((row) => -row.pnl), models: alternatives.map((row) => row.walkForward.map((value) => -value.pnl)), parameters: { bootstrap: "stationary", block_size: blockSize, reps: 20000, seed: 20260716, studentize: true, nested: false } });
  const pvalues = spaOracle.output.results.pvalues;
  if (!pvalues || !(pvalues.lower <= pvalues.consistent && pvalues.consistent <= pvalues.upper)) throw new Error("oracle SPA p-values are invalid");
  const scores: CapitalPolicyScore[] = confirmation.map(({ policy, replay }) => { const risk = bootstrapCapitalRisk(blockValues(replay, split.confirmation), blockSize); return { policy, confirmationPnl: replay.netPnl, cvar95MaxFall: risk.cvar95MaximumFall, probabilityBelowInitial: risk.probabilityBelowInitial, endingVault: replay.endingVault, skippedPositions: replay.skippedPositions, spaConsistent: policy.family === "NO_VAULT_FIXED100" ? 1 : pvalues.consistent, spaUpper: policy.family === "NO_VAULT_FIXED100" ? 1 : pvalues.upper }; });
  const selected = selectCapitalPolicy(scores), selectedReplay = confirmation.find((row) => row.policy.id === selected.policy.id)!.replay;
  return { label, methodologyLabel: "historical pseudo-out-of-sample evidence; not true forward validation", blocks: { total: blocks.length, ...split }, candidateCounts: { coarse: coarse.length, locked: lockedPolicies.length, development: developmentCandidates.length, confirmation: confirmationCandidates.length }, paretoSeeds, development, confirmation: confirmation.map(({ policy, replay }) => ({ policy, ...compact(replay as unknown as Record<string, unknown>, ["ledger", "curve", "transfers"]) })), oracle: { bSb, bCb, blockSize, blockLength: blockOracle, spa: spaOracle, pvalues }, selected, selectedReplay };
}

function dynamicSummary(candidates: readonly ExecutionCandidate[], policy: ScientificCapitalPolicy, positions: number, exposure: number, operationWindowOnly: boolean) { return replayScientificCapitalPolicy(candidates, policy, { maxOpenPositions: positions, maxOpenExposurePct: exposure, maxAcceptedPerOperatingDay: MAX_ACCEPTED_PER_OPERATING_DAY, operationWindowOnly, stakePolicy: "DYNAMIC_ACTIVE_3PCT" }); }

function fixedSummary(candidates: readonly ExecutionCandidate[], policy: ScientificCapitalPolicy, positions: number, exposure: number, operationWindowOnly: boolean) { return replayScientificCapitalPolicy(candidates, policy, { maxOpenPositions: positions, maxOpenExposurePct: exposure, maxAcceptedPerOperatingDay: MAX_ACCEPTED_PER_OPERATING_DAY, operationWindowOnly }); }

interface CapacityFrontierCell { positions: number; exposure: number; pnl: number; maximumFall: number; executedMatches: number }
type CompactReplay = Omit<ScientificCapitalReplay, "ledger" | "curve"> & { risk: BootstrapRiskSummary };
interface ScientificMatrixCell extends FinalArchitectureCell {
  model: WaterfallModelPolicyId;
  filterContract: string;
  capitalPolicy: ScientificCapitalPolicy;
  capitalPolicyLockSource: "UNIVERSAL_PRIMARY_SENSITIVITY" | "PRIMARY" | "SENSITIVITY";
  eligibleForFinalSelection: boolean;
  operationScenario: "24X7" | "NIGHT_ONLY";
  capacity: { maxOpenPositions: number; maxOpenExposurePct: number; maxAcceptedPerOperatingDay: number; developmentCeilingPassed: boolean };
  developmentCapacityFrontier: CapacityFrontierCell[];
  confirmation: CompactReplay;
  ledger: CapitalLedgerRow[];
  curve: CapitalCurvePoint[];
  executionLedgerHash: string;
  capitalCurveHash: string;
}

export function runFinalScientificArchitectureFreeze(inputPath: string, outputRoot: string, python: string, oracleScript: string) {
  const raw = readFileSync(inputPath);
  const datasetSha256 = sha(raw);
  if (datasetSha256 !== DATASET_SHA) throw new Error(`frozen dataset hash mismatch: ${datasetSha256}`);
  prepareOutputRoot(outputRoot);
  const rows = JSON.parse(raw.toString("utf8")) as ExportRow[];
  const classifier = loadExecutableFunnelClassifier();
  const models: WaterfallModelPolicyId[] = ["B2_PRICE_FLOOR_030_TIMING_WITHIN_120M", "B2_TIMING_WITHIN_120M", "B2_PRICE_FLOOR_030", "ALT2_TS_SCORE_GE_65"];
  const waterfalls = new Map(models.map((model) => [model, buildExecutionWaterfall(rows, classifier, model)]));
  const primaryWaterfall = waterfalls.get("B2_PRICE_FLOOR_030_TIMING_WITHIN_120M")!;
  const sensitivityWaterfall = waterfalls.get("B2_TIMING_WITHIN_120M")!;
  const primaryCapital = evaluateCapitalSequence(outputRoot, "PRIMARY", primaryWaterfall.executionCandidates, python, oracleScript);
  const sensitivityCapital = evaluateCapitalSequence(outputRoot, "SENSITIVITY", sensitivityWaterfall.executionCandidates, python, oracleScript);
  const materiallyDependent = primaryCapital.selected.policy.family !== sensitivityCapital.selected.policy.family
    || Math.abs(primaryCapital.selected.confirmationPnl - sensitivityCapital.selected.confirmationPnl) >= FIXED_STAKE_USD
    || Math.abs(primaryCapital.selected.cvar95MaxFall - sensitivityCapital.selected.cvar95MaxFall) >= FIXED_STAKE_USD;
  const universalPolicy = materiallyDependent ? null : primaryCapital.selected.policy;
  const capitalPolicyLockHash = stableHash({ primary: primaryCapital.selected, sensitivity: sensitivityCapital.selected, materiallyDependent, universalPolicy });
  const policyOptions = (model: WaterfallModelPolicyId): Array<{ policy: ScientificCapitalPolicy; source: ScientificMatrixCell["capitalPolicyLockSource"]; exact: boolean; blockSize: number }> => {
    if (universalPolicy) return [{ policy: universalPolicy, source: "UNIVERSAL_PRIMARY_SENSITIVITY", exact: true, blockSize: primaryCapital.oracle.blockSize }];
    if (model === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M") return [{ policy: primaryCapital.selected.policy, source: "PRIMARY", exact: true, blockSize: primaryCapital.oracle.blockSize }];
    if (model === "B2_TIMING_WITHIN_120M") return [{ policy: sensitivityCapital.selected.policy, source: "SENSITIVITY", exact: true, blockSize: sensitivityCapital.oracle.blockSize }];
    const options = [
      { policy: primaryCapital.selected.policy, source: "PRIMARY" as const, exact: false, blockSize: primaryCapital.oracle.blockSize },
      { policy: sensitivityCapital.selected.policy, source: "SENSITIVITY" as const, exact: false, blockSize: sensitivityCapital.oracle.blockSize },
    ];
    return [...new Map(options.map((option) => [option.policy.id, option])).values()];
  };
  const matrix: ScientificMatrixCell[] = [];
  for (const model of models) {
    const candidates = waterfalls.get(model)!.executionCandidates;
    const blocks = [...new Set(candidates.map((candidate) => minskNightKey(Date.parse(candidate.decisionAtIso))))].sort();
    const split = buildMinskOperatingDaySplit(blocks);
    const development = byBlocks(candidates, new Set(split.development));
    const confirmation = byBlocks(candidates, new Set(split.confirmation));
    for (const option of policyOptions(model)) for (const operationScenario of ["24X7", "NIGHT_ONLY"] as const) for (const stakePolicy of ["FIXED_100", "DYNAMIC_ACTIVE_3PCT"] as const) {
      const windowOnly = operationScenario === "NIGHT_ONLY";
      const frontier: CapacityFrontierCell[] = [];
      for (const positions of POSITIONS) for (const exposure of EXPOSURES) {
        const replay = stakePolicy === "FIXED_100" ? fixedSummary(development, option.policy, positions, exposure, windowOnly) : dynamicSummary(development, option.policy, positions, exposure, windowOnly);
        frontier.push({ positions, exposure, pnl: replay.netPnl, maximumFall: replay.maximumFallFromTotalPeak, executedMatches: replay.executedMatches });
      }
      const valid = frontier.filter((cell) => cell.maximumFall <= DRAWDOWN_CEILING_USD);
      const rankedPool = valid.length ? valid : frontier;
      const lockedCapacity = [...rankedPool].sort((a, b) => b.pnl - a.pnl || a.maximumFall - b.maximumFall || a.positions - b.positions || a.exposure - b.exposure)[0];
      const replay = stakePolicy === "FIXED_100" ? fixedSummary(confirmation, option.policy, lockedCapacity.positions, lockedCapacity.exposure, windowOnly) : dynamicSummary(confirmation, option.policy, lockedCapacity.positions, lockedCapacity.exposure, windowOnly);
      const risk = bootstrapCapitalRisk(blockValues(replay, split.confirmation), option.blockSize);
      const { ledger, curve, ...replaySummary } = replay;
      const capacity = { maxOpenPositions: lockedCapacity.positions, maxOpenExposurePct: lockedCapacity.exposure, maxAcceptedPerOperatingDay: MAX_ACCEPTED_PER_OPERATING_DAY, developmentCeilingPassed: valid.length > 0 };
      const selectionHash = stableHash({ model, filterContract: FILTER_CONTRACTS[model], capitalPolicy: option.policy, capitalPolicyLockSource: option.source, capitalPolicyLockHash, stakePolicy, operationScenario, capacity, developmentBlocks: split.development, confirmationBlocks: split.confirmation });
      matrix.push({ model, filterContract: FILTER_CONTRACTS[model], capitalPolicy: option.policy, capitalPolicyLockSource: option.source, eligibleForFinalSelection: option.exact && valid.length > 0, stakePolicy, operationScenario, capacity, developmentCapacityFrontier: frontier, confirmation: { ...replaySummary, risk }, ledger, curve, selectionHash, executionLedgerHash: replay.executionLedgerHash, capitalCurveHash: replay.capitalCurveHash });
    }
  }
  const { pnlMax, riskMin, scientificWinner } = selectFinalArchitectureCells(matrix, DRAWDOWN_CEILING_USD);
  const winnerLedger = scientificWinner.ledger;
  const winnerCurve = scientificWinner.curve;
  const capitalFrontier = {
    sequences: {
      B2_PRICE_FLOOR_030_TIMING_WITHIN_120M: compact(primaryCapital as unknown as Record<string, unknown>, ["selectedReplay"]),
      B2_TIMING_WITHIN_120M: compact(sensitivityCapital as unknown as Record<string, unknown>, ["selectedReplay"]),
    },
    capitalPolicyLockHash,
    sensitivityVerdict: materiallyDependent ? "CAPITAL_POLICY_SIGNAL_SEQUENCE_DEPENDENT" : "UNIVERSAL_POLICY_SUPPORTED",
    selectedPolicy: universalPolicy,
  };
  const compactCell = (cell: ScientificMatrixCell) => compact(cell as unknown as Record<string, unknown>, ["ledger", "curve", "developmentCapacityFrontier"]);
  const finalMatrix = matrix.map((cell) => ({ ...compactCell(cell), developmentCapacityFrontier: cell.developmentCapacityFrontier }));
  const finalSelection = { PNL_MAX: compactCell(pnlMax), RISK_MIN: compactCell(riskMin), SCIENTIFIC_FINAL_WINNER: compactCell(scientificWinner) };
  const artifactHashes: Record<string, string> = {};
  artifactHashes.capital_policy_frontier = write(outputRoot, "capital_policy_frontier.json", capitalFrontier);
  artifactHashes.final_model_stake_matrix = write(outputRoot, "final_model_stake_matrix.json", finalMatrix);
  artifactHashes.winner_execution_ledger = write(outputRoot, "winner_execution_ledger.json", winnerLedger);
  artifactHashes.winner_capital_curve = write(outputRoot, "winner_capital_curve.json", winnerCurve);
  artifactHashes.final_selection = write(outputRoot, "final_selection.json", finalSelection);
  artifactHashes.founder_report_ru = write(outputRoot, "founder_report_ru.md", renderScientificFounderReport({ datasetSha256, sensitivityVerdict: capitalFrontier.sensitivityVerdict, primaryCapitalPolicy: primaryCapital.selected.policy.id, sensitivityCapitalPolicy: sensitivityCapital.selected.policy.id, primarySpa: { consistent: primaryCapital.oracle.pvalues.consistent, upper: primaryCapital.oracle.pvalues.upper }, sensitivitySpa: { consistent: sensitivityCapital.oracle.pvalues.consistent, upper: sensitivityCapital.oracle.pvalues.upper }, pnlMax: compactCell(pnlMax), riskMin: compactCell(riskMin), winner: compactCell(scientificWinner) }));
  const dashboardEvidence = { title: "PREMVP Historical Scientific Architecture Freeze", frozenDatasetSha256: datasetSha256, capitalFrontier, finalMatrix, winner: compactCell(scientificWinner), winnerCurve, bootstrap: scientificWinner.confirmation.risk };
  artifactHashes.dashboard = write(outputRoot, "scientific_architecture_dashboard.html", renderScientificArchitectureDashboard(dashboardEvidence));
  const manifestBase = { version: "FINAL_SCIENTIFIC_ARCHITECTURE_FREEZE_V1", datasetSha256, oracle: { version: ORACLE_VERSION, commit: ORACLE_COMMIT, evidenceManifestFileSha256: ORACLE_EVIDENCE_MANIFEST_FILE_SHA256 }, artifactHashes: { ...artifactHashes }, capitalPolicyLockHash, selectionHash: scientificWinner.selectionHash, executionLedgerHash: scientificWinner.executionLedgerHash, capitalCurveHash: scientificWinner.capitalCurveHash };
  const manifest = { ...manifestBase, manifestSha256: stableHash(manifestBase) };
  const manifestArtifactSha256 = write(outputRoot, "manifest.json", manifest);
  const freezeBase = {
    status: ["HISTORICAL_ARCHITECTURE_FROZEN", "IRELAND_PARITY_PENDING", "FORWARD_VALIDATION_PENDING", "NOT_LIVE"], datasetSha256,
    signalModel: scientificWinner.model, signalModelVersion: scientificWinner.model, filterContract: scientificWinner.filterContract,
    t90Contract: "T90_RAW_SNAPSHOT_AT_OR_BEFORE_DECISION", historicalMatchIdentityVersion: primaryWaterfall.identityRecoveryAudit.version,
    oneMatchSelectionRanking: "score DESC, coverage DESC, price ASC, created_at DESC, observationId ASC",
    capitalPolicy: scientificWinner.capitalPolicy, capitalPolicyLockHash, stakePolicy: scientificWinner.stakePolicy,
    stakeReferenceSchedule: scientificWinner.stakePolicy === "DYNAMIC_ACTIVE_3PCT" ? "MINSK_NIGHT_FIXED_MAX3_V1" : "FIXED_100",
    operationScenario: scientificWinner.operationScenario, capacityPolicy: scientificWinner.capacity,
    settlementContract: "SETTLE_SAME_TIMESTAMP_BATCH_THEN_POLICY_THEN_ENTRY_BATCH_V1",
    riskDefinitions: { maximumFall: "absolute USD fall from previous settled Total peak", cvar95: "mean worst 5% stationary-bootstrap maximum fall", drawdownCeilingUnits: 40.35199895, unitValueUsd: 100, drawdownCeilingUsd: DRAWDOWN_CEILING_USD },
    oracle: { package: "arch", version: ORACLE_VERSION, commit: ORACLE_COMMIT, evidenceManifestFileSha256: ORACLE_EVIDENCE_MANIFEST_FILE_SHA256, bootstrap: "stationary", reps: 20000, seed: 20260716, studentize: true, nested: false, blockLength: "approved automatic b_sb rounded up for integer API block_size", decisionPvalue: "consistent", corroborationPvalue: "upper", reportOnlyPvalue: "lower" },
    selectionHash: scientificWinner.selectionHash, executionLedgerHash: scientificWinner.executionLedgerHash, capitalCurveHash: scientificWinner.capitalCurveHash,
    evidenceManifestHash: manifest.manifestSha256, evidenceManifestArtifactSha256: manifestArtifactSha256,
  };
  const freezeRegistry = { ...freezeBase, freezeRegistryHash: stableHash(freezeBase) };
  const freezeRegistryArtifactSha256 = write(outputRoot, "freeze_registry.json", freezeRegistry);
  return { datasetSha256, capitalFrontier, finalMatrix, pnlMax: compactCell(pnlMax), riskMin: compactCell(riskMin), scientificWinner: compactCell(scientificWinner), freezeRegistry, freezeRegistryArtifactSha256, manifest };
}

if (require.main === module) { const [input, output, python, oracleScript] = process.argv.slice(2); if (!input || !output || !python || !oracleScript) throw new Error("usage: run-final-scientific-architecture-freeze <dataset> <output> <python> <oracle-script>"); console.log(JSON.stringify(runFinalScientificArchitectureFreeze(input, output, python, oracleScript), null, 2)); }
