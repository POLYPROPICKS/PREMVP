export interface TrustMetric {
  id: string;
  label: string;
  value: number;
  bar: number;
  icon: string;
}

export interface PremiumSignal {
  id: string;
  league: string;
  time: string;
  eventTitle: string;
  confidenceLabel: string;
  position: string;
  profit: string;
  winProbability: number;
  price: string;
  ctaLabel: string;
  metrics: TrustMetric[];
}

export const premiumSignals: PremiumSignal[] = [
  {
    id: "barcelona-real-madrid",
    league: "La Liga",
    time: "10:00 PM",
    eventTitle: "Barcelona vs Real Madrid",
    confidenceLabel: "HIGH CONFIDENCE",
    position: "Barcelona",
    profit: "317%",
    winProbability: 78,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: [
      {
        id: "smart-money",
        label: "Smart Money",
        value: 82,
        bar: 82,
        icon: "/icons/trust-smart-money.png",
      },
      {
        id: "public-vs-whale",
        label: "Public vs Whale Money",
        value: 74,
        bar: 74,
        icon: "/icons/trust-public-whale.png",
      },
      {
        id: "pre-event-score",
        label: "PreEventScore AI",
        value: 93,
        bar: 93,
        icon: "/icons/trust-ai-score.png",
      },
    ],
  },
];
