import { NextRequest, NextResponse } from "next/server";
import {
  persistReservationPlanDiagnostics,
  loadPlanStatus,
  executeForceRebuild,
  runReservationCronWithEvidence,
  buildReservationPlan,
  buildCanaryPreview,
  persistReservationPlan,
  loadReservations,
} from "@/lib/executor/nightEventReservations";
import {
  buildPlanRunId,
  resolveNightWindow,
  isInReservationCreationWindow,
} from "@/lib/executor/nightWindow";

// Contur3 17:00 Minsk event-first reservation cron.
//   GET/POST /api/cron/night-event-reservations          → create/return tonight's reserved events.
//   ?mode=status                                          → read-only status, never writes.
//   ?dryRun=1                                            → alias for mode=status.
//   ?forceRebuild=CEO_APPROVED                           → delete queue+reservations, rebuild.
//   ?forceCreate=CEO_APPROVED                            → bypass daytime creation window guard.
//   ?force=1                                             → rewrite an existing frozen plan (legacy).
//   ?canary=CEO_APPROVED&mode=canaryPreview              → read-only, zero writes: bounded preview
//                                                            of selectable physical-event groups.
//   ?canary=CEO_APPROVED&targetPhysicalEventKeyHash=...  → create exactly one Reservation for the
//                                                            one physical-event group matching that
//                                                            exact hash. Fail-closed (zero writes) on
//                                                            no match, ambiguous match, or a plan that
//                                                            already has rows. Uses the existing
//                                                            write seam (not forceRebuild).
//
// Creation window guard: writes are blocked 08:00–16:30 Minsk to prevent accidental
// stale-plan creation from morning cron misfires. Use forceCreate=CEO_APPROVED to override.
//
// Auth: same x-executor-secret pattern as /api/executor/*. Event-level only — this NEVER
// writes the execution queue and NEVER places orders. Per-event market selection happens
// later via /api/cron/event-rebalance.

export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const dryRun = searchParams.get("dryRun") === "1";
  const forceRebuild = searchParams.get("forceRebuild") === "CEO_APPROVED";
  const forceCreate = searchParams.get("forceCreate") === "CEO_APPROVED";
  const force = searchParams.get("force") === "1";
  const canary = searchParams.get("canary");
  const canaryAuthorized = canary === "CEO_APPROVED";
  const targetPhysicalEventKeyHash = searchParams.get("targetPhysicalEventKeyHash");
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    // ── canary=CEO_APPROVED&mode=canaryPreview: read-only, zero writes ───────
    if (mode === "canaryPreview") {
      if (!canaryAuthorized) {
        return NextResponse.json(
          {
            ok: false,
            canary_mode: true,
            first_failure_code: "CANARY_TARGET_REJECTED_NO_AUTH",
            error: "mode=canaryPreview requires canary=CEO_APPROVED",
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const plan = await buildReservationPlan(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1" });
      const preview_groups = buildCanaryPreview(plan, nowMs);
      return NextResponse.json(
        {
          ok: true,
          canary_mode: true,
          read_only: true,
          preview_groups,
          generated_at_iso: nowIso,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── canary=CEO_APPROVED&targetPhysicalEventKeyHash=...: exact single-event
    //    reservation creation via the existing write seam ────────────────────
    if (targetPhysicalEventKeyHash) {
      if (!canaryAuthorized) {
        return NextResponse.json(
          {
            ok: false,
            canary_mode: true,
            target_event_hash: targetPhysicalEventKeyHash,
            first_failure_code: "CANARY_TARGET_REJECTED_NO_AUTH",
            error: "targetPhysicalEventKeyHash requires canary=CEO_APPROVED",
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const plan = await buildReservationPlan(nowMs, {
        selectorMode: "CONTRACT_A_PLANNING_V1",
        targetPhysicalEventKeyHash,
      });
      const matched_event_groups = plan.diagnostics.canary_target_matched_group_count;
      if (matched_event_groups === 0) {
        return NextResponse.json(
          {
            ok: false,
            canary_mode: true,
            target_event_hash: targetPhysicalEventKeyHash,
            matched_event_groups,
            reservations_created: 0,
            first_failure_code: "CANARY_TARGET_NOT_FOUND",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }
      if (matched_event_groups > 1) {
        return NextResponse.json(
          {
            ok: false,
            canary_mode: true,
            target_event_hash: targetPhysicalEventKeyHash,
            matched_event_groups,
            reservations_created: 0,
            first_failure_code: "CANARY_TARGET_AMBIGUOUS",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }
      const persisted = await persistReservationPlan(plan, { force: false });
      if (persisted.already_exists) {
        return NextResponse.json(
          {
            ok: false,
            canary_mode: true,
            target_event_hash: targetPhysicalEventKeyHash,
            matched_event_groups,
            reservations_created: 0,
            first_failure_code: "CANARY_PLAN_NOT_EMPTY",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }
      const rows = await loadReservations(plan.plan_run_id);
      const createdRow = rows.find((r) => r.match_family_key === plan.diagnostics.canary_target_group_key);
      return NextResponse.json(
        {
          ok: true,
          canary_mode: true,
          target_event_hash: targetPhysicalEventKeyHash,
          matched_event_groups,
          reservations_created: persisted.written_count,
          target_reservation_id: createdRow?.id ?? null,
          plan_run_id: plan.plan_run_id,
          first_failure_code: null,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── mode=status or dryRun=1: read-only, never writes ─────────────────────
    if (mode === "status" || dryRun) {
      const planRunId = buildPlanRunId(nowMs);
      const window = resolveNightWindow(nowMs);
      const planHealth = await loadPlanStatus(planRunId, nowMs);
      return NextResponse.json(
        {
          ok: true,
          mode: "status",
          read_only: true,
          plan_run_id: planRunId,
          plan_date_minsk: window.planDateMinsk,
          window_start_iso: window.startIso,
          window_end_iso: window.endIso,
          horizon_end_iso: window.horizonEndIso,
          plan_health: planHealth,
          in_creation_window: isInReservationCreationWindow(nowMs),
          generated_at_iso: nowIso,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── forceRebuild=CEO_APPROVED: delete queue + reservations + rebuild ──────
    // (unless the replacement plan is empty, in which case nothing is deleted --
    // see executeForceRebuild's ABORTED_NO_REPLACEMENT path.)
    if (forceRebuild) {
      const result = await executeForceRebuild(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1" });
      const diagResult = await persistReservationPlanDiagnostics(result.plan, {
        context: "force-rebuild",
      });
      const aborted = result.result === "ABORTED_NO_REPLACEMENT";
      return NextResponse.json(
        {
          ok: true,
          force_rebuild: true,
          result: result.result,
          plan_run_id: result.plan_run_id,
          deleted_queue_count: result.deleted_queue_count,
          deleted_reservation_count: result.deleted_reservation_count,
          written_count: result.persist.written_count,
          reserved_count: result.persist.reserved_count,
          plan_health: result.plan_health,
          bad_market_level_count: result.plan.diagnostics.market_level_keys_skipped,
          by_sport: result.plan.diagnostics.by_sport,
          by_tier: result.plan.diagnostics.by_tier,
          diagnostics: result.plan.diagnostics,
          diagnostic_report_path: diagResult.path,
          founder_action_required: false,
          note: aborted
            ? "Force rebuild ABORTED: replacement plan was empty. No existing queue/reservation rows were deleted."
            : "Force rebuild complete. event_execution_queue rows for this plan_run_id were deleted and reservations rebuilt.",
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── Creation window guard: block daytime writes (08:00–16:30 Minsk) ───────
    const inWindow = isInReservationCreationWindow(nowMs);
    if (!inWindow && !force && !forceCreate) {
      const planRunId = buildPlanRunId(nowMs);
      const window = resolveNightWindow(nowMs);
      const planHealth = await loadPlanStatus(planRunId, nowMs);
      return NextResponse.json(
        {
          ok: true,
          write_skipped: true,
          write_skip_reason: "OUTSIDE_CREATION_WINDOW_08_TO_1630_MINSK",
          allowed_creation_window: "16:30–08:00 Minsk (evening/night)",
          plan_run_id: planRunId,
          plan_date_minsk: window.planDateMinsk,
          window_start_iso: window.startIso,
          window_end_iso: window.endIso,
          plan_health: planHealth,
          in_creation_window: false,
          generated_at_iso: nowIso,
          hint: "Cron fires at 17:00 Minsk. Override with ?forceCreate=CEO_APPROVED.",
          founder_action_required: false,
          ireland_autostart_expected: false,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── Standard create / idempotent path (records job_runs evidence) ──────────
    const { plan, persisted: result } = await runReservationCronWithEvidence(nowMs, {
      force: force || forceCreate,
      selectorMode: "CONTRACT_A_PLANNING_V1",
    });

    // Persist diagnostics (non-fatal if it fails).
    const diagResult = await persistReservationPlanDiagnostics(plan, {
      context: "night-event-reservations-cron",
    });

    // Derive per-status counts from returned rows (DB-backed when already_exists=true).
    const statusBuckets: Record<string, number> = {};
    for (const r of result.reservations) {
      statusBuckets[r.status] = (statusBuckets[r.status] ?? 0) + 1;
    }
    const queued_count = statusBuckets["QUEUED"] ?? 0;
    const skipped_count = (statusBuckets["SKIPPED"] ?? 0) + (statusBuckets["CANCELLED"] ?? 0);
    const expired_count = statusBuckets["EXPIRED"] ?? 0;

    // Compute plan_health from DB (always reflects actual current state).
    const planHealth = await loadPlanStatus(result.plan_run_id, nowMs);

    return NextResponse.json(
      {
        ok: true,
        plan_run_id: result.plan_run_id,
        plan_date_minsk: plan.plan_date_minsk,
        window_start_iso: plan.window.startIso,
        window_end_iso: plan.window.endIso,
        horizon_end_iso: plan.window.horizonEndIso,
        already_exists: result.already_exists,
        written_count: result.written_count,
        reserved_count: result.reserved_count,
        queued_count,
        skipped_count,
        expired_count,
        bad_market_level_count: plan.diagnostics.market_level_keys_skipped,
        plan_health: planHealth,
        by_sport: plan.diagnostics.by_sport,
        by_tier: plan.diagnostics.by_tier,
        diagnostics: plan.diagnostics,
        diagnostic_report_path: diagResult.path,
        reserved_events: result.reservations.map((r) => ({
          rank: r.reservation_rank,
          tier: r.event_tier,
          event_title: r.event_title,
          event_slug: r.event_slug,
          sport: r.sport,
          strategic_scope: r.strategic_scope,
          game_start_iso: r.game_start_iso,
          score: r.event_score,
          status: r.status,
        })),
        in_creation_window: inWindow,
        founder_action_required: false,
        ireland_autostart_expected: true,
        note: "Event-level reservation only. Market selection occurs at T-60/T-30 rebalance.",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[cron/night-event-reservations] Error:", msg);
    return NextResponse.json(
      { ok: false, error: msg, founder_action_required: false },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
