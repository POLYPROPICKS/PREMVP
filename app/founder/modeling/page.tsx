import type { Metadata } from "next";
import { cookies } from "next/headers";
import { isFounderModelingSession } from "@/lib/auth/founderModeling";
import FounderAccessRequired from "./FounderAccessRequired";
import { ControlsGuide, LevelLadder, LiveGuide, SafeGuide } from "./ModelingGuide";
import ResearchPaperScorecard from "./ResearchPaperScorecard";
import SafeMatchesPanel from "./SafeMatchesPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Founder Modeling Dashboard",
  robots: { index: false, follow: false },
};

const head = { background: "#1b2837", color: "#e9eef5", padding: "12px 24px", margin: 0, fontSize: 20, borderTop: "2px solid #4fb0ff" } as const;

export default async function FounderModelingPage() {
  // Access still requires the signed Founder Preview session; without it the page only explains the legitimate login path.
  if (!isFounderModelingSession((await cookies()).get("ppp_session")?.value)) return <FounderAccessRequired />;
  return (
    <div>
      <header style={{ background: "#0d141c", color: "#e9eef5", padding: "16px 24px" }}>
        <h1 style={{ fontSize: 26, margin: 0 }}>Founder Modeling — панель моделирования</h1>
        <nav aria-label="Разделы" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <a href="#safe" style={{ color: "#4fb0ff" }}>1. SAFE-модели</a>
          <a href="#abc" style={{ color: "#4fb0ff" }}>2. Контроли A/B/C</a>
          <a href="#live" style={{ color: "#4fb0ff" }}>3. Production LIVE</a>
        </nav>
      </header>
      <LevelLadder />
      <h2 id="safe" style={head}>1. SAFE-модели — исторические теневые модели (не торговля)</h2>
      <SafeGuide />
      <SafeMatchesPanel />
      <h2 id="abc" style={head}>2. Виртуальные контроли A/B/C</h2>
      <ControlsGuide />
      <ResearchPaperScorecard />
      <h2 id="live" style={head}>3. Production LIVE</h2>
      <LiveGuide />
      <iframe
        src="/founder/modeling/assets/MODELING_DASHBOARD.html"
        title="Founder Modeling Dashboard"
        style={{ border: "none", width: "100%", height: "100vh" }}
      />
    </div>
  );
}
