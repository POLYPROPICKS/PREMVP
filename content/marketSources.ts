export interface MarketSource {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
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
  },
];
