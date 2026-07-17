import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type JoinedRow = Record<string, unknown> & {
  executionIndex: number; observationId: string; decisionAtIso: string | null; resolvedAtIso: string | null;
  entryPrice: number | null; result: string | null; fixedStake: number | null; fixedRealizedPnl: number | null;
};

const stable = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
    : JSON.stringify(value);
export const canonicalHash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
export const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const round = (n: number) => Number(n.toFixed(8));
const resultNorm = (v: unknown) => String(v ?? "").toLowerCase().replace("won", "win").replace("lost", "loss");
const minskDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const pnl1u = (r: JoinedRow) => r.result === "win" && r.entryPrice ? (1 / r.entryPrice) - 1 : r.result === "loss" ? -1 : 0;

export function loadFrozenContracts(root: string) {
  const handoff = `${root}/modeling/canonical/model-handoff-v1`;
  const evidence = `${root}/modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault`;
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const contract = read(`${handoff}/canonical_model_contract.json`);
  return { contract, identities: read(`${handoff}/locked_signal_identity_set.json`), sequence: read(`${handoff}/locked_execution_sequence.json`),
    fixed: read(`${evidence}/fixed_profile_ledger.json`), dynamic: read(`${evidence}/dynamic_profile_ledger.json`), dynamicCurve: read(`${evidence}/dynamic_profile_curve.json`),
    paths: { dataset: "modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/generated_signal_pairs_export.json.gz", identity: "modeling/canonical/model-handoff-v1/locked_signal_identity_set.json", sequence: "modeling/canonical/model-handoff-v1/locked_execution_sequence.json", fixed: "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/fixed_profile_ledger.json", dynamic: "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/dynamic_profile_ledger.json", curve: "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/dynamic_profile_curve.json" } };
}

export function streamJoinLockedObservations(root: string): { rows: JoinedRow[]; missingIds: string[] } {
  const f = loadFrozenContracts(root); const corpus = JSON.parse(gunzipSync(readFileSync(`${root}/${f.paths.dataset}`)).toString("utf8"));
  const byId = new Map(corpus.map((x: any) => [x.id, x])); const fixed = new Map(f.fixed.map((x: any) => [x.observationId, x])); const dynamic = new Map(f.dynamic.map((x: any) => [x.observationId, x]));
  const missingIds: string[] = [];
  const rows = f.sequence.records.map((s: any) => { const c: any = byId.get(s.observationId); const fx: any = fixed.get(s.observationId); const dy: any = dynamic.get(s.observationId); if (!c) missingIds.push(s.observationId);
    return { executionIndex: s.executionSequenceIndex, observationId: s.observationId, conditionId: c?.condition_id ?? null, tokenId: c?.token_id ?? null,
      decisionAtIso: s.decisionAtIso ?? c?.created_at ?? null, eventStartIso: c?.diagnostics?.gameStartIso ?? null, resolvedAtIso: s.resolvedAtIso ?? c?.resolved_at ?? null,
      sport: c?.sport ?? c?.diagnostics?.sport ?? null, league: c?.league ?? c?.diagnostics?.league ?? null, competition: c?.competition ?? null,
      eventTitle: c?.event_slug ?? null, marketTitle: c?.diagnostics?.marketTitle ?? c?.market_slug ?? null, marketFamily: c?.diagnostics?.marketFamily ?? c?.diagnostics?.marketType ?? null,
      selection: c?.selected_outcome ?? c?.diagnostics?.selectedOutcome ?? null, signalScore: c?.pre_event_score_num ?? c?.score ?? null, entryPrice: c?.entry_price_num ?? fx?.entryPrice ?? null,
      result: resultNorm(c?.signal_result ?? fx?.result) || null, sourceIdentity: c?.formula_version ?? null, sourceVersion: c?.metric_formula_version ?? null,
      historicalDerivedMatchKey: c?.historicalDerivedMatchKey ?? null, identityConfidence: c?.identityConfidence ?? null,
      fixedStake: fx?.stake ?? null, fixedTerminalReason: fx?.terminalReason ?? null, fixedRealizedPnl: fx?.netPnl ?? null,
      dynamicStake: dy?.stake ?? null, dynamicTerminalReason: dy?.terminalReason ?? null, dynamicRealizedPnl: dy?.netPnl ?? null } as JoinedRow; });
  return { rows, missingIds };
}

export function validateJoinedRows(rows: JoinedRow[], expected: number) {
  const counts = new Map<string, number>(); rows.forEach(r => counts.set(r.observationId, (counts.get(r.observationId) ?? 0) + 1));
  const duplicateObservationIds = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  const fields = ["sport", "league", "marketFamily", "eventStartIso", "identityConfidence", "historicalDerivedMatchKey"];
  const missingAttribution = Object.fromEntries(fields.map(f => [f.replace("eventStartIso", "eventStart"), rows.filter(r => r[f] == null).length]));
  const contradictions = rows.filter(r => r.fixedRealizedPnl != null && ((r.result === "win" && Number(r.fixedRealizedPnl) <= 0) || (r.result === "loss" && Number(r.fixedRealizedPnl) !== -Number(r.fixedStake)))).map(r => r.observationId);
  const invalidPrices = rows.filter(r => r.entryPrice == null || !Number.isFinite(r.entryPrice) || r.entryPrice <= 0 || r.entryPrice >= 1).map(r => r.observationId);
  const impossibleTimestamps = rows.filter(r => r.decisionAtIso && r.resolvedAtIso && +new Date(r.decisionAtIso) > +new Date(r.resolvedAtIso)).map(r => r.observationId);
  return { expected, represented: rows.length, unique: counts.size, duplicateObservationIds, silentlyDropped: expected - rows.length, missingAttribution, contradictions, invalidPrices, impossibleTimestamps,
    pass: rows.length === expected && counts.size === expected && !duplicateObservationIds.length && !contradictions.length && !invalidPrices.length && !impossibleTimestamps.length && Object.values(missingAttribution).every(n => n === 0) };
}

export function buildDualChronology(rows: JoinedRow[], start?: string, end?: string) {
  const dates = rows.flatMap(r => [r.decisionAtIso, r.resolvedAtIso]).filter(Boolean).map(x => minskDate(x!));
  const from = start ?? dates.sort()[0], to = end ?? dates.sort().at(-1)!; const calendar: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) calendar.push(d.toISOString().slice(0, 10));
  const make = (key: "decisionAtIso" | "resolvedAtIso", pnl: (r: JoinedRow) => number) => { let cumulative = 0; return calendar.map(date => { const day = rows.filter(r => r[key] && minskDate(r[key]!) === date).sort((a,b) => (+new Date(a[key]!) - +new Date(b[key]!)) || a.executionIndex-b.executionIndex); const realized = day.reduce((a,r)=>a+pnl(r),0); cumulative += realized; return { date, count: day.length, stakedUnits: round(day.reduce((a,r)=>a+Number(r.fixedStake ?? 0),0)), realizedPnl: round(realized), cumulativePnl: round(cumulative), executionIndexes: day.map(r=>r.executionIndex) }; }); };
  return { settlement: make("resolvedAtIso", r=>Number(r.fixedRealizedPnl ?? 0)), decision: make("decisionAtIso", r=>Number(r.fixedRealizedPnl ?? 0)) };
}

export function calculateWindowMetrics(rows: JoinedRow[], key: "decisionAtIso"|"resolvedAtIso", from: string, to?: string, pnlField: "fixedRealizedPnl"|"dynamicRealizedPnl" = "fixedRealizedPnl") {
  const selected=rows.filter(r=>r[key] && minskDate(r[key]!)>=from && (!to || minskDate(r[key]!)<=to)); const stakeField=pnlField==="fixedRealizedPnl"?"fixedStake":"dynamicStake";
  const stake=selected.reduce((a,r)=>a+Number(r[stakeField]??0),0), pnl=selected.reduce((a,r)=>a+Number(r[pnlField]??0),0);
  return { count:selected.length, stake:round(stake), pnl:round(pnl), roiPct:stake?round(100*pnl/stake):0, wins:selected.filter(r=>r.result==="win").length, losses:selected.filter(r=>r.result==="loss").length };
}
export function calculateSegmentAttribution(rows: JoinedRow[], from: string, to: string) { const selected=rows.filter(r=>r.resolvedAtIso&&minskDate(r.resolvedAtIso)>=from&&minskDate(r.resolvedAtIso)<=to); const dimensions=["sport","league","marketFamily","eventTitle","entryPriceBand","scoreBand","stakeBand","lagBand","sourceVersion","identityConfidence"];
  const band=(r:JoinedRow,d:string):unknown=>{const p=Number(r.entryPrice); if(d==="entryPriceBand")return p<.3?"<0.30":p<.4?"0.30–0.39":p<.5?"0.40–0.49":p<.6?"0.50–0.59":p<.7?"0.60–0.69":">=0.70"; if(d==="scoreBand")return r.signalScore==null?null:`${Math.floor(Number(r.signalScore)/10)*10}-${Math.floor(Number(r.signalScore)/10)*10+9}`; if(d==="stakeBand")return Number(r.fixedStake)===1?"1u":String(r.fixedStake); if(d==="lagBand"){const h=(+new Date(r.resolvedAtIso!)-+new Date(r.decisionAtIso!))/36e5;return h<=24?"<=24h":h<=48?"24–48h":h<=168?"2–7d":h<=336?"7–14d":">14d";} return r[d]??null;};
  return dimensions.flatMap(d=>{const m=new Map<string,{count:number;stake:number;pnl:number}>();selected.forEach(r=>{const k=String(band(r,d)??"NULL");const v=m.get(k)??{count:0,stake:0,pnl:0};v.count++;v.stake+=Number(r.fixedStake??0);v.pnl+=Number(r.fixedRealizedPnl??0);m.set(k,v)});return [...m].map(([value,v])=>({dimension:d,value,...v,stake:round(v.stake),pnl:round(v.pnl),roiPct:v.stake?round(100*v.pnl/v.stake):0})).sort((a,b)=>b.pnl-a.pnl)}); }

export function runFixedOneUnitSuffixControl(rows: JoinedRow[], cutoff: string) { const x=rows.filter(r=>r.decisionAtIso&&minskDate(r.decisionAtIso)>=cutoff); const returns=x.map(pnl1u), pnl=returns.reduce((a,b)=>a+b,0);let peak=0,cum=0,dd=0,streak=0,longest=0;returns.forEach(v=>{cum+=v;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);streak=v<0?streak+1:0;longest=Math.max(longest,streak)});return { cutoffEuropeMinsk:cutoff,count:x.length,wins:x.filter(r=>r.result==="win").length,losses:x.filter(r=>r.result==="loss").length,voidOther:x.filter(r=>!['win','loss'].includes(String(r.result))).length,totalStake:x.length,grossPnl:round(pnl),grossRoiPct:x.length?round(100*pnl/x.length):0,averagePnl: x.length?round(pnl/x.length):0,medianPnl:median(returns),maximumDrawdown:round(dd),longestLossStreak:longest,breakEvenExecutionCostBps:x.length?round(10000*pnl/x.length):0,policy:"FIXED_1U_NO_COMPOUNDING_NO_VAULT_NO_CAPITAL_SKIP"}; }
const median=(x:number[])=>{const a=[...x].sort((p,q)=>p-q);return a.length?round(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0};
export function calculateResolutionLagAudit(rows:JoinedRow[]){const calc=(x:JoinedRow[])=>{const h=x.filter(r=>r.decisionAtIso&&r.resolvedAtIso).map(r=>(+new Date(r.resolvedAtIso!)-+new Date(r.decisionAtIso!))/36e5);return {count:h.length,medianHours:median(h),meanHours:h.length?round(h.reduce((a,b)=>a+b,0)/h.length):0,buckets:Object.fromEntries(["<=24h","24–48h","2–7d","7–14d",">14d"].map(k=>[k,0]))}};return {full:calc(rows),early:calc(rows.filter(r=>r.resolvedAtIso&&minskDate(r.resolvedAtIso)>="2026-05-29"&&minskDate(r.resolvedAtIso)<="2026-06-07")),plateau:calc(rows.filter(r=>r.resolvedAtIso&&minskDate(r.resolvedAtIso)>="2026-06-19"&&minskDate(r.resolvedAtIso)<="2026-07-10"))};}

function rng(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export function calculateStatisticalStability(rows:JoinedRow[],seed=20260717){const samples={full:rows, suspicious:rows.filter(r=>r.resolvedAtIso&&minskDate(r.resolvedAtIso)>="2026-05-29"&&minskDate(r.resolvedAtIso)<="2026-06-07"),suffix8:rows.filter(r=>r.decisionAtIso&&minskDate(r.decisionAtIso)>="2026-06-08"),suffix9:rows.filter(r=>r.decisionAtIso&&minskDate(r.decisionAtIso)>="2026-06-09")};return Object.fromEntries(Object.entries(samples).map(([k,x],ix)=>{const ret=x.map(pnl1u),mean=ret.reduce((a,b)=>a+b,0)/(ret.length||1),random=rng(seed+ix),boots=Array.from({length:10000},()=>Array.from({length:ret.length},()=>ret[Math.floor(random()*ret.length)]??0).reduce((a,b)=>a+b,0)/(ret.length||1)).sort((a,b)=>a-b);const wins=x.filter(r=>r.result==="win").length,n=x.length,p=wins/(n||1),z=1.96,den=1+z*z/(n||1),center=(p+z*z/(2*(n||1)))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*(n||1)))/(n||1))/den;return[k,{sampleSize:n,grossRoiPct:round(100*mean),meanReturn:round(mean),medianReturn:median(ret),winRate:round(p),wilson95:[round(center-margin),round(center+margin)],bootstrapMean95:[round(boots[249]),round(boots[9749])],bootstrapResamples:10000,seed:seed+ix}]}));}

export function deriveAuditVerdict(gates:any, suffix:any){const dataTrust=gates.pass?"FULL_HISTORY_DATA_TRUSTED":"DATA_TRUST_UNRESOLVED";const temporal=suffix.grossPnl<0?"POST_JUNE_GROSS_NEGATIVE":suffix.breakEvenExecutionCostBps<50?"POST_JUNE_FEE_FRAGILE":"REGIME_DEPENDENT";return{dataTrust,temporalStability:temporal,freezeReview:gates.pass&&suffix.grossPnl>0?"READY_FOR_FINAL_DOCUMENT_AND_INDEPENDENT_REVIEW":gates.pass?"BLOCKED_MODEL_NOT_PROMOTABLE":"BLOCKED_PENDING_DATA_REPAIR",failedEvidence:gates.pass?[]:["metadata attribution coverage incomplete and/or exact join gates failed"],confidenceIntervalsCaveat:"Confidence intervals do not correct source-data errors."};}
export function renderAuditHtml(payload:any){const json=JSON.stringify(payload).replace(/</g,"\\u003c");return `<!doctype html><html><head><meta charset="utf-8"><title>Suspicious Growth Temporal Audit</title><style>body{font:14px system-ui;max-width:1100px;margin:30px auto;color:#17202a}section{border-top:1px solid #ccd;padding:16px}pre{white-space:pre-wrap}.fail{color:#a00}</style></head><body><h1>Suspicious Growth Temporal Audit</h1><section><h2>Settlement-time versus decision-date cumulative PnL</h2><div id="chronology"></div></section><section><h2>Early versus post-9-June fixed-1u</h2><div id="suffix"></div></section><section><h2>Top contribution and resolution lag</h2><div id="segments"></div></section><section><h2>Data-quality gates and verdict</h2><pre id="verdict"></pre></section><script type="application/json" id="audit-data">${json}</script><script>const d=JSON.parse(document.getElementById('audit-data').textContent);document.getElementById('chronology').textContent=JSON.stringify(d.chronology);document.getElementById('suffix').textContent=JSON.stringify(d.suffix);document.getElementById('segments').textContent=JSON.stringify({attribution:d.attribution,lag:d.lag});document.getElementById('verdict').textContent=JSON.stringify({gates:d.gates,verdict:d.verdict},null,2)</script></body></html>`;}
export function writeDeterministicManifest(files:Record<string,string>){return {version:"SUSPICIOUS_GROWTH_TEMPORAL_AUDIT_MANIFEST_V1",files:Object.fromEntries(Object.entries(files).sort().map(([p,c])=>[p,createHash("sha256").update(c).digest("hex")]))};}
