// Read-only sufficient-statistics adapter over the canonical paper settlement engine.
import { CONTROL_STRATEGIES, ALPHA_PROGRAMS } from "./inplayPaperDecisions";
import { economics, economicsByProvenance, settlePositionBoxB, type FrozenBet, type BoxBOutcome, type PositionSettlement } from "./inplayPaperSettlement";
import type { GammaMarket } from "../feed/resolveSignalOutcome";

export function scorecardSql(from: string, to: string) {
  for (const t of [from, to]) if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(t) || !Number.isFinite(Date.parse(t))) throw Error("INVALID_WINDOW");
  if (from >= to) throw Error("INVALID_WINDOW");
  return `with cohort as materialized (
 select d.strategy_id,d.strategy_version,d.status,d.physical_event_id,d.condition_id,d.token_id,d.market_family,d.market_scope,
 d.entry_vwap,d.provenance_class,d.frozen_db_at,d.event_start_iso,d.admission_observed_at,d.created_at,
 coalesce(d.provider_sport_family,'UNKNOWN') sport,coalesce(o.canonical_market_type,'UNKNOWN') market_type
 from public.research_inplay_paper_decisions d
 left join public.research_inplay_core_path_observations o on o.id=d.source_observation_id
   and o.physical_event_id=d.physical_event_id and o.condition_id=d.condition_id and o.token_id=d.token_id
 where d.admission_observed_at >= '${from}'::timestamptz and d.admission_observed_at < '${to}'::timestamptz and d.created_at <= now()
), conditions as (select lower(condition_id) k,count(distinct physical_event_id) events from cohort where status='BET' group by 1),
 latest as (select distinct on (b.condition_id) b.condition_id,b.revision_no,b.outcome_status,b.winner_token_id,b.market_token_ids,b.recorded_at
 from public.market_outcome_revisions b join conditions c on c.k=b.condition_id where b.recorded_at<=now() order by b.condition_id,b.revision_no desc),
 cells as (select strategy_id,strategy_version,status,sport,market_family,market_scope,market_type,
 (admission_observed_at at time zone 'UTC')::date::text as "day",d.condition_id,token_id,entry_vwap,provenance_class,
 frozen_db_at is not null db_clock,event_start_iso,c.events condition_events,
 case when b.condition_id is null then null else jsonb_build_object('condition_id',b.condition_id,'revision_no',b.revision_no,'outcome_status',b.outcome_status,'winner_token_id',b.winner_token_id,'market_token_ids',b.market_token_ids) end box,
 count(*) n from cohort d left join conditions c on c.k=lower(d.condition_id) left join latest b on b.condition_id=lower(d.condition_id)
 group by strategy_id,strategy_version,status,sport,market_family,market_scope,market_type,(admission_observed_at at time zone 'UTC')::date::text,d.condition_id,token_id,entry_vwap,provenance_class,db_clock,event_start_iso,c.events,b.condition_id,b.revision_no,b.outcome_status,b.winner_token_id,b.market_token_ids),
 event_counts as (select strategy_id,strategy_version,sport,market_family,market_scope,market_type,
 grouping(sport) gs,grouping(market_family) gm,count(distinct physical_event_id) events,
 count(distinct physical_event_id) filter(where status='BET') bet_events
 from cohort group by grouping sets ((strategy_id,strategy_version),(strategy_id,strategy_version,sport),
 (strategy_id,strategy_version,market_family,market_scope,market_type),(strategy_id,strategy_version,sport,market_family,market_scope,market_type)))
 select jsonb_build_object('scope','RESEARCH_PAPER','read_at',now(),'from','${from}','to','${to}',
 'first_admission',(select min(admission_observed_at) from cohort),'last_admission',(select max(admission_observed_at) from cohort),
 'last_created_at',(select max(created_at) from cohort),'independent_events',(select count(distinct physical_event_id) from cohort),
 'independent_bet_events',(select count(distinct physical_event_id) from cohort where status='BET'),
 'cells',coalesce((select jsonb_agg(c) from cells c),'[]'::jsonb),'event_counts',coalesce((select jsonb_agg(e) from event_counts e),'[]'::jsonb)) scorecard_input`;
}

export type Cell = { strategy_id: string; strategy_version: string; status: string; sport: string; market_family: string | null; market_scope: string | null; market_type: string; day: string; condition_id: string | null; token_id: string | null; entry_vwap: number | null; provenance_class: string | null; db_clock: boolean; event_start_iso: string | null; condition_events: number; box: BoxBOutcome | null; n: number; settlement?: Pick<PositionSettlement,"outcome"|"reason"|"gross_pnl_u"> };
export type EventCount = Pick<Cell,"strategy_id"|"strategy_version"|"sport"|"market_family"|"market_scope"|"market_type"> & {gs:number;gm:number;events:number;bet_events:number};
export type ScorecardInput = { scope: string; read_at:string; from:string; to:string; first_admission:string; last_admission:string; last_created_at:string; independent_events:number; independent_bet_events:number; cells:Cell[]; event_counts:EventCount[] };
const key = (c: Partial<Cell>, gs: number, gm: number) => JSON.stringify([c.strategy_id,c.strategy_version,gs ? null:c.sport,...(gm ? [null,null,null]:[c.market_family,c.market_scope,c.market_type])]);

export function buildPerformanceScorecard(input: ScorecardInput, markets: ReadonlyMap<string,GammaMarket|null> = new Map()) {
  if (input.scope !== "RESEARCH_PAPER") throw Error("NOT_RESEARCH_CLONE");
  const asOf = Math.min(Date.parse(input.to), Date.parse(input.read_at));
  if (!Number.isFinite(asOf) || Date.parse(input.from)>=asOf) throw Error("INVALID_WINDOW");
  const cells = input.cells.map((c,i) => {
    if (!Number.isSafeInteger(c.n) || c.n<1) throw Error("INVALID_AGGREGATE_COUNT");
    const bet: FrozenBet = { ...c, decision_id:`aggregate-${i}`,physical_event_id:"AGGREGATE",side:null,entry_quantity:null,entry_notional_usd:null,observed_at:null,source_observation_id:null };
    const sameDay = c.day === input.read_at.slice(0,10) ? asOf : undefined;
    const p = c.status === "BET" && c.settlement ? { ...bet, ...c.settlement, broken_edge: "NONE" as const, winning_token_id:null, net_pnl_u:null, net_pnl_status:"UNKNOWN_NO_ACTUAL_FEE_AUTHORITY" as const, entry_fee_schedule_per_1u:null } : c.status === "BET" ? settlePositionBoxB(bet,c.box,markets.get((c.condition_id??"").toLowerCase())??null,new Set(Array.from({length:Number(c.condition_events)||1},(_,j)=>String(j))),sameDay) : null;
    return {c,p};
  });
  const views = [[1,1],[0,1],[1,0],[0,0]].map(([gs,gm]) => {
    const groups = new Map<string, typeof cells>();
    for (const item of cells) { const k=key(item.c,gs,gm); const g=groups.get(k)??[];g.push(item);groups.set(k,g); }
    return [...groups].map(([k,g]) => {
      const c=g[0].c, ec=input.event_counts.find(e=>e.gs===gs&&e.gm===gm&&key(e,gs,gm)===k);
      if (!ec) throw Error("EVENT_COUNTS_MISSING");
      // Expand aggregate multiplicities only in memory; no raw decision rows are exported/read.
      const positions=g.flatMap(x=>x.p?Array.from({length:x.c.n},()=>x.p!):[]);
      const e=economics(positions), by_provenance=economicsByProvenance(positions), count=(fn:(c:Cell)=>boolean)=>g.reduce((n,x)=>n+(fn(x.c)?x.c.n:0),0);
      const reasons:Record<string,number>={},authorities:Record<string,number>={};
      for(const {c,p} of g) if(p) { const a=p.outcome==="OPEN"?"UNRESOLVED":p.reason.startsWith("BOX_B_")?"BOX_B":"GAMMA_CLOB"; authorities[a]=(authorities[a]??0)+c.n;if(p.outcome==="OPEN")reasons[p.reason]=(reasons[p.reason]??0)+c.n; }
      return {strategy_id:c.strategy_id,strategy_version:c.strategy_version,sport:gs?"ALL":c.sport,market:gm?"ALL":[c.market_family??"UNKNOWN",c.market_type,c.market_scope??"UNKNOWN"].join(" / "),period_start:input.from,period_end:input.to,as_of:input.read_at,calendar_days:new Set(g.map(x=>x.c.day)).size,incomplete_days:[...(input.from.slice(11)!=="00:00:00Z"&&input.from.slice(11)!=="00:00:00.000Z"?[input.from.slice(0,10)]:[]),...(asOf%86400000&&g.some(x=>x.c.day===new Date(asOf).toISOString().slice(0,10))?[new Date(asOf).toISOString().slice(0,10)]:[])],last_updated:input.last_created_at,bet:e.positions_n,skip:count(c=>c.status==="SKIP"),waiting:count(c=>c.status==="WAITING"),unique_events:ec.events,unique_bet_events:ec.bet_events,db_clock_bet:count(c=>c.status==="BET"&&c.db_clock),historical_bet:count(c=>c.status==="BET"&&!c.db_clock),live_prospective_bet:count(c=>c.status==="BET"&&c.provenance_class==="LIVE_PROSPECTIVE"),delayed_paper_bet:count(c=>c.status==="BET"&&c.provenance_class==="DELAYED_PAPER"),win:e.win_n,loss:e.loss_n,void:e.void_n,pending:e.open_n,win_rate:e.win_n+e.loss_n?e.win_n/(e.win_n+e.loss_n):null,gross_pnl_u:e.gross_pnl_u,gross_roi:e.settled_roi,net_pnl:null,net_roi:null,net_status:e.net_pnl_status,by_provenance,authorities,unresolved_reasons:reasons,quality:e.positions_n?`${Object.keys(by_provenance).length>1?"MIXED_PROVENANCE":Object.keys(by_provenance)[0]}; PROSPECTIVE_PROFITABILITY_UNPROVEN`:"NO_BETS"};
    }).sort((a,b)=>JSON.stringify([a.strategy_id,a.strategy_version,a.sport,a.market]).localeCompare(JSON.stringify([b.strategy_id,b.strategy_version,b.sport,b.market])));
  });
  for(const s of [...CONTROL_STRATEGIES,...ALPHA_PROGRAMS]) if(!views[0].some(r=>r.strategy_id===s.id)) views[0].push({strategy_id:s.id,strategy_version:s.version,sport:"ALL",market:"ALL",period_start:input.from,period_end:input.to,as_of:input.read_at,quality:s.id==="VALUE_BACKED_TAIL_REPRICING"?"NOT_READY":s.id==="STATEWISE_PAYOFF_ARBITRAGE"?"SCOPED_NO_GO":"NOT_STARTED",bet:0,skip:0,waiting:0,unique_events:0,unique_bet_events:0,db_clock_bet:0,historical_bet:0,live_prospective_bet:0,delayed_paper_bet:0,win:0,loss:0,void:0,pending:0,win_rate:null,gross_pnl_u:null,gross_roi:null,net_pnl:null,net_roi:null,net_status:"UNKNOWN_NO_ACTUAL_FEE_AUTHORITY",by_provenance:{},authorities:{},unresolved_reasons:{},calendar_days:new Set(input.cells.map(x=>x.day)).size,incomplete_days:asOf%86400000?[new Date(asOf).toISOString().slice(0,10)]:[],last_updated:input.last_created_at});
  const additive=["bet","skip","waiting","win","loss","void","pending","db_clock_bet","historical_bet","live_prospective_bet","delayed_paper_bet","gross_pnl_u"] as const;
  for(const total of views[0]) {
    if(total.bet!==total.win+total.loss+total.void+total.pending)throw Error("OUTCOME_RECONCILIATION_FAILED");
    for(const view of views.slice(1)) for(const field of additive) {
      const n=view.filter(r=>r.strategy_id===total.strategy_id&&r.strategy_version===total.strategy_version).reduce((n,r)=>n+(r[field]??0),0);
      if(Math.abs(n-(total[field]??0))>0.00001)throw Error(`SUBTOTAL_RECONCILIATION_FAILED:${field}`);
    }
  }
  return {report:"INPLAY_PERFORMANCE_SCORECARD_V1",metadata:{...input,cells:undefined,event_counts:undefined},reconciliation:"PASS",strategy_totals:views[0],strategy_sport:views[1],strategy_market:views[2],strategy_sport_market:views[3]};
}

export function renderPerformanceScorecard(r:ReturnType<typeof buildPerformanceScorecard>) {
  const table=(rows:typeof r.strategy_totals)=>["| Strategy / version | Sport | Market family / type / scope | BET / SKIP / WAIT | Events all / BET | DB clock / historical / live BET | W / L / V / pending | Win rate | Gross P&L u | Gross ROI | Quality |","|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|",...rows.map(x=>`| ${x.strategy_id} / ${x.strategy_version} | ${x.sport} | ${x.market} | ${x.bet} / ${x.skip} / ${x.waiting} | ${x.unique_events} / ${x.unique_bet_events} | ${x.db_clock_bet} / ${x.historical_bet} / ${x.live_prospective_bet} | ${x.win} / ${x.loss} / ${x.void} / ${x.pending} | ${x.win_rate===null?"UNKNOWN":(100*x.win_rate).toFixed(2)+"%"} | ${x.gross_pnl_u??"UNKNOWN"} | ${x.gross_roi===null?"UNKNOWN":(100*x.gross_roi).toFixed(2)+"%"} | ${x.quality} |`)].join("\n");
  return `# Model performance scorecard\n\nPeriod: [${r.metadata.from}, ${r.metadata.to}) UTC, admission time. DB read: ${r.metadata.read_at}. Last admission: ${r.metadata.last_admission}; last creation: ${r.metadata.last_created_at}.\n\nCalendar days: ${r.strategy_totals[0]?.calendar_days}; incomplete days: ${r.strategy_totals[0]?.incomplete_days.join(", ")||"none"}. Outcome checks/provider receipts may be later than DB read; see JSON receipt timestamps.\n\nIndependent physical events across strategies: **${r.metadata.independent_events} all / ${r.metadata.independent_bet_events} with BET**. Never sum strategy event counts.\n\n${table(r.strategy_totals)}\n\n${["Sport","Market","Sport × market"].map((name,i)=>`<details><summary>${name} breakdown</summary>\n\n${table([r.strategy_sport,r.strategy_market,r.strategy_sport_market][i])}\n\n</details>`).join("\n\n")}\n\nReconciliation: ${r.reconciliation}. Gross ROI = sum canonical settled 1u P&L / settled positions (including VOID); win rate excludes VOID/pending. Net P&L and ROI: UNKNOWN, no actual fee authority. These are virtual paper positions.\n\nA/B/C are IN-PLAY controls. DB-owned frozen_db_at authenticates persistence time, not timely or profitable decisions. Historical DELAYED_PAPER is separate from LIVE_PROSPECTIVE. Six hours after start permits an outcome check; it never guarantees finality. Completed days use canonical Box B terminal precedence then Gamma/CLOB fallback; current day uses Box B only after start + 6h. Unresolved reasons and authority counts appear in aggregate JSON. Alpha emission remains disabled; Execution & Optimal Exit Authority is shared economics, not a strategy.\n`;
}
