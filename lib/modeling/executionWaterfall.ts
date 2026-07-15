import type { ExportRow } from "./generatedSignalPairsExportContract";
import { getStrictDedupKeyForExportRow } from "./generatedSignalPairsExportContract";
import { projectGeneratedSignalPairsStrictDedup } from "./generatedSignalPairsDedupPolicy";
import { evaluateHistoricalFunnelVariant, getCoverageValue, getHoursUntilStartValue, getScoreValue, isEsports } from "./historicalFunnelVariants";
import { BASE_COMPARATOR_ID, passesPriceFloor, passesTimingWithin120m } from "./boundedRoutingExperiments";
import { getEntryPriceValue } from "./scoreComponentAnalysis";
import { buildHistoricalMatchIdentityRecovery, type HistoricalIdentityRecoveryAudit } from "./historicalMatchIdentityRecovery";
import { computeRowReturnPct } from "./roiPnlContract";
import { runBankrollVaultReplay } from "./bankrollVaultReplay";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

export const EXECUTION_WATERFALL_VERSION = "EXECUTION_WATERFALL_V1" as const;
export const BASE_TO_T90_REASONS = [
  "QUALIFIED",
  "NO_VALID_EVENT_START",
  "NO_SNAPSHOT_AT_OR_BEFORE_T90",
  "T90_SNAPSHOT_SCORE_REJECTED",
  "T90_SNAPSHOT_PRICE_REJECTED",
  "T90_SNAPSHOT_TIMING_REJECTED",
  "T90_SNAPSHOT_ESPORTS_REJECTED",
  "OTHER_EXACT_BASE_CONTRACT_REJECTION",
] as const;
export type BaseToT90Reason = (typeof BASE_TO_T90_REASONS)[number];
export const ENTRANT_REASONS = ["LATEST_SCORE_REJECTED", "LATEST_PRICE_REJECTED", "LATEST_TIMING_REJECTED", "LATEST_ESPORTS_REJECTED", "LATEST_INVALID_OR_MISSING_FIELD", "OTHER_EXACT_BASE_REJECTION"] as const;
export type EntrantReason = (typeof ENTRANT_REASONS)[number];

export interface WaterfallAttribution {
  count: number;
  wins: number;
  losses: number;
  flatOneUnitPnl: number;
  flatOneUnitRoi: number | null;
  counterfactualPnl: number;
  counterfactualLabel?: string;
  representativeSamples?: string[];
}

export interface ExecutionCandidate {
  observationId: string;
  identity: string;
  matchKey: string;
  decisionAtIso: string;
  createdAtIso: string;
  resolvedAtIso: string;
  finalScore: number;
  dataCoverage: number;
  entryPrice: number;
  row: ExportRow;
}

export interface ExecutionWaterfallResult {
  version: typeof EXECUTION_WATERFALL_VERSION;
  rawSnapshots: number;
  strictSignalIdentities: number;
  baseModelRows: number;
  t90QualifiedRows: number;
  derivedSportingMatchGroups: number;
  marketsRankedOutInsideMatches: number;
  rowsRejectedNoMatchIdentity: number;
  identityRecoveryAudit: HistoricalIdentityRecoveryAudit;
  groupSizeDistribution: Record<string, number>;
  largestGroups: Array<{ matchKey: string; markets: number }>;
  selectedWinners: Array<{ matchKey: string; observationId: string }>;
  controlExecuted: number;
  controlRejected: number;
  baseToT90Reasons: Record<BaseToT90Reason, WaterfallAttribution>;
  exitReasons: Record<Exclude<BaseToT90Reason, "QUALIFIED">, WaterfallAttribution>;
  entrantReasons: Record<EntrantReason, WaterfallAttribution>;
  cohortReconciliation: { baseLatestCount: number; t90Count: number; retainedCount: number; baseOnlyExitCount: number; t90OnlyEntrantCount: number; unionCount: number };
  retainedAnalysis: {
    sameObservationCount: number;
    differentObservationCount: number;
    price: Record<"increased" | "decreased" | "unchanged", number>;
    score: Record<"increased" | "decreased" | "unchanged", number>;
    coverage: Record<"increased" | "decreased" | "unchanged", number>;
    representativeExamples: Array<{ identity: string; latestObservationId: string; t90ObservationId: string }>;
  };
  entrantDetails: Array<Record<string, string | number | null>>;
  reconciliationOverlapCount: number;
  controlPolicyReasons: Record<string, WaterfallAttribution>;
  duplicateMarketCounterfactual: { label: "NON-INDEPENDENT COUNTERFACTUAL"; includedInCanonicalTotal: false; attribution: WaterfallAttribution };
  terminalIdentityCount: number;
  executionCandidates: ExecutionCandidate[];
}

function id(row: ExportRow): string {
  return typeof row.id === "string" ? row.id : String(row.id ?? getStrictDedupKeyForExportRow(row) ?? "");
}
function identity(row: ExportRow): string | null { return getStrictDedupKeyForExportRow(row); }
function startMs(row: ExportRow): number | null {
  const d = row.diagnostics && typeof row.diagnostics === "object" ? row.diagnostics as Record<string, unknown> : {};
  const ms = typeof d.gameStartIso === "string" ? Date.parse(d.gameStartIso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function createdMs(row: ExportRow): number | null {
  const ms = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function attribution(rows: readonly ExportRow[]): WaterfallAttribution {
  let wins = 0, losses = 0, pnl = 0;
  for (const row of [...rows].sort((a, b) => id(a).localeCompare(id(b)))) {
    const r = computeRowReturnPct(row);
    if (r.label === "win" && r.returnPct !== null) wins++;
    if (r.label === "loss" && r.returnPct !== null) losses++;
    if (r.returnPct !== null) pnl += r.returnPct / 100;
  }
  const n = wins + losses;
  const roundedPnl = Math.round(pnl * 1e8) / 1e8;
  return { count: rows.length, wins, losses, flatOneUnitPnl: roundedPnl, flatOneUnitRoi: n ? Math.round((roundedPnl / n * 100) * 1e8) / 1e8 : null, counterfactualPnl: roundedPnl };
}
function emptyReasons<T extends string>(reasons: readonly T[]): Record<T, ExportRow[]> {
  const result = {} as Record<T, ExportRow[]>;
  for (const reason of reasons) result[reason] = [];
  return result;
}

export type WaterfallModelPolicyId = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M" | "B2_TIMING_WITHIN_120M" | "B2_PRICE_FLOOR_030";
export function buildExecutionWaterfall(rawRows: readonly ExportRow[], classifier: ExecutableFunnelClassifier, modelPolicyId: WaterfallModelPolicyId = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M"): ExecutionWaterfallResult {
  const passesModel = (row: ExportRow): boolean => modelPolicyId === "B2_TIMING_WITHIN_120M" ? passesTimingWithin120m(row) : modelPolicyId === "B2_PRICE_FLOOR_030" ? passesPriceFloor(row) : passesPriceFloor(row) && passesTimingWithin120m(row);
  const deduped = projectGeneratedSignalPairsStrictDedup([...rawRows]).dedupedRows;
  const alt4 = evaluateHistoricalFunnelVariant(deduped, classifier, BASE_COMPARATOR_ID).selectedRows as ExportRow[];
  const baseRows = alt4.filter(passesModel);
  const rawByIdentity = new Map<string, ExportRow[]>();
  for (const row of rawRows) {
    const key = identity(row); if (!key) continue;
    const bucket = rawByIdentity.get(key) ?? []; bucket.push(row); rawByIdentity.set(key, bucket);
  }
  const reasonRows = emptyReasons(BASE_TO_T90_REASONS);
  const baseQualified: ExportRow[] = [];
  for (const base of baseRows) {
    const key = identity(base)!;
    const snapshots = rawByIdentity.get(key) ?? [];
    const validStart = snapshots.filter((r) => startMs(r) !== null && createdMs(r) !== null);
    if (!validStart.length) { reasonRows.NO_VALID_EVENT_START.push(base); continue; }
    const eligible = validStart.filter((r) => createdMs(r)! <= startMs(r)! - 90 * 60_000)
      .sort((a, b) => createdMs(b)! - createdMs(a)! || id(a).localeCompare(id(b)));
    if (!eligible.length) { reasonRows.NO_SNAPSHOT_AT_OR_BEFORE_T90.push(base); continue; }
    const snap = eligible[0];
    const score = getScoreValue(snap);
    if (score === null || score < 65) reasonRows.T90_SNAPSHOT_SCORE_REJECTED.push(snap);
    else if (isEsports(snap)) reasonRows.T90_SNAPSHOT_ESPORTS_REJECTED.push(snap);
    else if (modelPolicyId !== "B2_TIMING_WITHIN_120M" && !passesPriceFloor(snap)) reasonRows.T90_SNAPSHOT_PRICE_REJECTED.push(snap);
    else if (modelPolicyId !== "B2_PRICE_FLOOR_030" && !passesTimingWithin120m(snap)) reasonRows.T90_SNAPSHOT_TIMING_REJECTED.push(snap);
    else if (!(evaluateHistoricalFunnelVariant([snap], classifier, BASE_COMPARATOR_ID).selectedRows.length === 1)) reasonRows.OTHER_EXACT_BASE_CONTRACT_REJECTION.push(snap);
    else { reasonRows.QUALIFIED.push(snap); baseQualified.push(snap); }
  }
  const t90Snapshots: ExportRow[] = [];
  for (const snapshots of rawByIdentity.values()) {
    const eligible = snapshots.filter((r) => startMs(r) !== null && createdMs(r) !== null && createdMs(r)! <= startMs(r)! - 90 * 60_000)
      .sort((a, b) => createdMs(b)! - createdMs(a)! || id(a).localeCompare(id(b)));
    if (eligible[0]) t90Snapshots.push(eligible[0]);
  }
  const qualified = (evaluateHistoricalFunnelVariant(t90Snapshots, classifier, BASE_COMPARATOR_ID).selectedRows as ExportRow[])
    .filter(passesModel);
  const baseByIdentity = new Map(baseRows.map((r) => [identity(r)!, r]));
  const t90ByIdentity = new Map(qualified.map((r) => [identity(r)!, r]));
  const retainedIds = [...baseByIdentity.keys()].filter((key) => t90ByIdentity.has(key)).sort();
  const exitIds = [...baseByIdentity.keys()].filter((key) => !t90ByIdentity.has(key)).sort();
  const entrantIds = [...t90ByIdentity.keys()].filter((key) => !baseByIdentity.has(key)).sort();
  const entrantRows = emptyReasons(ENTRANT_REASONS);
  const dedupByIdentity = new Map(deduped.map((r) => [identity(r)!, r]));
  const entrantDetails: Array<Record<string, string | number | null>> = [];
  for (const key of entrantIds) {
    const latest = dedupByIdentity.get(key)!;
    const t90 = t90ByIdentity.get(key)!;
    const score = getScoreValue(latest), price = getEntryPriceValue(latest), coverage = getCoverageValue(latest);
    let reason: EntrantReason;
    if (score === null || price === null || coverage === null || startMs(latest) === null) reason = "LATEST_INVALID_OR_MISSING_FIELD";
    else if (score < 65) reason = "LATEST_SCORE_REJECTED";
    else if (isEsports(latest)) reason = "LATEST_ESPORTS_REJECTED";
    else if (!passesPriceFloor(latest)) reason = "LATEST_PRICE_REJECTED";
    else if (!passesTimingWithin120m(latest)) reason = "LATEST_TIMING_REJECTED";
    else reason = "OTHER_EXACT_BASE_REJECTION";
    entrantRows[reason].push(latest);
    entrantDetails.push({ identity: key, t90ObservationId: id(t90), latestObservationId: id(latest), t90CreatedAt: String(t90.created_at), latestCreatedAt: String(latest.created_at), t90Price: getEntryPriceValue(t90), latestPrice: price, t90Score: getScoreValue(t90), latestScore: score, t90Coverage: getCoverageValue(t90), latestCoverage: coverage, exactEntrantReason: reason });
  }
  const movement = () => ({ increased: 0, decreased: 0, unchanged: 0 });
  const retainedAnalysis = { sameObservationCount: 0, differentObservationCount: 0, price: movement(), score: movement(), coverage: movement(), representativeExamples: [] as Array<{ identity: string; latestObservationId: string; t90ObservationId: string }> };
  const compare = (a: number | null, b: number | null, target: ReturnType<typeof movement>) => { if (a === b) target.unchanged++; else if (a !== null && b !== null && b > a) target.increased++; else if (a !== null && b !== null) target.decreased++; else target.unchanged++; };
  for (const key of retainedIds) {
    const latest = baseByIdentity.get(key)!, t90 = t90ByIdentity.get(key)!;
    if (id(latest) === id(t90)) retainedAnalysis.sameObservationCount++; else {
      retainedAnalysis.differentObservationCount++;
      compare(getEntryPriceValue(t90), getEntryPriceValue(latest), retainedAnalysis.price);
      compare(getScoreValue(t90), getScoreValue(latest), retainedAnalysis.score);
      compare(getCoverageValue(t90), getCoverageValue(latest), retainedAnalysis.coverage);
      if (retainedAnalysis.representativeExamples.length < 10) retainedAnalysis.representativeExamples.push({ identity: key, latestObservationId: id(latest), t90ObservationId: id(t90) });
    }
  }
  const recoveredIdentity = buildHistoricalMatchIdentityRecovery(rawRows, qualified);
  const matchIndex = recoveredIdentity.index;
  const groups = new Map<string, ExportRow[]>();
  let rowsRejectedNoMatchIdentity = 0;
  for (const row of qualified) {
    const evidence = matchIndex.byObservationId.get(id(row));
    if (!evidence?.key) { rowsRejectedNoMatchIdentity++; continue; }
    const bucket = groups.get(evidence.key) ?? []; bucket.push(row); groups.set(evidence.key, bucket);
  }
  const rank = (a: ExportRow, b: ExportRow): number =>
    (getScoreValue(b)! - getScoreValue(a)!) || (getCoverageValue(b)! - getCoverageValue(a)!) ||
    (getEntryPriceValue(a)! - getEntryPriceValue(b)!) || (createdMs(b)! - createdMs(a)!) || id(a).localeCompare(id(b));
  const winners: ExecutionCandidate[] = [];
  const rankedOut: ExportRow[] = [];
  for (const [matchKey, rows] of groups) {
    const sorted = [...rows].sort(rank); rankedOut.push(...sorted.slice(1));
    const row = sorted[0], start = startMs(row)!;
    winners.push({ observationId: id(row), identity: identity(row)!, matchKey, decisionAtIso: new Date(start - 90 * 60_000).toISOString(), createdAtIso: String(row.created_at), resolvedAtIso: String(row.resolved_at), finalScore: getScoreValue(row)!, dataCoverage: getCoverageValue(row)!, entryPrice: getEntryPriceValue(row)!, row });
  }
  winners.sort((a, b) => Date.parse(a.decisionAtIso) - Date.parse(b.decisionAtIso) || b.finalScore - a.finalScore || b.dataCoverage - a.dataCoverage || a.entryPrice - b.entryPrice || Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso) || a.observationId.localeCompare(b.observationId));
  const control = runBankrollVaultReplay({ rawRows, classifier, insuranceBankroll: 100, matchIdentityMode: "historical-derived-v1" });
  const winnerById = new Map(winners.map((w) => [w.observationId, w.row]));
  const policyRows: Record<string, ExportRow[]> = { EXECUTED: [], OPEN_EXPOSURE_CAP: [], POSITION_CAP: [], DAILY_CAP: [], AVAILABLE_CASH: [], INVALID_SETTLEMENT: [], OTHER: [] };
  for (const d of control.decisionLedger) {
    const row = winnerById.get(d.observationId); if (!row) continue;
    if (d.accepted) policyRows.EXECUTED.push(row);
    else if (d.rejectionReason === "OPEN_EXPOSURE_CAP_REJECTED") policyRows.OPEN_EXPOSURE_CAP.push(row);
    else if (d.rejectionReason === "CONCURRENT_POSITION_CAP_REJECTED") policyRows.POSITION_CAP.push(row);
    else if (d.rejectionReason === "DAILY_CAP_REJECTED") policyRows.DAILY_CAP.push(row);
    else policyRows.OTHER.push(row);
  }
  const distribution: Record<string, number> = {};
  for (const rows of groups.values()) distribution[String(rows.length)] = (distribution[String(rows.length)] ?? 0) + 1;
  const terminalIdentityCount = retainedIds.length + exitIds.length + entrantIds.length;
  const exitReasons = Object.fromEntries(BASE_TO_T90_REASONS.filter((r) => r !== "QUALIFIED").map((reason) => [reason, { ...attribution(reasonRows[reason]), counterfactualLabel: "NON-CANONICAL LATEST-ROW COUNTERFACTUAL", representativeSamples: reasonRows[reason].map(id).sort().slice(0, 5) }])) as Record<Exclude<BaseToT90Reason, "QUALIFIED">, WaterfallAttribution>;
  return {
    version: EXECUTION_WATERFALL_VERSION, rawSnapshots: rawRows.length, strictSignalIdentities: deduped.length,
    baseModelRows: baseRows.length, t90QualifiedRows: qualified.length, derivedSportingMatchGroups: groups.size,
    marketsRankedOutInsideMatches: rankedOut.length, rowsRejectedNoMatchIdentity, identityRecoveryAudit: recoveredIdentity.audit, groupSizeDistribution: distribution,
    largestGroups: [...groups].map(([matchKey, rows]) => ({ matchKey, markets: rows.length })).sort((a,b)=>b.markets-a.markets||a.matchKey.localeCompare(b.matchKey)).slice(0,20),
    selectedWinners: winners.map((w) => ({ matchKey: w.matchKey, observationId: w.observationId })),
    controlExecuted: policyRows.EXECUTED.length, controlRejected: winners.length - policyRows.EXECUTED.length,
    baseToT90Reasons: Object.fromEntries(BASE_TO_T90_REASONS.map((reason) => [reason, attribution(reasonRows[reason])])) as Record<BaseToT90Reason, WaterfallAttribution>,
    exitReasons,
    entrantReasons: Object.fromEntries(ENTRANT_REASONS.map((reason) => [reason, attribution(entrantRows[reason])])) as Record<EntrantReason, WaterfallAttribution>,
    cohortReconciliation: { baseLatestCount: baseRows.length, t90Count: qualified.length, retainedCount: retainedIds.length, baseOnlyExitCount: exitIds.length, t90OnlyEntrantCount: entrantIds.length, unionCount: terminalIdentityCount },
    retainedAnalysis,
    entrantDetails,
    reconciliationOverlapCount: new Set([...retainedIds.filter((x) => exitIds.includes(x) || entrantIds.includes(x)), ...exitIds.filter((x) => entrantIds.includes(x))]).size,
    controlPolicyReasons: Object.fromEntries(Object.entries(policyRows).map(([k,v]) => [k, attribution(v)])),
    duplicateMarketCounterfactual: { label: "NON-INDEPENDENT COUNTERFACTUAL", includedInCanonicalTotal: false, attribution: attribution(rankedOut) },
    terminalIdentityCount, executionCandidates: winners,
  };
}

export function compactExecutionWaterfall(result: ExecutionWaterfallResult): Omit<ExecutionWaterfallResult, "executionCandidates"> {
  const { executionCandidates: _, ...compact } = result; return compact;
}
