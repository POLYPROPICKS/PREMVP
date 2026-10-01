import { casWriteQueue } from "@/lib/executor/queueAttemptsCas";
import { getActiveContour } from "@/lib/constructor/devLive";
import { createSupabaseQueueCasPort } from "@/lib/executor/makerFallbackSupabasePort";
import { NextRequest, NextResponse } from "next/server";
import {
  runEventRebalanceWithEvidence,
  persistRebalanceDiagnostics,
  runControlledLiveIntent,
} from "@/lib/executor/eventExecutionQueue";
import { isEmergencyQuiesceActive, buildEmergencyQuiesceResult } from "@/lib/ops/emergencyQuiesce";
import { reconcileStaleClaims, type StaleClaimRow } from "@/lib/executor/staleQueueClaims";
import { supabaseAdmin } from "@/lib/supabase/server";
import { reconcileExecutionLifecycle } from "@/lib/executor/executionLifecycle";

// Contur3 per-event rebalance cron (run every 5-10 minutes).
//   GET/POST /api/cron/event-rebalance          → select one market per due reserved event,
//                                                  write READY rows to event_execution_queue.
//   ?dryRun=1                                    → compute outcomes without writing.
//   ?maxQueueWrites=N (1-5)                      → default canonical branch ONLY (Phase 1 safety
//                                                  cap). Fails closed with zero queue writes when
//                                                  the planned queue-row count exceeds N. Never
//                                                  applies to founderBattleBatch or
//                                                  controlledLiveIntent -- those are separate
//                                                  branches entirely and ignore this param.
//   ?canary=CEO_APPROVED&targetReservationId=...  → identity-targeted rebalance: process exactly
//                                                  one due Reservation via the SAME
//                                                  runEventRebalanceWithEvidence entrypoint and
//                                                  final Contract A / exact-market selection as the
//                                                  normal path below. maxQueueWrites is always
//                                                  forced to 1. Fails closed (CANARY_RESERVATION_NOT_FOUND)
//                                                  when the id is unknown or not yet due.
//
// Auth: same x-executor-secret pattern as /api/executor/*. NO live orders, NO Ireland calls.

export const dynamic = "force-dynamic";

const MAX_QUEUE_WRITES_MIN = 1;
const MAX_QUEUE_WRITES_MAX = 5;

/** Parses ?maxQueueWrites -- absent is valid (null, no cap). Present must be an integer in [1,5]. */
function parseMaxQueueWrites(raw: string | null): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (!/^-?\d+$/.test(raw.trim())) {
    return { ok: false, error: `INVALID_MAX_QUEUE_WRITES: must be an integer between ${MAX_QUEUE_WRITES_MIN} and ${MAX_QUEUE_WRITES_MAX}, got "${raw}"` };
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MAX_QUEUE_WRITES_MIN || n > MAX_QUEUE_WRITES_MAX) {
    return { ok: false, error: `INVALID_MAX_QUEUE_WRITES: must be an integer between ${MAX_QUEUE_WRITES_MIN} and ${MAX_QUEUE_WRITES_MAX}, got "${raw}"` };
  }
  return { ok: true, value: n };
}

async function handle(request: NextRequest) {
  // EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1: the very first thing this
  // route does, before auth, before any Supabase client call. A deterministic
  // 200 so the scheduler never sees a failure to retry.
  if (isEmergencyQuiesceActive("cron/event-rebalance")) {
    return NextResponse.json(buildEmergencyQuiesceResult("cron/event-rebalance"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = getActiveContour().resolveEnv("executorCandidatesSecret");
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dryRun") === "1";
  const controlledLiveIntent = searchParams.get("controlledLiveIntent");
  const founderBattleBatch = searchParams.get("founderBattleBatch") === "1";
  const canary = searchParams.get("canary");
  const targetReservationId = searchParams.get("targetReservationId");

  // The pre-manifest founder batch selected new candidates from historical GSP.
  // It is deliberately unavailable: live rebalance may only consume a persisted
  // Reservation manifest or Queue authority and must never rediscover a market.
  if (founderBattleBatch) {
    return NextResponse.json(
      { ok: false, mode: "founder_battle_batch", error: "LEGACY_GSP_BATCH_REMOVED" },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Canary identity-targeted rebalance: process exactly one Reservation, via
  // the SAME production runEventRebalanceWithEvidence entrypoint and the same
  // final Contract A / exact-market selection as the normal scheduled path
  // below -- only the due-reservation set fed into it is narrowed to one row.
  // maxQueueWrites is always forced to 1 here regardless of the request param.
  if (targetReservationId !== null) {
    if (canary !== "CEO_APPROVED") {
      return NextResponse.json(
        {
          ok: false,
          canary_mode: true,
          target_reservation_id: targetReservationId,
          first_failure_code: "CANARY_TARGET_REJECTED_NO_AUTH",
          error: "targetReservationId requires canary=CEO_APPROVED",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    try {
      const result = await runEventRebalanceWithEvidence(Date.now(), {
        write: !dryRun,
        maxQueueWrites: 1,
        targetReservationId,
      }, { contour: getActiveContour() });
      const first_failure_code = !result.target_reservation_matched
        ? "CANARY_RESERVATION_NOT_FOUND"
        : result.first_rejection_code === "BLOCKED_BY_MAX_QUEUE_WRITES"
          ? "CANARY_FINAL_MARKET_NOT_READY"
          : result.skipped_count > 0
            ? "CANARY_FINAL_MARKET_NOT_READY"
            : null;
      return NextResponse.json(
        {
          ok: result.target_reservation_matched && result.queued_count <= 1,
          canary_mode: true,
          dry_run: dryRun,
          target_reservation_id: targetReservationId,
          target_reservation_matched: result.target_reservation_matched,
          queue_writes_attempted: result.due_count,
          queue_writes_created: result.queued_count,
          rebalance_run_id: result.rebalance_run_id,
          due_count: result.due_count,
          skipped_count: result.skipped_count,
          outcomes: result.outcomes,
          first_failure_code,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[cron/event-rebalance] canary error:", msg);
      return NextResponse.json(
        { ok: false, canary_mode: true, target_reservation_id: targetReservationId, error: msg },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  // Controlled one-shot live-intent mode: an entirely separate, narrower
  // branch from the normal scheduled rebalance below. It never touches
  // runEventRebalanceWithEvidence or job_runs evidence, and it rejects any
  // value other than the one pre-authorized fixed test id.
  if (controlledLiveIntent !== null) {
    try {
      const result = await runControlledLiveIntent(Date.now(), controlledLiveIntent, { write: !dryRun });
      const status = result.kind === "BLOCKED_INVALID_REQUEST" ? 400 : 200;
      return NextResponse.json(
        {
          ok: result.kind === "CREATED" || result.kind === "ALREADY_EXISTS",
          mode: "controlled_live_intent",
          dry_run: dryRun,
          kind: result.kind,
          reason: result.reason,
          wrote: result.wrote,
          matching_row_count: result.matching_row_count ?? null,
          queue_row: result.queue_row ?? null,
        },
        { status, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[cron/event-rebalance] controlled_live_intent error:", msg);
      return NextResponse.json(
        { ok: false, mode: "controlled_live_intent", error: msg },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const maxQueueWritesParsed = parseMaxQueueWrites(searchParams.get("maxQueueWrites"));
  if (!maxQueueWritesParsed.ok) {
    return NextResponse.json(
      { ok: false, error: maxQueueWritesParsed.error },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const nowIso = new Date().toISOString();
    const staleClaims = await reconcileStaleClaims({
      async loadExpiredClaims(deadline, limit) {
        const { data, error } = await supabaseAdmin.from("event_execution_queue")
          .select("id,status,latest_entry_iso,idempotency_key,condition_id,token_id,side,diagnostics")
          .eq("status", "CLAIMED").lte("latest_entry_iso", deadline)
          .order("latest_entry_iso", { ascending: false }).limit(limit);
        if (error) throw new Error(`STALE_CLAIM_READ_FAILED: ${error.message}`);
        return (data ?? []) as StaleClaimRow[];
      },
      async hasMatchingOrderEvent(row) {
        const { data, error } = await supabaseAdmin.from("executor_order_events")
          .select("id,condition_id,token_id,side,selected_side")
          .eq("idempotency_key", row.idempotency_key!).limit(2);
        if (error) throw new Error(`STALE_CLAIM_ORDER_READ_FAILED: ${error.message}`);
        if ((data ?? []).length > 1) throw new Error("STALE_CLAIM_AMBIGUOUS_ORDER_EVENTS");
        const event = data?.[0];
        if (!event) return false;
        if (event.condition_id !== row.condition_id || event.token_id !== row.token_id ||
            (event.side ?? event.selected_side) !== row.side) throw new Error("STALE_CLAIM_ORDER_IDENTITY_CONFLICT");
        return true;
      },
      async expireClaim(row, _deadline, diagnostics) {
        // Fresh-read + CAS: a CLAIMED row may already carry execution_attempts_v1 (e.g. a proven-zero
        // taker result with an authorized maker command); the expiry must never erase it.
        const res = await casWriteQueue(createSupabaseQueueCasPort(), String(row.id), (fresh) =>
          fresh.status !== "CLAIMED"
            ? null
            : { status: "EXPIRED", diagnostics, extra: { selection_reason: "CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT" } },
        );
        return res.written;
      },
    }, nowIso, !dryRun);
    const result = await runEventRebalanceWithEvidence(Date.now(), {
      write: !dryRun,
      maxQueueWrites: maxQueueWritesParsed.value,
    }, { contour: getActiveContour() });
    const diagResult = await persistRebalanceDiagnostics(result, {
      context: "event-rebalance-cron",
    });
    let executionLifecycle: Awaited<ReturnType<typeof reconcileExecutionLifecycle>> | { error: string };
    try {
      executionLifecycle = await reconcileExecutionLifecycle(supabaseAdmin, { writeMode: !dryRun, limit: 20 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_LIFECYCLE_ERROR";
      console.error("[cron/event-rebalance] lifecycle error:", message);
      executionLifecycle = { error: message };
    }
    return NextResponse.json(
      {
        ok: !result.blocked_by_max_queue_writes,
        dry_run: dryRun,
        stale_claims: staleClaims,
        execution_lifecycle: executionLifecycle,
        rebalance_diagnostics_version: "blocked-candidates-v2",
        rebalance_run_id: result.rebalance_run_id,
        active_reservations_count: result.active_reservations_count,
        due_count: result.due_count,
        queued_count: result.queued_count,
        skipped_count: result.skipped_count,
        already_queued_count: result.already_queued_count,
        expired_count: result.expired_count,
        future_valid_reservations_count: result.future_valid_reservations_count,
        // Hard failure surface: due reservations existed but none reached the queue.
        fail_due_reservations_not_queued: result.fail_due_reservations_not_queued,
        // Phase 1 canonical safety cap surface.
        max_queue_writes: result.max_queue_writes,
        planned_queue_writes: result.planned_queue_writes,
        blocked_by_max_queue_writes: result.blocked_by_max_queue_writes,
        diagnostic_report_path: diagResult.path,
        next_due_iso: result.next_due_reservations[0]?.rebalance_starts_iso ?? null,
        next_check_after_seconds: result.next_check_after_seconds,
        next_due_reservations: result.next_due_reservations,
        // Per-active-reservation reason table so due_count=0 always explains itself.
        reservation_classification: result.reservation_classification,
        outcomes: result.outcomes.map((o) => ({
          match_family_key: o.match_family_key,
          result: o.result,
          reason: o.reason,
          market_slug: o.queue_row?.market_slug ?? null,
          side: o.queue_row?.side ?? null,
          stake_usd: o.queue_row?.stake_usd ?? null,
          preferred_entry_iso: o.queue_row?.preferred_entry_iso ?? null,
          latest_entry_iso: o.queue_row?.latest_entry_iso ?? null,
          ...(o.blocked_candidates !== undefined
            ? {
                diagnostics_version: "blocked-candidates-v2",
                blocked_candidates: o.blocked_candidates,
              }
            : {}),
        })),
        founder_action_required: false,
        ireland_autostart_expected: result.queued_count > 0 || result.already_queued_count > 0,
      },
      {
        // Write-mode blocked-by-cap is a real failure to write what was
        // requested -- non-2xx, distinct from a dry-run preview of the same
        // condition (which stays 200: it never attempted a write at all).
        status: result.blocked_by_max_queue_writes && !dryRun ? 409 : 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[cron/event-rebalance] Error:", msg);
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
