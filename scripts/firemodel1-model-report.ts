// FireModel1 Data Contract Report — Phase 1: data readiness check.
// Run: npm run firemodel1:report

import { supabaseAdmin } from "../lib/supabase/server";
import { since, LINE } from "../lib/executor/modelingData";

const COMMIT_0F637C0_DATE = "2026-06-15T00:00:00Z"; // approximate

async function fetchVersion(version: string | null) {
  const q = supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, created_at, condition_id, selected_token_id, entry_price_num, " +
        "signal_confidence_num, smart_money_score_num, metric_formula_version, " +
        "formula_version, signal_result, realized_return_pct, diagnostics",
      { count: "exact" },
    );
  const res = version ? q.eq("metric_formula_version", version) : q.is("metric_formula_version", null);
  const { data, count, error } = await res.limit(2000);
  if (error) throw new Error(`DB: ${error.message}`);
  return { rows: (data ?? []) as unknown as Record<string, unknown>[], count: count ?? 0 };
}

function fieldCoverage(rows: Record<string, unknown>[], field: string): string {
  const present = rows.filter((r) => {
    if (field.startsWith("diagnostics.")) {
      const sub = field.replace("diagnostics.", "");
      const d = r.diagnostics as Record<string, unknown> | null;
      return d != null && d[sub] != null && d[sub] !== "null" && d[sub] !== "";
    }
    return r[field] != null && r[field] !== "";
  }).length;
  const pct = rows.length ? Math.round((present / rows.length) * 100) : 0;
  return `${present}/${rows.length} (${pct}%)`;
}

async function main() {
  console.log(`\nFIREMODEL1 DATA CONTRACT REPORT  ${new Date().toISOString()}`);
  console.log(LINE);

  const versions = [
    "v2-lite-growth-safe",
    "shadow-firemodel1_1_research_v0",
    "shadow-strategic-sports-v1",
  ];

  // A) Row counts by version
  console.log("\nA) ROW COUNTS BY VERSION");
  for (const v of versions) {
    const { rows, count } = await fetchVersion(v);
    const resolved = rows.filter((r) => r.signal_result != null).length;
    const hasPnl = rows.filter((r) => r.realized_return_pct != null).length;
    console.log(`  ${v.padEnd(38)} total=${count} resolved=${resolved} pnl_present=${hasPnl}`);
  }

  // B) Field coverage on allowed versions
  console.log("\nB) FIELD COVERAGE (v2-lite + shadow-fm1.1)");
  const { rows: allowed } = await fetchVersion("v2-lite-growth-safe");
  const { rows: shadow } = await fetchVersion("shadow-firemodel1_1_research_v0");
  const combined = [...allowed, ...shadow] as Record<string, unknown>[];

  const fields = [
    "condition_id", "selected_token_id", "entry_price_num",
    "signal_confidence_num", "smart_money_score_num",
    "signal_result", "realized_return_pct",
    "diagnostics.dataCoverage", "diagnostics.gameStartIso",
  ];
  for (const f of fields) {
    console.log(`  ${f.padEnd(36)} : ${fieldCoverage(combined, f)}`);
  }

  // C) Era breakdown
  console.log("\nC) ERA BREAKDOWN");
  const eras = [
    { label: "before patch 0f637c0", sinceD: 30, beforeD: 0 },
    { label: "last 7d",     sinceD: 7 },
    { label: "last 48h",    sinceD: 2 },
    { label: "last 24h",    sinceD: 1 },
  ];

  const { data: allRows } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("created_at, metric_formula_version, signal_result")
    .in("metric_formula_version", ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"])
    .order("created_at", { ascending: false })
    .limit(5000);

  const eraAllRows = (allRows ?? []) as Array<{ created_at: string; signal_result: string | null }>;
  const beforePatch = eraAllRows.filter((r) => r.created_at < COMMIT_0F637C0_DATE);
  const afterPatch = eraAllRows.filter((r) => r.created_at >= COMMIT_0F637C0_DATE);
  const last7d = eraAllRows.filter((r) => r.created_at >= since(7));
  const last48h = eraAllRows.filter((r) => r.created_at >= since(2));
  const last24h = eraAllRows.filter((r) => r.created_at >= since(1));

  for (const [label, rows] of [
    ["before 0f637c0", beforePatch], ["after 0f637c0", afterPatch],
    ["last 7d", last7d], ["last 48h", last48h], ["last 24h", last24h],
  ] as [string, typeof eraAllRows][]) {
    const res = rows.filter((r) => r.signal_result != null).length;
    console.log(`  ${label.padEnd(18)} rows=${rows.length} resolved=${res}`);
  }

  // D) Warnings
  console.log("\nD) WARNINGS");
  const totalResolved = eraAllRows.filter((r) => r.signal_result != null).length;
  if (totalResolved < 10) {
    console.log("  ⚠ CRITICAL: resolved_count < 10 — ROI analysis not meaningful yet");
  }
  if (totalResolved === 0) {
    console.log("  ⚠ CRITICAL: realized_return_pct ALL NULL — no live orders placed yet");
    console.log("     ROI_NOT_AVAILABLE: missing realized_return_pct, signal_result");
  }
  const fm11Rows = shadow.filter((r) => r.signal_result != null);
  if (fm11Rows.length === 0) {
    console.log("  ⚠ MEDIUM: shadow-firemodel1_1_research_v0 has no resolved rows");
    console.log("     Resolver may not cover this version yet — verify resolver SQL");
  }

  const oldShadow = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id", { count: "exact" })
    .eq("metric_formula_version", "shadow-strategic-sports-v1");
  if ((oldShadow.count ?? 0) > 0) {
    console.log(`  ⚠ INFO: ${oldShadow.count} old shadow-strategic-sports-v1 rows exist — excluded from private candidates unless enriched`);
  }

  console.log(`\n${LINE}\n`);
}

main().catch((e) => {
  console.error("MODEL_REPORT_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
