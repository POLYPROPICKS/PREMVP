// T10_EXACT_MARKET_REFERENCE_SHADOW_PROOF_V1 — bounded READ-ONLY replay, AGGREGATE_FIRST.
//
// Stage 1 (aggregate): one DB-side SQL statement classifies every recent natural
// T10 candidate with the frozen exactMarketReference V1 rules (expressed in SQL)
// and returns ONLY GROUP BY counts — no raw observation rows leave the database.
// Stage 2 (bounded detail): <=20 joined candidate rows (focus token first) are
// fetched, re-classified by the pure TypeScript engine, and must match the SQL
// grade exactly (parity proof that the SQL mirrors the engine).
// Raw observation rows read are counted and hard-capped at RAW_ROW_CEILING.
//
// Transport: Supabase Management API SQL endpoint with read_only=true
// (SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF). It never writes.
//
// Usage: npx tsx scripts/diagnostics/t10ExactMarketReferenceReplay.ts [--hours=72] [--focus-token=<token_id>]
import { evaluateExactMarketReference, type ReferenceEvidence } from "../../lib/executor/exactMarketReference";
import { LIVE_EXECUTION_MAX_SPREAD } from "../../lib/executor/executorQueueTypes";
import { bStrategySupportRegion } from "../../lib/executor/reservationMarketBaseline";

const MAX_HOURS = 72;
const MAX_T10_RUNS = 50;
const DETAIL_LIMIT = 20;
const RAW_ROW_CEILING = 200;
const B_FAMILIES = ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"] as const;
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

// Classified candidate universe, one row per T10 B-family token (stays DB-side).
function candidateCte(since: string): string {
  const regions = B_FAMILIES.map((f) => {
    const r = bStrategySupportRegion(f);
    return r ? `(${lit(f)}, ${r.min}, ${r.max})` : null;
  }).filter(Boolean).join(", ");
  const eps = 1e-9;
  const spread = LIVE_EXECUTION_MAX_SPREAD;
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
    EXISTS (SELECT 1 FROM reservation_market_observations x WHERE x.capture_run_id = o.capture_run_id
      AND x.canonical_market_family = o.canonical_market_family AND x.condition_id <> o.condition_id) AS other_line_present,
    (rg.family IS NOT NULL AND o.ask_decimal_odds BETWEEN rg.lo AND rg.hi) AS b_region,
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
  WHERE o.canonical_market_family IN (${B_FAMILIES.map(lit).join(", ")})
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
         WHEN g.lo > g.hi + ${eps} THEN 'UNRESOLVED' ELSE 'STRONG' END AS status,
    CASE WHEN g.cmp_present AND g.cmp_side = g.side THEN 'IDENTITY_INCONSISTENT'
         WHEN g.usable_n = 0 THEN 'NO_USABLE_EXACT_WITNESS' WHEN g.usable_n = 1 THEN 'SINGLE_EXACT_WITNESS'
         WHEN g.lo > g.hi + ${eps} THEN 'WITNESS_CONFLICT_NO_COMMON_PRICE' ELSE 'EXACT_WITNESSES_AGREE' END AS reason
  FROM graded g
)`;
}

type Agg = { k: string; n: number };
type Detail = {
  id: string; physical_event_id: string; condition_id: string; token_id: string; side: string;
  family: string; market_slug: string | null; b_region: boolean; b_selected: boolean;
  best_bid: number | null; best_ask: number | null; t10_reason: string | null;
  t30_present: boolean; t30_bid: number | null; t30_ask: number | null; t30_reason: string | null;
  cmp_present: boolean; cmp_bid: number | null; cmp_ask: number | null; cmp_side: string | null;
  other_line_present: boolean; status: string; reason: string; usable_n: number; lo: number | null; hi: number | null;
};

async function main() {
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(arg("hours") ?? MAX_HOURS)));
  const focusToken = arg("focus-token") ?? "";
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const cte = candidateCte(since);

  // ---- Stage 1: aggregates only (keyed counts; zero raw observation rows). ----
  const agg = await readOnlySql<Agg>(`${cte}
SELECT 'runs:t10' k, (SELECT count(*) FROM t10_runs)::int n
UNION ALL SELECT 'runs:t10_complete', (SELECT count(*) FROM t10_runs WHERE capture_complete AND capture_status = 'COMPLETE')::int
UNION ALL SELECT 'runs:t30_matched', (SELECT count(*) FROM t30_runs)::int
UNION ALL SELECT 'reservations', (SELECT count(DISTINCT reservation_id) FROM t10_runs)::int
UNION ALL SELECT 'all:' || status, count(*)::int FROM classified GROUP BY status
UNION ALL SELECT 'b_region:' || status, count(*)::int FROM classified WHERE b_region GROUP BY status
UNION ALL SELECT 'b_selected:' || status, count(*)::int FROM classified WHERE b_selected GROUP BY status
UNION ALL SELECT 'res_cov:b_region_strong', count(DISTINCT reservation_id)::int FROM classified WHERE b_region AND status = 'STRONG'
UNION ALL SELECT 'res_cov:b_region_strong_or_weak', count(DISTINCT reservation_id)::int FROM classified WHERE b_region AND status <> 'UNRESOLVED'
UNION ALL SELECT 'res_cov:any_b_region', count(DISTINCT reservation_id)::int FROM classified WHERE b_region
UNION ALL SELECT 'reason:' || status || ':' || reason, count(*)::int FROM classified GROUP BY status, reason
UNION ALL SELECT 'used:T10_BOOK', count(*) FILTER (WHERE t10_reason IS NULL AND status <> 'UNRESOLVED')::int FROM classified
UNION ALL SELECT 'used:T30_BOOK', count(*) FILTER (WHERE t30_present AND t30_reason IS NULL AND status <> 'UNRESOLVED')::int FROM classified
UNION ALL SELECT 'reject:T10_BOOK:' || t10_reason, count(*)::int FROM classified WHERE t10_reason IS NOT NULL GROUP BY t10_reason
UNION ALL SELECT 'reject:T30_BOOK:' || t30_reason, count(*)::int FROM classified WHERE t30_reason IS NOT NULL GROUP BY t30_reason
UNION ALL SELECT 'reject:BINARY_COMPLEMENT:SAME_CONDITION_BINARY_MIRROR', count(*) FILTER (WHERE cmp_present)::int FROM classified
UNION ALL SELECT 'reject:OTHER_LINE:OTHER_MARKET_NO_VALIDATED_EXACT_MAPPING', count(*) FILTER (WHERE other_line_present)::int FROM classified
UNION ALL SELECT 'reject:RECENT_TRADE:SOURCE_UNAVAILABLE_NO_AUTHORITATIVE_CARRIER', count(*)::int FROM classified
UNION ALL SELECT 'event:' || physical_event_id || ':' || status, count(*)::int FROM classified GROUP BY physical_event_id, status`);
  const get = (k: string) => agg.find((a) => a.k === k)?.n ?? 0;
  const pick = (prefix: string) => Object.fromEntries(agg.filter((a) => a.k.startsWith(prefix) && a.n > 0)
    .map((a) => [a.k.slice(prefix.length), a.n]).sort((a, b) => (b[1] as number) - (a[1] as number)));
  const tally = (p: string) => {
    const s = get(`${p}:STRONG`), w = get(`${p}:WEAK`), u = get(`${p}:UNRESOLVED`);
    return { markets_n: s + w + u, STRONG_n: s, WEAK_n: w, UNRESOLVED_n: u };
  };

  // ---- Stage 2: bounded detail (focus token first), each row re-graded by the TS engine. ----
  const detail = await readOnlySql<Detail>(`${cte}
SELECT id, physical_event_id, condition_id, token_id, side, family, market_slug, b_region, b_selected,
  best_bid::float8 best_bid, best_ask::float8 best_ask, t10_reason, t30_present, t30_bid::float8 t30_bid, t30_ask::float8 t30_ask, t30_reason,
  cmp_present, cmp_bid::float8 cmp_bid, cmp_ask::float8 cmp_ask, cmp_side, other_line_present, status, reason, usable_n, lo::float8 lo, hi::float8 hi
FROM classified
ORDER BY (token_id = ${lit(focusToken)}) DESC, b_selected DESC, b_region DESC, (status <> 'UNRESOLVED') DESC, id
LIMIT ${DETAIL_LIMIT}`);
  // Each joined detail row carries the candidate's T10 row plus its T30 and complement rows.
  const rawRowsRead = detail.reduce((n, d) => n + 1 + (d.t30_present ? 1 : 0) + (d.cmp_present ? 1 : 0), 0);
  if (rawRowsRead > RAW_ROW_CEILING) throw new Error(`RAW_ROW_CEILING_EXCEEDED: ${rawRowsRead}`);

  // The window columns are not re-fetched; the SQL phase-window verdict is fed as observedAt inside/outside the window.
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
  let parityMismatch = 0;
  const detailOut = detail.map((d) => {
    const evidence: ReferenceEvidence[] = [evidenceFor("T10_BOOK", d, d.best_bid, d.best_ask, d.t10_reason)];
    if (d.t30_present) evidence.push(evidenceFor("T30_BOOK", d, d.t30_bid, d.t30_ask, d.t30_reason));
    if (d.cmp_present) evidence.push({ ...evidenceFor("T10_BOOK", d, d.cmp_bid, d.cmp_ask, null), source: "BINARY_COMPLEMENT",
      observationKey: `cmp:${d.id}`, identity: { physicalEventId: d.physical_event_id, conditionId: d.condition_id, tokenId: `${d.token_id}:complement`, side: d.cmp_side ?? "" } });
    if (d.other_line_present) evidence.push({ ...evidenceFor("T10_BOOK", d, null, null, null), source: "OTHER_LINE",
      observationKey: `line:${d.id}`, identity: { physicalEventId: d.physical_event_id, conditionId: `${d.condition_id}:other`, tokenId: "other", side: "other" } });
    evidence.push({ ...evidenceFor("T10_BOOK", d, null, null, null), source: "RECENT_TRADE", observationKey: `trade:${d.id}` });
    const ref = evaluateExactMarketReference({ physicalEventId: d.physical_event_id, conditionId: d.condition_id, tokenId: d.token_id, side: d.side }, evidence);
    const sqlRef = d.status === "UNRESOLVED" || d.lo === null || d.hi === null ? null : Math.round(((d.lo + d.hi) / 2) * 1e6) / 1e6;
    const parity = ref.status === d.status && ref.reason === d.reason && ref.reference_price === sqlRef &&
      ref.independent_witness_count === (d.status === "UNRESOLVED" && d.reason !== "WITNESS_CONFLICT_NO_COMMON_PRICE" ? 0 : d.usable_n);
    if (!parity) parityMismatch += 1;
    return {
      physical_event_id: d.physical_event_id, market_slug: d.market_slug, family: d.family, side: d.side,
      token_id_tail: d.token_id.slice(-8), focus: d.token_id === focusToken, b_selected: d.b_selected, b_price_region: d.b_region,
      bid: d.best_bid, ask: d.best_ask, complement_bid_ask: d.cmp_present ? [d.cmp_bid, d.cmp_ask] : null,
      t30_witness_present: d.t30_present, t10_witness_present: true,
      independent_witness_count: ref.independent_witness_count, status: ref.status,
      reference_price: ref.reference_price, uncertainty: ref.uncertainty, reason: ref.reason,
      rejected: ref.rejected_sources.map((x) => `${x.source}:${x.reason}`), sql_engine_parity: parity,
    };
  });

  console.log(JSON.stringify({
    replay: "T10_EXACT_MARKET_REFERENCE_SHADOW_PROOF_V1", mode: "AGGREGATE_FIRST_READ_ONLY", window_hours: hours, since,
    t10_runs_n: get("runs:t10"), t10_runs_complete_n: get("runs:t10_complete"), t30_runs_matched_n: get("runs:t30_matched"),
    reservations_n: get("reservations"),
    all_candidates: tally("all"), b_price_region_candidates: tally("b_region"), b_selected_candidates: tally("b_selected"),
    reservations_with_b_region_strong_n: get("res_cov:b_region_strong"),
    reservations_with_b_region_strong_or_weak_n: get("res_cov:b_region_strong_or_weak"),
    reservations_with_any_b_region_candidate_n: get("res_cov:any_b_region"),
    status_reasons: pick("reason:"), source_usage: pick("used:"), rejection_reasons: pick("reject:"),
    AGGREGATE_ROWS_READ: agg.length, DETAIL_ROWS_READ: detail.length, RAW_ROWS_READ_TOTAL: rawRowsRead,
    RAW_ROW_CEILING, SQL_ENGINE_PARITY_MISMATCHES: parityMismatch,
  }, null, 2));

  console.log("\nPER_EVENT");
  const events = new Map<string, Record<string, number>>();
  for (const a of agg.filter((x) => x.k.startsWith("event:"))) {
    const rest = a.k.slice("event:".length);
    const cut = rest.lastIndexOf(":");
    const e = events.get(rest.slice(0, cut)) ?? { STRONG: 0, WEAK: 0, UNRESOLVED: 0 };
    e[rest.slice(cut + 1)] = a.n;
    events.set(rest.slice(0, cut), e);
  }
  for (const [event, s] of [...events].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(JSON.stringify({ physical_event_id: event, candidate_markets_n: s.STRONG + s.WEAK + s.UNRESOLVED, STRONG_n: s.STRONG, WEAK_n: s.WEAK, UNRESOLVED_n: s.UNRESOLVED }));
  }
  console.log(`\nDETAIL (<=${DETAIL_LIMIT})`);
  for (const row of detailOut) console.log(JSON.stringify(row));
  if (parityMismatch > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
