import { NextRequest, NextResponse } from "next/server";
import { buildFireModelCandidates } from "@/lib/executor/buildFireModelCandidates";
import {
  buildNightPortfolioPlan,
  nightPlanControlSemantics,
  IRELAND_RUNTIME_CONTRACT,
  IRELAND_RECOMMENDED_RUNTIME_SECONDS,
  TARGET_MIN_BETS_DEFAULT,
  TARGET_MAX_BETS_DEFAULT,
} from "@/lib/executor/nightPortfolioPlanner";

// Read-only planning route. Returns the Night Portfolio Plan for the active
// 18:00–07:00 Europe/Minsk window. NO order placement, NO DB writes.
// Auth mirrors /api/executor/candidates (x-executor-secret).

// Wide pool so event-dedupe + Tier classification does not starve unique events.
const PLAN_POOL = 200;

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "1";

  const rawMin = parseInt(searchParams.get("targetMin") ?? "", 10);
  const rawMax = parseInt(searchParams.get("targetMax") ?? "", 10);
  const targetMin = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : TARGET_MIN_BETS_DEFAULT;
  const targetMax =
    Number.isFinite(rawMax) && rawMax >= targetMin ? rawMax : TARGET_MAX_BETS_DEFAULT;

  try {
    // planningMode=true: include future soccer/WC matches as future planning slots.
    const universe = await buildFireModelCandidates(PLAN_POOL, "all", true);
    const plan = buildNightPortfolioPlan(universe, {
      nowMs: Date.now(),
      targetMin,
      targetMax,
    });

    const semantics = nightPlanControlSemantics(plan);

    const body: Record<string, unknown> = {
      ok: true,
      // --- Autonomy / control semantics (founder approval is NOT required) ---
      ...semantics,
      // --- Ireland autostart contract (backend-exposed; Ireland edits out of scope) ---
      ireland_runtime_contract: IRELAND_RUNTIME_CONTRACT,
      // Recommended Ireland runtime env (NO secrets — operator sets values on the box).
      ireland_recommended_env: {
        LIVE_ENABLED: "YES",
        MAX_LIVE_ORDERS: `${plan.target_max_bets} (CAP, not target)`,
        RUN_SECONDS: `${IRELAND_RECOMMENDED_RUNTIME_SECONDS} (covers 18:00–07:00 Minsk)`,
        ALLOW_UNKNOWN_LIVE: "false/missing (must never be true)",
        note: "consume production candidates only after Railway deployment verified",
      },
      plan_version: plan.plan_version,
      timezone: plan.timezone,
      window_start_iso: plan.window_start_iso,
      window_end_iso: plan.window_end_iso,
      planned_at_iso: plan.planned_at_iso,
      target_min_bets: plan.target_min_bets,
      target_max_bets: plan.target_max_bets,
      starting_bankroll_usd: plan.starting_bankroll_usd,
      plan_status: plan.plan_status,
      tier1_event_slots: plan.tier1_event_slots,
      tier2_fallback_slots: plan.tier2_fallback_slots,
      planned_live_slots: plan.planned_live_slots,
      paper_only_slots: plan.paper_only_slots,
      unsafe_rejected_count: plan.unsafe_rejected_count,
      slot_shortage_count: plan.slot_shortage_count,
      second_alert_required: plan.second_alert_required,
      rebalance_policy: plan.rebalance_policy,
      planned_slots: plan.planned_slots,
      top_rejected_reasons: plan.top_rejected_reasons,
      diagnostics: plan.diagnostics,
    };

    // debug=1 surfaces only non-secret rejected-reason detail (already in plan).
    if (!debug) {
      delete body.top_rejected_reasons;
    }

    return NextResponse.json(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[executor/night-plan] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
