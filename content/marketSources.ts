export interface MarketSource {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
  type?: "sharp-flow" | "market-momentum" | "news-pulse";
  visualType?: "chart" | "shark-avatar" | "event-icon" | "news-icon";
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
    type: "sharp-flow",
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
    type: "sharp-flow",
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
    type: "market-momentum",
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
    type: "sharp-flow",
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
    type: "sharp-flow",
    visualType: "chart",
  },
];
