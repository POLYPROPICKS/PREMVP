// T10_ECONOMIC_ACTION_POLICY_FREEZE_V1 — bounded READ-ONLY counterfactual replay, AGGREGATE_FIRST.
//
// Builds on the canonical exact-market reference SQL (candidateCte from
// t10ExactMarketReferenceReplay.ts, already engine-parity proven) and applies the
// shadow T10 economic action policy (lib/executor/t10EconomicActionPolicy.ts) DB-side.
//
// Two modes are reported side by side and never mixed:
//   STRICT      — only evidence persisted pre-Queue at T10 (the real money-path input).
//   CONDITIONAL — price authority and reference proven; execution evidence that T10
//                 capture does not persist (full-stake ask ladder, tick, fee) is assumed
//                 to be resolved at execution time. Labelled *_PENDING_EXEC_EVIDENCE.
// Replay assumptions (no carrier at T10): before latest entry, no existing exposure.
//
// Stage 1: GROUP BY counts only. Stage 2: <=20 joined detail rows, each re-evaluated
// by the TypeScript policy in STRICT mode with an explicit parity check.
//
// Usage: npx tsx scripts/diagnostics/t10EconomicActionPolicyReplay.ts [--hours=72] [--focus-token=<token_id>]
import type { ReferenceEvidence } from "../../lib/executor/exactMarketReference";
import { QUEUE_MAX_ENTRY_PRICE } from "../../lib/executor/executorQueueTypes";
import { evaluatePolicyCandidate } from "../../lib/executor/t10EconomicActionPolicy";
import { candidateCte, readOnlySql } from "./t10ExactMarketReferenceReplay";

const MAX_HOURS = 72;
const DETAIL_LIMIT = 20;
const RAW_ROW_CEILING = 200;
const CAP = QUEUE_MAX_ENTRY_PRICE;
const B_PRIORITY = ["SPREADS", "TOTAL_CORNERS", "MONEYLINE", "TOTALS"] as const;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

function policyCte(since: string): string {
  const fresh = `(t10_reason IS NULL OR t10_reason NOT IN ('PHASE_LABEL_MISMATCH','CAPTURE_INCOMPLETE','ORDERBOOK_FETCH_NOT_SUCCESS','STALE_OR_OUTSIDE_PHASE_WINDOW'))`;
  return `${candidateCte(since)},
priced AS (
  SELECT c.*,
    CASE WHEN c.status <> 'UNRESOLVED' AND c.t30_present AND c.t30_reason IS NULL THEN least(c.t30_bid, ${CAP}) END AS p_buy_max,
    ${fresh} AS book_fresh,
    array_position(ARRAY[${B_PRIORITY.map(lit).join(",")}], c.family) AS b_priority
  FROM classified c
), gated AS (
  SELECT p.*,
    CASE WHEN p.status = 'UNRESOLVED' THEN 'REFERENCE_UNRESOLVED:' || p.reason
         WHEN p.p_buy_max IS NULL OR p.p_buy_max <= 0 THEN 'PRICE_AUTHORITY_MISSING_NO_ACCEPTED_T30_WITNESS'
         WHEN NOT coalesce(p.b_region, false) THEN 'OUTSIDE_V1_SUPPORT_BAND'
         WHEN NOT p.book_fresh THEN 'CURRENT_BOOK_NOT_FRESH_OR_NOT_EXACT'
         WHEN p.best_ask IS NULL OR p.best_ask <= 0 OR p.best_ask >= 1 THEN 'NO_EXECUTABLE_ASK'
    END AS shared_reason
  FROM priced p
), policy AS (
  SELECT g.*,
    coalesce(g.shared_reason, CASE WHEN g.status <> 'STRONG' THEN 'TAKER_REQUIRES_STRONG_REFERENCE'
         WHEN g.best_ask > ${CAP} + 1e-9 THEN 'TAKER_ASK_ABOVE_HARD_CAP'
         WHEN g.best_ask > g.p_buy_max + 1e-9 THEN 'TAKER_ASK_ABOVE_P_BUY_MAX'
         ELSE 'TAKER_FULL_STAKE_ASK_LEVELS_UNAVAILABLE' END) AS taker_reason,
    coalesce(g.shared_reason, 'MAKER_TICK_UNAVAILABLE_PRE_QUEUE') AS maker_reason,
    (g.shared_reason IS NULL AND g.status = 'STRONG' AND g.best_ask <= ${CAP} + 1e-9 AND g.best_ask <= g.p_buy_max + 1e-9) AS cond_taker,
    (g.shared_reason IS NULL) AS cond_maker
  FROM gated g
), ranked AS (
  SELECT q.*,
    row_number() OVER (PARTITION BY q.reservation_id ORDER BY
      q.cond_taker DESC, q.cond_maker DESC, (q.status = 'STRONG') DESC, (q.p_buy_max - q.best_ask) DESC NULLS LAST,
      q.condition_id, q.token_id, q.side) AS cond_rank,
    row_number() OVER (PARTITION BY q.reservation_id ORDER BY
      coalesce(q.b_region AND q.book_fresh AND q.best_ask > 0 AND q.ask_decimal_odds > 0, false) DESC, q.b_priority, q.condition_id, q.token_id) AS b_emulated_rank
  FROM policy q
), per_res AS (
  SELECT reservation_id,
    bool_or(cond_taker) AS any_cond_taker, bool_or(cond_maker) AS any_cond_maker,
    bool_or(b_selected) AS has_b_selected,
    bool_or(b_emulated_rank = 1 AND b_region AND book_fresh AND best_ask > 0) AS has_b_emulated,
    bool_or(b_emulated_rank = 1 AND b_region AND book_fresh AND best_ask > 0 AND (cond_taker OR cond_maker)) AS b_emulated_pick_actionable
  FROM ranked GROUP BY reservation_id
)`;
}

type Agg = { k: string; n: number };
type Detail = {
  id: string; reservation_id: string; physical_event_id: string; condition_id: string; token_id: string; side: string;
  family: string; market_slug: string | null; b_selected: boolean; b_region: boolean;
  best_bid: number | null; best_ask: number | null; t10_reason: string | null;
  t30_present: boolean; t30_bid: number | null; t30_ask: number | null; t30_reason: string | null;
  cmp_present: boolean; cmp_bid: number | null; cmp_ask: number | null; cmp_side: string | null;
  status: string; p_buy_max: number | null; taker_reason: string; maker_reason: string;
  cond_taker: boolean; cond_maker: boolean; cond_rank: number; b_emulated_rank: number;
};

async function main() {
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(arg("hours") ?? MAX_HOURS)));
  const focusToken = arg("focus-token") ?? "";
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const cte = policyCte(since);

  // ---- Stage 1: aggregates only. ----
  const agg = await readOnlySql<Agg>(`${cte}
SELECT 'reservations' k, count(DISTINCT reservation_id)::int n FROM ranked
UNION ALL SELECT 'candidates', count(*)::int FROM ranked
UNION ALL SELECT 'ref:' || status, count(*)::int FROM ranked GROUP BY status
UNION ALL SELECT 'authority:AVAILABLE', count(*) FILTER (WHERE p_buy_max IS NOT NULL)::int FROM ranked
UNION ALL SELECT 'authority:MISSING', count(*) FILTER (WHERE p_buy_max IS NULL)::int FROM ranked
UNION ALL SELECT 'authority_in_band:AVAILABLE', count(*) FILTER (WHERE p_buy_max IS NOT NULL AND b_region)::int FROM ranked
UNION ALL SELECT 'strict_taker_reason:' || taker_reason, count(*)::int FROM ranked GROUP BY taker_reason
UNION ALL SELECT 'strict_maker_reason:' || maker_reason, count(*)::int FROM ranked GROUP BY maker_reason
UNION ALL SELECT 'cond:TAKER_PRICE_FEASIBLE', count(*) FILTER (WHERE cond_taker)::int FROM ranked
UNION ALL SELECT 'cond:MAKER_PRICE_FEASIBLE', count(*) FILTER (WHERE cond_maker)::int FROM ranked
UNION ALL SELECT 'res_action:' || CASE WHEN any_cond_taker THEN 'TAKER_FIRST_PENDING_EXEC_EVIDENCE' WHEN any_cond_maker THEN 'MAKER_FIRST_PENDING_EXEC_EVIDENCE' ELSE 'SKIP' END, count(*)::int FROM per_res GROUP BY 1
UNION ALL SELECT 'res:with_cond_taker', count(*) FILTER (WHERE any_cond_taker)::int FROM per_res
UNION ALL SELECT 'res:with_cond_maker', count(*) FILTER (WHERE any_cond_maker)::int FROM per_res
UNION ALL SELECT 'res:with_any_cond_action', count(*) FILTER (WHERE any_cond_taker OR any_cond_maker)::int FROM per_res
UNION ALL SELECT 'res:with_b_selected_t10', count(*) FILTER (WHERE has_b_selected)::int FROM per_res
UNION ALL SELECT 'res:with_b_emulated_pick', count(*) FILTER (WHERE has_b_emulated)::int FROM per_res
UNION ALL SELECT 'res:b_emulated_pick_actionable', count(*) FILTER (WHERE b_emulated_pick_actionable)::int FROM per_res
UNION ALL SELECT 'res:policy_action_where_b_pick_not_actionable', count(*) FILTER (WHERE (any_cond_taker OR any_cond_maker) AND NOT coalesce(b_emulated_pick_actionable, false))::int FROM per_res
UNION ALL SELECT 'b_selected_t10:' || status || ':' || CASE WHEN cond_taker THEN 'TAKER' WHEN cond_maker THEN 'MAKER' ELSE 'SKIP:' || maker_reason END, count(*)::int FROM ranked WHERE b_selected GROUP BY 1
UNION ALL SELECT 'policy_selected_family:' || family, count(*)::int FROM ranked WHERE cond_rank = 1 AND (cond_taker OR cond_maker) GROUP BY family
UNION ALL SELECT 'b_emulated_family:' || family, count(*)::int FROM ranked WHERE b_emulated_rank = 1 AND b_region AND book_fresh AND best_ask > 0 GROUP BY family
UNION ALL SELECT 'family:' || family || ':' || status, count(*)::int FROM ranked GROUP BY family, status
UNION ALL SELECT 'family:' || family || ':AUTHORITY_IN_BAND', count(*) FILTER (WHERE p_buy_max IS NOT NULL AND b_region)::int FROM ranked GROUP BY family
UNION ALL SELECT 'family:' || family || ':COND_TAKER', count(*) FILTER (WHERE cond_taker)::int FROM ranked GROUP BY family
UNION ALL SELECT 'family:' || family || ':COND_MAKER', count(*) FILTER (WHERE cond_maker)::int FROM ranked GROUP BY family
UNION ALL SELECT 'maker_anchor_vs_current_bid:' || CASE WHEN best_bid IS NULL THEN 'NO_BID' WHEN p_buy_max < best_bid - 1e-9 THEN 'BELOW_CURRENT_BID' WHEN p_buy_max <= best_bid + 1e-9 THEN 'AT_CURRENT_BID' ELSE 'ABOVE_CURRENT_BID' END, count(*)::int FROM ranked WHERE cond_maker GROUP BY 1
UNION ALL SELECT 'gap_cents:' || round((best_ask - p_buy_max) * 100)::int, count(*)::int FROM ranked WHERE cond_maker GROUP BY 1`);
  const get = (k: string) => agg.find((a) => a.k === k)?.n ?? 0;
  const pick = (prefix: string) => Object.fromEntries(agg.filter((a) => a.k.startsWith(prefix) && a.n > 0)
    .map((a) => [a.k.slice(prefix.length), a.n]).sort((a, b) => (b[1] as number) - (a[1] as number)));

  // ---- Stage 2: bounded detail. ----
  const detail = await readOnlySql<Detail>(`${cte}
SELECT id, reservation_id, physical_event_id, condition_id, token_id, side, family, market_slug, b_selected, b_region,
  best_bid::float8 best_bid, best_ask::float8 best_ask, t10_reason, t30_present, t30_bid::float8 t30_bid, t30_ask::float8 t30_ask, t30_reason,
  cmp_present, cmp_bid::float8 cmp_bid, cmp_ask::float8 cmp_ask, cmp_side, status, p_buy_max::float8 p_buy_max,
  taker_reason, maker_reason, cond_taker, cond_maker, cond_rank::int cond_rank, b_emulated_rank::int b_emulated_rank
FROM ranked
ORDER BY (token_id = ${lit(focusToken)}) DESC, b_selected DESC, (cond_rank = 1 AND (cond_taker OR cond_maker)) DESC,
  cond_taker DESC, cond_maker DESC, (b_emulated_rank = 1 AND b_region) DESC, id
LIMIT ${DETAIL_LIMIT}`);
  const rawRowsRead = detail.reduce((n, d) => n + 1 + (d.t30_present ? 1 : 0) + (d.cmp_present ? 1 : 0), 0);
  if (rawRowsRead > RAW_ROW_CEILING) throw new Error(`RAW_ROW_CEILING_EXCEEDED: ${rawRowsRead}`);

  // SQL freshness / capture verdicts are fed through observedAt / captureComplete / fetchStatus.
  const START = "2026-01-01T12:00:00.000Z";
  const at = (m: number) => new Date(Date.parse(START) - m * 60_000).toISOString();
  const ev = (source: ReferenceEvidence["source"], d: Detail, bid: number | null, ask: number | null, reason: string | null, tokenId = d.token_id, side = d.side): ReferenceEvidence => ({
    source, observationKey: `${source}:${d.id}`,
    identity: { physicalEventId: reason === "IDENTITY_PHYSICAL_EVENT_MISMATCH" ? "other" : d.physical_event_id, conditionId: d.condition_id, tokenId, side },
    observationPhase: source === "T30_BOOK" ? "T_MINUS_30" : "T_MINUS_10",
    captureComplete: reason !== "CAPTURE_INCOMPLETE", fetchStatus: reason === "ORDERBOOK_FETCH_NOT_SUCCESS" ? "FAILED" : "SUCCESS",
    bestBid: bid, bestAsk: ask, eventStartIso: START,
    observedAt: reason === "STALE_OR_OUTSIDE_PHASE_WINDOW" ? at(60) : at(source === "T30_BOOK" ? 25 : 12),
  });
  let parityMismatch = 0;
  const detailOut = detail.map((d) => {
    const evidence = [ev("T10_BOOK", d, d.best_bid, d.best_ask, d.t10_reason)];
    if (d.t30_present) evidence.push(ev("T30_BOOK", d, d.t30_bid, d.t30_ask, d.t30_reason));
    if (d.cmp_present) evidence.push({ ...ev("BINARY_COMPLEMENT", d, d.cmp_bid, d.cmp_ask, null, `${d.token_id}:complement`, d.cmp_side ?? "") });
    const decision = evaluatePolicyCandidate({
      target: { physicalEventId: d.physical_event_id, conditionId: d.condition_id, tokenId: d.token_id, side: d.side },
      family: d.family, marketSlug: d.market_slug, evidence,
      execution: { askLevels: null, tickSize: null, takerFeeZeroProven: false, meaningfulBestBid: null },
      context: { beforeLatestEntry: true, existingExposure: false },
    });
    const parity = decision.referenceStatus === d.status && decision.pBuyMax === (d.p_buy_max === null ? null : Math.round(d.p_buy_max * 1e8) / 1e8) &&
      decision.taker.rejectReason === d.taker_reason && decision.maker.rejectReason === d.maker_reason;
    if (!parity) parityMismatch += 1;
    return {
      event: d.physical_event_id, market: d.market_slug, side: d.side, family: d.family, token_id_tail: d.token_id.slice(-8),
      focus: d.token_id === focusToken, b_selected_t10: d.b_selected, b_emulated_rank: d.b_emulated_rank,
      reference_status: decision.referenceStatus, prior_authority_source: decision.priceAuthoritySource,
      p_buy_max: decision.pBuyMax, current_bid: d.best_bid, current_ask: d.best_ask,
      taker_effective_cost: decision.taker.effectiveCost, maker_limit: decision.maker.limitPrice,
      maker_limit_upper_bound: decision.pBuyMax, strict_action: decision.taker.eligible ? "TAKER_FIRST" : decision.maker.eligible ? "MAKER_FIRST" : "SKIP",
      conditional_action: d.cond_taker ? "TAKER_FIRST_PENDING_EXEC_EVIDENCE" : d.cond_maker ? "MAKER_FIRST_PENDING_EXEC_EVIDENCE" : "SKIP",
      conditional_rank_in_event: d.cond_rank,
      taker_reject: decision.taker.rejectReason, maker_reject: decision.maker.rejectReason, sql_ts_parity: parity,
    };
  });

  console.log(JSON.stringify({
    replay: "T10_ECONOMIC_ACTION_POLICY_FREEZE_V1", mode: "AGGREGATE_FIRST_READ_ONLY", window_hours: hours, since,
    price_authority_version: "T30_BID_ANCHOR_V1",
    reservations_n: get("reservations"), candidate_tokens_n: get("candidates"),
    reference: { STRONG_n: get("ref:STRONG"), WEAK_n: get("ref:WEAK"), UNRESOLVED_n: get("ref:UNRESOLVED") },
    price_authority: { AVAILABLE_n: get("authority:AVAILABLE"), MISSING_n: get("authority:MISSING"), AVAILABLE_IN_SUPPORT_BAND_n: get("authority_in_band:AVAILABLE") },
    strict_shadow_actions: { TAKER_FIRST_n: 0, MAKER_FIRST_n: 0, SKIP_n: get("reservations"), note: "per reservation; derived from strict reasons below (no strict candidate passes)" },
    strict_taker_reasons: pick("strict_taker_reason:"), strict_maker_reasons: pick("strict_maker_reason:"),
    conditional_candidates: { TAKER_PRICE_FEASIBLE_n: get("cond:TAKER_PRICE_FEASIBLE"), MAKER_PRICE_FEASIBLE_n: get("cond:MAKER_PRICE_FEASIBLE") },
    conditional_shadow_actions_per_reservation: pick("res_action:"),
    reservation_level: {
      reservations_with_safe_taker_n_conditional: get("res:with_cond_taker"),
      reservations_with_safe_maker_n_conditional: get("res:with_cond_maker"),
      reservations_with_any_action_n_conditional: get("res:with_any_cond_action"),
      reservations_with_any_action_n_strict: 0,
      reservations_with_b_selected_t10_n: get("res:with_b_selected_t10"),
      reservations_with_b_emulated_pick_n: get("res:with_b_emulated_pick"),
      reservations_b_emulated_pick_actionable_n: get("res:b_emulated_pick_actionable"),
      reservations_policy_action_where_b_pick_not_actionable_n: get("res:policy_action_where_b_pick_not_actionable"),
    },
    b_selected_t10_counterfactual: pick("b_selected_t10:"),
    policy_selected_family_conditional: pick("policy_selected_family:"), b_emulated_family: pick("b_emulated_family:"),
    family_strata: pick("family:"),
    conditional_maker_ask_minus_p_buy_max_cents: pick("gap_cents:"),
    conditional_maker_anchor_vs_current_bid: pick("maker_anchor_vs_current_bid:"),
    AGGREGATE_ROWS_READ: agg.length, DETAIL_ROWS_READ: detail.length, RAW_ROWS_READ_TOTAL: rawRowsRead, RAW_ROW_CEILING,
    SQL_TS_POLICY_PARITY_MISMATCHES: parityMismatch,
  }, null, 2));
  console.log(`\nDETAIL (<=${DETAIL_LIMIT})`);
  for (const row of detailOut) console.log(JSON.stringify(row));
  if (parityMismatch > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
