// DBClone-only, READ-ONLY economic-proof runner for VALUE_BACKED_TAIL_REPRICING (soccer full-game TOTALS).
// Run: npx tsx scripts/research-tail-repricing-proof.ts [YYYY-MM-DD]   (UTC day, default 2026-10-10)
// Reads observations from the research clone, resolves the payoff line from the provider market fetched BY CONDITION ID,
// and prints aggregates plus <= 200 diagnostic rows. Writes nothing. No probability model is registered: EV stays WAITING.
import { createClient } from "@supabase/supabase-js";
import { fetchGammaMarketByConditionId } from "../lib/feed/resolveSignalOutcome";
import type { Observation } from "../lib/research/inplayPaperDecisions";
import {
  resolveLineAuthority, findScoreInconsistencies, assessTailRow, summarizeCoverage, freezeContractDecision, replayTotalsPayoff, reconcileSettlement,
  type LineAuthority, type ProviderMarketRaw, type TailRowAssessment,
} from "../lib/research/tailRepricing";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const MAX_DIAGNOSTIC_ROWS = 200;
const COLUMNS = "id,physical_event_id,provider_game_id,provider_event_id,provider_sport_family,event_start_iso,observed_at,created_at,event_live_status,state_authority,state_phase,state_period_num,state_clock_seconds_remaining,state_clock_seconds_elapsed,state_received_at,side_a_score,side_b_score,condition_id,token_id,side,canonical_market_family,canonical_market_type,market_slug,best_bid,best_ask,bid_depth_relevant_usd,ask_depth_relevant_usd,full_stake_executable_vwap,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled,taker_fee_usd,orderbook_fetch_status";
type Row = Observation & { state_clock_seconds_elapsed: number | null; state_received_at: string | null };

async function main() {
  const url = process.env.SUPABASE_CLONE_URL, key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("TAIL_PROOF_CLONE_CONFIG_MISSING");
  if (!url.includes(CLONE_REF)) throw new Error("TAIL_PROOF_NOT_THE_RESEARCH_CLONE");
  const day = process.argv[2] ?? "2026-10-10";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("TAIL_PROOF_BAD_DAY");
  const from = `${day}T00:00:00.000Z`, to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const rows: Row[] = [];
  let lastAt = from, lastId = "";
  for (let page = 0; page < 20; page++) {
    let q = db.from("research_inplay_core_path_observations").select(COLUMNS)
      .eq("canonical_market_family", "TOTALS").gte("observed_at", from).lt("observed_at", to)
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(1000);
    if (lastId) q = q.or(`observed_at.gt.${lastAt},and(observed_at.eq.${lastAt},id.gt.${lastId})`);
    const r = await q;
    if (r.error) throw new Error(`TAIL_PROOF_READ:${r.error.message}`);
    const batch = (r.data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < 1000) break;
    lastAt = batch[batch.length - 1].observed_at; lastId = batch[batch.length - 1].id;
  }
  const sportCounts: Record<string, number> = {};
  for (const r of rows) sportCounts[r.provider_sport_family] = (sportCounts[r.provider_sport_family] ?? 0) + 1;
  const soccer = rows.filter((r) => /soccer|football/i.test(r.provider_sport_family) && !/american/i.test(r.provider_sport_family));

  // Provider market per unique condition (exact-key fetch), bounded concurrency.
  const conditions = [...new Set(soccer.map((r) => r.condition_id))];
  const markets = new Map<string, ProviderMarketRaw | null>();
  for (let i = 0; i < conditions.length; i += 5)
    await Promise.all(conditions.slice(i, i + 5).map(async (c) => { markets.set(c, (await fetchGammaMarketByConditionId(c)) as ProviderMarketRaw | null); }));

  const byGame = new Map<string, Row[]>();
  for (const r of soccer) { const g = byGame.get(r.physical_event_id); if (g) g.push(r); else byGame.set(r.physical_event_id, [r]); }
  const lineByContract = new Map<string, LineAuthority>();
  const assessments: TailRowAssessment[] = [];
  const finalByGame = new Map<string, { a: number | null; b: number | null; maxPeriod: number | null }>();
  for (const [gameId, g] of byGame) {
    const bad = findScoreInconsistencies(g);
    const finals = g.filter((r) => r.event_live_status === "FINAL" && r.side_a_score !== null && r.side_b_score !== null);
    const lastFinal = finals[finals.length - 1];
    finalByGame.set(gameId, {
      a: lastFinal ? Number(lastFinal.side_a_score) : null, b: lastFinal ? Number(lastFinal.side_b_score) : null,
      maxPeriod: g.reduce<number | null>((m, r) => (r.state_period_num === null ? m : Math.max(m ?? 0, r.state_period_num)), null),
    });
    for (const r of g) {
      const key = `${r.physical_event_id}|${r.condition_id}|${r.token_id}`;
      let line = lineByContract.get(key);
      if (!line) { line = resolveLineAuthority({ conditionId: r.condition_id, tokenId: r.token_id, side: r.side, observationSlug: r.market_slug, market: markets.get(r.condition_id) ?? null }); lineByContract.set(key, line); }
      assessments.push(assessTailRow({ row: r, line, scoreInconsistent: bad.has(r.id), model: null }));
    }
  }

  const coverage = summarizeCoverage(assessments, lineByContract);
  const contracts = new Map<string, TailRowAssessment[]>();
  for (const a of assessments) { const k = `${a.physical_event_id}|${a.condition_id}|${a.token_id}`; const g = contracts.get(k); if (g) g.push(a); else contracts.set(k, [a]); }
  const settlement = { replayable_contracts_n: 0, consistent_n: 0, contradiction_n: 0, provider_unsettled_n: 0, not_replayable_n: 0 };
  const diagnostics: unknown[] = [];
  for (const [key, list] of contracts) {
    const d = freezeContractDecision(list);
    if (!d) continue;
    const line = lineByContract.get(key)!;
    const fin = finalByGame.get(d.physical_event_id)!;
    const replay = replayTotalsPayoff({ line, finalSideAScore: fin.a, finalSideBScore: fin.b, maxPeriodObserved: fin.maxPeriod });
    const rec = reconcileSettlement({ conditionId: d.condition_id, tokenId: d.token_id, market: markets.get(d.condition_id) ?? null, replay });
    if (rec.state === "CONSISTENT") { settlement.consistent_n++; settlement.replayable_contracts_n++; }
    else if (rec.state === "CONTRADICTION") { settlement.contradiction_n++; settlement.replayable_contracts_n++; }
    else if (rec.state === "PROVIDER_UNSETTLED") settlement.provider_unsettled_n++;
    else settlement.not_replayable_n++;
    if (diagnostics.length < MAX_DIAGNOSTIC_ROWS) diagnostics.push({ decision_id: d.decision_id, game: d.physical_event_id, line: d.line, dir: d.direction, status: d.status, edge: d.first_broken_edge, blockers: d.blockers, reconcile: rec.state });
  }
  console.log(JSON.stringify({
    STATUS: "SUCCESS", day, observation_rows_totals_family_n: rows.length, sport_family_counts: sportCounts, soccer_rows_n: soccer.length,
    unique_conditions_n: conditions.length, provider_markets_fetched_n: [...markets.values()].filter(Boolean).length,
    coverage, settlement, EV_MODEL_AUTHORITY: "ABSENT_NO_CALIBRATED_INDEPENDENT_MODEL_REGISTERED", diagnostics_n: diagnostics.length, diagnostics,
  }));
}
main().catch((e) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : "UNKNOWN" })); process.exitCode = 1; });
