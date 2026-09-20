/**
 * EXACT_SCORE_NO_GAMMA_SETTLEMENT_FINISH_V1 — research only, read-only, foreground.
 *
 * Question: does the ACTUAL recorded exact-score "NO" side make money?
 * (The blanket exact-score market ban would then be discarding a profitable sleeve.)
 *
 * Source:     public.generated_signal_research_snapshots (research clone), date-bounded 2h windows,
 *             server-filtered to event_slug ILIKE '%exact-score%' AND selected_outcome ILIKE 'no'.
 *             Actual selected_token_id / selected_price_num only — no synthetic NO price or side.
 * Settlement: Gamma /markets?condition_ids=... BATCH (sequential, one retry per batch), then the
 *             repo's resolveSignalOutcome (lib/feed/resolveSignalOutcome) on the ACTUAL selected token.
 *             (generated_signal_pairs join was tested earlier: 23/44,613 resolved -> not used.)
 * P&L:        settleBetU: WIN = 1/entry - 1, LOSS = -1, ROI = PnL/N.
 * Selection:  pre-event only (snapshot_at < game_start_iso). Production-comparable = ONE bet per
 *             physical event = earliest (snapshot_at, condition_id, selected_token_id) among
 *             candidates satisfying the sleeve predicate. Never outcome-aware.
 * Physical event key is reconstructed from event_slug (text up to and including the date).
 *
 *   railway run npx tsx scripts/modeling/model-expansion-sleeves.ts     (foreground only)
 *
 * Superseded V1 corpus study is preserved in git (76bbd2b). FIRST/SECOND-HALF and P40_50 are deferred.
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
const MINSK = 3 * 3600_000;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const day = (iso: string) => new Date(Date.parse(iso) + MINSK).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = createClient(process.env.SUPABASE_CLONE_URL!, process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const physicalKey = (slug: string, eventId: string | null) => /^(.*?-\d{4}-\d{2}-\d{2})/.exec(slug)?.[1] ?? eventId ?? slug;

interface Cand { cond: string; tok: string; pkey: string; ts: string; price: number; outcome: string; res?: "WIN" | "LOSS" }

async function main() {
  const t0 = Date.now();
  // ── 1. snapshots (exact-score NO only), 2h windows, concurrency 4 ──
  const windows: Array<[string, string]> = [];
  for (let t = Date.parse(START); t < Date.parse(END); t += 2 * 3600_000) windows.push([new Date(t).toISOString(), new Date(t + 2 * 3600_000).toISOString()]);
  const ident = new Map<string, Cand>(); // earliest pre-event snapshot per (cond|tok) with price in [0.40,0.97)
  const identBands = new Map<string, Cand>(); // earliest per (cond|tok|bucket) for bucket predicates
  const bucketOf = (p: number) => (p < 0.5 ? 0 : p < 0.6 ? 1 : p < 0.7 ? 2 : p < 0.8 ? 3 : p < 0.9 ? 4 : 5);
  let rowsSeen = 0, fetchErr = 0, next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (true) {
      const w = windows[next++];
      if (!w) return;
      for (let from = 0; ; from += 1000) {
        let data: any[] = [];
        try {
          const r: any = await Promise.race([
            c.from("generated_signal_research_snapshots")
              .select("condition_id,selected_token_id,event_id,event_slug,snapshot_at,selected_outcome,selected_price_num,game_start_iso")
              .gte("snapshot_at", w[0]).lt("snapshot_at", w[1]).ilike("event_slug", "%exact-score%").ilike("selected_outcome", "no")
              .gte("selected_price_num", 0.4).lt("selected_price_num", 0.97)
              .order("snapshot_at", { ascending: true }).range(from, from + 999),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("REQ_TIMEOUT")), 40_000)),
          ]);
          if (r.error) throw new Error(r.error.message);
          data = r.data ?? [];
        } catch { fetchErr++; break; }
        for (const x of data) {
          rowsSeen++;
          if (!x.condition_id || !x.selected_token_id || !x.game_start_iso || !(x.snapshot_at < x.game_start_iso)) continue;
          const cand: Cand = { cond: x.condition_id, tok: x.selected_token_id, pkey: physicalKey(x.event_slug, x.event_id), ts: x.snapshot_at, price: Number(x.selected_price_num), outcome: String(x.selected_outcome) };
          const k = `${cand.cond}|${cand.tok}`, kb = `${k}|${bucketOf(cand.price)}`;
          const p1 = ident.get(k); if (!p1 || cand.ts < p1.ts) ident.set(k, cand);
          const p2 = identBands.get(kb); if (!p2 || cand.ts < p2.ts) identBands.set(kb, cand);
        }
        if (data.length < 1000) break;
      }
    }
  }));
  const rawIdentities = ident.size;
  const conds = [...new Set([...identBands.values()].map((x) => x.cond))].sort();
  const physEvents = new Set([...identBands.values()].map((x) => x.pkey));

  // ── 2. Gamma BATCH settlement, sequential, one retry per batch, no single-lookup fanout ──
  const marketByCond = new Map<string, any>();
  let batches = 0, batchFailed = 0;
  for (let i = 0; i < conds.length; i += 40) {
    const batch = conds.slice(i, i + 40);
    const urls = [
      "https://gamma-api.polymarket.com/markets?" + batch.map((x) => "condition_ids=" + encodeURIComponent(x)).join("&") + "&closed=true&limit=" + batch.length,
      "https://gamma-api.polymarket.com/markets?condition_ids=" + batch.map((x) => encodeURIComponent(x)).join(",") + "&closed=true&limit=" + batch.length,
    ];
    batches++;
    let ok = false;
    for (let form = 0; form < urls.length && !ok; form++) {
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const res = await fetch(urls[form], { headers: { Accept: "application/json" }, cache: "no-store" });
          if (res.ok) {
            const d: any = await res.json();
            const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.markets) ? d.markets : [];
            if (batches === 1) console.error("DIAG batch1 form=" + form + " status=" + res.status + " items=" + arr.length + " keys=" + Object.keys(arr[0] ?? {}).slice(0, 6).join(","));
            for (const m of arr) if (m?.conditionId) marketByCond.set(String(m.conditionId).toLowerCase(), m);
            if (arr.length > 0) ok = true;
            else break; // empty for this form -> try the next form
          } else if (batches === 1) console.error("DIAG batch1 form=" + form + " status=" + res.status);
        } catch { /* retry once */ }
        if (!ok && attempt === 0) await sleep(1500);
      }
    }
    if (!ok) batchFailed++;
    if (Date.now() - t0 > 400_000) break; // hard budget guard; unresolved is reported, never silently dropped
  }
  const resolvedByKey = new Map<string, "WIN" | "LOSS">();
  const resolvedConds = new Set<string>();
  const states: Record<string, number> = {};
  for (const cand of identBands.values()) {
    const market = marketByCond.get(cand.cond.toLowerCase()) ?? null;
    const r = resolveSignalOutcome({ conditionId: cand.cond, selectedTokenId: cand.tok, entryPriceNum: cand.price, market });
    states[r.resolverState] = (states[r.resolverState] ?? 0) + 1;
    if (r.resolverState === "resolved_candidate" && (r.signalResult === "won" || r.signalResult === "lost")) { resolvedByKey.set(`${cand.cond}|${cand.tok}`, r.signalResult === "won" ? "WIN" : "LOSS"); resolvedConds.add(cand.cond); }
  }
  const coveragePct = conds.length ? r2((resolvedConds.size / conds.length) * 100) : 0;

  // reliable settled date: last day (decision day) with >=50% of that day's conditions resolved and >=10 conditions
  const dayCov: Record<string, { c: Set<string>; r: Set<string> }> = {};
  for (const cand of ident.values()) { const d = day(cand.ts); (dayCov[d] ??= { c: new Set(), r: new Set() }).c.add(cand.cond); if (resolvedByKey.has(`${cand.cond}|${cand.tok}`)) dayCov[d].r.add(cand.cond); }
  const dayList = Object.keys(dayCov).sort();
  const reliable = dayList.filter((d) => dayCov[d].c.size >= 10 && dayCov[d].r.size / dayCov[d].c.size >= 0.5);
  const LATEST = reliable.filter((d) => d >= SEP_START_DAY).pop() ?? (reliable.pop() ?? AUG_END_DAY);
  const AUG_DAYS = 28;
  const SEP_DAYS = LATEST >= SEP_START_DAY ? Math.round((Date.parse(LATEST) - Date.parse(SEP_START_DAY)) / 86400000) + 1 : 0;

  type Ev = Cand & { d: string; res: "WIN" | "LOSS" };
  const evAll: Ev[] = [...identBands.values()].filter((x) => resolvedByKey.has(`${x.cond}|${x.tok}`) && day(x.ts) <= LATEST)
    .map((x) => ({ ...x, d: day(x.ts), res: resolvedByKey.get(`${x.cond}|${x.tok}`)! }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.cond.localeCompare(b.cond) || a.tok.localeCompare(b.tok));
  const pnl = (e: Ev) => settleBetU(e.res, e.price);
  const metrics = (evs: Ev[], nd: number) => {
    const n = evs.length, p = evs.reduce((s, e) => s + pnl(e), 0), w = evs.filter((e) => e.res === "WIN").length;
    return { N: n, PNL: r2(p), ROI: n ? r2((p / n) * 100) : 0, WIN_RATE: n ? r2((w / n) * 100) : 0, AVG_ENTRY: n ? Math.round((evs.reduce((s, e) => s + e.price, 0) / n) * 1000) / 1000 : 0, EVENTS_PER_DAY: nd ? r2(n / nd) : 0 };
  };
  const period = (evs: Ev[]) => ({ AUG: metrics(evs.filter((e) => e.d <= AUG_END_DAY), AUG_DAYS), SEP: metrics(evs.filter((e) => e.d >= SEP_START_DAY), SEP_DAYS), COMBINED: metrics(evs, AUG_DAYS + SEP_DAYS) });
  const oneEventPerPhysical = (pred: (e: Ev) => boolean): Ev[] => { const claimed = new Set<string>(); const out: Ev[] = []; for (const e of evAll) { if (claimed.has(e.pkey) || !pred(e)) continue; claimed.add(e.pkey); out.push(e); } return out; };

  const prod = oneEventPerPhysical(() => true);
  const identSeen = new Set<string>();
  const identLevel = evAll.filter((e) => { const k = `${e.cond}|${e.tok}`; if (identSeen.has(k)) return false; identSeen.add(k); return true; });
  const buckets: Array<[string, number, number]> = [["0.40_0.50", .4, .5], ["0.50_0.60", .5, .6], ["0.60_0.70", .6, .7], ["0.70_0.80", .7, .8], ["0.80_0.90", .8, .9], ["0.90_0.97", .9, .97]];
  const bucketRes: Record<string, unknown> = {};
  for (const [n, lo, hi] of buckets) { const evs = oneEventPerPhysical((e) => e.price >= lo && e.price < hi); if (evs.length) bucketRes[n] = period(evs); }
  const pc = period(prod);
  const crossPositive = SEP_DAYS === 0 ? "INSUFFICIENT_DATA" : pc.AUG.PNL > 0 && pc.SEP.PNL > 0 && pc.COMBINED.N >= 30 ? "YES" : "NO";

  const OUT = {
    MISSION: "EXACT_SCORE_NO_GAMMA_SETTLEMENT_FINISH_V1",
    PERIODS: { AUG: ["2026-08-04", AUG_END_DAY, AUG_DAYS], SEP: [SEP_START_DAY, LATEST, SEP_DAYS] },
    LATEST_RELIABLY_SETTLED_DATE: LATEST,
    COUNTS: { SNAPSHOT_ROWS_SEEN: rowsSeen, FETCH_ERRORS: fetchErr, EXACT_SCORE_NO_RAW_IDENTITIES: rawIdentities, EXACT_SCORE_NO_UNIQUE_CONDITIONS: conds.length, EXACT_SCORE_NO_UNIQUE_PHYSICAL_EVENTS: physEvents.size },
    GAMMA: { REQUEST_BATCHES: batches, BATCHES_FAILED: batchFailed, CONDITIONS_REQUESTED: conds.length, CONDITIONS_RESOLVED: resolvedConds.size, CONDITIONS_UNRESOLVED: conds.length - resolvedConds.size, SETTLEMENT_COVERAGE_PCT: coveragePct, RESOLVER_STATES_IDENTITY_BUCKET_ROWS: states, SINGLE_LOOKUP_CONCURRENCY: 0 },
    DAILY_CONDITION_COVERAGE: Object.fromEntries(dayList.map((d) => [d, `${dayCov[d].r.size}/${dayCov[d].c.size}`])),
    IDENTITY_LEVEL_DIAGNOSTIC: { ...period(identLevel), NOTE: "identities, may include several propositions per sporting event" },
    ONE_PHYSICAL_EVENT_PRODUCTION_COMPARABLE: pc,
    PRICE_BUCKETS_ONE_PHYSICAL_EVENT: bucketRes,
    CROSS_PERIOD_POSITIVE: crossPositive,
    SELECTOR: "pre-event only; earliest (snapshot_at, condition_id, selected_token_id) per physical event; no outcome-aware choice",
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `EXACT_SCORE_NO_2026-08-04_${LATEST}.json`);
  writeFileSync(file, JSON.stringify(OUT, null, 1));
  console.log(JSON.stringify({ file, ...OUT, DAILY_CONDITION_COVERAGE: undefined, elapsedS: Math.round((Date.now() - t0) / 1000) }));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
