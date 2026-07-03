// Real resolved track record contract.
// Source: public.track_record_window_results — the materialized read-model built
// from actually shown signals (track_record_shown_signal_history) joined to their
// own resolved outcomes in generated_signal_pairs, deduped one row per match,
// resolved-only. See docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md.
// Never source Hit/Miss/PnL from a projected EV formula.

export interface TrackRecordRow {
  id: string;
  eventTitle: string;
  marketQuestion: string;
  pick: string;
  createdAt: string;
  decimalOdds: number;
  americanOdds: string | null;
  oddsSourcePath: string | null;
  projectedWinProbabilityPct: number;
  pnlUnits: number;
  projectedReturnUsd: number;
  projectedRoiPctPerSignal: number;
  status: 'Published' | 'Resolved';
  displayStatus: 'Hit' | 'Miss' | 'Pending';
  action: string | null;
  returnLabel: string;
  scoreRank: number;
  sourceModel: string | null;
}

export interface TrackRecordDisplayTable {
  windowDays: number;
  rows: TrackRecordRow[];
}

export interface ReturnCurvePoint {
  index: number;
  cumulativePnlUnits: number;
  cumulativeRoiPct: number;
  /** Dollar-true cumulative PnL at this point, flat-$100-stake model. */
  cumulativeProfitUsd: number;
  /** cumulativeProfitUsd / ((index + 1) * stakeUsd) * 100 — aligned with netReturnPct. */
  cumulativeReturnPct: number;
}

export interface WeekResultsCard {
  cardType: 'signal-week-results';
  schemaVersion: 'week-results-v3-resolved' | 'week-results-v1-legacy-proof';
  /** track_record_window_results = read-model (WhyTrust 14D block);
   *  generated_signal_pairs_legacy_7d_proof = restored pre-PR#22 7D proof for
   *  the paywall/top-feed consumers. */
  source: 'track_record_window_results' | 'generated_signal_pairs_legacy_7d_proof';
  /** ready = enough resolved shown-history rows; insufficient_history = show
   *  the honest tracking state, never a positive Net Return. */
  status?: 'ready' | 'insufficient_history';
  /** Raw shown/display-selected rows persisted for this window. */
  rawShownRows?: number;
  /** Shown rows after one-match-one-signal dedup. */
  uniqueMatches?: number;
  window: { label: string; days: number; startedAt: string; endedAt: string };
  title: string;
  subtitle: string;
  sampleSizeStatus: 'empty' | 'early' | 'active' | 'enough_data';
  selectedSignals: number;
  oddsCoveragePct: number;
  oddsSourceBreakdown: Record<string, number>;
  projectedWinRatePct: number;
  avgDecimalOdds: number;
  projectedPnlUnits: number;
  projectedReturnUsd: number;
  projectedRoiPct: number;
  /** Flat stake per signal in the $100-stake model (currently always 100). */
  stakeUsd: number;
  /** signalsTracked * stakeUsd. */
  totalStakeUsd: number;
  /** sum(projected_return_usd) — the dollar headline for "Net Return". */
  netProfitUsd: number;
  /** netProfitUsd / totalStakeUsd * 100 — secondary context only, never the headline. */
  netReturnPct: number;
  signalsTracked: number;
  resolvedCount: number;
  pendingCount: number;
  winsCount: number;
  lossesCount: number;
  returnCurve: ReturnCurvePoint[];
  trackRecordDisplayTable: TrackRecordDisplayTable;
}
