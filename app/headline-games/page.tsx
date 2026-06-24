import { redirect } from "next/navigation";

// Old temporary campaign route — permanently superseded by /marquee-matchup-analytics.
// Kept only as a redirect so existing SMS previews/links do not 404.
export default function HeadlineGamesRedirectPage() {
  redirect("/marquee-matchup-analytics");
}
