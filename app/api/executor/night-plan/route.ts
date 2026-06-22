import { NextRequest, NextResponse } from "next/server";
import { buildFireModelCandidates } from "@/lib/executor/buildFireModelCandidates";
import {
  buildNightPortfolioPlan,
  nightPlanControlSemantics,
  IRELAND_RUNTIME_CONTRACT,
  IRELAND_RECOMMENDED_RUNTIME_SECONDS,
  TARGET_MIN_BETS_DEFAULT,
  TARGET_MAX_BETS_DEFAULT,
  LIVE_FALLBACK_POLICY,
} from "@/lib/executor/nightPortfolioPlanner";

// Read-only planning route. Returns the Night Portfolio Plan for the active
// 18:00–07:00 Europe/Minsk window. NO order placement, NO DB writes.
// Auth mirrors /api/executor/candidates (x-executor-secret).

// Wide pool so event-dedupe + Tier classification does not starve unique events.
const PLAN_POOL = 200;
type AuditCandidate = Record<string, any>;

const CONTRACT_SCHEMA_VERSION = "executor-night-plan-v1";
const PILOT_EXECUTION_MODE = "ONE_ORDER_PILOT_REVIEW";
const BATTLE_EXECUTION_MODE = "NIGHT_LIVE_EXECUTION";
const PILOT_MAX_LIVE_ORDERS = 1;
const PILOT_MAX_CANDIDATE_COUNT = 1;
const PILOT_MAX_STAKE_USD = 5;
const PILOT_PER_TOKEN_SIDE_CAP_USD = 10;
const CONTRACT_VALIDITY_MINUTES = 15;
const ENTRY_WINDOW_POLICY_VERSION = "night-plan-entry-window-v1";
const STAKE_POLICY_VERSION = "P0D_PUBLISHED_1PF_TIER1_EXECUTABLE_V1+P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1+P0E_BLOCK_HALFTIME_MARKETS_V1";
// P0E_BLOCK_HALFTIME_MARKETS_V1: matches halftime/first-half markets by slug/family/key fields.
const HALFTIME_MARKET_RE = /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

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
    fallback_policy: candidate.fallback_policy,
    fallback_selected_tier: candidate.fallback_selected_tier,
    trace_id: candidate.trace_id,
    strategic_scope: candidate.strategic_scope,
    sport: candidate.sport,
    match_family_key: candidate.match_family_key,
  };
}

function toIsoMinutesFromNow(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function buildStrategyRunId(planVersion: string, windowStartIso: string, windowEndIso: string): string {
  return `executor-night-plan-v1:${planVersion}:${windowStartIso}:${windowEndIso}`;
}

function buildCandidateId(strategyRunId: string, candidate: {
  condition_id?: unknown;
  token_id?: unknown;
  side?: unknown;
  event_slug?: unknown;
  match_family_key?: unknown;
}): string {
  const eventKey =
    typeof candidate.event_slug === "string" && candidate.event_slug.trim()
      ? candidate.event_slug.trim()
      : typeof candidate.match_family_key === "string" && candidate.match_family_key.trim()
        ? candidate.match_family_key.trim()
        : "no_event";
  return [
    strategyRunId,
    typeof candidate.condition_id === "string" && candidate.condition_id.trim() ? candidate.condition_id.trim() : "no_condition",
    typeof candidate.token_id === "string" && candidate.token_id.trim() ? candidate.token_id.trim() : "no_token",
    typeof candidate.side === "string" && candidate.side.trim() ? candidate.side.trim() : "no_side",
    eventKey,
  ].join(":");
}

function toRejectedSummary(
  reasons: Record<string, number> | undefined,
  fallback: Record<string, number>
) {
  const merged = new Map<string, number>();
  for (const [reason, count] of Object.entries(reasons ?? {})) {
    merged.set(reason, (merged.get(reason) ?? 0) + count);
  }
  for (const [reason, count] of Object.entries(fallback)) {
    merged.set(reason, (merged.get(reason) ?? 0) + count);
  }
  return [...merged.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
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
          fallback_policy: LIVE_FALLBACK_POLICY,
          tier1_selected_count: opts.plan.diagnostics.tier1_selected_count ?? null,
          tier2_fallback_selected_count: opts.plan.diagnostics.tier2_fallback_selected_count ?? null,
          tier3_fallback_selected_count: opts.plan.diagnostics.tier3_fallback_selected_count ?? null,
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
  const requestedTargetMax =
    Number.isFinite(rawMax) && rawMax >= targetMin ? rawMax : TARGET_MAX_BETS_DEFAULT;
  const targetMax = Math.min(requestedTargetMax, TARGET_MAX_BETS_DEFAULT);
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
    const generatedAtIso = plan.planned_at_iso;
    const executionMode =
      plan.target_max_bets <= 1 ? PILOT_EXECUTION_MODE : BATTLE_EXECUTION_MODE;
    const maxLiveOrders = Math.max(1, plan.planned_live_slots);
    const maxCandidateCount = Math.max(1, plan.planned_slots.length);
    const maxStakeUsd = Math.max(
      ...plan.planned_slots.map((slot) => slot.planned_stake_usd),
      PILOT_MAX_STAKE_USD
    );
    const perTokenSideCapUsd = Math.max(maxStakeUsd, PILOT_PER_TOKEN_SIDE_CAP_USD);
    const strategyRunId = buildStrategyRunId(plan.plan_version, plan.window_start_iso, plan.window_end_iso);
    const validUntilSourceIso = plan.planned_slots.reduce<string | null>((acc, slot) => {
      if (!slot.latest_entry_iso) return acc;
      if (!acc) return slot.latest_entry_iso;
      return new Date(slot.latest_entry_iso).getTime() < new Date(acc).getTime() ? slot.latest_entry_iso : acc;
    }, null);
    const validUntilIso = validUntilSourceIso
      ? new Date(Math.min(Date.parse(validUntilSourceIso), Date.parse(toIsoMinutesFromNow(new Date(generatedAtIso), CONTRACT_VALIDITY_MINUTES)))).toISOString()
      : toIsoMinutesFromNow(new Date(generatedAtIso), CONTRACT_VALIDITY_MINUTES);
    const rejectedCandidatesSummary = toRejectedSummary(
      plan.top_rejected_reasons,
      plan.planned_slots.reduce<Record<string, number>>((acc, slot) => {
        for (const reason of slot.no_go_reasons) {
          acc[reason] = (acc[reason] ?? 0) + 1;
        }
        return acc;
      }, {})
    );
    const candidateProjections = plan.planned_slots.map((slot, index) => {
      const selected = slot.selected_candidate_preview;
      const conditionId = selected.condition_id;
      const tokenId = selected.token_id;
      const side = selected.side;
      const preferredEntryIso = slot.preferred_entry_iso;
      const latestEntryIso = slot.latest_entry_iso;
      const stakeAboveCap = slot.planned_stake_usd > maxStakeUsd;
      // P0D_PUBLISHED_1PF_TIER1_EXECUTABLE_V1: only Tier1 in NIGHT_LIVE_EXECUTION candidates.
      // P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1: max base stake $7.
      // P0E_BLOCK_HALFTIME_MARKETS_V1: halftime/first-half markets never executable.
      const isHalftimeMarket = HALFTIME_MARKET_RE.test(selected.market_slug ?? "") ||
        HALFTIME_MARKET_RE.test(selected.event_slug ?? "") ||
        HALFTIME_MARKET_RE.test(selected.match_family_key ?? "");
      const executable =
        Boolean(conditionId) &&
        Boolean(tokenId) &&
        Boolean(side) &&
        typeof slot.planned_stake_usd === "number" &&
        slot.planned_stake_usd > 0 &&
        !stakeAboveCap &&
        selected.live_eligible === true &&
        slot.tier === "TIER1" &&
        !isHalftimeMarket;
      const blockReason = executable
        ? null
        : isHalftimeMarket
          ? "HALFTIME_MARKET_EXCLUDED_FROM_LIVE"
          : !conditionId
            ? "MISSING_CONDITION_ID"
            : !tokenId
              ? "MISSING_TOKEN_ID"
              : !side
                ? "MISSING_SIDE"
                : !preferredEntryIso
                  ? "MISSING_PREFERRED_ENTRY_ISO"
                  : !latestEntryIso
                    ? "MISSING_LATEST_ENTRY_ISO"
                    : slot.planned_stake_usd <= 0
                        ? "INVALID_STAKE_USD"
                        : stakeAboveCap
                          ? "STAKE_ABOVE_MAX_STAKE_USD"
                          : slot.tier === "TIER2"
                            ? "TIER2_SHADOW_FOR_PUBLISHED_1PF"
                            : slot.tier === "TIER3"
                              ? "TIER3_EXCLUDED_FROM_LIVE"
                              : "NOT_EXECUTABLE";
      return {
        candidate_id: buildCandidateId(strategyRunId, selected),
        order_key: `${conditionId || "no_condition"}:${tokenId || "no_token"}:${side || "no_side"}`,
        strategy_run_id: strategyRunId,
        event_slug: selected.event_slug ?? slot.event_slug ?? null,
        event_id: selected.event_slug ?? slot.event_slug ?? null,
        condition_id: conditionId ?? null,
        token_id: tokenId ?? null,
        side: side ?? null,
        event_title: slot.event_title,
        preferred_entry_iso: preferredEntryIso,
        latest_entry_iso: latestEntryIso,
        stake_usd: slot.planned_stake_usd,
        max_stake_usd: maxStakeUsd,
        valid_until_iso: validUntilIso,
        execution_mode: executionMode,
        api_schema_version: CONTRACT_SCHEMA_VERSION,
        max_entry_price: selected.max_entry_price,
        selection_rank_for_event: index + 1,
        is_executable: executable,
        block_reason: blockReason,
      };
    });
    const candidates = candidateProjections.filter((candidate) => candidate.is_executable === true);

    const body: Record<string, unknown> = {
      ok: true,
      api_schema_version: CONTRACT_SCHEMA_VERSION,
      strategy_run_id: strategyRunId,
      generated_at_iso: generatedAtIso,
      valid_until_iso: validUntilIso,
      execution_mode: executionMode,
      max_live_orders: maxLiveOrders,
      max_candidate_count: maxCandidateCount,
      max_stake_usd: maxStakeUsd,
      per_token_side_cap_usd: perTokenSideCapUsd,
      one_position_per_event: true,
      entry_window_policy_version: ENTRY_WINDOW_POLICY_VERSION,
      stake_policy_version: STAKE_POLICY_VERSION,
      candidates,
      rejected_candidates_summary: rejectedCandidatesSummary,
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
      tier3_fallback_slots: plan.tier3_fallback_slots,
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
