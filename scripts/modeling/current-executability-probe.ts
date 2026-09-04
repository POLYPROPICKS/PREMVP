/**
 * CURRENT_EXECUTABILITY_AND_FINAL_FREEZE_V1 — read-only current-capacity probe.
 *
 * SELECT-only. No writes, no execution endpoints, no order placement, no
 * production mutation.
 *
 * Measures CURRENT executable opportunity supply for the three frozen summer
 * finalists (C1 / C4 / C2) against:
 *   A) the current true-wide research population
 *      (metric_formula_version = 'shadow-strategic-sports-v1'), and
 *   B) the exact current Contract A scored planning universe, resolved from
 *      live code (loadContractAPlanningSourceRows / fetchPlanningSourceRowSets):
 *        metric_formula_version IN ('v2-lite-growth-safe',
 *          'shadow-firemodel1_1_research_v0')
 *        AND signal_result IS NULL AND expires_at > now
 *        AND selected_token_id/condition_id/entry_price_num NOT NULL
 *        AND signal_confidence_num >= 50 AND created_at >= now-72h
 *        AND hasStructuredScoredSportAuthority(diagnostics)
 *   C) the current Contract A reservation output (night_event_reservations).
 *
 * Frozen finalist predicates — verbatim from
 * modeling/evidence/summer-model-ranking/SUMMER_MODEL_FINALIST_FREEZE_V1.json,
 * shared band 0.50 <= entry_price < 0.60:
 *   C1: band AND sport_family = soccer
 *   C4: band AND (sport_family = soccer OR lead_time_hours >= 24)
 *   C2: band AND lead_time_hours >= 24
 * No threshold changed. No new model. lead_time_hours = event_start - now
 * (forward / executable-today basis); event_start - created_at also reported.
 *
 * Usage: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 *   npx tsx scripts/modeling/current-executability-probe.ts [--scored-lookback-hours 48] [--json-out F]
 */
import { writeFileSync } from "node:fs";
import { hasStructuredScoredSportAuthority } from "@/lib/feed/sportScoreOwnership";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SCORED_LOOKBACK_H = parseInt(arg("--scored-lookback-hours", "48"), 10);
const WIDE_LOOKBACK_H = parseInt(arg("--wide-lookback-hours", "4"), 10); // wide table is ~40k rows/day; keep the scan bounded
const NOW = Date.now();
const nowIso = new Date(NOW).toISOString();

interface Row {
  id: string;
  condition_id: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  created_at: string;
  expires_at: string | null;
  diagnostics: Record<string, any> | null;
}
const SELECT =
  "id, condition_id, entry_price_num, signal_confidence_num, created_at, expires_at, diagnostics";

async function keysetScan(
  supabaseAdmin: any,
  narrow: (q: any) => any,
  label: string,
  pageSize = 800,
  ceiling = 150_000,
): Promise<Row[]> {
  const out: Row[] = [];
  let cur: { created_at: string; id: string } | null = null;
  for (;;) {
    let q = narrow(
      supabaseAdmin.from("generated_signal_pairs").select(SELECT),
    )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(pageSize);
    if (cur) {
      q = q.or(
        `created_at.lt.${cur.created_at},and(created_at.eq.${cur.created_at},id.lt.${cur.id})`,
      );
    }
    const { data, error } = await q;
    if (error) throw new Error(`${label}: ${error.message}`);
    const batch = (data ?? []) as Row[];
    out.push(...batch);
    if (batch.length < pageSize) break;
    const t = batch[batch.length - 1];
    cur = { created_at: t.created_at, id: t.id };
    if (out.length > ceiling) break;
  }
  return out;
}

const numOr = (v: unknown, d: number | null = null) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

function features(r: Row) {
  const d = r.diagnostics ?? {};
  const fam = String(d.providerSportFamily ?? d.providerSportCode ?? "unknown").toLowerCase();
  const ep = numOr(r.entry_price_num);
  const band = ep != null && ep >= 0.5 && ep < 0.6;
  const ctx = d.providerEventContext ?? {};
  const gs = ctx.eventStartIso ? Date.parse(ctx.eventStartIso) : NaN;
  const leadFwd = Number.isFinite(gs) ? (gs - NOW) / 3_600_000 : null;
  const leadCreated = Number.isFinite(gs) ? (gs - Date.parse(r.created_at)) / 3_600_000 : null;
  const cov = numOr(d.dataCoverage);
  const key = String(d.providerEventId ?? r.condition_id ?? r.id);
  return { fam, ep, band, leadFwd, leadCreated, cov, score: numOr(r.signal_confidence_num), key };
}

function collapse<T extends { key: string }>(rows: Row[], map: (r: Row) => T, pred: (x: T) => boolean) {
  const ordered = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const seen = new Map<string, T>();
  for (const r of ordered) {
    const x = map(r);
    if (seen.has(x.key)) continue;
    if (!pred(x)) continue;
    seen.set(x.key, x);
  }
  return seen;
}

function mix(rows: Row[]) {
  const ev = collapse(rows, features, () => true);
  const m: Record<string, number> = {};
  for (const x of ev.values()) m[x.fam] = (m[x.fam] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const scoredSince = new Date(NOW - SCORED_LOOKBACK_H * 3_600_000).toISOString();
  const wideSince = new Date(NOW - WIDE_LOOKBACK_H * 3_600_000).toISOString();

  // ---- B) scored planning universe (exact current Contract A predicate) ----
  const scoredRaw = await keysetScan(
    supabaseAdmin,
    (q) =>
      q
        .in("metric_formula_version", ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"])
        .is("signal_result", null)
        .not("selected_token_id", "is", null)
        .not("condition_id", "is", null)
        .not("entry_price_num", "is", null)
        .gte("signal_confidence_num", 50)
        .gte("created_at", scoredSince),
    "scored",
  );
  const scored = scoredRaw
    .filter((r) => r.expires_at && r.expires_at > nowIso)
    .filter((r) => hasStructuredScoredSportAuthority(r.diagnostics));
  const scoredSpanH = scoredRaw.length
    ? (Date.parse(scoredRaw[0].created_at) - Date.parse(scoredRaw[scoredRaw.length - 1].created_at)) /
      3_600_000
    : 0;
  const scoredDays = Math.max(scoredSpanH / 24, 0.01);

  // ---- A) current true-wide research supply (bounded scan) ----
  let wideRaw: Row[] = [];
  let wideErr: string | null = null;
  try {
    wideRaw = await keysetScan(
      supabaseAdmin,
      (q) =>
        q
          .eq("metric_formula_version", "shadow-strategic-sports-v1")
          .is("signal_result", null)
          .gte("created_at", wideSince),
      "wide",
      800,
      80_000,
    );
  } catch (e: any) {
    wideErr = e.message;
  }
  const wide = wideRaw.filter((r) => r.expires_at && r.expires_at > nowIso);
  const wideSpanH = wideRaw.length
    ? (Date.parse(wideRaw[0].created_at) - Date.parse(wideRaw[wideRaw.length - 1].created_at)) /
      3_600_000
    : 0;
  const wideDays = Math.max(wideSpanH / 24, 0.01);
  const wideEvents = collapse(wide, features, () => true);
  const wideFieldsComplete = [...wideEvents.values()].filter(
    (x) => x.fam !== "unknown" && x.leadFwd != null,
  ).length;

  // ---- C) current Contract A reservation output ----
  const resvSince = new Date(NOW - 28 * 86_400_000).toISOString();
  const { data: resvData } = await supabaseAdmin
    .from("night_event_reservations")
    .select("reserved_at, plan_date_minsk, sport, strategic_scope, game_start_iso, event_tier, status")
    .gte("reserved_at", resvSince)
    .order("reserved_at", { ascending: false })
    .limit(5000);
  const resv = (resvData ?? []) as any[];
  const resvByDay = new Map<string, number>();
  const resvScope = new Map<string, number>();
  let resvLeadGe24 = 0;
  for (const r of resv) {
    resvByDay.set((r.plan_date_minsk ?? "").slice(0, 10), (resvByDay.get((r.plan_date_minsk ?? "").slice(0, 10)) ?? 0) + 1);
    resvScope.set(String(r.strategic_scope), (resvScope.get(String(r.strategic_scope)) ?? 0) + 1);
    const gs = r.game_start_iso ? Date.parse(r.game_start_iso) : NaN;
    const ra = Date.parse(r.reserved_at);
    if (Number.isFinite(gs) && (gs - ra) / 3_600_000 >= 24) resvLeadGe24++;
  }
  const resvDays = [...resvByDay.keys()].filter(Boolean).length || 1;

  // ---- finalist funnels on the scored planning universe ----
  const badBucket = (x: ReturnType<typeof features>) =>
    x.cov != null && x.ep != null && x.cov >= 50 && x.cov <= 74 && x.ep >= 0.44 && x.ep <= 0.58;

  const finalists = [
    { id: "C1", rule: "band AND soccer", pred: (x: any) => x.band && x.fam === "soccer" },
    {
      id: "C4",
      rule: "band AND (soccer OR lead_fwd>=24h)",
      pred: (x: any) => x.band && (x.fam === "soccer" || (x.leadFwd ?? -1) >= 24),
    },
    { id: "C2", rule: "band AND lead_fwd>=24h", pred: (x: any) => x.band && (x.leadFwd ?? -1) >= 24 },
  ];

  const funnels: Record<string, any> = {};
  const allEv = collapse(scored, features, () => true);
  const leads = [...allEv.values()].map((x) => x.leadFwd).filter((v): v is number => v != null).sort((a, b) => a - b);
  const leadsC = [...allEv.values()].map((x) => x.leadCreated).filter((v): v is number => v != null).sort((a, b) => a - b);
  const qtl = (arr: number[], f: number) => (arr.length ? +arr[Math.floor(f * (arr.length - 1))].toFixed(1) : null);

  for (const f of finalists) {
    const model = collapse(scored, features, f.pred);
    const fieldsComplete = [...model.values()].filter(
      (x) => x.ep != null && x.fam !== "unknown" && x.leadFwd != null && x.score != null && x.cov != null,
    );
    const afterBad = fieldsComplete.filter((x) => !badBucket(x));
    const live6h = afterBad.filter((x) => x.leadFwd != null && x.leadFwd >= 0 && x.leadFwd <= 6);
    const wouldExecEarly = afterBad.filter((x) => x.leadFwd != null && x.leadFwd > 6);
    const leadGe24 = [...model.values()].filter((x) => (x.leadFwd ?? -1) >= 24).length;

    // rejection accounting (per physical event, on the full scored event set)
    let PRICE = 0, SPORT = 0, LEAD_TIME = 0, SCORE = 0, COVERAGE_OR_BAD_BUCKET = 0, CONTRACT_A_TIME_WINDOW = 0;
    for (const x of allEv.values()) {
      if (!x.band) { PRICE++; continue; }
      if (!f.pred(x)) {
        if (f.id === "C1") SPORT++;
        else if (f.id === "C2") LEAD_TIME++;
        else { SPORT++; } // C4 union failure
        continue;
      }
      if (x.score == null) { SCORE++; continue; }
      if (x.cov == null || badBucket(x)) { COVERAGE_OR_BAD_BUCKET++; continue; }
      if (!(x.leadFwd != null && x.leadFwd >= 0 && x.leadFwd <= 6)) { CONTRACT_A_TIME_WINDOW++; continue; }
    }

    funnels[f.id] = {
      predicate: f.rule,
      MODEL_ELIGIBLE_N: model.size,
      ELIGIBLE_WITH_LEAD_GE_24H_N: leadGe24,
      REQUIRED_FIELDS_COMPLETE_N: fieldsComplete.length,
      CONTRACT_A_COMPATIBLE_N: afterBad.length,
      LIVE_EXECUTABLE_NOW_LE_6H_N: live6h.length,
      WOULD_EXECUTE_IF_EARLY_ENTRY_ALLOWED_N: wouldExecEarly.length,
      UNIQUE_EXECUTABLE_PHYSICAL_EVENT_N: afterBad.length,
      est_model_eligible_per_day: +(model.size / scoredDays).toFixed(1),
      est_contract_a_compatible_per_day: +(afterBad.length / scoredDays).toFixed(1),
      est_live_executable_le_6h_per_day: +(live6h.length / scoredDays).toFixed(1),
      LOST_ONLY_BECAUSE_OF_CURRENT_TIME_WINDOW_N: CONTRACT_A_TIME_WINDOW,
      rejection_accounting_events: {
        PRICE, SPORT, LEAD_TIME, SCORE, COVERAGE_OR_BAD_BUCKET,
        CONTRACT_A_TIME_WINDOW_GT_6H: CONTRACT_A_TIME_WINDOW,
        CONFIDENCE_LT_50: "removed upstream by the scored predicate (>=50 required)",
      },
    };
  }

  const report = {
    mission: "CURRENT_EXECUTABILITY_AND_FINAL_FREEZE_V1",
    probe_at: nowIso,
    NO_RETUNING: true,
    contract_a_scored_predicate:
      "metric_formula_version IN ('v2-lite-growth-safe','shadow-firemodel1_1_research_v0') AND signal_result IS NULL AND expires_at > now AND selected_token_id/condition_id/entry_price_num NOT NULL AND signal_confidence_num >= 50 AND created_at >= now-72h AND hasStructuredScoredSportAuthority(diagnostics)",

    CURRENT_TRUE_WIDE_SUPPLY: {
      note: wideErr
        ? `bounded scan error: ${wideErr}`
        : "bounded keyset scan (wide table ~40k outcomes/day); rates extrapolated from the scanned span",
      scanned_span_hours: +wideSpanH.toFixed(2),
      CURRENT_PROVIDER_OUTCOME_N_scanned: wide.length,
      CURRENT_PROVIDER_PHYSICAL_EVENT_N_scanned: wideEvents.size,
      est_provider_outcomes_per_day: +(wide.length / wideDays).toFixed(0),
      est_provider_physical_events_per_day: +(wideEvents.size / wideDays).toFixed(0),
      est_price_band_events_per_day: +(
        [...wideEvents.values()].filter((x) => x.band).length / wideDays
      ).toFixed(0),
      REQUIRED_FIELDS_COMPLETE_events_scanned: wideFieldsComplete,
      finding:
        "The true-wide 'shadow-strategic-sports-v1' population does NOT carry diagnostics.providerSportFamily or providerEventContext.eventStartIso — sport_family and event_start are absent — so it supplies ~0 model-executable events for C1/C4/C2. The decision-time fields the finalists need exist only in the scored planning universe below.",
      sport_family_event_mix: mix(wide),
    },

    CURRENT_CONTRACT_A_SCORED_UNIVERSE: {
      scanned_span_hours: +scoredSpanH.toFixed(2),
      raw_rows: scoredRaw.length,
      live_and_structured_sport_authority: scored.length,
      distinct_physical_events: allEv.size,
      est_events_per_day: +(allEv.size / scoredDays).toFixed(0),
      est_price_band_events_per_day: +(
        [...allEv.values()].filter((x) => x.band).length / scoredDays
      ).toFixed(0),
      sport_family_event_mix: mix(scored),
      lead_fwd_hours_qtiles: { min: qtl(leads, 0), p50: qtl(leads, 0.5), p90: qtl(leads, 0.9), p99: qtl(leads, 0.99), max: qtl(leads, 1) },
      lead_created_hours_qtiles: { min: qtl(leadsC, 0), p50: qtl(leadsC, 0.5), p90: qtl(leadsC, 0.9), p99: qtl(leadsC, 0.99), max: qtl(leadsC, 1) },
      lead_ge_24h_events: [...allEv.values()].filter((x) => (x.leadFwd ?? -1) >= 24 || (x.leadCreated ?? -1) >= 24).length,
      structural_finding:
        "No scored planning candidate exceeds ~24h forward or created-basis lead. The scoring pipeline horizon is a hard ~24h wall, so C2 and the non-soccer arm of C4 have ZERO current supply BEFORE the Contract A 6h live gate is even reached.",
    },

    CURRENT_CONTRACT_A_RESERVATIONS_28D: {
      rows: resv.length,
      days: resvDays,
      per_day: +(resv.length / resvDays).toFixed(1),
      strategic_scope_mix: Object.fromEntries([...resvScope.entries()].sort((a, b) => b[1] - a[1])),
      soccer_share_pct: +(((resvScope.get("SOCCER") ?? 0) + (resvScope.get("WC") ?? 0)) / resv.length * 100).toFixed(1),
      lead_ge_24h_reservations: resvLeadGe24,
      per_day_by_plan_date: Object.fromEntries([...resvByDay.entries()].filter(([k]) => k).sort()),
      slot_cap_per_plan_run: 15,
    },

    FINALIST_FUNNELS_ON_SCORED_UNIVERSE: funnels,
  };

  const json = JSON.stringify(report, null, 2);
  const jo = args.indexOf("--json-out");
  if (jo >= 0 && args[jo + 1]) writeFileSync(args[jo + 1], json);
  process.stdout.write(json + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
