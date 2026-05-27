export type Platform = 'tiktok' | 'instagram' | 'x' | 'telegram';
export type ScreenshotType = 'polymarket' | 'fanduel' | 'draftkings';
export type PMActivity = 'Buy' | 'Sell';

export interface PMRow {
  activity: PMActivity;
  emoji: string;
  eventName: string;
  pill: 'yes' | 'no';
  pillPrice: string;
  shares: string;
  value: string;
  valueType: 'pos' | 'neg' | 'neu';
  timeAgo: string;
  highlight?: boolean;
}

export interface PMScreenshot {
  type: 'polymarket';
  portfolio: string;
  cash: string;
  flag: string;
  rows: PMRow[];
}

export interface FanDuelScreenshot {
  type: 'fanduel';
  league: string;
  event: string;
  selection: string;
  result: string;
  date: string;
  wager: string;
  payout: string;
  netProfit: string;
  betId: string;
}

export interface DraftKingsScreenshot {
  type: 'draftkings';
  league: string;
  event: string;
  selection: string;
  result: string;
  odds: string;
  totalPayout: string;
  wager: string;
  profit: string;
  betId: string;
}

export type Screenshot = PMScreenshot | FanDuelScreenshot | DraftKingsScreenshot;

export interface TestimonialCard {
  id: string;
  avatarUrl: string;
  username: string;
  platform: Platform;
  quote: string;
  verifiedEvent: string;
  verifiedPnl: string;
  screenshot: Screenshot;
}
