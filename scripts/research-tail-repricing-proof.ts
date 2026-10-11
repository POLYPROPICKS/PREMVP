/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type */
// DBClone-only, READ-ONLY, ROW-BUDGETED proof runner for VALUE_BACKED_TAIL_REPRICING (soccer full-game TOTALS).
// Run: npx tsx scripts/research-tail-repricing-proof.ts [YYYY-MM-DD] [--contracts handoff.csv]   (UTC day, default 2026-10-10)
// Aggregate-first: (0) head-only COUNTs with the soccer predicate applied AT THE DATABASE (0 raw rows);
// (1) contract identities from a public handoff CSV (0 DB rows) or a capped discovery read; the payoff line is proven from the
// provider market fetched BY CONDITION ID; (2) one capped candidate-row read (soccer + LIVE + BUY + tail-price filters pushed to SQL).
// Raw rows are capped at 50 per stage and 200 per mission (RawRowBudget reserves before each read). Writes nothing.
// No probability model is registered: EV stays WAITING and BET is unreachable.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import type { Observation } from "../lib/research/inplayPaperDecisions";
import {
  resolveLineAuthority, findScoreInconsistencies, assessTailRow, freezeContractDecision, selectExactConditionMarket, parseContractHandoff,
  RawRowBudget, RAW_ROWS_PER_STAGE_CAP, PROVISIONAL_RESEARCH_GATES, TAIL_PRICE_RANGE,
  type ContractHandoff, type LineAuthority, type ProviderMarketRaw, type TailRowAssessment,
} from "../lib/research/tailRepricing";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const GAMMA = "https://gamma-api.polymarket.com";
const COLUMNS = "id,physical_event_id,provider_game_id,provider_event_id,provider_sport_family,event_start_iso,observed_at,created_at,event_live_status,state_authority,state_phase,state_period_num,state_clock_seconds_remaining,state_clock_seconds_elapsed,state_received_at,side_a_score,side_b_score,condition_id,token_id,side,canonical_market_family,canonical_market_type,market_slug,best_bid,best_ask,bid_depth_relevant_usd,ask_depth_relevant_usd,full_stake_executable_vwap,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled,taker_fee_usd,orderbook_fetch_status";
type Row = Observation & { state_clock_seconds_elapsed: number | null; state_received_at: string | null };
const keyOf = (e: string, c: string, t: string) => `${e}|${c.toLowerCase()}|${t}`;
const bump = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by; };

/** Gamma hides settled markets unless closed=true; try the open query first, then the closed one. Exact condition id match only. */
async function fetchProviderMarket(conditionId: string): Promise<ProviderMarketRaw | null> {
  for (const extra of ["", "&closed=true"]) {
    try {
      const res = await fetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}${extra}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) continue;
      const hit = selectExactConditionMarket(await res.json(), conditionId);
      if (hit) return hit;
    } catch { /* network error: treated as unavailable */ }
  }
  return null;
}

async function main() {
  const url = process.env.SUPABASE_CLONE_URL, key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  const args = process.argv.slice(2);
  const ci = args.indexOf("--contracts");
  const handoffPath = ci >= 0 ? args[ci + 1] : null;
  const day = args.find((a, i) => !a.startsWith("--") && i !== ci + 1) ?? "2026-10-10";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("TAIL_PROOF_BAD_DAY");
  const handoff: ContractHandoff[] | null = handoffPath ? parseContractHandoff(readFileSync(handoffPath, "utf8")) : null;
  const from = `${day}T00:00:00.000Z`, to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const budget = new RawRowBudget();

  // The DB is needed only for stage 0 counts and stage 2 candidate rows (and stage 1 discovery when no handoff is supplied).
  const db = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  if (db && !url!.includes(CLONE_REF)) throw new Error("TAIL_PROOF_NOT_THE_RESEARCH_CLONE");
  if (!db && !handoff) throw new Error("TAIL_PROOF_CLONE_CONFIG_MISSING");
  // Soccer + full-game TOTALS + day are predicates at the database read boundary; no unrelated sport is ever fetched.
  const scoped = <T extends { eq: Function; gte: Function; lt: Function }>(q: T): T => (q as any).eq("provider_sport_family", "soccer").eq("canonical_market_family", "TOTALS").gte("observed_at", from).lt("observed_at", to);
  const candidate = (q: any) => q.eq("event_live_status", "LIVE").eq("orderbook_fetch_status", "SUCCESS").not("state_authority", "is", null).not("state_received_at", "is", null)
    .not("state_period_num", "is", null).not("state_clock_seconds_elapsed", "is", null).not("side_a_score", "is", null).not("side_b_score", "is", null)
    .gte("full_stake_executable_vwap", TAIL_PRICE_RANGE.min).lte("full_stake_executable_vwap", TAIL_PRICE_RANGE.max);

  // ── stage 0: head-only aggregates (0 raw rows) ──
  const counts: Record<string, number | string> = {};
  if (db) {
    const head = () => db.from("research_inplay_core_path_observations").select("id", { count: "exact", head: true });
    const a = await scoped(head()); const b = await candidate(scoped(head()));
    if (a.error || b.error) throw new Error(`TAIL_PROOF_COUNT:${(a.error ?? b.error)!.message}`);
    counts.soccer_totals_observations_n = a.count ?? -1; counts.soccer_totals_live_state_buy_tail_price_prefilter_n = b.count ?? -1;
  } else counts.note = "NO_CLONE_CONFIG_COUNTS_SKIPPED";

  // ── stage 1: contract identities ──
  let contracts: ContractHandoff[];
  let discoveryTruncated = false;
  if (handoff) contracts = handoff;
  else {
    budget.reserve("discovery", RAW_ROWS_PER_STAGE_CAP);
    const r = await candidate(scoped(db!.from("research_inplay_core_path_observations").select("physical_event_id,condition_id,token_id,side,market_slug")))
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(RAW_ROWS_PER_STAGE_CAP);
    if (r.error) throw new Error(`TAIL_PROOF_READ:${r.error.message}`);
    const got = (r.data ?? []) as unknown as Array<{ physical_event_id: string; condition_id: string; token_id: string; side: string; market_slug: string }>;
    budget.release("discovery", RAW_ROWS_PER_STAGE_CAP - got.length);
    discoveryTruncated = got.length >= RAW_ROWS_PER_STAGE_CAP;
    const m = new Map<string, ContractHandoff>();
    for (const g of got) { const k = keyOf(g.physical_event_id, g.condition_id, g.token_id); const e = m.get(k); if (e) e.eligible_observation_count++; else m.set(k, { physical_event_id: g.physical_event_id, condition_id: g.condition_id, token_id: g.token_id, side: g.side, slug: g.market_slug, eligible_observation_count: 1 }); }
    contracts = [...m.values()];
  }
  const conditions = [...new Set(contracts.map((c) => c.condition_id.toLowerCase()))];
  const markets = new Map<string, ProviderMarketRaw | null>();
  for (let i = 0; i < conditions.length; i += 5) await Promise.all(conditions.slice(i, i + 5).map(async (c) => { markets.set(c, await fetchProviderMarket(c)); }));
  const lineByContract = new Map<string, LineAuthority>();
  const lineContracts: Record<string, number> = {}, lineObservations: Record<string, number> = {}, lineReasons: Record<string, number> = {}, perCondition = new Map<string, Set<string>>();
  for (const c of contracts) {
    const la = resolveLineAuthority({ conditionId: c.condition_id, tokenId: c.token_id, side: c.side, observationSlug: c.slug, market: markets.get(c.condition_id.toLowerCase()) ?? null });
    lineByContract.set(keyOf(c.physical_event_id, c.condition_id, c.token_id), la);
    bump(lineContracts, la.status); bump(lineObservations, la.status, c.eligible_observation_count); bump(lineReasons, `${la.status}:${la.reason}`);
    const s = perCondition.get(c.condition_id.toLowerCase()) ?? new Set<string>(); s.add(la.status); perCondition.set(c.condition_id.toLowerCase(), s);
  }
  // A condition is PROVEN only when every contract of it is; otherwise the worst status among its contracts (AMBIGUOUS > UNSUPPORTED > UNAVAILABLE).
  const rank = ["AMBIGUOUS", "UNSUPPORTED", "UNAVAILABLE", "PROVEN"];
  const lineConditions: Record<string, number> = {};
  for (const [, s] of perCondition) bump(lineConditions, rank.find((x) => s.has(x)) ?? "UNAVAILABLE");

  // ── stage 2: capped candidate-row assessment ──
  let rows: Row[] = [];
  if (db) {
    budget.reserve("candidates", RAW_ROWS_PER_STAGE_CAP);
    let q = candidate(scoped(db.from("research_inplay_core_path_observations").select(COLUMNS)));
    if (conditions.length) q = q.in("condition_id", conditions);
    const r = await q.order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(RAW_ROWS_PER_STAGE_CAP);
    if (r.error) throw new Error(`TAIL_PROOF_READ:${r.error.message}`);
    rows = (r.data ?? []) as unknown as Row[];
    budget.release("candidates", RAW_ROWS_PER_STAGE_CAP - rows.length);
  }
  const byGame = new Map<string, Row[]>();
  for (const r of rows) { const g = byGame.get(r.physical_event_id); if (g) g.push(r); else byGame.set(r.physical_event_id, [r]); }
  const assessments: TailRowAssessment[] = [];
  for (const [, g] of byGame) {
    const bad = findScoreInconsistencies(g); // sample-only: the full per-game series is intentionally not scanned under the row budget
    for (const r of g) assessments.push(assessTailRow({ row: r, line: lineByContract.get(keyOf(r.physical_event_id, r.condition_id, r.token_id)) ?? resolveLineAuthority({ conditionId: r.condition_id, tokenId: r.token_id, side: r.side, observationSlug: r.market_slug, market: markets.get(r.condition_id.toLowerCase()) ?? null }), scoreInconsistent: bad.has(r.id), model: null }));
  }
  const byContract = new Map<string, TailRowAssessment[]>();
  for (const a of assessments) { const k = keyOf(a.physical_event_id, a.condition_id, a.token_id); const g = byContract.get(k); if (g) g.push(a); else byContract.set(k, [a]); }
  const decisions = { bet_n: 0, skip_n: 0, waiting_n: 0 };
  const blockers: Record<string, number> = {};
  for (const [, list] of byContract) {
    const d = freezeContractDecision(list);
    if (!d) continue;
    if (d.status === "BET") decisions.bet_n++; else if (d.status === "SKIP") decisions.skip_n++; else decisions.waiting_n++;
    for (const b of d.blockers) bump(blockers, b);
  }

  console.log(JSON.stringify({
    STATUS: "SUCCESS", day, scope: "SOCCER_TOTALS_FULL_GAME", provisional_research_gates: PROVISIONAL_RESEARCH_GATES,
    stage0_counts: counts,
    contracts_checked_n: contracts.length, conditions_checked_n: conditions.length, provider_markets_fetched_n: [...markets.values()].filter(Boolean).length,
    contract_source: handoff ? "PUBLIC_HANDOFF_CSV" : "CAPPED_DISCOVERY_READ", discovery_truncated: discoveryTruncated,
    line_authority: { contracts: lineContracts, observations: lineObservations, conditions: lineConditions, reasons: lineReasons },
    candidate_rows_assessed_n: rows.length, candidate_contracts_n: byContract.size, candidate_decisions: decisions, candidate_blockers: blockers,
    settlement: "NOT_RUN_ROW_BUDGET", EV_MODEL_AUTHORITY: "ABSENT_NO_CALIBRATED_INDEPENDENT_MODEL_REGISTERED",
    RAW_ROW_BUDGET: budget.snapshot(),
  }));
}
main().catch((e) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : "UNKNOWN" })); process.exitCode = 1; });
