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
  {
    id: "brazil-england",
    league: "World Cup 2026",
    time: "8:00 PM",
    eventTitle: "Brazil vs England",
    confidenceLabel: "HIGH CONFIDENCE",
    position: "Brazil",
    profit: "214%",
    winProbability: 72,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: [
      {
        id: "smart-money",
        label: "Smart Money",
        value: 79,
        bar: 79,
        icon: "/icons/trust-smart-money.png",
      },
      {
        id: "public-vs-whale",
        label: "Public vs Whale Money",
        value: 68,
        bar: 68,
        icon: "/icons/trust-public-whale.png",
      },
      {
        id: "pre-event-score",
        label: "PreEventScore AI",
        value: 88,
        bar: 88,
        icon: "/icons/trust-ai-score.png",
      },
    ],
  },
  {
    id: "usa-mexico",
    league: "World Cup 2026",
    time: "9:30 PM",
    eventTitle: "USA vs Mexico",
    confidenceLabel: "HIGH CONFIDENCE",
    position: "USA",
    profit: "186%",
    winProbability: 69,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: [
      {
        id: "smart-money",
        label: "Smart Money",
        value: 76,
        bar: 76,
        icon: "/icons/trust-smart-money.png",
      },
      {
        id: "public-vs-whale",
        label: "Public vs Whale Money",
        value: 71,
        bar: 71,
        icon: "/icons/trust-public-whale.png",
      },
      {
        id: "pre-event-score",
        label: "PreEventScore AI",
        value: 84,
        bar: 84,
        icon: "/icons/trust-ai-score.png",
      },
    ],
  },
  {
    id: "france-portugal",
    league: "World Cup 2026",
    time: "7:00 PM",
    eventTitle: "France vs Portugal",
    confidenceLabel: "HIGH CONFIDENCE",
    position: "France",
    profit: "241%",
    winProbability: 74,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: [
      {
        id: "smart-money",
        label: "Smart Money",
        value: 81,
        bar: 81,
        icon: "/icons/trust-smart-money.png",
      },
      {
        id: "public-vs-whale",
        label: "Public vs Whale Money",
        value: 73,
        bar: 73,
        icon: "/icons/trust-public-whale.png",
      },
      {
        id: "pre-event-score",
        label: "PreEventScore AI",
        value: 90,
        bar: 90,
        icon: "/icons/trust-ai-score.png",
      },
    ],
  },
  {
    id: "argentina-germany",
    league: "World Cup 2026",
    time: "10:00 PM",
    eventTitle: "Argentina vs Germany",
    confidenceLabel: "HIGH CONFIDENCE",
    position: "Argentina",
    profit: "205%",
    winProbability: 71,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: [
      {
        id: "smart-money",
        label: "Smart Money",
        value: 78,
        bar: 78,
        icon: "/icons/trust-smart-money.png",
      },
      {
        id: "public-vs-whale",
        label: "Public vs Whale Money",
        value: 70,
        bar: 70,
        icon: "/icons/trust-public-whale.png",
      },
      {
        id: "pre-event-score",
        label: "PreEventScore AI",
        value: 86,
        bar: 86,
        icon: "/icons/trust-ai-score.png",
      },
    ],
  },
];
