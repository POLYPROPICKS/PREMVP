"use client";

import { useEffect, useState } from "react";
import type { readFounderShadowMatches } from "@/lib/research/founderShadowMatches";

type Report = Awaited<ReturnType<typeof readFounderShadowMatches>>;
const pct = (n: number | null) => n === null ? "UNKNOWN" : `${(n * 100).toFixed(2)}%`;
const u = (n: number | null) => n === null ? "UNKNOWN" : n.toFixed(3);
const th = { textAlign: "left" as const, padding: 8, borderBottom: "1px solid #596575" };
const td = { padding: 8, borderBottom: "1px solid #303c4a", whiteSpace: "nowrap" as const };

export default function SafeMatchesPanel() {
  const [days, setDays] = useState("7"), [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(true), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setBusy(true); setError("");
      try {
        const res = await fetch(`/api/founder/modeling/research/shadow-matches?days=${days}`, { cache: "no-store", signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw Error(res.status === 404 ? "Founder Preview session required or expired." : data.message ?? "SAFE match statistics unavailable.");
        setReport(data);
      } catch (e) { if (!controller.signal.aborted) { setReport(null); setError(e instanceof Error ? e.message : "SAFE match statistics unavailable."); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh]);
  return <section aria-label="SAFE models by physical match" style={{ background: "#0d141c", color: "#e9eef5", padding: 24, fontSize: 14 }}>
    <h1 style={{ fontSize: 24, marginBottom: 8 }}>SAFE models — isolated physical matches</h1>
    <p>Five SAFE shadow models, one row per event key per model. Model exposures are not independent matches. SAFE shadow is separate from A/B/C paper and Production LIVE.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "12px 0" }}>
      <label>Recent decision days <select value={days} onChange={e => setDays(e.target.value)} style={{ color: "#111", background: "#fff" }}>
        {["3", "7", "14"].map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <button onClick={() => setRefresh(n => n + 1)} disabled={busy}>Refresh</button>
    </div>
    <div role="status" aria-live="polite">{busy && !report ? "Reading SAFE ledger aggregate…" : error ||
      `${report?.freshness} · checked ${report?.read_at} · snapshot refreshed ${report?.snapshot_refreshed_at ?? "UNKNOWN"} · latest decision date ${report?.latest_decision_date} (Minsk today ${report?.minsk_today})`}</div>
    {report && <>
      {report.freshness === "STALE" && <p role="alert">STALE: {report.behind_today ? "latest decision date is behind today; " : ""}the shadow snapshot is older than 2h or missing. Figures describe the stored ledger only.</p>}
      <p>Window {report.window_from} … {report.window_to}: {report.overall.exposures} model exposures; last settlement check {report.last_settlement_check ?? "UNKNOWN"}; {report.rows_first_persistence_unknown} rows with unknown first-persistence time.</p>
      <p style={{ opacity: 0.8 }}>{report.identity_caveat} Gross 1u P&amp;L uses persisted entry price on provider-settled WIN/LOSS only; UNQUERIED stays unresolved; fees and net are UNKNOWN.</p>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>By decision date: exposures vs distinct physical-event keys</h2>
      <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Date", "Model exposures", "Unique event keys", "Keys shared by ≥2 models", "Overlap (models→keys)", "No key", "Win / Loss / Unresolved", "Gross P&L (u)", "Settled ROI"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.days.map(d => <tr key={d.decision_date}>
          {[d.decision_date, d.model_exposures, d.unique_event_keys, d.keys_shared_across_models,
            Object.entries(d.overlap_by_model_count).map(([k, n]) => `${k}→${n}`).join(", "), d.rows_without_event_key,
            `${d.overall.win} / ${d.overall.loss} / ${d.overall.unresolved}`, u(d.overall.gross_pnl_u), pct(d.overall.settled_roi)].map((v, i) => <td key={i} style={td}>{v}</td>)}
        </tr>)}</tbody></table></div>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>By model and date</h2>
      <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Date", "Model", "Selections", "Unique event keys", "Win / Loss / Unresolved", "Gross P&L (u)", "Settled ROI"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.days.flatMap(d => d.models.map(m => <tr key={`${d.decision_date}/${m.model_id}`}>
          {[d.decision_date, m.model_id, m.exposures === 0 ? "0 (no selections)" : m.exposures, m.unique_event_keys, `${m.win} / ${m.loss} / ${m.unresolved}`, u(m.gross_pnl_u), pct(m.settled_roi)].map((v, i) => <td key={i} style={td}>{v}</td>)}
        </tr>))}</tbody></table></div>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>Physical matches, newest two decision days</h2>
      <div style={{ overflowX: "auto", maxHeight: 520 }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Date", "Event key", "Sport", "Event start", "Models", "Model / token / entry / result / P&L (u)"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.events.map(e => <tr key={`${e.decision_date}/${e.physical_event_key}`}>
          {[e.decision_date, e.physical_event_key, e.sport ?? "UNKNOWN", e.event_start ?? "UNKNOWN", e.model_count,
            e.selections.map(s => `${s.model_id} · …${s.selected_token ?? "?"} · ${s.entry_price ?? "?"} · ${s.result} · ${u(s.gross_pnl_u)}`).join("  |  ")].map((v, i) => <td key={i} style={{ ...td, whiteSpace: i === 5 ? "normal" : "nowrap", maxWidth: i === 5 ? 700 : undefined }}>{v}</td>)}
        </tr>)}</tbody></table></div>
      <p style={{ opacity: 0.8, marginTop: 8 }}>{report.provenance}</p>
    </>}
  </section>;
}
