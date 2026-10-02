// T10_EXACT_MARKET_REFERENCE_SHADOW_PROOF_V1 — bounded READ-ONLY replay.
//
// Replays the shadow exact-market reference engine over recent natural T10
// captures (reservation_market_capture_runs / reservation_market_observations)
// and the persisted B decisions (reservation_strategy_observations). It never
// writes. Narrow projections only; aggregates are printed first; candidate
// detail is capped at 20 rows.
//
// Usage: npx tsx scripts/diagnostics/t10ExactMarketReferenceReplay.ts [--hours=72] [--focus-token=<token_id>]
import { evaluateExactMarketReference, type ExactMarketReference, type ReferenceEvidence } from "../../lib/executor/exactMarketReference";
import { bStrategySupportRegion } from "../../lib/executor/reservationMarketBaseline";

const MAX_HOURS = 72;
const MAX_RUNS = 50;
const MAX_OBSERVATION_ROWS = 5000; // in-process aggregation input ceiling
const DETAIL_LIMIT = 20;
const B_FAMILIES = new Set(["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
const B_VARIANT = "B_FOUR_MARKET_PRIORITY_V1";

type Run = {
  id: string; reservation_id: string; physical_event_id: string; event_start_iso: string;
  observation_phase: string; observed_at: string; capture_complete: boolean; capture_status: string;
};
type Obs = {
  id: string; capture_run_id: string; reservation_id: string; physical_event_id: string;
  event_start_iso: string; observation_phase: string; observed_at: string;
  condition_id: string; token_id: string; side: string; canonical_market_family: string | null;
  market_slug: string | null; best_bid: number | null; best_ask: number | null;
  ask_decimal_odds: number | null; orderbook_fetch_status: string;
};

const RUN_COLS = "id,reservation_id,physical_event_id,event_start_iso,observation_phase,observed_at,capture_complete,capture_status";
const OBS_COLS = "id,capture_run_id,reservation_id,physical_event_id,event_start_iso,observation_phase,observed_at,condition_id,token_id,side,canonical_market_family,market_slug,best_bid,best_ask,ask_decimal_odds,orderbook_fetch_status";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const inc = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sorted = (map: Map<string, number>) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

function evidenceFrom(source: ReferenceEvidence["source"], o: Obs, run: Run | undefined): ReferenceEvidence {
  return {
    source, observationKey: o.id,
    identity: { physicalEventId: o.physical_event_id, conditionId: o.condition_id, tokenId: o.token_id, side: o.side },
    observationPhase: o.observation_phase, captureComplete: run?.capture_complete === true && run.capture_status === "COMPLETE",
    fetchStatus: o.orderbook_fetch_status, bestBid: num(o.best_bid), bestAsk: num(o.best_ask),
    observedAt: o.observed_at, eventStartIso: o.event_start_iso,
  };
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("REPLAY_ENV_MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  const { supabaseAdmin: db } = await import("../../lib/supabase/server");
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(arg("hours") ?? MAX_HOURS)));
  const focusToken = arg("focus-token");
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const { data: t10Data, error: t10Err } = await db.from("reservation_market_capture_runs").select(RUN_COLS)
    .eq("observation_phase", "T_MINUS_10").gte("observed_at", since).order("observed_at", { ascending: false }).limit(MAX_RUNS);
  if (t10Err) throw new Error(`T10_RUN_READ_FAILED: ${t10Err.message}`);
  const t10Runs = (t10Data ?? []) as Run[];
  const reservationIds = [...new Set(t10Runs.map((r) => r.reservation_id))];
  const { data: t30Data, error: t30Err } = reservationIds.length
    ? await db.from("reservation_market_capture_runs").select(RUN_COLS)
      .eq("observation_phase", "T_MINUS_30").in("reservation_id", reservationIds).limit(MAX_RUNS * 2)
    : { data: [], error: null };
  if (t30Err) throw new Error(`T30_RUN_READ_FAILED: ${t30Err.message}`);
  const runs = new Map<string, Run>([...t10Runs, ...((t30Data ?? []) as Run[])].map((r) => [r.id, r]));

  const observations: Obs[] = [];
  for (const runId of runs.keys()) {
    const { data, error } = await db.from("reservation_market_observations").select(OBS_COLS)
      .eq("capture_run_id", runId).order("id").limit(1000);
    if (error) throw new Error(`OBSERVATION_READ_FAILED: ${error.message}`);
    observations.push(...((data ?? []) as Obs[]));
    if (observations.length > MAX_OBSERVATION_ROWS) throw new Error("OBSERVATION_READ_CEILING_EXCEEDED");
  }

  const bSelected = new Set<string>();
  let bDecisionReadStatus = "OK";
  if (t10Runs.length) {
    const { data, error } = await db.from("reservation_strategy_observations").select("market_observation_id")
      .in("capture_run_id", t10Runs.map((r) => r.id)).eq("strategy_variant", B_VARIANT).eq("evaluation_state", "SELECTED").limit(MAX_RUNS);
    if (error) bDecisionReadStatus = `READ_FAILED: ${error.message}`;
    for (const row of (data ?? []) as { market_observation_id: string }[]) bSelected.add(row.market_observation_id);
  }

  const byRun = new Map<string, Obs[]>();
  for (const o of observations) byRun.set(o.capture_run_id, [...(byRun.get(o.capture_run_id) ?? []), o]);
  const t30RunByReservation = new Map<string, Run>();
  for (const r of runs.values()) if (r.observation_phase === "T_MINUS_30") t30RunByReservation.set(r.reservation_id, r);

  type Row = { o: Obs; ref: ExactMarketReference; t30: boolean; complement: Obs | undefined; bEligible: boolean; bSelected: boolean };
  const rows: Row[] = [];
  const perEvent = new Map<string, { reservations: Set<string>; n: number; STRONG: number; WEAK: number; UNRESOLVED: number }>();
  const sourceUsage = new Map<string, number>();
  const rejectionCounts = new Map<string, number>();
  const statusReasons = new Map<string, number>();

  for (const run of t10Runs) {
    const t10Obs = byRun.get(run.id) ?? [];
    const t30Run = t30RunByReservation.get(run.reservation_id);
    const t30Obs = t30Run ? byRun.get(t30Run.id) ?? [] : [];
    for (const o of t10Obs) {
      if (!B_FAMILIES.has(o.canonical_market_family ?? "")) continue;
      const evidence: ReferenceEvidence[] = [evidenceFrom("T10_BOOK", o, run)];
      const t30 = t30Obs.find((x) => x.condition_id === o.condition_id && x.token_id === o.token_id && x.side === o.side);
      if (t30) evidence.push(evidenceFrom("T30_BOOK", t30, t30Run));
      const complement = t10Obs.find((x) => x.condition_id === o.condition_id && x.token_id !== o.token_id);
      if (complement) evidence.push(evidenceFrom("BINARY_COMPLEMENT", complement, run));
      // One representative other line of the same family: diagnostic only.
      const otherLine = t10Obs.find((x) => x.canonical_market_family === o.canonical_market_family && x.condition_id !== o.condition_id);
      if (otherLine) evidence.push(evidenceFrom("OTHER_LINE", otherLine, run));
      // No authoritative recent-trade carrier exists in the T10 lineage.
      evidence.push({ ...evidenceFrom("RECENT_TRADE", o, run), observationKey: `trade:${o.id}` });
      const ref = evaluateExactMarketReference(
        { physicalEventId: o.physical_event_id, conditionId: o.condition_id, tokenId: o.token_id, side: o.side }, evidence);
      const region = bStrategySupportRegion(o.canonical_market_family ?? "");
      const odds = num(o.ask_decimal_odds);
      rows.push({ o, ref, t30: !!t30, complement, bEligible: !!region && odds !== null && odds >= region.min && odds <= region.max, bSelected: bSelected.has(o.id) });
      const ev = perEvent.get(o.physical_event_id) ?? { reservations: new Set<string>(), n: 0, STRONG: 0, WEAK: 0, UNRESOLVED: 0 };
      ev.reservations.add(o.reservation_id); ev.n += 1; ev[ref.status] += 1;
      perEvent.set(o.physical_event_id, ev);
      for (const s of ref.sources_used) inc(sourceUsage, s);
      for (const r of ref.rejected_sources) inc(rejectionCounts, `${r.source}:${r.reason}`);
      inc(statusReasons, `${ref.status}:${ref.reason}`);
    }
  }

  const tally = (subset: Row[]) => ({
    markets_n: subset.length,
    STRONG_n: subset.filter((r) => r.ref.status === "STRONG").length,
    WEAK_n: subset.filter((r) => r.ref.status === "WEAK").length,
    UNRESOLVED_n: subset.filter((r) => r.ref.status === "UNRESOLVED").length,
  });
  const t10Complete = t10Runs.filter((r) => r.capture_complete && r.capture_status === "COMPLETE").length;
  console.log(JSON.stringify({
    replay: "T10_EXACT_MARKET_REFERENCE_SHADOW_PROOF_V1", window_hours: hours, since,
    t10_runs_n: t10Runs.length, t10_runs_complete_n: t10Complete, t30_runs_n: t30RunByReservation.size,
    observations_read_n: observations.length, b_decision_read: bDecisionReadStatus,
    reservations_n: reservationIds.length,
    all_candidates: tally(rows),
    b_price_region_candidates: tally(rows.filter((r) => r.bEligible)),
    b_selected_candidates: tally(rows.filter((r) => r.bSelected)),
    // One live bet per Reservation: how many Reservations hold >=1 B-region exact market of each grade.
    reservations_with_b_region_strong_n: new Set(rows.filter((r) => r.bEligible && r.ref.status === "STRONG").map((r) => r.o.reservation_id)).size,
    reservations_with_b_region_strong_or_weak_n: new Set(rows.filter((r) => r.bEligible && r.ref.status !== "UNRESOLVED").map((r) => r.o.reservation_id)).size,
    reservations_with_any_b_region_candidate_n: new Set(rows.filter((r) => r.bEligible).map((r) => r.o.reservation_id)).size,
    status_reasons: sorted(statusReasons), source_usage: sorted(sourceUsage), rejection_reasons: sorted(rejectionCounts),
  }, null, 2));

  console.log("\nPER_EVENT");
  for (const [event, s] of [...perEvent].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(JSON.stringify({ physical_event_id: event, reservations_n: s.reservations.size, candidate_markets_n: s.n, STRONG_n: s.STRONG, WEAK_n: s.WEAK, UNRESOLVED_n: s.UNRESOLVED }));
  }

  // Detail: focus token first, then B-selected, then B price region, then STRONG/WEAK.
  const rank = (r: Row) => (r.o.token_id === focusToken ? 0 : r.bSelected ? 1 : r.bEligible ? 2 : r.ref.status !== "UNRESOLVED" ? 3 : 4);
  const detail = [...rows].sort((a, b) => rank(a) - rank(b) || a.o.id.localeCompare(b.o.id)).slice(0, DETAIL_LIMIT);
  console.log(`\nDETAIL (<=${DETAIL_LIMIT})`);
  for (const r of detail) {
    console.log(JSON.stringify({
      physical_event_id: r.o.physical_event_id, market_slug: r.o.market_slug, family: r.o.canonical_market_family, side: r.o.side,
      token_id_tail: r.o.token_id.slice(-8), focus: r.o.token_id === focusToken, b_selected: r.bSelected, b_price_region: r.bEligible,
      bid: num(r.o.best_bid), ask: num(r.o.best_ask),
      complement_bid_ask: r.complement ? [num(r.complement.best_bid), num(r.complement.best_ask)] : null,
      t30_witness_present: r.t30, t10_witness_present: true,
      independent_witness_count: r.ref.independent_witness_count, status: r.ref.status,
      reference_price: r.ref.reference_price, uncertainty: r.ref.uncertainty, reason: r.ref.reason,
      rejected: r.ref.rejected_sources.map((x) => `${x.source}:${x.reason}`),
    }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
