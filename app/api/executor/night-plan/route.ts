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
type AuditCandidate = Record<string, any>;

function positiveNumber(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function writePollProof(route: string, payload: Record<string, unknown>) {
  try {
    await import("@/lib/supabase/server").then(({ supabaseAdmin }) =>
      supabaseAdmin.from("executor_order_events").insert({
        event_type: "night_plan_poll",
        source: route,
        environment: process.env.NODE_ENV ?? "production",
        order_status: "poll_ok",
        success: true,
        dry_run: true,
        live_confirm: false,
        executor_meta: payload,
        raw_event_json: payload,
      })
    );
  } catch (error) {
    console.warn("[executor/night-plan] poll proof write failed:", error instanceof Error ? error.message : error);
  }
}

function auditTraceId(candidate: AuditCandidate): string {
  return [
    candidate.condition_id ?? "no_condition",
    candidate.token_id ?? candidate.selected_token_id ?? "no_token",
    candidate.event_slug ?? candidate.match_family_key ?? "no_event",
  ].join("::");
}

function compactCandidatePayload(candidate: AuditCandidate): Record<string, unknown> {
  return {
    signal_id: candidate.signal_id,
    event_slug: candidate.event_slug,
    market_slug: candidate.market_slug,
    side: candidate.side,
    condition_id: candidate.condition_id,
    token_id: candidate.token_id ?? candidate.selected_token_id,
    selected_token_id: candidate.selected_token_id,
    score: candidate.score,
    coverage: candidate.coverage,
    tier: candidate.tier,
    stake_usd: candidate.stake_usd,
    live_eligible: candidate.live_eligible,
    live_rejection_reason: candidate.live_rejection_reason,
    strategic_scope: candidate.strategic_scope,
    sport: candidate.sport,
    match_family_key: candidate.match_family_key,
  };
}

async function writeNightPlanAudit(opts: {
  runId: string;
  plan: ReturnType<typeof buildNightPortfolioPlan>;
  requestParams: Record<string, unknown>;
  rawDiagnostics: Record<string, any> | null;
}): Promise<{ failed: boolean; reason: string | null }> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    const selected = ((opts.plan.diagnostics.selected_event_candidates ?? []) as AuditCandidate[]);
    const events = [
      {
        run_id: opts.runId,
        trace_id: opts.runId,
        stage: "NIGHT_PLAN_API_RUN",
        status: "SUCCESS",
        source: "api/executor/night-plan",
        payload_json: {
          raw_count: opts.rawDiagnostics?.total_db_rows ?? null,
          selected_event_candidates_count: selected.length,
          live_eligible_count: selected.filter((c) => c.live_eligible === true).length,
          wc_count: selected.filter((c) => c.strategic_scope === "WC").length,
          final_plan_count: opts.plan.planned_slots.length,
          request_params: opts.requestParams,
          window_start_iso: opts.plan.window_start_iso,
          window_end_iso: opts.plan.window_end_iso,
          plan_status: opts.plan.plan_status,
        },
      },
      ...selected.map((candidate) => ({
        run_id: opts.runId,
        trace_id: auditTraceId(candidate),
        stage: "EXPOSED_BY_API",
        event_slug: candidate.event_slug ?? null,
        market_slug: candidate.market_slug ?? null,
        side: candidate.side ?? candidate.selected_outcome ?? null,
        condition_id: candidate.condition_id ?? null,
        token_id: candidate.token_id ?? candidate.selected_token_id ?? null,
        score: candidate.score ?? null,
        coverage: candidate.coverage ?? null,
        tier: candidate.tier ?? null,
        stake_usd: candidate.stake_usd ?? null,
        live_eligible: candidate.live_eligible === true,
        status: candidate.live_eligible === true ? "LIVE_ELIGIBLE" : "NOT_LIVE",
        reason: candidate.live_rejection_reason ?? null,
        source: "api/executor/night-plan",
        payload_json: compactCandidatePayload(candidate),
      })),
    ];
    const { error } = await supabaseAdmin.from("executor_audit_events").insert(events);
    if (error) return { failed: true, reason: error.message };
    return { failed: false, reason: null };
  } catch (error) {
    return {
      failed: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

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
  const bankrollInputs = [
    ["bankroll", positiveNumber(searchParams.get("bankroll"))],
    ["cash", positiveNumber(searchParams.get("cash"))],
    ["availableCash", positiveNumber(searchParams.get("availableCash"))],
    ["currentBankroll", positiveNumber(searchParams.get("currentBankroll"))],
  ] as const;
  const provided = bankrollInputs.filter(([, value]) => value !== null);
  const effectiveBankroll = provided.length
    ? Math.min(...provided.map(([, value]) => value as number))
    : null;
  const bankrollInputSource = provided.map(([name]) => name).join(",") || "default_300";
  const runId = `night-plan:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;

  try {
    // planningMode=true: include shadow-strategic-sports-v1 and future soccer/WC matches.
    const { candidates: universe, rawDiagnostics } = await buildFireModelCandidates(PLAN_POOL, "all", true);
    const plan = buildNightPortfolioPlan(universe, {
      nowMs: Date.now(),
      targetMin,
      targetMax,
      startingBankrollUsd: effectiveBankroll ?? undefined,
      availableCashUsd: effectiveBankroll ?? undefined,
      bankrollInputSource,
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
      effective_bankroll_usd: plan.diagnostics.effective_bankroll_usd,
      bankroll_input_source: plan.diagnostics.bankroll_input_source,
      bankroll_warning: plan.diagnostics.bankroll_warning,
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
      diagnostics: {
        ...plan.diagnostics,
        ...(rawDiagnostics
          ? {
              source_counts_by_formula_version:
                rawDiagnostics.source_counts_by_formula_version,
              activity_label_rows: rawDiagnostics.activity_label_rows,
              rows_missing_game_start: rawDiagnostics.rows_missing_game_start,
              rows_missing_event_slug: rawDiagnostics.rows_missing_event_slug,
              rows_missing_selected_token: rawDiagnostics.rows_missing_selected_token,
              rows_missing_selected_outcome: rawDiagnostics.rows_missing_selected_outcome,
              wc_like_rows: rawDiagnostics.wc_like_rows,
              soccer_like_rows: rawDiagnostics.soccer_like_rows,
              wc_tier2_override_candidates:
                rawDiagnostics.wc_tier2_override_candidates,
              wc_tier2_override_live_enabled:
                rawDiagnostics.wc_tier2_override_live_enabled,
              wc_tier2_override_rejected_by_reason:
                rawDiagnostics.wc_tier2_override_rejected_by_reason,
              sport_classification_confidence: rawDiagnostics.sport_classification_confidence_counts,
              match_family_quality_counts: rawDiagnostics.match_family_quality_counts,
              rejected_before_planning_by_reason:
                rawDiagnostics.rejected_before_planning_by_reason,
              dropped_by_formula_version_and_reason:
                rawDiagnostics.dropped_by_formula_version_and_reason,
              versions_queried: rawDiagnostics.versions_queried,
              versions_with_zero_db_rows: rawDiagnostics.versions_with_zero_db_rows,
              total_db_rows: rawDiagnostics.total_db_rows,
            }
          : {}),
      },
    };

    const requestParams = {
      targetMin,
      targetMax,
      bankroll_input_source: bankrollInputSource,
      effective_bankroll: effectiveBankroll,
      debug,
      url: request.url,
    };

    const auditResult = await writeNightPlanAudit({
      runId,
      plan,
      requestParams,
      rawDiagnostics: rawDiagnostics as Record<string, any> | null,
    });

    if (auditResult.failed) {
      (body.diagnostics as Record<string, unknown>).auditWriteFailed = true;
      (body.diagnostics as Record<string, unknown>).auditWriteFailureReason =
        auditResult.reason;
    } else {
      (body.diagnostics as Record<string, unknown>).auditWriteFailed = false;
      (body.diagnostics as Record<string, unknown>).auditRunId = runId;
    }

    await writePollProof("executor/night-plan", {
      route: "executor/night-plan",
      run_id: runId,
      planned_count: plan.planned_live_slots,
      tier1_event_slots: plan.tier1_event_slots,
      effective_bankroll_usd: plan.diagnostics.effective_bankroll_usd,
      generated_at: new Date().toISOString(),
    });

    // debug=1 adds sample source rows (safe fields only, no secrets) and full rejected reasons.
    if (debug && rawDiagnostics) {
      (body.diagnostics as Record<string, unknown>).sample_source_rows =
        rawDiagnostics.sample_source_rows;
    }
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
