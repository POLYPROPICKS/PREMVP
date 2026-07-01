// Published-signal track record contract.
// Source: public.track_record_display_signals — the accepted physical display
// table (one row per published, pre-scored signal per window_days/batch_day).
// No resolved won/lost ledger, no fixed/model odds, no runtime aggregation
// over generated_signal_pairs.

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
  status: 'Published';
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
}

export interface WeekResultsCard {
  cardType: 'signal-week-results';
  schemaVersion: 'week-results-v2-projected';
  source: 'track_record_display_signals';
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
  netReturnPct: number;
  signalsTracked: number;
  resolvedCount: number;
  pendingCount: number;
  winsCount: number;
  lossesCount: number;
  returnCurve: ReturnCurvePoint[];
  trackRecordDisplayTable: TrackRecordDisplayTable;
}
