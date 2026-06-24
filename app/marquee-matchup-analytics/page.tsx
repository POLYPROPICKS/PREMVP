import type { Metadata } from "next";
import MarqueeMatchupClient from "./MarqueeMatchupClient";

export const metadata: Metadata = {
  title: "Marquee Matchup Analytics",
  description:
    "View concise game-day context and event activity summaries in one premium preview.",
  robots: { index: false, follow: true },
  alternates: { canonical: "https://polypropicks.com/marquee-matchup-analytics" },
};

export default function MarqueeMatchupAnalyticsPage() {
  return <MarqueeMatchupClient />;
}
