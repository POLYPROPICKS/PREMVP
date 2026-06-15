import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "crypto";

const POLICY_VERSION = "battle-sm-guard-v1-20260615";

export type StrategicScope = "WC" | "SOCCER" | "MLB" | "ESPORT" | "OTHER" | "UNKNOWN";

export interface FireModelCandidate {
  signal_id: string;
  strategy: string;
  rank: number;
  market_slug: string;
  event_slug: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  selected_outcome: string | null;
  inferred_sport: string;
  market_family: string;
  strategic_scope: StrategicScope;
  max_entry_price: number;
  stake_usd: number;
  max_order_usd: number;
  max_spread: number;
  one_order_only: boolean;
  executor_mode_allowed: string;
  first_live_test_allowed: boolean;
  stale_after: string;
  no_trade_after: string | null;
  idempotency_key: string;
  model_rule_id: string;
  created_at: string;
  source: string;
  diagnostics: {
    executor_action: string;
    paper_only: boolean;
    real_trade: boolean;
    score: number;
    coverage: number;
    smart_money: number | null;
    entry_price: number;
    game_start_iso: string;
    hours_to_start_now: number;
    fire_model_alias: string;
    version: string;
  };
}

const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];

const TIER_ORDER: Record<string, number> = {
  TIER1_CORE_STRICT_72_COV50: 1,
  TIER2_SAFE_EXPAND_60_COV50: 2,
  TIER3_MICRO_EXPAND_50_COV25: 3,
};

const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const WC_RE = /world[\s-]?cup|wc2026|fifa|cabo|belgium|egypt|spain/i;
const SOCCER_RE = /soccer|\bfootball\b|premier[\s-]league|serie[\s-]a|bundesliga|la[\s-]liga|\bmls\b|champions[\s-]league|europa[\s-]league|ligue|eredivisie|match[\s-]result|clean[\s-]sheet|btts|both[\s-]teams/i;
const MLB_RE = /\bmlb\b|\bbaseball\b|royals|yankees|red[\s-]sox|dodgers|\bcubs\b|\bmets\b|cardinals|\bbraves\b|astros|phillies|padres|mariners|brewers|pirates|\breds\b|orioles|nationals|athletics|\btigers\b|\btwins\b|white[\s-]sox|\brangers\b|\bangels\b|guardians|\brays\b|rockies|diamondbacks|marlins|blue[\s-]jays/i;

function isSportsExcluded(text: string): boolean {
  return NBA_NHL_RE.test(text);
}

function inferScope(ref: string): StrategicScope {
  if (WC_RE.test(ref)) return "WC";
  if (SOCCER_RE.test(ref)) return "SOCCER";
  if (MLB_RE.test(ref)) return "MLB";
  if (ESPORTS_RE.test(ref)) return "ESPORT";
  return "UNKNOWN";
}

function inferSportAndFamily(scope: StrategicScope): { sport: string; family: string } {
  switch (scope) {
    case "WC":     return { sport: "soccer",   family: "world_cup" };
    case "SOCCER": return { sport: "soccer",   family: "soccer"    };
    case "MLB":    return { sport: "baseball", family: "mlb"       };
    case "ESPORT": return { sport: "esport",   family: "esport"    };
    default:       return { sport: "unknown",  family: "other"     };
  }
}

function computeTier(score: number, coverage: number): string | null {
  if (score >= 72 && coverage >= 50) return "TIER1_CORE_STRICT_72_COV50";
  if (score >= 60 && coverage >= 50) return "TIER2_SAFE_EXPAND_60_COV50";
  if (score >= 50 && coverage >= 25) return "TIER3_MICRO_EXPAND_50_COV25";
  return null;
}

function computeBaseStake(score: number, coverage: number): number {
  if (score >= 72 && coverage >= 75) return 10;
  if (score >= 72 && coverage >= 50) return 7;
  if (score >= 60 && coverage >= 50) return 7;
  if (score >= 50 && coverage >= 25) return 3;
  return 0;
}

function computeStake(base: number, smartMoney: number | null, esports: boolean): number {
  let stake = smartMoney != null && smartMoney >= 75 ? Math.floor(base / 2) : base;
  if (esports) stake = Math.min(stake, 5);
  return Math.min(stake, 10);
}

function computeExecutorAction(score: number, coverage: number, hoursToStart: number, tier: string): string {
  if (hoursToStart < 0) return "SKIP_STARTED";
  if (hoursToStart <= 2 && (tier === "TIER1_CORE_STRICT_72_COV50" || tier === "TIER2_SAFE_EXPAND_60_COV50")) {
    return "BET_OR_PAPER_GO";
  }
  if (score >= 75 && coverage >= 75 && hoursToStart <= 6) return "QUEUE_TOP_TIER_ONLY";
  if (hoursToStart > 6) return "QUEUE_LATER";
  return "QUEUE_WAIT_T_MINUS_60";
}

function makeIdempotencyKey(signalId: string, tokenId: string): string {
  return createHash("sha256")
    .update(`${signalId}__${tokenId}__${POLICY_VERSION}`)
    .digest("hex")
    .slice(0, 32);
}

export async function buildFireModelCandidates(limit: number, scope = "all"): Promise<FireModelCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, condition_id, selected_outcome, selected_token_id, entry_price_num, " +
      "signal_confidence_num, smart_money_score_num, diagnostics, " +
      "market_slug, event_slug, metric_formula_version, created_at, expires_at"
    )
    .in("metric_formula_version", ALLOWED_VERSIONS)
    .is("signal_result", null)
    .gt("expires_at", new Date().toISOString())
    .not("selected_token_id", "is", null)
    .not("condition_id", "is", null)
    .not("entry_price_num", "is", null)
    .gte("signal_confidence_num", 50)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`DB query failed: ${error.message}`);

  const now = Date.now();
  const candidates: Array<Omit<FireModelCandidate, "rank">> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (data ?? []) as any[]) {
    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const coverage = typeof diag.dataCoverage === "number" ? diag.dataCoverage : null;
    const gameStartIso = typeof diag.gameStartIso === "string" && diag.gameStartIso !== "null"
      ? diag.gameStartIso : null;
    const score = typeof row.signal_confidence_num === "number" ? row.signal_confidence_num : null;
    const entryPrice = typeof row.entry_price_num === "number" ? row.entry_price_num : null;

    if (coverage == null || coverage < 25) continue;
    if (score == null || score < 50) continue;
    if (entryPrice == null) continue;
    if (!gameStartIso) continue;

    const gameStartMs = new Date(gameStartIso).getTime();
    if (isNaN(gameStartMs) || gameStartMs <= now) continue;

    const marketRef = ((row.market_slug ?? "") + " " + (row.event_slug ?? "")).toLowerCase();
    if (isSportsExcluded(marketRef)) continue;

    // Bad bucket: coverage 50–74 AND entry_price 0.44–0.58
    if (coverage >= 50 && coverage <= 74 && entryPrice >= 0.44 && entryPrice <= 0.58) continue;

    const strategicScope = inferScope(marketRef);

    // scope filter — default "all" passes everything
    if (scope !== "all") {
      const want = scope.toUpperCase();
      if (want === "WC"     && strategicScope !== "WC") continue;
      if (want === "SOCCER" && strategicScope !== "WC" && strategicScope !== "SOCCER") continue;
      if (want === "MLB"    && strategicScope !== "MLB") continue;
      if (want === "ESPORT" && strategicScope !== "ESPORT") continue;
    }

    const tier = computeTier(score, coverage);
    if (!tier) continue;

    const isEsport = ESPORTS_RE.test(marketRef);
    const smartMoney = typeof row.smart_money_score_num === "number" ? row.smart_money_score_num : null;
    const baseStake = computeBaseStake(score, coverage);
    const stakeUsd = computeStake(baseStake, smartMoney, isEsport);
    if (stakeUsd <= 0) continue;

    const maxEntryPrice = Math.min(Math.round((entryPrice + 0.04) * 1000) / 1000, 0.99);
    const hoursToStart = Math.round(((gameStartMs - now) / 3_600_000) * 100) / 100;
    const executorAction = computeExecutorAction(score, coverage, hoursToStart, tier);

    const { sport, family } = inferSportAndFamily(strategicScope);
    const staleAfter = typeof row.expires_at === "string" ? row.expires_at : gameStartIso;
    const selectedOutcome = typeof row.selected_outcome === "string" ? row.selected_outcome : null;
    const side = selectedOutcome ?? "Yes";

    candidates.push({
      signal_id: row.id,
      strategy: tier,
      market_slug: row.market_slug || row.event_slug || row.condition_id,
      event_slug: typeof row.event_slug === "string" && row.event_slug.trim() ? row.event_slug : null,
      condition_id: row.condition_id,
      token_id: row.selected_token_id,
      side,
      selected_outcome: selectedOutcome,
      inferred_sport: sport,
      market_family: family,
      strategic_scope: strategicScope,
      max_entry_price: maxEntryPrice,
      stake_usd: stakeUsd,
      max_order_usd: 5,
      max_spread: 0.03,
      one_order_only: true,
      executor_mode_allowed: "dry_run_only",
      first_live_test_allowed: true,
      stale_after: staleAfter,
      no_trade_after: gameStartIso,
      idempotency_key: makeIdempotencyKey(row.id, row.selected_token_id),
      model_rule_id: POLICY_VERSION,
      created_at: row.created_at,
      source: "FireModel1_private_executor_2026_06_15",
      diagnostics: {
        executor_action: executorAction,
        paper_only: true,
        real_trade: false,
        score,
        coverage,
        smart_money: smartMoney,
        entry_price: entryPrice,
        game_start_iso: gameStartIso,
        hours_to_start_now: hoursToStart,
        fire_model_alias: "FireModel1",
        version: row.metric_formula_version,
      },
    });
  }

  candidates.sort((a, b) => {
    const tierDiff = (TIER_ORDER[a.strategy] ?? 9) - (TIER_ORDER[b.strategy] ?? 9);
    if (tierDiff !== 0) return tierDiff;
    const scoreDiff = b.diagnostics.score - a.diagnostics.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.diagnostics.hours_to_start_now - b.diagnostics.hours_to_start_now;
  });

  return candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));
}
