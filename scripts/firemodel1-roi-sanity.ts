// FireModel1 ROI Sanity Board — read-only, no writes, no SQL to founder.
// Reads resolved rows from generated_signal_pairs, groups by cohort, prints compact board.
// Run: npm run firemodel1:roi

import { supabaseAdmin } from "../lib/supabase/server";

const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];

type Row = {
  condition_id: string;
  selected_token_id: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  smart_money_score_num: number | null;
  signal_result: string | null;
  realized_return_pct: number | null;
  winning_outcome: string | null;
  selected_outcome: string | null;
  metric_formula_version: string | null;
  market_slug: string | null;
  event_slug: string | null;
  created_at: string;
  diagnostics: Record<string, unknown>;
};

const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const WC_RE = /world[\s-]?cup|wc2026|fifa|cabo|belgium|egypt|spain/i;

const since = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

interface CohortStats {
  label: string;
  total: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  roiPct: number | null;
  missingFields: string[];
}

function computeCohort(rows: Row[], label: string): CohortStats {
  const resolved = rows.filter((r) => r.signal_result !== null);
  const unresolved = rows.filter((r) => r.signal_result === null);
  const missing: string[] = [];

  const hasResult = resolved.every((r) => r.signal_result != null);
  const hasPnl = resolved.every((r) => r.realized_return_pct != null);
  const hasEntry = rows.every((r) => r.entry_price_num != null);
  if (!hasResult && resolved.length > 0) missing.push("signal_result");
  if (!hasPnl && resolved.length > 0) missing.push("realized_return_pct");
  if (!hasEntry) missing.push("entry_price_num");

  const wins = resolved.filter((r) => r.signal_result === "WIN").length;
  const losses = resolved.filter((r) => r.signal_result === "LOSS").length;

  let roiPct: number | null = null;
  if (hasPnl && resolved.length > 0) {
    const totalReturn = resolved.reduce((s, r) => s + (r.realized_return_pct ?? 0), 0);
    roiPct = Math.round((totalReturn / resolved.length) * 10) / 10;
  }

  return {
    label,
    total: rows.length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    wins,
    losses,
    roiPct,
    missingFields: missing,
  };
}

function printCohort(c: CohortStats, window: string) {
  const roi =
    c.roiPct != null
      ? `ROI=${c.roiPct > 0 ? "+" : ""}${c.roiPct}%`
      : `ROI_NOT_AVAILABLE: missing ${c.missingFields.join(",") || "unknown"}`;
  const warn = c.resolved < 10 ? " ⚠ N<10" : "";
  const unwarn = c.unresolved / Math.max(c.total, 1) > 0.8 ? " ⚠ MOSTLY_UNRESOLVED" : "";
  console.log(
    `  [${window}] ${c.label.padEnd(24)} tot=${c.total} res=${c.resolved} W=${c.wins} L=${c.losses} ${roi}${warn}${unwarn}`,
  );
}

function priceBucket(ep: number | null): string {
  if (ep == null) return "unknown";
  if (ep < 0.25) return "<0.25";
  if (ep < 0.44) return "0.25-0.44";
  if (ep <= 0.58) return "0.44-0.58";
  if (ep <= 0.75) return "0.58-0.75";
  return ">0.75";
}

function covBucket(cov: number | null): string {
  if (cov == null) return "unknown";
  if (cov < 25) return "<25";
  if (cov < 50) return "25-49";
  if (cov < 75) return "50-74";
  return ">=75";
}

function smBucket(sm: number | null): string {
  if (sm == null) return "unknown";
  if (sm < 50) return "sm<50";
  if (sm < 75) return "sm50-74";
  return "sm>=75";
}

function getTier(r: Row): string {
  const sc = r.signal_confidence_num ?? 0;
  const cov = (r.diagnostics?.dataCoverage as number) ?? 0;
  if (sc >= 72 && cov >= 50) return "TIER1_STRICT_72_COV50";
  if (sc >= 60 && cov >= 50) return "TIER2_SAFE_60_COV50";
  if (sc >= 50 && cov >= 25) return "TIER3_MICRO_50_COV25";
  return "BELOW_GATE";
}

function marketRef(r: Row): string {
  return (r.market_slug ?? r.event_slug ?? "").toLowerCase();
}

async function fetchWindow(days: number): Promise<Row[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "condition_id, selected_token_id, entry_price_num, signal_confidence_num, " +
        "smart_money_score_num, signal_result, realized_return_pct, winning_outcome, " +
        "selected_outcome, metric_formula_version, market_slug, event_slug, created_at, diagnostics",
    )
    .in("metric_formula_version", ALLOWED_VERSIONS)
    .gte("created_at", since(days))
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`DB error: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "24h", days: 1 },
  { label: "48h", days: 2 },
  { label: "96h", days: 4 },
  { label: "7d", days: 7 },
  { label: "since-2026-06-11", days: 5 },
];

async function main() {
  const line = "─".repeat(74);
  console.log(`\nFIREMODEL1 ROI SANITY BOARD  ${new Date().toISOString()}`);
  console.log(`Policy: battle-sm-guard-v1-20260615  Bank:$300  Cap:$10\n`);

  for (const w of WINDOWS) {
    const rows = await fetchWindow(w.days);
    if (rows.length === 0) {
      console.log(`[${w.label}] NO_DATA`);
      continue;
    }
    console.log(`${line}`);
    console.log(`WINDOW: ${w.label}  (${rows.length} total rows)`);

    // Tier cohorts
    const tiers = ["TIER1_STRICT_72_COV50", "TIER2_SAFE_60_COV50", "TIER3_MICRO_50_COV25"];
    for (const t of tiers) {
      printCohort(computeCohort(rows.filter((r) => getTier(r) === t), t), w.label);
    }

    // WC / eSports / non-NBA-NHL
    printCohort(computeCohort(rows.filter((r) => WC_RE.test(marketRef(r))), "WC2026"), w.label);
    printCohort(
      computeCohort(rows.filter((r) => ESPORTS_RE.test(marketRef(r))), "eSports"),
      w.label,
    );
    printCohort(
      computeCohort(
        rows.filter((r) => !NBA_NHL_RE.test(marketRef(r))),
        "non-NBA/NHL",
      ),
      w.label,
    );

    // Price buckets
    const pBuckets = ["<0.25", "0.25-0.44", "0.44-0.58", "0.58-0.75", ">0.75"];
    for (const pb of pBuckets) {
      printCohort(
        computeCohort(rows.filter((r) => priceBucket(r.entry_price_num) === pb), `price:${pb}`),
        w.label,
      );
    }

    // Coverage buckets
    for (const cb of ["<25", "25-49", "50-74", ">=75"]) {
      printCohort(
        computeCohort(
          rows.filter((r) => covBucket(r.diagnostics?.dataCoverage as number | null) === cb),
          `cov:${cb}`,
        ),
        w.label,
      );
    }

    // Smart money buckets
    for (const sb of ["sm<50", "sm50-74", "sm>=75"]) {
      printCohort(
        computeCohort(rows.filter((r) => smBucket(r.smart_money_score_num) === sb), sb),
        w.label,
      );
    }

    // Cost stress (only if realized_return_pct available)
    const resolvedWithPnl = rows.filter((r) => r.signal_result != null && r.realized_return_pct != null);
    if (resolvedWithPnl.length > 0) {
      console.log(`\n  COST STRESS (${resolvedWithPnl.length} resolved rows):`);
      for (const slip of [0, 0.01, 0.02, 0.04]) {
        const adj =
          resolvedWithPnl.reduce((s, r) => s + (r.realized_return_pct ?? 0) - slip * 100, 0) /
          resolvedWithPnl.length;
        console.log(
          `    slip=${slip.toFixed(2)}c  avg_adj_roi=${adj > 0 ? "+" : ""}${adj.toFixed(1)}%`,
        );
      }
    } else {
      console.log(`\n  COST_STRESS: ROI_NOT_AVAILABLE: missing realized_return_pct`);
    }
  }

  console.log(`${line}\n`);
}

main().catch((e) => {
  console.error("ROI_SANITY_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
