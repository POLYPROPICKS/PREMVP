import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isFounderModelingSession } from "@/lib/auth/founderModeling";
import ResearchPaperScorecard from "./ResearchPaperScorecard";
import SafeMatchesPanel from "./SafeMatchesPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Founder Modeling Dashboard",
  robots: { index: false, follow: false },
};

export default async function FounderModelingPage() {
  if (!isFounderModelingSession((await cookies()).get("ppp_session")?.value)) notFound();
  return (
    <div>
      <SafeMatchesPanel />
      <ResearchPaperScorecard />
      <iframe
        src="/founder/modeling/assets/MODELING_DASHBOARD.html"
        title="Founder Modeling Dashboard"
        style={{ border: "none", width: "100%", height: "100vh" }}
      />
    </div>
  );
}
