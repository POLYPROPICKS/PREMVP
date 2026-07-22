// scripts/contur3/audit-night-funnel.ts
//
// READ-ONLY exact night-plan funnel audit. Reuses the real production
// functions (buildFireModelCandidates planningMode, buildReservationPlan,
// produceFrozenModelV2ShadowDecisions, the paginated fetchAllPlanningRows
// loader) and the pure assembly in lib/executor/nightFunnelAudit.ts. It never
// writes: only Supabase .select() reads, no POST, no insert/update, no
// reservation/rebalance orchestration. Temp JSON may be written only under /tmp.
//
// Usage:
//   npx tsx scripts/contur3/audit-night-funnel.ts \
//     --plan-id night-plan:2026-07-22:1700-minsk \
//     --as-of 2026-07-22T14:00:00.000Z \
//     --horizon-end 2026-07-23T08:06:34.283Z \
//     --timezone Europe/Minsk

import { loadEnvConfig } from "@next/env";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { produceFrozenModelV2ShadowDecisions } from "@/lib/modeling/frozenModelProducerV2Shadow";
import {
  assembleNightFunnelAudit,
  type QueueCounts,
  type FunnelStage,
} from "@/lib/executor/nightFunnelAudit";

const PLANNING_PAGE_SIZE = 1000; // mirrors buildFireModelCandidates' loader page size (diagnostic only)

function arg(name: string, fallback: string | null = null): string | null {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function printFunnel(title: string, stages: FunnelStage[]): void {
  console.log(`\n=== ${title} ===`);
  console.log("stage | input | dropped | output | reason | source");
  for (const s of stages) {
    console.log(`${s.stage} | ${s.input} | ${s.dropped} | ${s.output} | ${s.reason} | ${s.source}`);
  }
}

async function main() {
  loadEnvConfig(process.cwd());

  const planId = arg("plan-id");
  const asOf = arg("as-of");
  const horizonEnd = arg("horizon-end");
  const timezone = arg("timezone", "Europe/Minsk");
  if (!planId || !asOf) {
    console.error("MISSING_ARGS: --plan-id and --as-of are required");
    process.exit(2);
  }
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    console.error(`INVALID_AS_OF: ${asOf}`);
    process.exit(2);
  }

  // Dynamic imports keep loadEnvConfig ordering (env before supabaseAdmin init).
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { buildFireModelCandidates, fetchAllPlanningRows } = await import("@/lib/executor/buildFireModelCandidates");
  const { buildReservationPlan } = await import("@/lib/executor/nightEventReservations");

  console.log(`[audit-night-funnel] plan_id=${planId} as_of=${asOf} horizon_end=${horizonEnd} tz=${timezone}`);

  // ── Planning funnel: real production planning candidate build + reservation plan.
  const PLAN_POOL = 100_000;
  const { rawDiagnostics } = await buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_PLANNING_V1");
  const plan = await buildReservationPlan(asOfMs, { selectorMode: "CONTRACT_A_PLANNING_V1" });

  // ── Contract A source rows via the SAME paginated production loader + query.
  const lookbackHours = parseInt(process.env.PLANNING_LOOKBACK_HOURS ?? "72", 10);
  const lookbackIso = new Date(asOfMs - lookbackHours * 3_600_000).toISOString();
  const sourceRows = await fetchAllPlanningRows(
    () =>
      supabaseAdmin
        .from("generated_signal_pairs")
        .select("*")
        .gte("created_at", lookbackIso)
        .order("created_at", { ascending: false }),
    { stage: "audit_contract_a_source_fetch" },
  );
  const pageCount = Math.max(1, Math.ceil(sourceRows.length / PLANNING_PAGE_SIZE));
  console.log(`[audit-night-funnel] contract_a source rows loaded=${sourceRows.length} (~${pageCount} page(s) @ ${PLANNING_PAGE_SIZE})`);

  // AT_PLAN_TIME: producer evaluated as-of the plan instant.
  const contractAAtPlanTime = produceFrozenModelV2ShadowDecisions(sourceRows, asOf);
  // CURRENT_SOURCE_FORECAST: NON-AUTHORITATIVE — production re-fetches fresh rows
  // at the first due window; this replays the SAME source rows at "now" only as
  // an indicative forecast, never as the final future decision.
  const contractAForecast = produceFrozenModelV2ShadowDecisions(sourceRows, new Date().toISOString());

  // ── Actual persisted reservations for this plan (READ-ONLY).
  const { data: resRows, error: resErr } = await supabaseAdmin
    .from("night_event_reservations")
    .select("id, status, event_title, match_family_key, game_start_iso, event_tier, selection_reason, diagnostics")
    .eq("plan_run_id", planId);
  if (resErr) {
    console.error(`RESERVATION_READ_FAILED: ${resErr.message}`);
    process.exit(1);
  }
  const reservations = resRows ?? [];
  const reservedCount = reservations.filter((r) => r.status === "RESERVED" || r.status === "QUEUED" || r.status === "REBALANCE_PENDING").length;
  const skippedCount = reservations.filter((r) => r.status === "SKIPPED").length;

  // ── Actual queue rows for this plan (READ-ONLY).
  const { data: queueRows, error: qErr } = await supabaseAdmin
    .from("event_execution_queue")
    .select("status")
    .eq("plan_run_id", planId);
  if (qErr) {
    console.error(`QUEUE_READ_FAILED: ${qErr.message}`);
    process.exit(1);
  }
  const queueCounts: QueueCounts = { total: 0, READY: 0, CLAIMED: 0, SENT: 0, EXECUTED: 0, FAILED: 0 };
  for (const q of queueRows ?? []) {
    queueCounts.total += 1;
    const st = String((q as { status?: unknown }).status ?? "");
    if (st in queueCounts) (queueCounts as unknown as Record<string, number>)[st] += 1;
  }

  const audit = assembleNightFunnelAudit({
    planId,
    raw: rawDiagnostics,
    plan: plan.diagnostics,
    reservedCount,
    skippedCount,
    contractAAtPlanTime,
    contractAForecast,
    queueCounts,
  });

  // ── Output: compact funnel tables, crosswalk, missing events, JSON summary.
  printFunnel("PLANNING FUNNEL", audit.planning_funnel);
  printFunnel("CONTRACT_A_AT_PLAN_TIME", audit.contract_a_at_plan_time);
  printFunnel("CONTRACT_A_CURRENT_SOURCE_FORECAST (NON-AUTHORITATIVE — production re-fetches fresh rows at first due window)", audit.contract_a_forecast);

  console.log("\n=== RESERVATION CROSSWALK (actual persisted rows) ===");
  for (const r of reservations) {
    const diag = (r.diagnostics ?? {}) as Record<string, unknown>;
    console.log(
      `reservation_id=${r.id} status=${r.status} event=${r.event_title} match_family_key=${r.match_family_key} ` +
        `game_start_iso=${r.game_start_iso} tier=${r.event_tier} selector_id=${diag.selector_id ?? "n/a"} reason=${r.selection_reason ?? "n/a"}`,
    );
  }

  console.log("\n=== QUEUE ===");
  console.log(JSON.stringify(queueCounts));

  console.log("\n=== JSON SUMMARY ===");
  console.log(JSON.stringify(audit));

  // Temp artifact under /tmp only (never committed to Git).
  const outPath = path.join("/tmp", `night_funnel_audit_${planId.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  try {
    writeFileSync(outPath, JSON.stringify(audit, null, 2));
    console.log(`[audit-night-funnel] wrote ${outPath}`);
  } catch {
    // Non-fatal: stdout JSON above is the durable output.
  }
}

main().catch((err) => {
  console.error("[audit-night-funnel] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
