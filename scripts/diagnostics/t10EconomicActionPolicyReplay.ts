// T10_ECONOMIC_ACTION_POLICY_FREEZE_V1 — bounded READ-ONLY counterfactual replay (AGGREGATE_FIRST).
// MONEY_PATH_ACTIVE=NO. Nothing here writes; nothing on the money path reads this script.
//
// Stage 1 (aggregate): ONE DB-side read-only statement grades every recent natural T10 candidate
//   (exactMarketReference V1 rules, mirrored in SQL as in t10ExactMarketReferenceReplay), derives the
//   T30_EXACT_BID_ANCHOR_V1 price authority, simulates the Maker rule, picks <=1 action per reservation
//   and returns ONLY GROUP BY counts. No raw observation rows leave the database.
// Stage 2 (bounded detail): <=20 candidate rows are fetched and re-graded by the pure TypeScript policy
//   (lib/executor/t10EconomicActionPolicy.ts); any disagreement with the SQL grade exits non-zero.
//
// Evidence gaps are reported, never filled:
//   - T10 captures persist no ask ladder / depth / fee  => TAKER_EXECUTION_EVIDENCE_MISSING for every candidate.
//   - T10 captures persist no tick_size                 => Maker is TICK_UNKNOWN unless --assume-tick is given.
//     --assume-tick is a labelled SENSITIVITY input (NOT authoritative); the default run assumes nothing.
//   - Exposure and latest-entry state are not in the T10 tables; they are assumed clear (beforeLatestEntry=true,
//     exposureExists=false) and reported as such.
//
// Transport: Supabase Management API SQL endpoint with read_only=true (SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF).
// Usage: npx tsx scripts/diagnostics/t10EconomicActionPolicyReplay.ts [--hours=72] [--assume-tick=0.01]
//        [--detail-limit=20] [--focus-slug=<market_slug> --focus-side=<Under|Over|..>]
import { evaluateExactMarketReference, type ReferenceEvidence } from "../../lib/executor/exactMarketReference";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "../../lib/executor/executorQueueTypes";
import { bStrategySupportRegion } from "../../lib/executor/reservationMarketBaseline";
import { evaluateT10EconomicAction, PRICE_AUTHORITY_VERSION, T10_ECONOMIC_ACTION_POLICY_VERSION, type PolicyCandidateInput } from "../../lib/executor/t10EconomicActionPolicy";
import { LIVE_EXECUTION_MAX_SPREAD } from "../../lib/executor/executorQueueTypes";

const MAX_HOURS = 72;
const MAX_T10_RUNS = 50;
const MAX_DETAIL = 20;
const RAW_ROW_CEILING = 200;
const FAMILIES = ["SPREADS", "TOTAL_CORNERS", "MONEYLINE", "TOTALS"] as const;
const B_VARIANT = "B_FOUR_MARKET_PRIORITY_V1";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function readOnlySql<T>(query: string): Promise<T[]> {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) throw new Error("REPLAY_ENV_MISSING: SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN");
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: true }),
  });
  if (!res.ok) throw new Error(`READ_ONLY_SQL_FAILED: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T[];
}

function candidateCte(since: string, tick: number | null): string {
  const regions = FAMILIES.map((f) => {
    const r = bStrategySupportRegion(f);
    return r ? `(${lit(f)}, ${r.min}, ${r.max})` : null;
  }).filter(Boolean).join(", ");
  const eps = 1e-9;
  const spread = LIVE_EXECUTION_MAX_SPREAD;
  const cap = QUEUE_MAX_ENTRY_PRICE;
  const tickSql = tick === null ? "NULL::numeric" : `${tick}::numeric`;
  // Same ordered rejection rules as exactMarketReference.bookRejection.
  const bookReason = (o: string, run: string, phase: string, lo: number, hi: number) => `CASE
      WHEN ${o}.observation_phase <> ${lit(phase)} THEN 'PHASE_LABEL_MISMATCH'
      WHEN NOT (${run}.capture_complete IS TRUE AND ${run}.capture_status = 'COMPLETE') THEN 'CAPTURE_INCOMPLETE'
      WHEN ${o}.orderbook_fetch_status IS DISTINCT FROM 'SUCCESS' THEN 'ORDERBOOK_FETCH_NOT_SUCCESS'
      WHEN NOT (extract(epoch FROM (${o}.event_start_iso - ${o}.observed_at)) / 60 > ${lo}
            AND extract(epoch FROM (${o}.event_start_iso - ${o}.observed_at)) / 60 <= ${hi}) THEN 'STALE_OR_OUTSIDE_PHASE_WINDOW'
      WHEN ${o}.best_bid IS NULL OR ${o}.best_ask IS NULL OR ${o}.best_bid <= 0 OR ${o}.best_ask >= 1 THEN 'BOOK_ONE_SIDED'
      WHEN ${o}.best_bid > ${o}.best_ask + ${eps} THEN 'BOOK_CROSSED'
      WHEN ${o}.best_ask - ${o}.best_bid > ${spread} + ${eps} THEN 'BOOK_SPREAD_ABOVE_SOURCE_QUALITY'
      ELSE NULL END`;
  return `
WITH t10_runs AS (
  SELECT id, reservation_id, capture_complete, capture_status FROM reservation_market_capture_runs
  WHERE observation_phase = 'T_MINUS_10' AND observed_at >= ${lit(since)}
  ORDER BY observed_at DESC LIMIT ${MAX_T10_RUNS}
), t30_runs AS (
  SELECT DISTINCT ON (r.reservation_id) r.id, r.reservation_id, r.capture_complete, r.capture_status
  FROM reservation_market_capture_runs r JOIN t10_runs t ON t.reservation_id = r.reservation_id
  WHERE r.observation_phase = 'T_MINUS_30' ORDER BY r.reservation_id, r.observed_at DESC
), regions(family, lo, hi) AS (VALUES ${regions}),
base AS (
  SELECT o.id, o.reservation_id, o.physical_event_id, o.condition_id, o.token_id, o.side,
    o.canonical_market_family AS family, o.market_slug, o.best_bid, o.best_ask, o.ask_decimal_odds,
    ${bookReason("o", "r", "T_MINUS_10", 9, 15)} AS t10_reason,
    t30.best_bid AS t30_bid, t30.best_ask AS t30_ask, (t30.id IS NOT NULL) AS t30_present,
    CASE WHEN t30.id IS NULL THEN NULL
         WHEN t30.physical_event_id <> o.physical_event_id THEN 'IDENTITY_PHYSICAL_EVENT_MISMATCH'
         ELSE ${bookReason("t30", "r30", "T_MINUS_30", 20, 30)} END AS t30_reason,
    cmp.best_bid AS cmp_bid, cmp.best_ask AS cmp_ask, cmp.side AS cmp_side, (cmp.id IS NOT NULL) AS cmp_present,
    coalesce(rg.family IS NOT NULL AND o.ask_decimal_odds BETWEEN rg.lo AND rg.hi, false) AS b_region,
    EXISTS (SELECT 1 FROM reservation_strategy_observations s WHERE s.market_observation_id = o.id
      AND s.strategy_variant = ${lit(B_VARIANT)} AND s.evaluation_state = 'SELECTED') AS b_selected
  FROM t10_runs r
  JOIN reservation_market_observations o ON o.capture_run_id = r.id
  LEFT JOIN regions rg ON rg.family = o.canonical_market_family
  LEFT JOIN t30_runs r30 ON r30.reservation_id = r.reservation_id
  LEFT JOIN reservation_market_observations t30 ON t30.capture_run_id = r30.id
    AND t30.condition_id = o.condition_id AND t30.token_id = o.token_id AND t30.side = o.side
  LEFT JOIN LATERAL (SELECT c.id, c.best_bid, c.best_ask, c.side FROM reservation_market_observations c
    WHERE c.capture_run_id = o.capture_run_id AND c.condition_id = o.condition_id AND c.token_id <> o.token_id
    ORDER BY c.id LIMIT 1) cmp ON true
  WHERE o.canonical_market_family IN (${FAMILIES.map(lit).join(", ")})
), graded AS (
  SELECT b.*, (b.t10_reason IS NULL)::int + (b.t30_present AND b.t30_reason IS NULL)::int AS usable_n,
    CASE WHEN b.t10_reason IS NULL AND b.t30_present AND b.t30_reason IS NULL THEN greatest(b.best_bid, b.t30_bid)
         WHEN b.t10_reason IS NULL THEN b.best_bid WHEN b.t30_present AND b.t30_reason IS NULL THEN b.t30_bid END AS lo,
    CASE WHEN b.t10_reason IS NULL AND b.t30_present AND b.t30_reason IS NULL THEN least(b.best_ask, b.t30_ask)
         WHEN b.t10_reason IS NULL THEN b.best_ask WHEN b.t30_present AND b.t30_reason IS NULL THEN b.t30_ask END AS hi
  FROM base b
), classified AS (
  SELECT g.*,
    CASE WHEN g.cmp_present AND g.cmp_side = g.side THEN 'UNRESOLVED'
         WHEN g.usable_n = 0 THEN 'UNRESOLVED' WHEN g.usable_n = 1 THEN 'WEAK'
         WHEN g.lo > g.hi + ${eps} THEN 'UNRESOLVED' ELSE 'STRONG' END AS status
  FROM graded g
), priced AS (
  -- PRICE authority T30_EXACT_BID_ANCHOR_V1: P_BUY_MAX = min(identity-exact usable T30 best_bid, hard cap).
  SELECT c.*,
    CASE WHEN c.t30_present AND c.t30_reason IS NULL AND c.t30_bid > 0 THEN least(c.t30_bid, ${cap}) END AS p_buy_max,
    CASE WHEN NOT c.t30_present THEN 'NO_T30_EXACT_WITNESS'
         WHEN c.t30_reason IS NOT NULL THEN 'T30_WITNESS_REJECTED:' || c.t30_reason END AS pa_reason,
    (c.t10_reason IS NULL OR c.t10_reason = 'BOOK_SPREAD_ABOVE_SOURCE_QUALITY') AS t10_fresh
  FROM classified c
), gated AS (
  SELECT p.*,
    CASE WHEN p.status = 'UNRESOLVED' THEN 'REFERENCE_UNRESOLVED'
         WHEN NOT p.b_region THEN 'NOT_SUPPORT_ELIGIBLE'
         WHEN p.p_buy_max IS NULL THEN 'PRICE_AUTHORITY_UNAVAILABLE'
         WHEN NOT p.t10_fresh OR p.best_ask IS NULL THEN 'T10_BOOK_NOT_FRESH' END AS gate_reason,
    ${tickSql} AS tick
  FROM priced p
), simulated AS (
  SELECT g.*,
    CASE WHEN g.gate_reason IS NULL AND g.tick IS NOT NULL
         THEN round(floor(least(g.p_buy_max, g.best_ask - g.tick, ${cap}) / g.tick + ${eps}) * g.tick, 6) END AS maker_limit
  FROM gated g
), decided AS (
  SELECT s.*,
    -- TAKER is never simulable here: T10 captures persist no ask ladder / depth / fee.
    CASE WHEN s.gate_reason IS NOT NULL THEN s.gate_reason
         WHEN s.status <> 'STRONG' THEN 'TAKER_REQUIRES_STRONG'
         ELSE 'TAKER_EXECUTION_EVIDENCE_MISSING' END AS taker_reason,
    CASE WHEN s.gate_reason IS NOT NULL THEN s.gate_reason
         WHEN s.tick IS NULL THEN 'TICK_UNKNOWN'
         WHEN NOT (s.maker_limit > 0) THEN 'MAKER_LIMIT_NOT_POSITIVE'
         WHEN NOT (s.maker_limit < s.best_ask - ${eps}) THEN 'MAKER_LIMIT_NOT_BELOW_ASK' END AS maker_reason,
    (s.gate_reason IS NULL AND s.status = 'STRONG' AND s.best_ask <= s.p_buy_max) AS taker_ask_within_anchor
  FROM simulated s
), ranked AS (
  SELECT d.*, (d.maker_reason IS NULL) AS maker_ok,
    -- MAKER ranking: STRONG before WEAK, larger cushion, fewer ticks to ask, identity (depth/freshness absent in T10 rows).
    CASE WHEN d.maker_reason IS NULL THEN row_number() OVER (PARTITION BY d.reservation_id, (d.maker_reason IS NULL) ORDER BY
      (d.status <> 'STRONG'), (d.p_buy_max - d.maker_limit) DESC, (d.best_ask - d.maker_limit) ASC,
      d.condition_id, d.token_id, d.side) END AS maker_rank
  FROM decided d
), evt AS (
  SELECT reservation_id,
    count(*) FILTER (WHERE maker_ok) AS makers_n,
    bool_or(b_selected) AS has_b, bool_or(b_selected AND maker_ok) AS b_safe
  FROM ranked GROUP BY reservation_id
)`;
}

type Agg = { k: string; n: number };
type Detail = {
  id: string; physical_event_id: string; condition_id: string; token_id: string; side: string; family: string;
  market_slug: string | null; b_region: boolean; b_selected: boolean; best_bid: number | null; best_ask: number | null;
  t10_reason: string | null; t30_present: boolean; t30_bid: number | null; t30_ask: number | null; t30_reason: string | null;
  cmp_present: boolean; cmp_bid: number | null; cmp_ask: number | null; cmp_side: string | null;
  status: string; p_buy_max: number | null; t10_fresh: boolean; gate_reason: string | null; tick: number | null;
  maker_limit: number | null; maker_reason: string | null; taker_reason: string; maker_ok: boolean; maker_rank: number | null;
};

async function main() {
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(arg("hours") ?? MAX_HOURS)));
  const tickArg = arg("assume-tick");
  const tick = tickArg === undefined ? null : Number(tickArg);
  if (tick !== null && !(tick > 0 && tick < 1)) throw new Error("ASSUME_TICK_INVALID");
  const detailLimit = Math.min(MAX_DETAIL, Math.max(0, Number(arg("detail-limit") ?? MAX_DETAIL)));
  const focusSlug = arg("focus-slug") ?? "";
  const focusSide = arg("focus-side") ?? "";
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const cte = candidateCte(since, tick);

  // ---- Stage 1: aggregates only. ----
  const agg = await readOnlySql<Agg>(`${cte}
SELECT 'runs:t10' k, (SELECT count(*) FROM t10_runs)::int n
UNION ALL SELECT 'runs:t10_complete', (SELECT count(*) FROM t10_runs WHERE capture_complete AND capture_status = 'COMPLETE')::int
UNION ALL SELECT 'runs:t30_matched', (SELECT count(*) FROM t30_runs)::int
UNION ALL SELECT 'reservations', (SELECT count(DISTINCT reservation_id) FROM t10_runs)::int
UNION ALL SELECT 'ref:all:' || status, count(*)::int FROM ranked GROUP BY status
UNION ALL SELECT 'ref:elig:' || status, count(*)::int FROM ranked WHERE b_region GROUP BY status
UNION ALL SELECT 'pa:elig:available', count(*)::int FROM ranked WHERE b_region AND p_buy_max IS NOT NULL
UNION ALL SELECT 'pa:elig:missing', count(*)::int FROM ranked WHERE b_region AND p_buy_max IS NULL
UNION ALL SELECT 'pa:elig:available_strong_or_weak', count(*)::int FROM ranked WHERE b_region AND p_buy_max IS NOT NULL AND status <> 'UNRESOLVED'
UNION ALL SELECT 'pa:src:T30_BOOK', count(*)::int FROM ranked WHERE b_region AND p_buy_max IS NOT NULL
UNION ALL SELECT 'pa:reason:' || coalesce(pa_reason, 'T30_EXACT_BID_ANCHOR'), count(*)::int FROM ranked WHERE b_region GROUP BY pa_reason
UNION ALL SELECT 'tok:safe_maker', count(*) FILTER (WHERE maker_ok)::int FROM ranked
UNION ALL SELECT 'tok:safe_taker', 0
UNION ALL SELECT 'tok:taker_ask_within_anchor_upper_bound', count(*) FILTER (WHERE taker_ask_within_anchor)::int FROM ranked
UNION ALL SELECT 'res:taker_upper_bound', count(DISTINCT reservation_id) FILTER (WHERE taker_ask_within_anchor)::int FROM ranked
UNION ALL SELECT 'res:safe_taker', 0
UNION ALL SELECT 'res:safe_maker', count(*) FILTER (WHERE makers_n > 0)::int FROM evt
UNION ALL SELECT 'res:any_safe', count(*) FILTER (WHERE makers_n > 0)::int FROM evt
UNION ALL SELECT 'act:TAKER_FIRST', 0
UNION ALL SELECT 'act:MAKER_FIRST', count(*) FILTER (WHERE makers_n > 0)::int FROM evt
UNION ALL SELECT 'act:SKIP', count(*) FILTER (WHERE makers_n = 0)::int FROM evt
UNION ALL SELECT 'fam:' || family || ':elig', count(*)::int FROM ranked WHERE b_region GROUP BY family
UNION ALL SELECT 'fam:' || family || ':' || status, count(*)::int FROM ranked WHERE b_region GROUP BY family, status
UNION ALL SELECT 'fam:' || family || ':anchor', count(*)::int FROM ranked WHERE b_region AND p_buy_max IS NOT NULL GROUP BY family
UNION ALL SELECT 'fam:' || family || ':safe_maker', count(*)::int FROM ranked WHERE maker_ok GROUP BY family
UNION ALL SELECT 'fam:' || family || ':selected_maker', count(*)::int FROM ranked WHERE maker_rank = 1 GROUP BY family
UNION ALL SELECT 'reject:maker:' || maker_reason, count(*)::int FROM ranked WHERE b_region AND maker_reason IS NOT NULL GROUP BY maker_reason
UNION ALL SELECT 'reject:taker:' || taker_reason, count(*)::int FROM ranked WHERE b_region GROUP BY taker_reason
UNION ALL SELECT 'curb:selected_n', count(*)::int FROM ranked WHERE b_selected
UNION ALL SELECT 'curb:selected_unresolved_n', count(*)::int FROM ranked WHERE b_selected AND status = 'UNRESOLVED'
UNION ALL SELECT 'curb:selected_safe_action_n', count(*)::int FROM ranked WHERE b_selected AND maker_ok
UNION ALL SELECT 'curb:res_new_action_no_b', count(*) FILTER (WHERE makers_n > 0 AND NOT has_b)::int FROM evt
UNION ALL SELECT 'curb:res_new_action_b_not_safe', count(*) FILTER (WHERE makers_n > 0 AND has_b AND NOT b_safe)::int FROM evt
UNION ALL SELECT 'curb:res_b_safe', count(*) FILTER (WHERE b_safe)::int FROM evt
UNION ALL SELECT 'curb:res_new_winner_differs_from_safe_b', count(*)::int FROM ranked r JOIN evt e USING (reservation_id) WHERE r.maker_rank = 1 AND e.b_safe AND NOT r.b_selected`);
  const get = (k: string) => agg.find((a) => a.k === k)?.n ?? 0;
  const pick = (prefix: string) => Object.fromEntries(agg.filter((a) => a.k.startsWith(prefix) && a.n > 0)
    .map((a) => [a.k.slice(prefix.length), a.n]).sort((a, b) => (b[1] as number) - (a[1] as number)));
  const tally = (p: string) => ({ STRONG_n: get(`${p}:STRONG`), WEAK_n: get(`${p}:WEAK`), UNRESOLVED_n: get(`${p}:UNRESOLVED`) });

  // ---- Stage 2: bounded detail (focus first, then event winners, B-selected, anchored), re-graded in TS. ----
  const detail = detailLimit === 0 ? [] : await readOnlySql<Detail>(`${cte}
SELECT id, physical_event_id, condition_id, token_id, side, family, market_slug, b_region, b_selected,
  best_bid::float8 best_bid, best_ask::float8 best_ask, t10_reason, t30_present, t30_bid::float8 t30_bid, t30_ask::float8 t30_ask, t30_reason,
  cmp_present, cmp_bid::float8 cmp_bid, cmp_ask::float8 cmp_ask, cmp_side, status, p_buy_max::float8 p_buy_max, t10_fresh,
  gate_reason, tick::float8 tick, maker_limit::float8 maker_limit, maker_reason, taker_reason, maker_ok, maker_rank
FROM ranked
ORDER BY (market_slug = ${lit(focusSlug)} AND side = ${lit(focusSide)}) DESC, coalesce(maker_rank = 1, false) DESC, b_selected DESC,
  (p_buy_max IS NOT NULL) DESC, b_region DESC, id
LIMIT ${detailLimit}`);
  const rawRowsRead = detail.reduce((n, d) => n + 1 + (d.t30_present ? 1 : 0) + (d.cmp_present ? 1 : 0), 0);
  if (rawRowsRead > RAW_ROW_CEILING) throw new Error(`RAW_ROW_CEILING_EXCEEDED: ${rawRowsRead}`);

  // Synthetic observation times keep the SQL phase-window verdict (the window columns are not re-fetched).
  const START = "2026-01-01T12:00:00.000Z";
  const at = (minutesBefore: number) => new Date(Date.parse(START) - minutesBefore * 60_000).toISOString();
  const evidenceFor = (source: "T10_BOOK" | "T30_BOOK", d: Detail, bid: number | null, ask: number | null, reason: string | null): ReferenceEvidence => {
    const t10 = source === "T10_BOOK";
    return {
      source, observationKey: `${source}:${d.id}`,
      identity: { physicalEventId: reason === "IDENTITY_PHYSICAL_EVENT_MISMATCH" ? "other" : d.physical_event_id, conditionId: d.condition_id, tokenId: d.token_id, side: d.side },
      observationPhase: t10 ? "T_MINUS_10" : "T_MINUS_30",
      captureComplete: reason !== "CAPTURE_INCOMPLETE",
      fetchStatus: reason === "ORDERBOOK_FETCH_NOT_SUCCESS" ? "FAILED" : "SUCCESS",
      bestBid: bid, bestAsk: ask, eventStartIso: START,
      observedAt: reason === "STALE_OR_OUTSIDE_PHASE_WINDOW" ? at(60) : at(t10 ? 12 : 25),
    };
  };
  const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  let parityMismatch = 0;
  const detailOut = detail.map((d) => {
    const identity = { physicalEventId: d.physical_event_id, conditionId: d.condition_id, tokenId: d.token_id, side: d.side };
    const t10Evidence = evidenceFor("T10_BOOK", d, d.best_bid, d.best_ask, d.t10_reason);
    const evidence: ReferenceEvidence[] = [t10Evidence];
    const t30Evidence = d.t30_present ? evidenceFor("T30_BOOK", d, d.t30_bid, d.t30_ask, d.t30_reason) : null;
    if (t30Evidence) evidence.push(t30Evidence);
    if (d.cmp_present) evidence.push({ ...evidenceFor("T10_BOOK", d, d.cmp_bid, d.cmp_ask, null), source: "BINARY_COMPLEMENT",
      observationKey: `cmp:${d.id}`, identity: { ...identity, tokenId: `${d.token_id}:complement`, side: d.cmp_side ?? "" } });
    const input: PolicyCandidateInput = {
      identity, family: d.family, supportEligible: d.b_region,
      reference: evaluateExactMarketReference(identity, evidence), t30Evidence,
      t10: { bestBid: d.best_bid, bestAsk: d.best_ask, bookFresh: d.t10_fresh, observedAtMs: 0, tickSize: d.tick },
      stakeUsd: QUEUE_DEFAULT_STAKE_USD, hardCap: QUEUE_MAX_ENTRY_PRICE,
      beforeLatestEntry: true, exposureExists: false,
    };
    const ev = evaluateT10EconomicAction(input);
    const expectedMakerReason = d.maker_reason ?? null;
    const parity = ev.referenceStatus === d.status && r6(ev.priceAuthority.pBuyMax) === r6(d.p_buy_max) &&
      ev.maker.eligible === d.maker_ok && r6(ev.maker.limitPrice) === r6(d.maker_limit) &&
      (ev.maker.rejectReason ?? null) === expectedMakerReason && ev.taker.eligible === false &&
      (ev.taker.rejectReason ?? null) === d.taker_reason;
    if (!parity) parityMismatch += 1;
    return {
      physical_event_id: d.physical_event_id, market_slug: d.market_slug, family: d.family, side: d.side,
      token_id_tail: d.token_id.slice(-8), reference_status: ev.referenceStatus,
      t30_bid_ask: d.t30_present ? [d.t30_bid, d.t30_ask] : null, p_buy_max: ev.priceAuthority.pBuyMax,
      price_authority_reason: ev.priceAuthority.reason, t10_bid_ask: [d.best_bid, d.best_ask],
      taker_effective_cost: ev.taker.effectiveCost, taker_advantage_vs_anchor: ev.taker.priceAdvantageVsAnchor,
      taker_reject: ev.taker.rejectReason, maker_limit: ev.maker.limitPrice, maker_cushion_vs_anchor: ev.maker.cushionVsAnchor,
      maker_reject: ev.maker.rejectReason, meaningful_bid_guard: ev.maker.meaningfulBidGuard,
      token_action: ev.shadowAction, event_winner: d.maker_rank === 1, reason: ev.reason,
      current_b_selected: d.b_selected, b_price_region: d.b_region, sql_policy_parity: parity,
    };
  });

  const reservations = get("reservations");
  console.log(JSON.stringify({
    replay: "T10_ECONOMIC_ACTION_POLICY_FREEZE_V1", mode: "AGGREGATE_FIRST_READ_ONLY", MONEY_PATH_ACTIVE: "NO",
    policy_version: T10_ECONOMIC_ACTION_POLICY_VERSION, price_authority_version: PRICE_AUTHORITY_VERSION,
    P_BUY_MAX_formula: `min(T30 identity-exact usable best_bid, ${QUEUE_MAX_ENTRY_PRICE})`,
    window_hours: hours, since,
    tick_input: tick === null ? "UNKNOWN (T10 captures persist no tick_size; Maker => TICK_UNKNOWN)" : `ASSUMED_SENSITIVITY_NOT_AUTHORITATIVE:${tick}`,
    assumptions_not_in_t10_tables: { beforeLatestEntry: true, exposureExists: false, meaningful_best_bid_guard: "NOT_PROVEN" },
    WINDOW: { reservations_n: reservations, complete_t10_runs_n: get("runs:t10_complete"), t10_runs_n: get("runs:t10"), t30_runs_matched_n: get("runs:t30_matched") },
    REFERENCE: { all_family_candidates: tally("ref:all"), support_eligible_candidates: tally("ref:elig") },
    PRICE_AUTHORITY: { support_eligible_available_n: get("pa:elig:available"), support_eligible_missing_n: get("pa:elig:missing"),
      available_and_reference_STRONG_or_WEAK_n: get("pa:elig:available_strong_or_weak"),
      authority_source_counts: pick("pa:src:"), reasons: pick("pa:reason:") },
    SHADOW_ACTIONS_per_reservation: { TAKER_FIRST_n: get("act:TAKER_FIRST"), MAKER_FIRST_n: get("act:MAKER_FIRST"), SKIP_n: reservations - get("act:MAKER_FIRST") - get("act:TAKER_FIRST"),
      reservations_with_supported_universe_n: get("act:MAKER_FIRST") + get("act:SKIP"),
      note: "SKIP counts every reservation without a safe action, including reservations with no supported-family candidates" },
    RESERVATION_LEVEL: { reservations_with_safe_taker_n: get("res:safe_taker"), reservations_with_safe_maker_n: get("res:safe_maker"),
      reservations_with_any_safe_action_n: get("res:any_safe"),
      reservations_where_taker_is_not_ruled_out_by_best_ask_n: get("res:taker_upper_bound"),
      note_taker: "TAKER cannot be simulated: T10 persists no ask ladder/depth/fee. *_not_ruled_out is a necessary-condition upper bound (best_ask <= P_BUY_MAX), NOT a taker count." },
    TOKEN_LEVEL: { safe_maker_n: get("tok:safe_maker"), safe_taker_n: 0, taker_ask_within_anchor_upper_bound_n: get("tok:taker_ask_within_anchor_upper_bound") },
    FAMILY_STRATA: Object.fromEntries(FAMILIES.map((f) => [f, {
      support_eligible_n: get(`fam:${f}:elig`), STRONG_n: get(`fam:${f}:STRONG`), WEAK_n: get(`fam:${f}:WEAK`), UNRESOLVED_n: get(`fam:${f}:UNRESOLVED`),
      anchor_available_n: get(`fam:${f}:anchor`), safe_maker_n: get(`fam:${f}:safe_maker`), event_winner_maker_n: get(`fam:${f}:selected_maker`) }])),
    REJECTION_REASONS: { maker: pick("reject:maker:"), taker: pick("reject:taker:") },
    CURRENT_B_COMPARISON: {
      current_b_selected_n: get("curb:selected_n"), current_b_selected_unresolved_n: get("curb:selected_unresolved_n"),
      current_b_selected_safe_action_n: get("curb:selected_safe_action_n"),
      reservations_new_policy_action_but_b_selected_none_n: get("curb:res_new_action_no_b"),
      reservations_new_policy_action_but_b_selected_not_safe_n: get("curb:res_new_action_b_not_safe"),
      reservations_b_selected_is_safe_n: get("curb:res_b_safe"),
      reservations_new_winner_differs_from_safe_b_n: get("curb:res_new_winner_differs_from_safe_b") },
    AGGREGATE_ROWS_READ: agg.length, DETAIL_ROWS_READ: detail.length, RAW_ROWS_READ_TOTAL: rawRowsRead,
    RAW_ROW_CEILING, SQL_POLICY_PARITY_MISMATCHES: parityMismatch,
  }, null, 2));
  console.log(`\nDETAIL (<=${detailLimit})`);
  for (const row of detailOut) console.log(JSON.stringify(row));
  if (parityMismatch > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
