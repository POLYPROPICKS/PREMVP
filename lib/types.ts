// Shared TypeScript interfaces for Premvp1.1 editable card data

export interface TrustMetric {
  id: string;
  label: string;
  value: string;
  progress?: number; // 0-100 for progress bars
  icon?: string; // optional icon key
}

export interface MarketSourceCard {
  id: string;
  sourceName: string;
  sectionLabel?: string;
  sourcePills?: string[];
  recencyPill?: string;
  ageLabel: string;
  headline: string;
  subheadline: string;
  changeLabel: string;
  isActive: boolean;
}

export interface PremiumEventCard {
  id: string;
  sportIcon?: string;
  leagueLabel: string;
  timeLabel: string;
  confidenceBadge: string;
  eventTitle: string;
  positionLabel: string;
  positionValue: string;
  profitLabel: string;
  profitValue: string;
  winProbability: number;
  trustMetrics: TrustMetric[];
  ctaText: string;
  priceLabel: string;
  isActive: boolean;
}

export interface CategoryTab {
  id: string;
  label: string;
  isActive: boolean;
}
