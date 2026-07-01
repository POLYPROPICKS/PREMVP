// Projected published-signal track record contract.
// Source: generated_signal_pairs_latest_daily_match_quality_real_odds
// (latest daily batch, signalKey+matchKey deduped, top-6-of-10 quality filtered,
// real market odds only — no resolved won/lost ledger, no fixed/model odds).

export type OddsSource = 'diagnostics.currentPrice' | 'entry_price_num' | 'expected_return_pct_num';

export interface TrackRecordRow {
  id: string;
  eventTitle: string;
  marketQuestion: string;
  pick: string;
  createdAt: string;
  marketPrice: number;
  priceSource: OddsSource;
  decimalOdds: number;
  projectedWinProbabilityPct: number;
  pnlUnits: number;
  projectedReturnUsd: number;
  status: 'Published';
}

export interface TrackRecordDisplayTable {
  windowDays: number;
  rows: TrackRecordRow[];
}

export interface WeekResultsCard {
  cardType: 'signal-week-results';
  schemaVersion: 'week-results-v2-projected';
  source: 'generated_signal_pairs_latest_daily_match_quality_real_odds';
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
  trackRecordDisplayTable: TrackRecordDisplayTable;
}
