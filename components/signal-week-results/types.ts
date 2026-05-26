export interface PaywallChartPoint {
  index: number;
  resolvedAt: string;
  eventTitle: string;
  pick: string;
  result: 'won' | 'lost';
  returnPct: number;
  cumulativeReturnPct: number;
  americanOdds: string | null;
  europeanOdds: number | null;
  label: string;
}

export interface WeekMiniResult {
  id: string;
  eventTitle: string;
  pick: string;
  result: 'won' | 'lost';
  returnPct: number;
  label: string;
  americanOdds: string | null;
  europeanOdds: number | null;
  marketActivityScore: number;
  resolvedAt: string;
}

export interface WeekResultsCard {
  cardType: 'signal-week-results';
  schemaVersion: 'week-results-v1';
  window: { label: string; days: number; startedAt: string; endedAt: string };
  title: string;
  subtitle: string;
  selectionRule: string;
  sampleSizeStatus: 'empty' | 'early' | 'active' | 'enough_data';
  showPerformanceClaim: boolean;
  totalStats: {
    resolvedCount: number;
    wonCount: number;
    lostCount: number;
    pushCount: number;
    winRatePct: number | null;
    totalReturnPct: number | null;
  };
  displayedStats: {
    displayedCount: number;
    displayedWon: number;
    displayedLost: number;
    displayedPush: number;
    winRatioLabel: string;
    maxDisplayed: 7;
    maxLosses: 1;
  };
  frontendHints: {
    primaryMetric: string;
    compactFields: string[];
    paywallFields: string[];
    hiddenFields: string[];
  };
  featuredResult: null | {
    id: string;
    eventTitle: string;
    pick: string;
    winner: string | null;
    result: 'won' | 'lost';
    returnPct: number;
    americanOdds: string | null;
    europeanOdds: number | null;
    marketActivityScore: number;
    marketActivityLabel: string | null;
    resolvedAt: string;
  };
  miniResults: WeekMiniResult[];
  paywallChart: {
    chartType: 'cumulative-return';
    title: string;
    source: string;
    displayMode: string;
    yUnit: string;
    windowLabel: string;
    finalReturnPct: number | null;
    points: PaywallChartPoint[];
  };
  diagnostics: Record<string, unknown>;
}
