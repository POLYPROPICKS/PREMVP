/**
 * FOOTBALL_CORE_PORTFOLIO_COMPOSITION_V1 — exact portfolio economics of the two
 * approved football CORE candidates. No new modeling, no thresholds, no predicate
 * duplication: membership comes from the exported registry selectors and
 * economics from the registry's common settlement map (flat 1u, OPEN != LOSS).
 *
 * Priority (A_THEN_B / B_THEN_A) is applied to SELECTED physical events BEFORE
 * settlement is consulted. Max one economic bet per physical event.
 *
 * Read-only against the research clone. No DB writes.
 *
 *   npx tsx scripts/modeling/football-core-portfolio-composition.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DATASET_ID,
  buildRunContext,
  buildSafeUniverseV2,
  calendarDaysInclusive,
  evaluateSelection,
  selectFootballOdds185200Repaired,
  selectFootballOrdinaryStructuredOdds175200,
  type CommonMetrics,
} from "./football-strategy-registry";
import { RANGE_START, RANGE_END } from "./build-football-denominator-reconciliation-v2";
import { loadFrozenFootballDenominatorV2 } from "./load-frozen-football-denominator-v2";
import { connectClone } from "./football-structural-authority";
import { fetchTennisIdentityLookup } from "./tennis-safe-comparable-leaderboard";
import type { SelectedCandidate } from "./daily-portfolio-frontier";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

export const OUT_DIR = "modeling/evidence/football-core-portfolio-composition-v1";
export const CORE_A_ID = "FOOTBALL_ODDS_185_200_REPAIRED";
export const CORE_B_ID = "FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200";

export const PERIODS = [
  { id: "AUG", from: "2026-08-04", to: "2026-08-31" },
  { id: "SEP_1_12", from: "2026-09-01", to: "2026-09-12" },
  { id: "SEP_13_24", from: "2026-09-13", to: "2026-09-24" },
] as const;

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Deterministic chronological order (matches metricsFor ordering). */
export const chronological = (rows: SelectedCandidate[]): SelectedCandidate[] =>
  [...rows].sort(
    (a, b) =>
      a.decisionTimestamp.localeCompare(b.decisionTimestamp) ||
      a.physicalEventKey.localeCompare(b.physicalEventKey) ||
      a.candidateIdentity.localeCompare(b.candidateIdentity),
  );

export interface Composition {
  portfolio: SelectedCandidate[];
  primary: SelectedCandidate[];
  incremental: SelectedCandidate[];
  /** Secondary picks dropped because primary already claimed the physical event. */
  dropped: SelectedCandidate[];
}

/**
 * Primary claims its physical events first; secondary contributes only events the
 * primary did not claim. Uses SELECTION only — settlement is never consulted.
 */
export function composePriority(primary: SelectedCandidate[], secondary: SelectedCandidate[]): Composition {
  const claimed = new Set(primary.map((p) => p.physicalEventKey));
  const incremental: SelectedCandidate[] = [];
  const dropped: SelectedCandidate[] = [];
  for (const s of chronological(secondary)) {
    if (claimed.has(s.physicalEventKey)) dropped.push(s);
    else {
      claimed.add(s.physicalEventKey); // guard: at most one bet per physical event
      incremental.push(s);
    }
  }
  return { portfolio: chronological([...primary, ...incremental]), primary, incremental, dropped };
}

export interface OverlapStats {
  CORE_A_SELECTED_N: number;
  CORE_B_SELECTED_N: number;
  OVERLAP_PHYSICAL_EVENT_N: number;
  A_ONLY_EVENT_N: number;
  B_ONLY_EVENT_N: number;
  UNION_EVENT_N: number;
  SAME_SELECTED_IDENTITY_N: number;
  DIFFERENT_SELECTED_IDENTITY_N: number;
  DIFFERENT_IDENTITY_EXAMPLES: Array<{ physicalEventKey: string; a_identity: string; b_identity: string }>;
}

export function overlapStats(a: SelectedCandidate[], b: SelectedCandidate[], exampleLimit = 20): OverlapStats {
  const aBy = new Map(a.map((x) => [x.physicalEventKey, x] as const));
  const bBy = new Map(b.map((x) => [x.physicalEventKey, x] as const));
  let same = 0;
  let diff = 0;
  const examples: OverlapStats["DIFFERENT_IDENTITY_EXAMPLES"] = [];
  for (const [key, ax] of [...aBy].sort(([x], [y]) => x.localeCompare(y))) {
    const bx = bBy.get(key);
    if (!bx) continue;
    if (ax.candidateIdentity === bx.candidateIdentity) same += 1;
    else {
      diff += 1;
      if (examples.length < exampleLimit) examples.push({ physicalEventKey: key, a_identity: ax.candidateIdentity, b_identity: bx.candidateIdentity });
    }
  }
  const overlap = same + diff;
  return {
    CORE_A_SELECTED_N: a.length,
    CORE_B_SELECTED_N: b.length,
    OVERLAP_PHYSICAL_EVENT_N: overlap,
    A_ONLY_EVENT_N: aBy.size - overlap,
    B_ONLY_EVENT_N: bBy.size - overlap,
    UNION_EVENT_N: aBy.size + bBy.size - overlap,
    SAME_SELECTED_IDENTITY_N: same,
    DIFFERENT_SELECTED_IDENTITY_N: diff,
    DIFFERENT_IDENTITY_EXAMPLES: examples,
  };
}

const inPeriod = (rows: SelectedCandidate[], from: string, to: string) => rows.filter((r) => r.day >= from && r.day <= to);

export interface PeriodMetrics { SETTLED_N: number; PNL_U: number; ROI_PCT: number; MAX_DD_U: number }
const periodRow = (m: CommonMetrics): PeriodMetrics => ({ SETTLED_N: m.settled_n, PNL_U: m.pnl_u, ROI_PCT: m.roi_pct, MAX_DD_U: m.max_dd_u });

export function periodDiagnostics(sets: Record<string, SelectedCandidate[]>, settlement: Map<string, CorpusLabel>) {
  const out: Record<string, Record<string, PeriodMetrics>> = {};
  for (const [name, rows] of Object.entries(sets)) {
    out[name] = {};
    for (const p of PERIODS) {
      out[name][p.id] = periodRow(evaluateSelection(inPeriod(rows, p.from, p.to), settlement, calendarDaysInclusive(p.from, p.to)));
    }
  }
  return out;
}

export interface Comparison {
  overlap: OverlapStats;
  standalone: { CORE_A: CommonMetrics; CORE_B: CommonMetrics };
  A_THEN_B: { metrics: CommonMetrics; B_incremental: CommonMetrics; B_dropped_n: number; DELTA_PNL_VS_A: number; DELTA_ROI_PP_VS_A: number; DELTA_MAXDD_VS_A: number };
  B_THEN_A: { metrics: CommonMetrics; A_incremental: CommonMetrics; A_dropped_n: number; DELTA_PNL_VS_B: number; DELTA_ROI_PP_VS_B: number; DELTA_MAXDD_VS_B: number };
  period_diagnostics: Record<string, Record<string, PeriodMetrics>>;
  naive_no_overlap_ceiling: { selected_n: number; pnl_u: number };
  primary_pnl_max: { portfolio: "A_THEN_B" | "B_THEN_A"; pnl_u: number };
}

export function compare(a: SelectedCandidate[], b: SelectedCandidate[], settlement: Map<string, CorpusLabel>, days: number): Comparison {
  const ev = (rows: SelectedCandidate[]) => evaluateSelection(rows, settlement, days);
  const mA = ev(a);
  const mB = ev(b);
  const ab = composePriority(a, b);
  const ba = composePriority(b, a);
  const mAB = ev(ab.portfolio);
  const mBA = ev(ba.portfolio);
  const tieAB = mAB.pnl_u >= mBA.pnl_u;
  return {
    overlap: overlapStats(a, b),
    standalone: { CORE_A: mA, CORE_B: mB },
    A_THEN_B: {
      metrics: mAB,
      B_incremental: ev(ab.incremental),
      B_dropped_n: ab.dropped.length,
      DELTA_PNL_VS_A: round(mAB.pnl_u - mA.pnl_u, 2),
      DELTA_ROI_PP_VS_A: round(mAB.roi_pct - mA.roi_pct, 2),
      DELTA_MAXDD_VS_A: round(mAB.max_dd_u - mA.max_dd_u, 2),
    },
    B_THEN_A: {
      metrics: mBA,
      A_incremental: ev(ba.incremental),
      A_dropped_n: ba.dropped.length,
      DELTA_PNL_VS_B: round(mBA.pnl_u - mB.pnl_u, 2),
      DELTA_ROI_PP_VS_B: round(mBA.roi_pct - mB.roi_pct, 2),
      DELTA_MAXDD_VS_B: round(mBA.max_dd_u - mB.max_dd_u, 2),
    },
    period_diagnostics: periodDiagnostics({ CORE_A: a, CORE_B: b, A_THEN_B: ab.portfolio, B_THEN_A: ba.portfolio }, settlement),
    naive_no_overlap_ceiling: { selected_n: a.length + b.length, pnl_u: round(mA.pnl_u + mB.pnl_u, 2) },
    primary_pnl_max: tieAB ? { portfolio: "A_THEN_B", pnl_u: mAB.pnl_u } : { portfolio: "B_THEN_A", pnl_u: mBA.pnl_u },
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const f2 = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

export function renderCeoMd(c: Comparison, days: number): string {
  const row = (name: string, m: CommonMetrics) =>
    `| ${name} | ${m.selected_n} | ${m.settled_n} | ${m.open_n} | ${m.wins} | ${m.losses} | ${f2(m.pnl_u)} | ${m.roi_pct.toFixed(2)} | ${m.max_dd_u.toFixed(2)} | ${m.bets_per_calendar_day.toFixed(2)} |`;
  const o = c.overlap;
  const per = Object.entries(c.period_diagnostics)
    .flatMap(([name, ps]) => Object.entries(ps).map(([p, m]) => `| ${name} | ${p} | ${m.SETTLED_N} | ${f2(m.PNL_U)} | ${m.ROI_PCT.toFixed(2)} | ${m.MAX_DD_U.toFixed(2)} |`))
    .join("\n");
  return `# Football CORE portfolio composition (${DATASET_ID}, ${days} days)

Flat 1u. WIN = 1/entry_price - 1, LOSS = -1, OPEN = no PnL. One bet per physical event. Priority is applied before settlement.

## Portfolios
| Portfolio | Selected | Settled | Open | Wins | Losses | PnL u | ROI % | MaxDD u | Bets/day |
|---|---|---|---|---|---|---|---|---|---|
${row("CORE_A alone", c.standalone.CORE_A)}
${row("CORE_B alone", c.standalone.CORE_B)}
${row("A_THEN_B", c.A_THEN_B.metrics)}
${row("B_THEN_A", c.B_THEN_A.metrics)}

## Overlap
A ${o.CORE_A_SELECTED_N} / B ${o.CORE_B_SELECTED_N}; overlap ${o.OVERLAP_PHYSICAL_EVENT_N} (same identity ${o.SAME_SELECTED_IDENTITY_N}, different ${o.DIFFERENT_SELECTED_IDENTITY_N}); A-only ${o.A_ONLY_EVENT_N}; B-only ${o.B_ONLY_EVENT_N}; union ${o.UNION_EVENT_N}. Naive no-overlap ceiling ${c.naive_no_overlap_ceiling.selected_n} selected / ${f2(c.naive_no_overlap_ceiling.pnl_u)}u.

## Incremental contribution
- A_THEN_B, B adds: selected ${c.A_THEN_B.B_incremental.selected_n}, settled ${c.A_THEN_B.B_incremental.settled_n}, open ${c.A_THEN_B.B_incremental.open_n}, PnL ${f2(c.A_THEN_B.B_incremental.pnl_u)}u. Delta vs A: PnL ${f2(c.A_THEN_B.DELTA_PNL_VS_A)}u, ROI ${f2(c.A_THEN_B.DELTA_ROI_PP_VS_A)}pp, MaxDD ${f2(c.A_THEN_B.DELTA_MAXDD_VS_A)}u.
- B_THEN_A, A adds: selected ${c.B_THEN_A.A_incremental.selected_n}, settled ${c.B_THEN_A.A_incremental.settled_n}, open ${c.B_THEN_A.A_incremental.open_n}, PnL ${f2(c.B_THEN_A.A_incremental.pnl_u)}u. Delta vs B: PnL ${f2(c.B_THEN_A.DELTA_PNL_VS_B)}u, ROI ${f2(c.B_THEN_A.DELTA_ROI_PP_VS_B)}pp, MaxDD ${f2(c.B_THEN_A.DELTA_MAXDD_VS_B)}u.

## Period diagnostics (fixed strategies, no optimization)
| Set | Period | Settled | PnL u | ROI % | MaxDD u |
|---|---|---|---|---|---|
${per}

Primary PnL-max portfolio: **${c.primary_pnl_max.portfolio}** (${f2(c.primary_pnl_max.pnl_u)}u).
`;
}

async function main() {
  const db = await connectClone();
  const frozen = await loadFrozenFootballDenominatorV2(db);
  const preliminary = buildSafeUniverseV2(frozen.sourceRows, frozen.overlay, () => null);
  const identityLookup = await fetchTennisIdentityLookup(db, preliminary.tennisConditionIds);
  const ctx = buildRunContext(frozen.sourceRows, frozen.overlay, identityLookup);
  const days = calendarDaysInclusive(RANGE_START, RANGE_END);
  const a = selectFootballOdds185200Repaired(ctx);
  const b = selectFootballOrdinaryStructuredOdds175200(ctx);
  const cmp = compare(a, b, ctx.settlement, days);

  // Sanity: standalone authority must reproduce exactly.
  const sa = cmp.standalone.CORE_A;
  const sb = cmp.standalone.CORE_B;
  const okA = sa.selected_n === 1386 && sa.settled_n === 988 && sa.open_n === 398 && sa.pnl_u === 178.31 && sa.max_dd_u === -12.48;
  const okB = sb.selected_n === 726 && sb.settled_n === 566 && sb.open_n === 160 && sb.pnl_u === 135.21 && sb.max_dd_u === -8.65;
  const sanity = { STANDALONE_A_REPRODUCED: okA, STANDALONE_B_REPRODUCED: okB, UNION_LE_NAIVE_CEILING: cmp.overlap.UNION_EVENT_N <= 2112, PHYSICAL_EVENTS_CANONICAL: 5030 };
  if (!okA || !okB) throw new Error(`STANDALONE_REPRODUCTION_FAILED ${JSON.stringify({ sa, sb })}`);

  const json = JSON.stringify({ MISSION: "FOOTBALL_PRIMARY_CORE_PORTFOLIO_COMPOSITION", DATASET_ID, RANGE: `${RANGE_START}..${RANGE_END}`, CALENDAR_DAYS: days, CORE_A: CORE_A_ID, CORE_B: CORE_B_ID, SANITY: sanity, ...cmp, DB_WRITES: 0, PRODUCTION_WRITES: 0 }, null, 2) + "\n";
  const md = renderCeoMd(cmp, days);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "PORTFOLIO_COMPARISON.json"), json);
  writeFileSync(join(OUT_DIR, "CEO_PORTFOLIO_COMPARISON.md"), md);
  writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), `${sha256(md)}  CEO_PORTFOLIO_COMPARISON.md\n${sha256(json)}  PORTFOLIO_COMPARISON.json\n`);
  console.log(JSON.stringify({ STATUS: "SUCCESS", SANITY: sanity, OVERLAP: { ...cmp.overlap, DIFFERENT_IDENTITY_EXAMPLES: undefined }, A_THEN_B: cmp.A_THEN_B.metrics, B_THEN_A: cmp.B_THEN_A.metrics, PRIMARY: cmp.primary_pnl_max, DB_WRITES: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
