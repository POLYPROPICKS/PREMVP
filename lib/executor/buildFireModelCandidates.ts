import { supabaseAdmin } from "@/lib/supabase/server";

export interface FireModelCandidate {
  signal_id: string;
  strategy: string;
  rank: number;
  market_slug: string;
  condition_id: string;
  token_id: string;
  side: string;
  max_entry_price: number;
  stake_usd: number;
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

function isSportsExcluded(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i.test(text);
}

function isEsports(text: string | null | undefined): boolean {
  if (!text) return false;
  return /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i.test(text);
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

export async function buildFireModelCandidates(limit: number): Promise<FireModelCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, condition_id, selected_outcome, selected_token_id, entry_price_num, " +
      "signal_confidence_num, smart_money_score_num, diagnostics, " +
      "market_slug, event_slug, metric_formula_version, created_at"
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

    const marketRef = (row.market_slug ?? "") + " " + (row.event_slug ?? "");
    if (isSportsExcluded(marketRef)) continue;

    // Bad bucket: coverage 50–74 AND entry_price 0.44–0.58
    if (coverage >= 50 && coverage <= 74 && entryPrice >= 0.44 && entryPrice <= 0.58) continue;

    const tier = computeTier(score, coverage);
    if (!tier) continue;

    const esports = isEsports(marketRef);
    const smartMoney = typeof row.smart_money_score_num === "number" ? row.smart_money_score_num : null;
    const baseStake = computeBaseStake(score, coverage);
    const stakeUsd = computeStake(baseStake, smartMoney, esports);
    if (stakeUsd <= 0) continue;

    const maxEntryPrice = Math.min(Math.round((entryPrice + 0.04) * 1000) / 1000, 0.99);
    const hoursToStart = Math.round(((gameStartMs - now) / 3_600_000) * 100) / 100;
    const executorAction = computeExecutorAction(score, coverage, hoursToStart, tier);

    candidates.push({
      signal_id: row.id,
      strategy: tier,
      market_slug: row.market_slug || row.event_slug || row.condition_id,
      condition_id: row.condition_id,
      token_id: row.selected_token_id,
      side: row.selected_outcome ?? "Yes",
      max_entry_price: maxEntryPrice,
      stake_usd: stakeUsd,
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
