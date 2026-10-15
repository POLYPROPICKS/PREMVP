"use client";

import { useEffect, useState } from "react";
import type { readFounderPaper } from "@/lib/research/founderPaperReader";

type Report = Awaited<ReturnType<typeof readFounderPaper>>;
const views = ["strategy_totals","strategy_sport","strategy_market","strategy_sport_market"] as const;
const names = ["All strategies","Strategy × sport","Strategy × market","Strategy × sport × market"];
const label = (id:string) => ({CONTROL_PRICE_BUCKET_A:"CONTROL A",CONTROL_PRICE_BUCKET_B:"CONTROL B",CONTROL_PRICE_BUCKET_C:"CONTROL C",VALUE_BACKED_TAIL_REPRICING:"Value-Backed Tail Repricing",STATEWISE_PAYOFF_ARBITRAGE:"Structural Payoff Arbitrage"}[id]??id);
const percent = (n:number|null) => n===null?"UNKNOWN":`${(n*100).toFixed(2)}%`;

export default function ResearchPaperScorecard() {
  const [range,setRange] = useState("all"), [from,setFrom] = useState(""), [to,setTo] = useState("");
  const [view,setView] = useState(0), [report,setReport] = useState<Report|null>(null);
  const [error,setError] = useState(""), [busy,setBusy] = useState(true), [refresh,setRefresh] = useState(0);
  useEffect(()=>{
    const controller = new AbortController();
    const params = new URLSearchParams({range});
    if (range==="custom") { params.set("from",from);params.set("to",to); }
    async function load() {
      setBusy(true); setReport(null); setError("");
      try {
        const res = await fetch(`/api/founder/modeling/research/scorecard?${params}`,{cache:"no-store",signal:controller.signal});
        const data = await res.json();
        if (!res.ok) throw Error(res.status===404?"Founder Preview session required or expired.":data.message??"Research reporting unavailable.");
        setReport(data);
      } catch(e) { if(!controller.signal.aborted) setError(e instanceof Error?e.message:"Research reporting unavailable."); }
      finally { if(!controller.signal.aborted) setBusy(false); }
    }
    void load();
    const timer = setInterval(()=>{void load();},60_000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[range,from,to,refresh]);
  return <section aria-label="Research Paper Scorecard" style={{background:"#101720",color:"#e9eef5",padding:24,fontSize:14}}>
    <h1 style={{fontSize:24,marginBottom:12}}>Research Paper Scorecard</h1>
    <p>Virtual 1u paper positions. Legacy historical modeling and Production LIVE remain below.</p>
    <div style={{display:"flex",gap:12,flexWrap:"wrap",margin:"16px 0"}}>
      <label>UTC period <select value={range} onChange={e=>setRange(e.target.value)} style={{color:"#111",background:"#fff"}}>
        <option value="all">All available A/B/C dates</option><option value="7">7D</option><option value="14">14D</option><option value="30">30D</option><option value="custom">Custom (max 366 days)</option>
      </select></label>
      {range==="custom" && <><label>From <input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>Through <input type="date" value={to} onChange={e=>setTo(e.target.value)} /></label></>}
      <label>View <select value={view} onChange={e=>setView(Number(e.target.value))} style={{color:"#111",background:"#fff"}}>{names.map((n,i)=><option key={n} value={i}>{n}</option>)}</select></label>
      <button onClick={()=>setRefresh(n=>n+1)} disabled={busy}>Refresh</button>
    </div>
    <div role="status" aria-live="polite">{busy?"Reading research reports…":error||`${report?.freshness} · checked ${report?.read_at} · source age ${report?.freshness_seconds}s`}</div>
    {report && <>
      <p>Reporting cohort: [{report.period_from}, {report.period_to}) UTC; cutoff {report.read_at}. Last admission: {report.last_admission}; last decision creation: {report.last_created_at}.</p>
      <p>Portfolio distinct physical matches: {report.independent_events}; with BET: {report.independent_bet_events}. These are independently deduplicated across strategies.</p>
      {report.freshness==="STALE" && <p role="alert">STALE: source reports need a successful research pipeline refresh. Figures below describe the dated reports.</p>}
      <div style={{overflowX:"auto",marginTop:12}}><table style={{borderCollapse:"collapse",whiteSpace:"nowrap"}}>
        <thead><tr>{["Strategy","Sport","Market family / type / scope","FROM / TO (UTC)","Observed UTC days","Unique matches (all / BET)","BET / SKIP","DB-clock BET","Historical / DELAYED_PAPER BET","LIVE_PROSPECTIVE BET","WIN / LOSS / VOID / PENDING","Win rate","Gross P&L (u)","Settled gross ROI","Net P&L / ROI","Last data refresh","Outcome / timing authority"].map(h=><th key={h} style={{textAlign:"left",padding:10,borderBottom:"1px solid #596575"}}>{h}</th>)}</tr></thead>
        <tbody>{report[views[view]].map(r=><tr key={`${r.strategy_id}/${r.strategy_version}/${r.sport}/${r.market}`}>
          {[`${label(r.strategy_id)} (${r.strategy_version})${r.strategy_id.startsWith("CONTROL_")?"":` — ${r.quality}`}`,r.sport,r.market,`${r.period_start} / ${r.period_end}`,`${r.calendar_days}${r.incomplete_days.length?` · incomplete: ${r.incomplete_days.join(", ")}`:""}`,`${r.unique_events} / ${r.unique_bet_events}`,`${r.bet} / ${r.skip}`,r.db_clock_bet,`${r.historical_bet} / ${r.delayed_paper_bet}`,r.live_prospective_bet,`${r.win} / ${r.loss} / ${r.void} / ${r.pending}`,percent(r.win_rate),r.gross_pnl_u===null?"UNKNOWN":r.gross_pnl_u.toFixed(6),percent(r.gross_roi),"UNKNOWN / UNKNOWN",report.source_refreshes.map(s=>`${s.day}: ${s.refreshed_at}`).join("; "),`${Object.entries(r.authorities).map(([a,n])=>`${a}: ${n}`).join("; ")||r.quality}; ${r.quality}`].map((v,i)=><td key={i} style={{padding:10,borderBottom:"1px solid #303c4a",maxWidth:450,whiteSpace:i===15||i===16?"normal":"nowrap"}}>{v}</td>)}
        </tr>)}</tbody>
      </table></div>
      <details><summary>Outcome and economics semantics</summary><p>BET = WIN + LOSS + VOID + PENDING. Win rate excludes VOID and pending; gross ROI uses settled 1u stakes including VOID. DB-clock verification authenticates persistence, not profitability. DELAYED_PAPER stays separate from LIVE_PROSPECTIVE. Six hours after scheduled start permits an outcome check; it does not guarantee resolution. Completed days use canonical Box B terminal precedence and Gamma fallback. Unresolved positions remain PENDING.</p></details>
    </>}
    {!report && <p>CONTROL A / CONTROL B / CONTROL C: performance unavailable until authoritative reports load.</p>}
    <p>Value-Backed Tail Repricing — NOT_READY · Structural Payoff Arbitrage — SCOPED_NO_GO. No fabricated alpha P&amp;L.</p>
    <p>Execution &amp; Optimal Exit Authority — shared economics / data-quality status. Net fees: UNKNOWN.</p>
  </section>;
}
