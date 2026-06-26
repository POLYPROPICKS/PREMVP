// LIQUIDITY_MODEL — pure 24h funnel aggregation, machine verdict, and report
// renderers (markdown + json). No I/O. The funnel-log script supplies inputs.

import {
  computeMarketFamilyGate,
  isVolumeGatePassed,
  normalizeSport,
} from "./marketGates";
import {
  buildWatchlistCandidate,
  type SourceResearchRow,
} from "./watchlistBuilder";
import type {
  DbStatus,
  FunnelExample,
  LiquidityFunnelSummary,
  MachineVerdict,
  MarketFamilyGateBreakdown,
  SimulationRow,
  SimulationSummaryBreakdown,
  SnapshotRow,
  VolumeGateBreakdown,
  WatchlistRow,
} from "./types";

export interface FunnelInputs {
  windowStartIso: string;
  windowEndIso: string;
  dbStatus: DbStatus;
  sourceRows: SourceResearchRow[];
  watchlistRows: WatchlistRow[];
  snapshotRows: SnapshotRow[];
  simulationRows: SimulationRow[];
  minVolumeUsd?: number;
}

const SF = (sport: string, family: string) => `${sport}::${family}`;

function inc(map: Partial<Record<string, number>>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function emptyVolumeBreakdown(): VolumeGateBreakdown {
  return {
    checked: 0,
    pass: 0,
    passEventLevel: 0,
    failBelowThreshold: 0,
    failMissing: 0,
    failStale: 0,
    failUnknown: 0,
  };
}

function emptyFamilyBreakdown(): MarketFamilyGateBreakdown {
  return {
    supported: 0,
    excludedOutrightFuture: 0,
    excludedProp: 0,
    excludedExactScore: 0,
    excludedNoveltyPolitics: 0,
    excludedUnknownFamily: 0,
  };
}

function tallyVolume(b: VolumeGateBreakdown, status: string): void {
  b.checked += 1;
  switch (status) {
    case "PASS":
      b.pass += 1;
      break;
    case "PASS_EVENT_LEVEL":
      b.passEventLevel += 1;
      break;
    case "FAIL_BELOW_THRESHOLD":
      b.failBelowThreshold += 1;
      break;
    case "FAIL_MISSING_VOLUME":
      b.failMissing += 1;
      break;
    case "FAIL_STALE_VOLUME":
      b.failStale += 1;
      break;
    default:
      b.failUnknown += 1;
  }
}

function tallyFamily(b: MarketFamilyGateBreakdown, status: string): void {
  switch (status) {
    case "SUPPORTED":
      b.supported += 1;
      break;
    case "EXCLUDED_OUTRIGHT_FUTURE":
      b.excludedOutrightFuture += 1;
      break;
    case "EXCLUDED_PROP":
      b.excludedProp += 1;
      break;
    case "EXCLUDED_EXACT_SCORE":
      b.excludedExactScore += 1;
      break;
    case "EXCLUDED_NOVELTY_POLITICS":
      b.excludedNoveltyPolitics += 1;
      break;
    default:
      b.excludedUnknownFamily += 1;
  }
}

/** Aggregate the full 24h funnel from raw source/watchlist/snapshot/sim rows. */
export function summarizeLiquidityFunnel24h(inputs: FunnelInputs): LiquidityFunnelSummary {
  const sourceRowsBySport: Record<string, number> = {};
  const candidateRowsBySport: Record<string, number> = {};
  const marketFamilyGateBySport: Record<string, MarketFamilyGateBreakdown> = {};
  const volumeGateBySport: Record<string, VolumeGateBreakdown> = {};
  const sourceRowsBySportFamily: Record<string, number> = {};
  const volumeGateBySportFamily: Record<string, VolumeGateBreakdown> = {};
  const rejectedMarketFamilies: Record<string, number> = {};

  let candidateRows = 0;
  let familyGatePass = 0;
  let volumeChecked = 0;
  let volumePass = 0;
  let volumeRejected = 0;

  for (const raw of inputs.sourceRows) {
    const candidate = buildWatchlistCandidate(raw, { minVolumeUsd: inputs.minVolumeUsd });
    const sport = candidate ? candidate.normalizedSport : normalizeSport(raw.sport ?? raw.league);
    inc(sourceRowsBySport, sport);

    if (!candidate) continue;
    candidateRows += 1;
    inc(candidateRowsBySport, sport);

    const key = SF(sport, candidate.normalizedMarketFamily);
    inc(sourceRowsBySportFamily, key);

    const famB = (marketFamilyGateBySport[sport] ??= emptyFamilyBreakdown());
    tallyFamily(famB, candidate.marketFamilyGate);

    if (candidate.marketFamilyGate === "SUPPORTED") {
      familyGatePass += 1;
      // Volume gate only meaningful for family-supported candidates.
      const volB = (volumeGateBySport[sport] ??= emptyVolumeBreakdown());
      tallyVolume(volB, candidate.volumeGate);
      const volBF = (volumeGateBySportFamily[key] ??= emptyVolumeBreakdown());
      tallyVolume(volBF, candidate.volumeGate);
      volumeChecked += 1;
      if (isVolumeGatePassed(candidate.volumeGate)) volumePass += 1;
      else volumeRejected += 1;
    } else {
      const reason = familyReason(candidate.marketFamilyGate, candidate.rawMarketFamily);
      inc(rejectedMarketFamilies, reason);
    }
  }

  // Watchlist coverage (active tokens that actually passed all gates).
  const activeWatchlistBySport: Record<string, number> = {};
  const activeWatchlistBySportFamily: Record<string, number> = {};
  for (const w of inputs.watchlistRows) {
    inc(activeWatchlistBySport, w.normalized_sport);
    inc(activeWatchlistBySportFamily, SF(w.normalized_sport, w.normalized_market_family));
  }

  // Snapshot quality.
  const snapshotSuccessBySportFamily: Record<string, number> = {};
  const failureReasons: Record<string, number> = {};
  const phaseBucketCoverage: Record<string, number> = {};
  let snapshotOk = 0;
  let snapshotPartial = 0;
  let snapshotFailed = 0;
  for (const s of inputs.snapshotRows) {
    inc(phaseBucketCoverage, s.phase_bucket);
    if (s.status === "OK") {
      snapshotOk += 1;
      inc(snapshotSuccessBySportFamily, SF(s.normalized_sport, s.normalized_market_family));
    } else if (s.status === "PARTIAL") {
      snapshotPartial += 1;
      inc(snapshotSuccessBySportFamily, SF(s.normalized_sport, s.normalized_market_family));
    } else {
      snapshotFailed += 1;
      inc(failureReasons, s.failure_code ?? s.status);
    }
  }
  const snapshotsWritten = inputs.snapshotRows.length;
  const bookAttempts = snapshotsWritten;
  const snapshotSuccessRate =
    snapshotsWritten > 0 ? (snapshotOk + snapshotPartial) / snapshotsWritten : null;

  // Simulation summary.
  const simulationSummaryBySportFamily: Record<string, SimulationSummaryBreakdown> = {};
  const executableOpportunitiesBySportFamily: Record<string, number> = {};
  let executable5 = 0;
  let executable10 = 0;
  let executable15 = 0;
  for (const sim of inputs.simulationRows) {
    const key = SF(sim.normalized_sport, sim.normalized_market_family);
    const b = (simulationSummaryBySportFamily[key] ??= {
      simulations: 0,
      executable5pct: 0,
      executable10pct: 0,
      executable15pct: 0,
    });
    b.simulations += 1;
    if (sim.executable_5pct) {
      b.executable5pct += 1;
      executable5 += 1;
      inc(executableOpportunitiesBySportFamily, key);
    }
    if (sim.executable_10pct) {
      b.executable10pct += 1;
      executable10 += 1;
    }
    if (sim.executable_15pct) {
      b.executable15pct += 1;
      executable15 += 1;
    }
  }

  // Sport coverage stats.
  const totalSourceWithSport = Object.values(sourceRowsBySport).reduce((a, b) => a + b, 0);
  const sportsCovered = Object.keys(sourceRowsBySport).filter((s) => s !== "UNKNOWN").length;
  const unknownSportShare =
    totalSourceWithSport > 0 ? (sourceRowsBySport.UNKNOWN ?? 0) / totalSourceWithSport : null;
  const knownCounts = Object.entries(sourceRowsBySport)
    .filter(([s]) => s !== "UNKNOWN")
    .map(([, n]) => n);
  const topSportShare =
    totalSourceWithSport > 0 && knownCounts.length > 0
      ? Math.max(...knownCounts) / totalSourceWithSport
      : null;

  const topExamples = buildTopExamples(inputs.snapshotRows, inputs.simulationRows);

  return {
    windowStartIso: inputs.windowStartIso,
    windowEndIso: inputs.windowEndIso,
    dbStatus: inputs.dbStatus,
    sourceRows: inputs.sourceRows.length,
    candidateRows,
    familyGatePass,
    volumeChecked,
    volumePass,
    volumeRejected,
    activeWatchlistTokens: inputs.watchlistRows.length,
    bookAttempts,
    snapshotsWritten,
    snapshotOk,
    snapshotPartial,
    snapshotFailed,
    snapshotSuccessRate,
    simulations: inputs.simulationRows.length,
    executable5pct: executable5,
    executable10pct: executable10,
    executable15pct: executable15,
    failures: snapshotFailed,
    sportsCovered,
    unknownSportShare,
    topSportShare,
    sourceRowsBySport,
    candidateRowsBySport,
    marketFamilyGateBySport,
    volumeGateBySport,
    activeWatchlistBySport,
    sourceRowsBySportFamily,
    volumeGateBySportFamily,
    activeWatchlistBySportFamily,
    snapshotSuccessBySportFamily,
    simulationSummaryBySportFamily,
    executableOpportunitiesBySportFamily,
    rejectedMarketFamilies,
    failureReasons,
    phaseBucketCoverage,
    topExamples,
  };
}

function familyReason(status: string, rawFamily: string | null): string {
  const base = status.toLowerCase();
  return rawFamily ? `${base}:${rawFamily}` : base;
}

function buildTopExamples(
  snapshots: SnapshotRow[],
  simulations: SimulationRow[],
): FunnelExample[] {
  const simByToken = new Map<string, SimulationRow>();
  for (const sim of simulations) simByToken.set(sim.token_id, sim);

  const usable = snapshots
    .filter((s) => s.status === "OK" || s.status === "PARTIAL")
    .sort((a, b) => (b.bid_depth_5pct_usd ?? 0) - (a.bid_depth_5pct_usd ?? 0))
    .slice(0, 20);

  return usable.map((s) => {
    const sim = simByToken.get(s.token_id);
    return {
      tokenId: s.token_id,
      normalizedSport: s.normalized_sport,
      normalizedMarketFamily: s.normalized_market_family,
      question: null,
      bestBid: s.best_bid,
      bestAsk: s.best_ask,
      spreadBps: s.spread_bps,
      executable5pct: sim ? sim.executable_5pct : null,
      netReturn5pctPct: sim ? sim.net_return_5pct_pct : null,
    };
  });
}

/** Per-sport summary view derived from the full summary. */
export function summarizeSportLiquidityFunnel24h(
  summary: LiquidityFunnelSummary,
  sport: string,
): {
  sport: string;
  sourceRows: number;
  candidateRows: number;
  familyGate: MarketFamilyGateBreakdown;
  volumeGate: VolumeGateBreakdown;
  activeWatchlist: number;
} {
  return {
    sport,
    sourceRows: summary.sourceRowsBySport[sport] ?? 0,
    candidateRows: summary.candidateRowsBySport[sport] ?? 0,
    familyGate: summary.marketFamilyGateBySport[sport] ?? emptyFamilyBreakdown(),
    volumeGate: summary.volumeGateBySport[sport] ?? emptyVolumeBreakdown(),
    activeWatchlist: summary.activeWatchlistBySport[sport] ?? 0,
  };
}

/** Per-(sport,family) summary view derived from the full summary. */
export function summarizeSportFamilyLiquidityFunnel24h(
  summary: LiquidityFunnelSummary,
  sport: string,
  family: string,
): {
  sport: string;
  family: string;
  sourceRows: number;
  volumeGate: VolumeGateBreakdown;
  activeWatchlist: number;
  snapshotSuccess: number;
  simulation: SimulationSummaryBreakdown;
  executableOpportunities: number;
} {
  const key = SF(sport, family);
  return {
    sport,
    family,
    sourceRows: summary.sourceRowsBySportFamily[key] ?? 0,
    volumeGate: summary.volumeGateBySportFamily[key] ?? emptyVolumeBreakdown(),
    activeWatchlist: summary.activeWatchlistBySportFamily[key] ?? 0,
    snapshotSuccess: summary.snapshotSuccessBySportFamily[key] ?? 0,
    simulation: summary.simulationSummaryBySportFamily[key] ?? {
      simulations: 0,
      executable5pct: 0,
      executable10pct: 0,
      executable15pct: 0,
    },
    executableOpportunities: summary.executableOpportunitiesBySportFamily[key] ?? 0,
  };
}

const LOW_SNAPSHOT_SUCCESS_THRESHOLD = 0.5;
const UNKNOWN_SPORT_DOMINANT_THRESHOLD = 0.5;
const SPORT_CONCENTRATION_THRESHOLD = 0.85;

/**
 * Derive a single machine verdict. DB/schema problems win first; then degraded
 * states are reported in funnel order (earliest broken stage first).
 */
export function computeMachineVerdict(summary: LiquidityFunnelSummary): MachineVerdict {
  if (summary.dbStatus === "DB_ENV_MISSING") return "DB_ENV_MISSING";
  if (summary.dbStatus === "SCHEMA_MISSING") return "SCHEMA_MISSING";

  // Sport-mix integrity checks (only meaningful with source rows).
  if (
    summary.sourceRows > 0 &&
    summary.unknownSportShare !== null &&
    summary.unknownSportShare > UNKNOWN_SPORT_DOMINANT_THRESHOLD
  ) {
    return "DEGRADED_UNKNOWN_SPORT_DOMINANT";
  }

  if (summary.volumeChecked > 0 && summary.volumePass === 0) {
    return "DEGRADED_NO_VOLUME_ELIGIBLE";
  }

  // Volume-source completely absent for family-supported candidates.
  if (summary.familyGatePass > 0 && summary.volumeChecked === 0) {
    return "DEGRADED_VOLUME_SOURCE_MISSING";
  }

  if (summary.activeWatchlistTokens === 0) return "DEGRADED_NO_WATCHLIST";

  if (
    summary.sportsCovered > 1 &&
    summary.topSportShare !== null &&
    summary.topSportShare > SPORT_CONCENTRATION_THRESHOLD
  ) {
    return "DEGRADED_SPORT_CONCENTRATION";
  }

  if (summary.snapshotsWritten === 0) return "DEGRADED_NO_SNAPSHOTS";

  if (
    summary.snapshotSuccessRate !== null &&
    summary.snapshotSuccessRate < LOW_SNAPSHOT_SUCCESS_THRESHOLD
  ) {
    return "DEGRADED_LOW_SNAPSHOT_SUCCESS";
  }

  if (summary.snapshotOk + summary.snapshotPartial === 0) return "DEGRADED_NO_LIQUIDITY";

  if (summary.simulations === 0) return "DEGRADED_NO_SIMULATIONS";

  return "OK_CAPTURING";
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function sortedEntries(map: Partial<Record<string, number>>): [string, number][] {
  return Object.entries(map)
    .map(([k, v]) => [k, v ?? 0] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null): string {
  return v === null ? "n/a" : String(v);
}

/** Render the canonical markdown funnel report. */
export function renderLiquidityFunnelMarkdown(
  summary: LiquidityFunnelSummary,
  verdict: MachineVerdict,
  generatedAt: string = new Date().toISOString(),
): string {
  const L: string[] = [];
  L.push("# LIQUIDITY_POOL_MVP 24H FUNNEL REPORT");
  L.push("");
  L.push(`generated_at: ${generatedAt}`);
  L.push("");

  L.push("## 1. Machine Verdict");
  L.push(`machine_verdict: **${verdict}**`);
  L.push(`db_status: ${summary.dbStatus}`);
  L.push("");

  L.push("## 2. 24H Window");
  L.push(`window_start: ${summary.windowStartIso}`);
  L.push(`window_end: ${summary.windowEndIso}`);
  L.push("");

  L.push("## 3. Source Inputs");
  L.push(`source_rows: ${summary.sourceRows}`);
  L.push(`candidate_rows: ${summary.candidateRows}`);
  L.push("");

  L.push("## 4. Sport Coverage");
  L.push(`sports_covered: ${summary.sportsCovered}`);
  L.push(`unknown_sport_share: ${fmtPct(summary.unknownSportShare)}`);
  L.push(`top_sport_share: ${fmtPct(summary.topSportShare)}`);
  for (const [sport, n] of sortedEntries(summary.sourceRowsBySport)) {
    L.push(`- ${sport}: source=${n} candidates=${summary.candidateRowsBySport[sport] ?? 0} active=${summary.activeWatchlistBySport[sport] ?? 0}`);
  }
  L.push("");

  L.push("## 5. Market Family Gate");
  L.push(`family_gate_pass: ${summary.familyGatePass}`);
  for (const [sport, b] of Object.entries(summary.marketFamilyGateBySport)) {
    if (!b) continue;
    L.push(`- ${sport}: supported=${b.supported} outright/future=${b.excludedOutrightFuture} prop=${b.excludedProp} exact_score=${b.excludedExactScore} novelty/politics=${b.excludedNoveltyPolitics} unknown=${b.excludedUnknownFamily}`);
  }
  L.push("");

  L.push("## 6. Volume Gate");
  L.push(`volume_checked: ${summary.volumeChecked} volume_pass: ${summary.volumePass} volume_rejected: ${summary.volumeRejected}`);
  for (const [sport, b] of Object.entries(summary.volumeGateBySport)) {
    if (!b) continue;
    L.push(`- ${sport}: checked=${b.checked} pass=${b.pass} event_level=${b.passEventLevel} below=${b.failBelowThreshold} missing=${b.failMissing} stale=${b.failStale} unknown=${b.failUnknown}`);
  }
  L.push("");

  L.push("## 7. Watchlist");
  L.push(`active_watchlist_tokens: ${summary.activeWatchlistTokens}`);
  L.push("");

  L.push("## 8. Orderbook Fetch / Snapshot Capture");
  L.push(`book_attempts: ${summary.bookAttempts}`);
  L.push(`snapshots_written: ${summary.snapshotsWritten}`);
  L.push("");

  L.push("## 9. Snapshot Quality");
  L.push(`ok: ${summary.snapshotOk} partial: ${summary.snapshotPartial} failed: ${summary.snapshotFailed}`);
  L.push(`snapshot_success_rate: ${fmtPct(summary.snapshotSuccessRate)}`);
  L.push("");

  L.push("## 10. Phase Bucket Coverage");
  for (const [bucket, n] of sortedEntries(summary.phaseBucketCoverage)) {
    L.push(`- ${bucket}: ${n}`);
  }
  L.push("");

  L.push("## 11. Sport / League / Market Family Coverage");
  for (const [key, n] of sortedEntries(summary.activeWatchlistBySportFamily)) {
    L.push(`- ${key}: active=${n} snapshots=${summary.snapshotSuccessBySportFamily[key] ?? 0}`);
  }
  L.push("");

  L.push("## 12. Liquidity Depth Summary");
  L.push(`(per-token depth metrics are stored on snapshot rows; see JSON for breakdowns)`);
  L.push("");

  L.push("## 13. Entry/Exit Simulation Summary");
  L.push(`simulations: ${summary.simulations}`);
  for (const [key, b] of Object.entries(summary.simulationSummaryBySportFamily)) {
    if (!b) continue;
    L.push(`- ${key}: sims=${b.simulations} exec5=${b.executable5pct} exec10=${b.executable10pct} exec15=${b.executable15pct}`);
  }
  L.push("");

  L.push("## 14. Executable Opportunities");
  L.push(`executable_5pct: ${summary.executable5pct} executable_10pct: ${summary.executable10pct} executable_15pct: ${summary.executable15pct}`);
  for (const [key, n] of sortedEntries(summary.executableOpportunitiesBySportFamily)) {
    L.push(`- ${key}: ${n}`);
  }
  L.push("");

  L.push("## 15. Failure Reasons");
  if (Object.keys(summary.failureReasons).length === 0) L.push("(none)");
  for (const [reason, n] of sortedEntries(summary.failureReasons)) {
    L.push(`- ${reason}: ${n}`);
  }
  L.push("");

  L.push("## 16. Rejected Market Families");
  if (Object.keys(summary.rejectedMarketFamilies).length === 0) L.push("(none)");
  for (const [reason, n] of sortedEntries(summary.rejectedMarketFamilies)) {
    L.push(`- ${reason}: ${n}`);
  }
  L.push("");

  L.push("## 17. UNKNOWN Sport / Family Quarantine");
  L.push(`unknown_sport_source_rows: ${summary.sourceRowsBySport.UNKNOWN ?? 0}`);
  L.push(`unknown_sport_active: ${summary.activeWatchlistBySport.UNKNOWN ?? 0}`);
  L.push("");

  L.push("## 18. Top 20 Examples");
  if (summary.topExamples.length === 0) L.push("(none)");
  for (const ex of summary.topExamples) {
    L.push(`- ${ex.tokenId} [${ex.normalizedSport}/${ex.normalizedMarketFamily}] bid=${fmtNum(ex.bestBid)} ask=${fmtNum(ex.bestAsk)} spread_bps=${fmtNum(ex.spreadBps)} exec5=${ex.executable5pct === null ? "n/a" : ex.executable5pct} ret5=${fmtNum(ex.netReturn5pctPct)}`);
  }
  L.push("");

  L.push("## 19. Next Action");
  L.push(nextAction(verdict));
  L.push("");

  return L.join("\n");
}

function nextAction(verdict: MachineVerdict): string {
  switch (verdict) {
    case "OK_CAPTURING":
      return "Contour healthy. Continue scheduled capture; review executable opportunities.";
    case "DB_ENV_MISSING":
      return "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the run environment, then re-run.";
    case "SCHEMA_MISSING":
      return "Operator must create the market_tracking_watchlist / snapshots / simulations tables, then re-run.";
    case "DEGRADED_NO_WATCHLIST":
      return "No gated tokens. Check source rows, sport/family normalization, and volume threshold.";
    case "DEGRADED_NO_VOLUME_ELIGIBLE":
      return "No market passed the volume gate. Verify market-level volume availability and threshold.";
    case "DEGRADED_VOLUME_SOURCE_MISSING":
      return "Family-supported markets lack volume data. Confirm volume_usd is populated on source rows.";
    case "DEGRADED_UNKNOWN_SPORT_DOMINANT":
      return "UNKNOWN sport dominates. Extend sport normalization aliases before trusting coverage.";
    case "DEGRADED_SPORT_CONCENTRATION":
      return "Coverage concentrated in one sport. Confirm source diversity / per-sport caps.";
    case "DEGRADED_NO_SNAPSHOTS":
      return "Watchlist exists but no snapshots captured. Check orderbook fetch path.";
    case "DEGRADED_LOW_SNAPSHOT_SUCCESS":
      return "Snapshot success below 50%. Inspect failure reasons / endpoint health.";
    case "DEGRADED_NO_LIQUIDITY":
      return "Snapshots captured but no usable liquidity. Verify token ids and book parsing.";
    case "DEGRADED_NO_SIMULATIONS":
      return "Snapshots present but no simulations produced. Check simulation selection.";
    default:
      return "Review funnel stages.";
  }
}

/** Render the canonical JSON funnel report (machine-consumable). */
export function renderLiquidityFunnelJson(
  summary: LiquidityFunnelSummary,
  verdict: MachineVerdict,
  generatedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    generated_at: generatedAt,
    machine_verdict: verdict,
    db_status: summary.dbStatus,
    window: { start: summary.windowStartIso, end: summary.windowEndIso },
    totals: {
      source_rows: summary.sourceRows,
      candidate_rows: summary.candidateRows,
      family_gate_pass: summary.familyGatePass,
      volume_checked: summary.volumeChecked,
      volume_pass: summary.volumePass,
      volume_rejected: summary.volumeRejected,
      active_watchlist_tokens: summary.activeWatchlistTokens,
      book_attempts: summary.bookAttempts,
      snapshots_written: summary.snapshotsWritten,
      snapshot_ok: summary.snapshotOk,
      snapshot_partial: summary.snapshotPartial,
      snapshot_failed: summary.snapshotFailed,
      snapshot_success_rate: summary.snapshotSuccessRate,
      simulations: summary.simulations,
      executable_5pct: summary.executable5pct,
      executable_10pct: summary.executable10pct,
      executable_15pct: summary.executable15pct,
      failures: summary.failures,
      sports_covered: summary.sportsCovered,
      unknown_sport_share: summary.unknownSportShare,
      top_sport_share: summary.topSportShare,
    },
    source_rows_by_sport: summary.sourceRowsBySport,
    candidate_rows_by_sport: summary.candidateRowsBySport,
    market_family_gate_by_sport: summary.marketFamilyGateBySport,
    volume_gate_by_sport: summary.volumeGateBySport,
    active_watchlist_by_sport: summary.activeWatchlistBySport,
    source_rows_by_sport_family: summary.sourceRowsBySportFamily,
    volume_gate_by_sport_family: summary.volumeGateBySportFamily,
    active_watchlist_by_sport_family: summary.activeWatchlistBySportFamily,
    snapshot_success_by_sport_family: summary.snapshotSuccessBySportFamily,
    simulation_summary_by_sport_family: summary.simulationSummaryBySportFamily,
    executable_opportunities_by_sport_family: summary.executableOpportunitiesBySportFamily,
    rejected_market_families: summary.rejectedMarketFamilies,
    failure_reasons: summary.failureReasons,
    phase_bucket_coverage: summary.phaseBucketCoverage,
    top_examples: summary.topExamples,
  };
}
