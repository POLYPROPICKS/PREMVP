/**
 * MODEL_EXPANSION_EXACT_SCORE_HALVES_P40_50_V1 — research only, local disk only.
 *
 * Reuses the PR #353/#354 machinery verbatim: loadPartition() (hash-verified
 * immutable D-1 corpus), buildExplicitDateRangeRowView(), toAtlasInput(),
 * evaluateEvent/sortChronologically, settleBetU (unit stake: WIN = 1/p - 1,
 * LOSS = -1), runStandalone/runPortfolio + PORTFOLIO_BROAD tiers from
 * daily-portfolio-frontier.ts. One physicalEventKey -> at most one bet,
 * chronological-first (decision-time only, never outcome-aware).
 *
 * The compact partition view drops marketTypeRaw; it is re-joined from the SAME
 * immutable CORPUS_<date>.jsonl.gz by (populationId, conditionId). There is NO
 * selected side/outcome field anywhere in the corpus -> YES/NO is
 * UNSUPPORTED_BY_SOURCE and is never synthesized.
 *
 *   npx tsx scripts/modeling/model-expansion-sleeves.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { buildExplicitDateRangeRowView, enumerateMinskDates, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { evaluateEvent, sortChronologically, settleBetU } from "@/lib/modeling/research-engine";
import { toAtlasInput } from "./factor-atlas";
import { loadPartition } from "./rolling-research-corpus";
import { PORTFOLIOS, runPortfolio } from "./daily-portfolio-frontier";

const CORPUS_DIR = "modeling/evidence/research-corpus-factory-live-v1";
const OUT_DIR = "modeling/evidence/model-expansion-sleeves-v1";
const AUG = ["2026-08-04", "2026-08-31"] as const;
const SEP = ["2026-09-01", "2026-09-03"] as const;
const MINSK_OFFSET_MS = 3 * 3600_000;
const minskDate = (iso: string) => new Date(Date.parse(iso) + MINSK_OFFSET_MS).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

// ── market class: RECONSTRUCTED from corpus marketTypeRaw, using the concepts of
// lib/contur3/taxonomy.ts (forbidden_exact_score / first_half / second_half / full_match).
type MClass = "EXACT_SCORE" | "FIRST_HALF" | "SECOND_HALF" | "FULL_MATCH" | "OTHER" | "UNKNOWN";
function classOf(mt: string | null): MClass {
  if (!mt) return "UNKNOWN";
  if (/exact_score/.test(mt)) return "EXACT_SCORE";
  if (/second_half/.test(mt)) return "SECOND_HALF";
  if (/first_half|halftime/.test(mt)) return "FIRST_HALF";
  if (/^(moneyline|child_moneyline|spreads|totals)$/.test(mt)) return "FULL_MATCH";
  return "OTHER";
}
function subtypeOf(mt: string | null): string {
  if (!mt) return "unknown";
  if (/result|moneyline|halftime/.test(mt)) return "moneyline";
  if (/spread|handicap/.test(mt)) return "spread";
  if (/total|over_under/.test(mt)) return "total";
  return "other";
}

interface Ev { key: string; ts: string; price: number; sport: string; outcome: "WIN" | "LOSS"; cls: MClass; mt: string; sub: string; day: string }

function metrics(evs: Ev[], days: number) {
  const n = evs.length;
  const pnl = evs.reduce((s, e) => s + settleBetU(e.outcome, e.price), 0);
  const wins = evs.filter((e) => e.outcome === "WIN").length;
  return {
    N: n, PNL: r2(pnl), ROI: n ? r2((pnl / n) * 100) : 0, WINRATE: n ? r2((wins / n) * 100) : 0,
    AVG_PRICE: n ? r2(evs.reduce((s, e) => s + e.price, 0) / n * 1000) / 1000 : 0, EV_PER_DAY: r2(n / days),
  };
}

const AUG_DAYS = enumerateMinskDates(AUG[0], AUG[1]).length;
const SEP_DAYS = enumerateMinskDates(SEP[0], SEP[1]).length;

function main() {
  const dates = enumerateMinskDates(AUG[0], SEP[1]);
  const partitions = dates.map((d) => loadPartition(d));
  const mtByCond = new Map<string, string | null>();
  for (const d of dates) {
    const t = gunzipSync(readFileSync(join(CORPUS_DIR, `CORPUS_${d}.jsonl.gz`))).toString().split("\n").filter(Boolean);
    for (const l of t) {
      const r = JSON.parse(l);
      const k = `${r.populationId}|${r.conditionId}`;
      if (!mtByCond.has(k) || (mtByCond.get(k) == null && r.marketTypeRaw)) mtByCond.set(k, r.marketTypeRaw ?? null);
    }
  }
  const view = buildExplicitDateRangeRowView({ rangeStart: AUG[0], rangeEnd: SEP[1], partitions });
  const out: Record<string, unknown> = { AUG_PERIOD: AUG, SEP_PERIOD: SEP, AUG_DAYS, SEP_DAYS, POPULATIONS: {} };

  for (const pop of Object.keys(view.POPULATION_ROW_N).sort()) {
    const popRows = view.rows.filter((r: ScorecardReadyRow) => r.populationId === pop);
    const input = toAtlasInput(popRows);
    const classify = (ref: string | undefined) => mtByCond.get(`${pop}|${ref}`) ?? null;
    const all: Ev[] = sortChronologically(input.map((e) => evaluateEvent(e))).map((e: any) => {
      const mt = classify(e.ref);
      return { key: e.physicalEventKey, ts: e.decisionTimestamp, price: e.entryPrice, sport: e.sportFamily || "unknown", outcome: e.outcome, cls: classOf(mt), mt: mt ?? "null", sub: subtypeOf(mt), day: minskDate(e.decisionTimestamp) };
    });

    // CURRENT_BROAD reference: exact frontier PORTFOLIO_BROAD over ALL rows (parity with #354);
    // it defines the physical-event set already captured (conservative overlap basis).
    const broadTiers = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")!.tiers;
    const broadBets = runPortfolio(input, broadTiers);
    const broadKeys = new Set(broadBets.map((b) => b.physicalEventKey));
    const broadEvs: Ev[] = broadBets.map((b) => ({ key: b.physicalEventKey, ts: b.decisionTimestamp, price: b.entryPrice, sport: b.sportFamily, outcome: b.outcome as "WIN" | "LOSS", cls: "FULL_MATCH", mt: "", sub: "", day: minskDate(b.decisionTimestamp) }));

    const sleeve = (pred: (e: Ev) => boolean): Ev[] => {
      const claimed = new Set<string>();
      const res: Ev[] = [];
      for (const e of all) { // already chronological; predicate before selection (runStandalone semantics)
        if (claimed.has(e.key) || !pred(e)) continue;
        claimed.add(e.key); res.push(e);
      }
      return res;
    };
    const report = (evs: Ev[]) => {
      const aug = evs.filter((e) => e.day <= AUG[1]);
      const sep = evs.filter((e) => e.day >= SEP[0]);
      const overlap = evs.filter((e) => broadKeys.has(e.key)).length;
      const inc = evs.length - overlap;
      return {
        AUG: metrics(aug, AUG_DAYS), SEP: metrics(sep, SEP_DAYS), COMBINED: metrics(evs, AUG_DAYS + SEP_DAYS),
        OVERLAP_N: overlap, INCREMENTAL_N: inc, INCREMENTAL_EVENTS_PER_DAY: r2(inc / (AUG_DAYS + SEP_DAYS)),
      };
    };
    const band = (lo: number, hi: number) => (e: Ev) => e.price >= lo && e.price < hi;
    const S: Record<string, unknown> = {};
    S.CURRENT_BROAD_REFERENCE = { ...report(broadEvs), OVERLAP_N: broadEvs.length, INCREMENTAL_N: 0, INCREMENTAL_EVENTS_PER_DAY: 0 };
    S.MARKET_CLASS_COUNTS_ROWS = all.reduce((a: any, e) => ((a[e.cls] = (a[e.cls] ?? 0) + 1), a), {});

    // A. exact score (side unsupported) — all sides pooled, labelled; price buckets
    const bands: Array<[string, number, number]> = [["0.40_0.50", .4, .5], ["0.50_0.60", .5, .6], ["0.60_0.70", .6, .7], ["0.70_0.80", .7, .8], ["0.80_0.90", .8, .9], ["0.90_0.97", .9, .97]];
    S.EXACT_SCORE_ALL_SIDES = report(sleeve((e) => e.cls === "EXACT_SCORE"));
    S.EXACT_SCORE_ALL_SIDES_BY_PRICE = Object.fromEntries(bands.map(([n, lo, hi]) => [n, report(sleeve((e) => e.cls === "EXACT_SCORE" && band(lo, hi)(e)))]));
    S.EXACT_SCORE_ALL_SIDES_C0_050_060 = report(sleeve((e) => e.cls === "EXACT_SCORE" && band(.5, .6)(e)));
    S.EXACT_SCORE_ALL_SIDES_BROAD_050_054 = report(sleeve((e) => e.cls === "EXACT_SCORE" && band(.5, .54)(e)));
    // B. halves
    for (const c of ["FIRST_HALF", "SECOND_HALF", "FULL_MATCH"] as const) {
      S[`${c}_ALL_PRICES`] = report(sleeve((e) => e.cls === c));
      S[`${c}_C0_050_060`] = report(sleeve((e) => e.cls === c && band(.5, .6)(e)));
      S[`${c}_BROAD_050_054`] = report(sleeve((e) => e.cls === c && band(.5, .54)(e)));
    }
    const bySM: Record<string, unknown> = {};
    for (const c of ["FIRST_HALF", "SECOND_HALF", "FULL_MATCH"] as const) {
      const sports = [...new Set(all.filter((e) => e.cls === c).map((e) => e.sport))].sort();
      for (const sp of sports) for (const sub of ["moneyline", "spread", "total", "other", "ALL"]) {
        for (const [bn, lo, hi] of [["C0_050_060", .5, .6]] as const) {
          const evs = sleeve((e) => e.cls === c && e.sport === sp && (sub === "ALL" || e.sub === sub) && band(lo, hi)(e));
          if (evs.length) bySM[`${c}|${sp}|${sub}|${bn}`] = { ...report(evs), LABEL: evs.length < 30 ? "SMALL_SAMPLE" : "N>=30" };
        }
      }
    }
    S.HALVES_BY_SPORT_MARKET_C0 = bySM;
    // C. 0.40–0.50 (side unsupported; full-match production-eligible classes, plus all-class)
    const sportsAll = [...new Set(all.filter((e) => e.price >= .4 && e.price < .5).map((e) => e.sport))].sort();
    const pb: Array<[string, number, number]> = [["0.40_0.42", .40, .42], ["0.42_0.44", .42, .44], ["0.44_0.46", .44, .46], ["0.46_0.48", .46, .48], ["0.48_0.50", .48, .50]];
    S.P40_50_FULL_MATCH = report(sleeve((e) => e.cls === "FULL_MATCH" && band(.4, .5)(e)));
    S.P40_50_ALL_CLASSES = report(sleeve(band(.4, .5)));
    S.P40_50_ALL_CLASSES_BUCKETS = Object.fromEntries(pb.map(([n, lo, hi]) => [n, report(sleeve(band(lo, hi)))]));
    S.P40_50_ALL_CLASSES_BY_SPORT = Object.fromEntries(sportsAll.map((sp) => { const evs = sleeve((e) => e.sport === sp && band(.4, .5)(e)); return [sp, { ...report(evs), LABEL: evs.length < 30 ? "SMALL_SAMPLE" : "N>=30" }]; }));
    S.P40_50_FULL_MATCH_BUCKETS = Object.fromEntries(pb.map(([n, lo, hi]) => [n, report(sleeve((e) => e.cls === "FULL_MATCH" && band(lo, hi)(e)))]));
    const sub: Record<string, unknown> = {};
    const sports = [...new Set(all.filter((e) => band(.4, .5)(e)).map((e) => e.sport))].sort();
    for (const cls of ["FULL_MATCH", "FIRST_HALF", "SECOND_HALF", "EXACT_SCORE", "OTHER", "UNKNOWN"] as const) {
      for (const sp of sports) for (const st of ["moneyline", "spread", "total", "other"]) {
        const evs = sleeve((e) => e.cls === cls && e.sport === sp && e.sub === st && band(.4, .5)(e));
        if (evs.length) sub[`${cls}|${sp}|${st}`] = { ...report(evs), LABEL: evs.length < 30 ? "SMALL_SAMPLE" : "N>=30" };
      }
    }
    S.P40_50_BY_CLASS_SPORT_TYPE = sub;
    (out.POPULATIONS as Record<string, unknown>)[pop] = S;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "SLEEVES_2026-08-04_2026-09-03.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ wrote: join(OUT_DIR, "SLEEVES_2026-08-04_2026-09-03.json") }));
}
main();
