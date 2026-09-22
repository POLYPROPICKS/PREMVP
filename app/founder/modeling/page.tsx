import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Founder Modeling Dashboard",
  robots: { index: false, follow: false },
};

export default function FounderModelingPage() {
  return (
    <div style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh" }}>
      <iframe
        src="/founder/modeling/assets/MODELING_DASHBOARD.html"
        title="Founder Modeling Dashboard"
        style={{ border: "none", width: "100%", height: "100%" }}
      />
    </div>
  );
}
