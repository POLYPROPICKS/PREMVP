// Legacy visual types for backward compatibility
export type LegacyMarketSourceVisualType = "shark-avatar" | "event-icon" | "news-icon";

// Approved visual types for PREMVP12
export type MarketSourceVisualType = "chart" | "news-image" | "team-crests" | "avatar";

// Approved card types for PREMVP12
export type MarketSourceCardType = "market-source" | "news-pulse" | "market-momentum" | "sharp-flow";

export interface MarketSource {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
  type?: MarketSourceCardType;
  visualType?: MarketSourceVisualType | LegacyMarketSourceVisualType;
}

// Evidence stack card type (same shape as MarketSource but with explicit type)
export interface MarketSourceEvidenceCard {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
  type?: MarketSourceCardType;
  visualType?: MarketSourceVisualType | LegacyMarketSourceVisualType;
}

export const marketSources: MarketSource[] = [
  {
    id: "barcelona-whale-flow",
    sourceLabel: "Market Source",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: "8 min ago",
    headline: "$13K whale flow",
    subline: "Barcelona odds moved +7%",
    delta: "+7%",
    type: "sharp-flow" as MarketSourceCardType,
    visualType: "chart",
  },
  {
    id: "brazil-whale-flow",
    sourceLabel: "Market Source",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: "11 min ago",
    headline: "$21K sharp flow",
    subline: "Brazil odds moved +5%",
    delta: "+5%",
    type: "sharp-flow" as MarketSourceCardType,
    visualType: "chart",
  },
  {
    id: "usa-mexico-market-move",
    sourceLabel: "Market Source",
    platform: "Kalshi",
    network: "US Market",
    timeAgo: "14 min ago",
    headline: "$9K entry spike",
    subline: "USA contract demand +6%",
    delta: "+6%",
    type: "market-momentum" as MarketSourceCardType,
    visualType: "chart",
  },
  {
    id: "france-sharp-entry",
    sourceLabel: "Market Source",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: "6 min ago",
    headline: "$17K whale entry",
    subline: "France probability moved +4%",
    delta: "+4%",
    type: "sharp-flow" as MarketSourceCardType,
    visualType: "chart",
  },
  {
    id: "argentina-liquidity-spike",
    sourceLabel: "Market Source",
    platform: "Kalshi",
    network: "US Market",
    timeAgo: "18 min ago",
    headline: "$12K liquidity shift",
    subline: "Argentina side volume +8%",
    delta: "+8%",
    type: "sharp-flow" as MarketSourceCardType,
    visualType: "chart",
  },
];
