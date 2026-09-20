/**
 * BASEBALL_P40_50_PRODUCTION_COMPARABLE_FINAL_GATE_V1 — research only, read-only, foreground.
 *
 * Counterfactual: keep EVERY current production admission gate, change ONLY the baseball entry-price
 * lower band from >=0.50 to >=0.40 (sleeve = baseball, full-match markets, [0.40,0.50)).
 *
 * Candidate population = the REAL production scored population (research clone generated_signal_pairs):
 *   metric_formula_version IN PRODUCTION_SCORED_PLANNING_VERSIONS, signal_confidence_num >= 50,
 *   diagnostics.providerSportFamily = 'baseball', actual entry_price_num / created_at (decision time).
 * Gates resolved from main (see FINGERPRINT in the artifact):
 *   hasStructuredScoredSportAuthority(diagnostics)          (sportScoreOwnership.ts)
 *   isAllowedFullMatchMarketClass(classifyMarketText(id))    (contur3/taxonomy.ts)
 *   coverage = diagnostics.dataCoverage ?? coverage >= 25    (buildFireModelCandidates.ts:2091)
 *   score = signal_confidence_num >= 50                      (buildFireModelCandidates.ts:2092)
 *   entry price + diagnostics.gameStartIso present; decision >= 30 min before start
 *   B2: not esports; price >= B2_PRICE_FLOOR (0.30); price < CONTRACT_A_MAX_ENTRY_PRICE_EXCLUSIVE (0.60)
 *   B2 price >= 0.50 (CONTRACT_A_MIN_ENTRY_PRICE) is the ONE predicate replaced for the sleeve: [0.40,0.50)
 *   FOOTBALL_NO_SIDE n/a (baseball); BAD_BUCKET is shadow telemetry only on main (not a reject)
 * Current Broad membership (same gates) = physical event with a qualifying identity in [0.50,0.54).
 * Selection: ONE bet per physical event = earliest (created_at, condition_id, selected_token_id), never
 * outcome-aware. identityText is approximated as market_slug + event_slug (buildIdentityText is internal).
 * Settlement: Gamma /markets?condition_ids=...&closed=true batches (sequential, one retry) ->
 * resolveSignalOutcome on the ACTUAL selected token. P&L: settleBetU (WIN 1/p-1, LOSS -1), ROI = PnL/N.
 *
 *   railway run npx tsx scripts/modeling/model-expansion-sleeves.ts     (foreground only)
 *
 * History preserved in git: 76bbd2b, 86ef297, 8fb6c2c.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settleBetU } from "@/lib/modeling/research-engine";
import { resolveSignalOutcome } from "@/lib/feed/resolveSignalOutcome";
import { hasStructuredScoredSportAuthority } from "@/lib/feed/sportScoreOwnership";
import { classifyMarketText, isAllowedFullMatchMarketClass } from "@/lib/contur3/taxonomy";
import { PRODUCTION_SCORED_PLANNING_VERSIONS } from "@/lib/executor/productionSignalPopulation";
import { B2_PRICE_FLOOR, CONTRACT_A_MAX_ENTRY_PRICE_EXCLUSIVE } from "@/lib/executor/contractAB2EventPolicy";

const OUT_DIR = "modeling/evidence/model-expansion-sleeves-v2";
const START = "2026-08-04T00:00:00Z";
const END = "2026-09-12T00:00:00Z";
const AUG_END_DAY = "2026-08-31";
const SEP_START_DAY = "2026-09-01";
const MINSK = 3 * 3600_000;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const day = (iso: string) => new Date(Date.parse(iso) + MINSK).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = createClient(process.env.SUPABASE_CLONE_URL!, process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

interface Cand { cond: string; tok: string; pkey: string; ts: string; price: number; res?: "WIN" | "LOSS" }

async function main() {
  const t0 = Date.now();
  const windows: Array<[string, string]> = [];
  for (let t = Date.parse(START); t < Date.parse(END); t += 2 * 3600_000) windows.push([new Date(t).toISOString(), new Date(t + 2 * 3600_000).toISOString()]);
  const gate: Record<string, number> = { rows_read: 0, not_structured_sport_authority: 0, not_allowed_fullmatch_market: 0, low_coverage: 0, missing_game_start: 0, lead_lt_30m: 0, price_out_of_all_bands: 0 };
  const sleeveRows = new Map<string, Cand>(); // [0.40,0.50) qualifying, earliest per identity
  const broadRows = new Map<string, Cand>(); // [0.50,0.54) qualifying (membership only)
  let fetchErr = 0, next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (true) {
      const w = windows[next++];
      if (!w) return;
      for (let from = 0; ; from += 1000) {
        let data: any[] = [];
        try {
          const r: any = await Promise.race([
            c.from("generated_signal_pairs")
              .select("condition_id,selected_token_id,entry_price_num,signal_confidence_num,created_at,event_slug,market_slug,diagnostics")
              .in("metric_formula_version", [...PRODUCTION_SCORED_PLANNING_VERSIONS])
              .gte("signal_confidence_num", 50)
              .gte("entry_price_num", 0.4).lt("entry_price_num", 0.54)
              .eq("diagnostics->>providerSportFamily", "baseball")
              .gte("created_at", w[0]).lt("created_at", w[1])
              .order("created_at", { ascending: true }).range(from, from + 999),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("REQ_TIMEOUT")), 45_000)),
          ]);
          if (r.error) throw new Error(r.error.message);
          data = r.data ?? [];
        } catch { fetchErr++; break; }
        for (const x of data) {
          gate.rows_read++;
          const diag = (x.diagnostics ?? {}) as Record<string, any>;
          if (!hasStructuredScoredSportAuthority(diag)) { gate.not_structured_sport_authority++; continue; }
          if (!isAllowedFullMatchMarketClass(classifyMarketText(`${x.market_slug ?? ""} ${x.event_slug ?? ""}`))) { gate.not_allowed_fullmatch_market++; continue; }
          const cov = typeof diag.dataCoverage === "number" ? diag.dataCoverage : typeof diag.coverage === "number" ? diag.coverage : null;
          if (cov == null || cov < 25) { gate.low_coverage++; continue; }
          const gs = typeof diag.gameStartIso === "string" && diag.gameStartIso !== "null" ? Date.parse(diag.gameStartIso) : NaN;
          if (!Number.isFinite(gs)) { gate.missing_game_start++; continue; }
          if (gs - Date.parse(x.created_at) < 30 * 60_000) { gate.lead_lt_30m++; continue; }
          const p = Number(x.entry_price_num);
          if (!(p >= B2_PRICE_FLOOR && p < CONTRACT_A_MAX_ENTRY_PRICE_EXCLUSIVE)) { gate.price_out_of_all_bands++; continue; }
          const pkey = String(diag.providerEventId ?? diag.providerEventContext?.eventId ?? x.event_slug ?? x.condition_id);
          const cand: Cand = { cond: x.condition_id, tok: x.selected_token_id, pkey, ts: x.created_at, price: p };
          const map = p < 0.5 ? sleeveRows : broadRows;
          const k = `${cand.cond}|${cand.tok}`;
          const prev = map.get(k); if (!prev || cand.ts < prev.ts) map.set(k, cand);
        }
        if (data.length < 1000) break;
      }
    }
  }));
  const broadKeys = new Set([...broadRows.values()].map((x) => x.pkey));
  const cands = [...sleeveRows.values()];
  const conds = [...new Set(cands.map((x) => x.cond))].sort();

  // ── Gamma batches (condition_ids, closed=true), sequential, one retry ──
  const marketByCond = new Map<string, any>();
  let batches = 0, batchFailed = 0;
  for (let i = 0; i < conds.length; i += 40) {
    const batch = conds.slice(i, i + 40);
    const url = "https://gamma-api.polymarket.com/markets?" + batch.map((x) => "condition_ids=" + encodeURIComponent(x)).join("&") + "&closed=true&limit=" + batch.length;
    batches++;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (res.ok) { const d: any = await res.json(); for (const m of Array.isArray(d) ? d : []) if (m?.conditionId) marketByCond.set(String(m.conditionId).toLowerCase(), m); ok = true; }
      } catch { /* one retry */ }
      if (!ok && attempt === 0) await sleep(1500);
    }
    if (!ok) batchFailed++;
  }
  const resolvedConds = new Set<string>();
  for (const x of cands) {
    const r = resolveSignalOutcome({ conditionId: x.cond, selectedTokenId: x.tok, entryPriceNum: x.price, market: marketByCond.get(x.cond.toLowerCase()) ?? null });
    if (r.resolverState === "resolved_candidate" && (r.signalResult === "won" || r.signalResult === "lost")) { x.res = r.signalResult === "won" ? "WIN" : "LOSS"; resolvedConds.add(x.cond); }
  }
  const coveragePct = conds.length ? r2((resolvedConds.size / conds.length) * 100) : 0;
  const dayCov: Record<string, { c: Set<string>; r: Set<string> }> = {};
  for (const x of cands) { const d = day(x.ts); (dayCov[d] ??= { c: new Set(), r: new Set() }).c.add(x.cond); if (x.res) dayCov[d].r.add(x.cond); }
  const dayList = Object.keys(dayCov).sort();
  const reliable = dayList.filter((d) => dayCov[d].c.size >= 3 && dayCov[d].r.size / dayCov[d].c.size >= 0.5);
  const LATEST = reliable.filter((d) => d >= SEP_START_DAY && d <= "2026-09-11").pop() ?? AUG_END_DAY;
  const AUG_DAYS = 28;
  const SEP_DAYS = LATEST >= SEP_START_DAY ? Math.round((Date.parse(LATEST) - Date.parse(SEP_START_DAY)) / 86400000) + 1 : 0;

  type Ev = Cand & { d: string; res: "WIN" | "LOSS" };
  const evAll: Ev[] = cands.filter((x) => x.res && day(x.ts) <= LATEST).map((x) => ({ ...x, d: day(x.ts), res: x.res! }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.cond.localeCompare(b.cond) || a.tok.localeCompare(b.tok));
  const pnl = (e: Ev) => settleBetU(e.res, e.price);
  const metrics = (evs: Ev[], nd: number) => {
    const n = evs.length, p = evs.reduce((s, e) => s + pnl(e), 0), w = evs.filter((e) => e.res === "WIN").length;
    return { N: n, PNL: r2(p), ROI: n ? r2((p / n) * 100) : 0, WIN_RATE: n ? r2((w / n) * 100) : 0, AVG_ENTRY: n ? Math.round((evs.reduce((s, e) => s + e.price, 0) / n) * 1000) / 1000 : 0, EVENTS_PER_DAY: nd ? r2(n / nd) : 0 };
  };
  const oneEvent = (pred: (e: Ev) => boolean): Ev[] => { const claimed = new Set<string>(); const out: Ev[] = []; for (const e of evAll) { if (claimed.has(e.pkey) || !pred(e)) continue; claimed.add(e.pkey); out.push(e); } return out; };
  const period = (evs: Ev[]) => ({ AUG: metrics(evs.filter((e) => e.d <= AUG_END_DAY), AUG_DAYS), SEP: metrics(evs.filter((e) => e.d >= SEP_START_DAY), SEP_DAYS), COMBINED: metrics(evs, AUG_DAYS + SEP_DAYS) });
  const sleeve = oneEvent(() => true);
  const main = period(sleeve);
  const overlap = sleeve.filter((e) => broadKeys.has(e.pkey)).length;
  const incremental = sleeve.length - overlap;
  const incPerDay = r2(incremental / (AUG_DAYS + SEP_DAYS));
  const GO = {
    AUG_PNL_POSITIVE: main.AUG.PNL > 0, SEP_PNL_POSITIVE: main.SEP.PNL > 0, COMBINED_N_GE_30: main.COMBINED.N >= 30, COMBINED_ROI_GE_5: main.COMBINED.ROI >= 5,
    SETTLEMENT_COVERAGE_GE_90: coveragePct >= 90, INCREMENTAL_EVENTS_PER_DAY_GE_2: incPerDay >= 2.0,
  };
  const FINAL_DECISION = Object.values(GO).every(Boolean) ? "GO" : "NO_GO";
  const bucketEdges: Array<[string, number, number]> = [["0.40_0.42", .4, .42], ["0.42_0.44", .42, .44], ["0.44_0.46", .44, .46], ["0.46_0.48", .46, .48], ["0.48_0.50", .48, .5]];
  const OUT = {
    MISSION: "BASEBALL_P40_50_PRODUCTION_COMPARABLE_FINAL_GATE_V1",
    COUNTERFACTUAL_CHANGE: "BASEBALL_PRICE_ONLY_0.40_TO_0.50",
    PRODUCTION_PREDICATE_FINGERPRINT: {
      population: { metric_formula_version_in: [...PRODUCTION_SCORED_PLANNING_VERSIONS], signal_confidence_num_gte: 50, providerSportFamily: "baseball" },
      structured_sport_authority: "hasStructuredScoredSportAuthority(diagnostics)",
      market_policy: "isAllowedFullMatchMarketClass(classifyMarketText(market_slug+event_slug))",
      coverage_gte: 25, score_gte: 50, game_start_required: "diagnostics.gameStartIso", min_lead_minutes: 30,
      b2: { esports_excluded: true, price_floor: B2_PRICE_FLOOR, price_lt: CONTRACT_A_MAX_ENTRY_PRICE_EXCLUSIVE, min_entry_price_0_50: "REPLACED for sleeve by [0.40,0.50)" },
      football_no_side: "n/a baseball", bad_bucket: "shadow telemetry only (not a reject)", one_physical_event: "earliest (created_at, condition_id, token)",
      broad_membership: "qualifying identity in [0.50,0.54) on same gates",
    },
    ALL_OTHER_PRODUCTION_GATES: "UNCHANGED",
    PERIODS: { AUG: ["2026-08-04", AUG_END_DAY, AUG_DAYS], SEP: [SEP_START_DAY, LATEST, SEP_DAYS] },
    LATEST_RELIABLY_SETTLED_DATE: LATEST,
    GATE_COUNTS: { ...gate, FETCH_ERRORS: fetchErr, SLEEVE_IDENTITIES: cands.length, BROAD_MEMBERSHIP_IDENTITIES: broadRows.size },
    GAMMA: { MODE: "CONDITION_IDS_CLOSED_TRUE", BATCHES: batches, BATCHES_FAILED: batchFailed, CONDITIONS_REQUESTED: conds.length, CONDITIONS_RESOLVED: resolvedConds.size, CONDITIONS_UNRESOLVED: conds.length - resolvedConds.size, SETTLEMENT_COVERAGE_PCT: coveragePct },
    BASEBALL_P40_50_PRODUCTION_COMPARABLE: main,
    PRICE_BUCKET_DIAGNOSTIC: Object.fromEntries(bucketEdges.map(([n, lo, hi]) => [n, period(oneEvent((e) => e.price >= lo && e.price < hi))])),
    CAPACITY: { BASEBALL_P40_50_EVENTS: sleeve.length, OVERLAP_WITH_CURRENT_BROAD_N: overlap, INCREMENTAL_UNIQUE_EVENTS_N: incremental, INCREMENTAL_EVENTS_PER_DAY: incPerDay },
    GO_GATE: GO,
    FINAL_DECISION,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `BASEBALL_P40_50_PRODUCTION_GATE_2026-08-04_${LATEST}.json`);
  writeFileSync(file, JSON.stringify(OUT, null, 1));
  console.log(JSON.stringify({ file, ...OUT, PRODUCTION_PREDICATE_FINGERPRINT: undefined, elapsedS: Math.round((Date.now() - t0) / 1000) }));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
