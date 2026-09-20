/**
 * P40_50_LONGER_SEPTEMBER_VALIDATION_V2 — research only, read-only, foreground.
 *
 * Do the sub-0.50 leads (price 0.40-0.42; baseball 0.40-0.50) survive a longer September and add
 * NEW physical events beyond current Broad?
 *
 * Source:     public.generated_signal_research_snapshots (research clone), date-bounded 2h windows,
 *             actual selected_price_num in [0.40,0.54): [0.40,0.50) = candidates, [0.50,0.54) = Broad
 *             MEMBERSHIP only (never settled). Actual side/price only; pre-event snapshots only.
 * Settlement: Gamma /markets?condition_ids=<batch>&closed=true (sequential batches, one retry) then
 *             resolveSignalOutcome on the ACTUAL selected token. Priority order: sleeve A + baseball
 *             conditions first, the rest of 0.42-0.50 afterwards while inside the time budget.
 * P&L:        settleBetU: WIN = 1/entry - 1, LOSS = -1, ROI = PnL/N.
 * Selection:  one bet per physical event = earliest (snapshot_at, condition_id, selected_token_id)
 *             among rows satisfying the sleeve predicate. Never outcome-aware.
 * Physical event key is reconstructed from event_slug (text up to and including the date).
 * Broad (research replay): a physical event with a FULL_MATCH (moneyline/spread/total) pre-event
 * snapshot priced in [0.50,0.54). Tier rules only PRIORITISE inside that band, so membership is exact.
 *
 *   railway run npx tsx scripts/modeling/model-expansion-sleeves.ts     (foreground only)
 *
 * History preserved in git: 76bbd2b (V1 corpus study), 86ef297 (EXACT_SCORE_NO study).
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settleBetU } from "@/lib/modeling/research-engine";
import { resolveSignalOutcome } from "@/lib/feed/resolveSignalOutcome";

const OUT_DIR = "modeling/evidence/model-expansion-sleeves-v2";
const START = "2026-08-04T00:00:00Z";
const END = "2026-09-12T00:00:00Z";
const AUG_END_DAY = "2026-08-31";
const SEP_START_DAY = "2026-09-01";
const GAMMA_DEADLINE_MS = 330_000;
const MINSK = 3 * 3600_000;
const EDGES = [0.4, 0.42, 0.44, 0.46, 0.48, 0.5, 0.54];
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const day = (iso: string) => new Date(Date.parse(iso) + MINSK).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = createClient(process.env.SUPABASE_CLONE_URL!, process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const physicalKey = (slug: string, eventId: string | null) => /^(.*?-\d{4}-\d{2}-\d{2})/.exec(slug)?.[1] ?? eventId ?? slug;

function isFullMatch(slug: string): boolean {
  const s = slug.replace(/^.*?-\d{4}-\d{2}-\d{2}/, "").toLowerCase();
  if (/exact-score|exactscore|(^|-)(1h|2h|first-half|second-half|halftime)(-|$)/.test(s)) return false;
  return s === "" || /spread|total|-ou-|over-under|moneyline|winner/.test(s);
}
const isBaseball = (sport: string, slug: string) => /^(mlb|kbo|npb|baseball)$/.test(sport) || /^(mlb|kbo|npb)-/.test(slug);
const isSoccer = (sport: string) => /soccer|epl|premier|la ?liga|bundesliga|serie|ligue|mls|ucl|uel|champions|europa|fifa|efl|eredivisie|copa|uefa/.test(sport);

interface Cand { cond: string; tok: string; pkey: string; ts: string; price: number; sport: string; fm: boolean; base: boolean; band: number; res?: "WIN" | "LOSS" }

async function main() {
  const t0 = Date.now();
  // ── 1. snapshots, price [0.40,0.54), pre-event, earliest per (cond|tok|band) ──
  const windows: Array<[string, string]> = [];
  for (let t = Date.parse(START); t < Date.parse(END); t += 2 * 3600_000) windows.push([new Date(t).toISOString(), new Date(t + 2 * 3600_000).toISOString()]);
  const byBand = new Map<string, Cand>();
  const sportCounts: Record<string, number> = {};
  let rowsSeen = 0, fetchErr = 0, next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (true) {
      const w = windows[next++];
      if (!w) return;
      for (let from = 0; ; from += 1000) {
        let data: any[] = [];
        try {
          const r: any = await Promise.race([
            c.from("generated_signal_research_snapshots")
              .select("condition_id,selected_token_id,event_id,event_slug,snapshot_at,selected_price_num,market_family,game_start_iso")
              .gte("snapshot_at", w[0]).lt("snapshot_at", w[1]).gte("selected_price_num", 0.4).lt("selected_price_num", 0.54)
              .order("snapshot_at", { ascending: true }).range(from, from + 999),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("REQ_TIMEOUT")), 40_000)),
          ]);
          if (r.error) throw new Error(r.error.message);
          data = r.data ?? [];
        } catch { fetchErr++; break; }
        for (const x of data) {
          rowsSeen++;
          if (!x.condition_id || !x.selected_token_id || !x.event_slug || !x.game_start_iso || !(x.snapshot_at < x.game_start_iso)) continue;
          const p = Number(x.selected_price_num);
          const band = EDGES.findIndex((e, i) => i < EDGES.length - 1 && p >= e && p < EDGES[i + 1]);
          if (band < 0) continue;
          const key = `${x.condition_id}|${x.selected_token_id}|${band}`;
          const prev = byBand.get(key);
          if (prev && prev.ts <= x.snapshot_at) continue;
          const sport = String(x.market_family ?? "unknown").toLowerCase();
          byBand.set(key, { cond: x.condition_id, tok: x.selected_token_id, pkey: physicalKey(x.event_slug, x.event_id), ts: x.snapshot_at, price: p, sport, fm: isFullMatch(x.event_slug), base: isBaseball(sport, x.event_slug), band });
        }
        if (data.length < 1000) break;
      }
    }
  }));
  const all = [...byBand.values()];
  for (const x of all) if (x.band < 5) sportCounts[x.sport] = (sportCounts[x.sport] ?? 0) + 1;
  const broadSet = new Set(all.filter((x) => x.band === 5 && x.fm).map((x) => x.pkey)); // [0.50,0.54) FULL_MATCH
  const cands = all.filter((x) => x.band < 5); // [0.40,0.50)

  // ── 2. Gamma batches (closed=true), sequential, one retry; priority: A + baseball first ──
  const condPrio = new Map<string, number>();
  for (const x of cands) condPrio.set(x.cond, Math.min(condPrio.get(x.cond) ?? 1, x.band === 0 || x.base ? 0 : 1));
  const conds = [...condPrio.keys()].sort((a, b) => condPrio.get(a)! - condPrio.get(b)! || a.localeCompare(b));
  const primaryConds = conds.filter((x) => condPrio.get(x) === 0);
  const marketByCond = new Map<string, any>();
  let batches = 0, batchFailed = 0, primaryDoneAt = 0;
  for (let i = 0; i < conds.length; i += 40) {
    if (Date.now() - t0 > GAMMA_DEADLINE_MS) break;
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
    if (!primaryDoneAt && i + 40 >= primaryConds.length) primaryDoneAt = Math.round((Date.now() - t0) / 1000);
  }
  const requested = new Set(conds.slice(0, batches * 40));
  const resolvedConds = new Set<string>();
  for (const x of cands) {
    if (!requested.has(x.cond)) continue;
    const market = marketByCond.get(x.cond.toLowerCase()) ?? null;
    const r = resolveSignalOutcome({ conditionId: x.cond, selectedTokenId: x.tok, entryPriceNum: x.price, market });
    if (r.resolverState === "resolved_candidate" && (r.signalResult === "won" || r.signalResult === "lost")) { x.res = r.signalResult === "won" ? "WIN" : "LOSS"; resolvedConds.add(x.cond); }
  }
  const covOf = (list: string[]) => { const req = list.filter((x) => requested.has(x)); const res = req.filter((x) => resolvedConds.has(x)).length; return { TOTAL: list.length, REQUESTED: req.length, RESOLVED: res, COVERAGE_PCT: list.length ? r2((res / list.length) * 100) : 0 }; };

  // reliable settled date (decision day): >=30 requested conditions and >=50% resolved
  const dayCov: Record<string, { c: Set<string>; r: Set<string> }> = {};
  for (const x of cands) { if (!requested.has(x.cond)) continue; const d = day(x.ts); (dayCov[d] ??= { c: new Set(), r: new Set() }).c.add(x.cond); if (x.res) dayCov[d].r.add(x.cond); }
  const dayList = Object.keys(dayCov).sort();
  const reliable = dayList.filter((d) => dayCov[d].c.size >= 30 && dayCov[d].r.size / dayCov[d].c.size >= 0.5);
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
  const sleeve = (pred: (e: Ev) => boolean): Ev[] => { const claimed = new Set<string>(); const out: Ev[] = []; for (const e of evAll) { if (claimed.has(e.pkey) || !pred(e)) continue; claimed.add(e.pkey); out.push(e); } return out; };
  const report = (evs: Ev[]) => {
    const aug = evs.filter((e) => e.d <= AUG_END_DAY), sep = evs.filter((e) => e.d >= SEP_START_DAY);
    const ov = evs.filter((e) => broadSet.has(e.pkey)).length;
    const cp = SEP_DAYS > 0 && aug.reduce((s, e) => s + pnl(e), 0) > 0 && sep.reduce((s, e) => s + pnl(e), 0) > 0 && evs.length >= 30;
    return { AUG: metrics(aug, AUG_DAYS), SEP: metrics(sep, SEP_DAYS), COMBINED: metrics(evs, AUG_DAYS + SEP_DAYS), OVERLAP_WITH_CURRENT_BROAD_N: ov, INCREMENTAL_UNIQUE_EVENTS_N: evs.length - ov, INCREMENTAL_EVENTS_PER_DAY: r2((evs.length - ov) / (AUG_DAYS + SEP_DAYS)), CROSS_PERIOD_POSITIVE: cp, LABEL: evs.length < 30 ? "SMALL_SAMPLE" : "N>=30" };
  };
  const A = (e: Ev) => e.band === 0;
  const B = (e: Ev) => e.base;
  const S = (e: Ev) => isSoccer(e.sport) && !e.base;
  const OUT: Record<string, unknown> = {
    MISSION: "P40_50_LONGER_SEPTEMBER_VALIDATION_V2",
    PERIODS: { AUG: ["2026-08-04", AUG_END_DAY, AUG_DAYS], SEP: [SEP_START_DAY, LATEST, SEP_DAYS] },
    LATEST_RELIABLY_SETTLED_DATE: LATEST,
    GAMMA: { MODE: "CONDITION_IDS_CLOSED_TRUE", BATCHES: batches, BATCHES_FAILED: batchFailed, CONDITIONS_REQUESTED: requested.size, CONDITIONS_RESOLVED: resolvedConds.size, CONDITIONS_UNRESOLVED: requested.size - resolvedConds.size, SETTLEMENT_COVERAGE_PCT_REQUESTED: requested.size ? r2((resolvedConds.size / requested.size) * 100) : 0, ALL_CANDIDATE_CONDITIONS: conds.length, PRIMARY_SLEEVE_CONDITIONS: covOf(primaryConds), PRIMARY_DONE_AT_S: primaryDoneAt, SINGLE_LOOKUP_CONCURRENCY: 0 },
    SNAPSHOT: { ROWS_SEEN: rowsSeen, FETCH_ERRORS: fetchErr, CANDIDATE_IDENTITY_BAND_ROWS: cands.length, BROAD_MEMBERSHIP_EVENTS: broadSet.size, MARKET_FAMILY_COUNTS_IN_CANDIDATES: sportCounts },
    DAILY_CONDITION_COVERAGE: Object.fromEntries(dayList.map((d) => [d, `${dayCov[d].r.size}/${dayCov[d].c.size}`])),
    PRICE_040_042_ALL_CLASSES: report(sleeve(A)),
    PRICE_040_042_FULL_MATCH_ONLY: report(sleeve((e) => A(e) && e.fm)),
    BASEBALL_P40_50_ALL_CLASSES: report(sleeve(B)),
    BASEBALL_P40_50_FULL_MATCH_ONLY: report(sleeve((e) => B(e) && e.fm)),
    SOCCER_P40_50_ALL_CLASSES: report(sleeve(S)),
    SOCCER_P40_50_FULL_MATCH_ONLY: report(sleeve((e) => S(e) && e.fm)),
    P40_50_WHOLE_ALL_CLASSES: report(sleeve(() => true)),
    BUCKET_CONTEXT_ALL_CLASSES: Object.fromEntries(([["0.42_0.44", 1], ["0.44_0.46", 2], ["0.46_0.48", 3], ["0.48_0.50", 4]] as const).map(([n, b]) => [n, report(sleeve((e) => e.band === b))])),
    BUCKET_CONTEXT_NOTE: "context only; conditions outside the priority sleeves are settled only while inside the time budget (see GAMMA coverage)",
    SELECTOR: "pre-event only; earliest (snapshot_at, condition_id, selected_token_id) per physical event; no outcome-aware choice",
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `P40_50_VALIDATION_2026-08-04_${LATEST}.json`);
  writeFileSync(file, JSON.stringify(OUT, null, 1));
  console.log(JSON.stringify({ file, ...OUT, DAILY_CONDITION_COVERAGE: undefined, elapsedS: Math.round((Date.now() - t0) / 1000) }));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
