import { NextRequest, NextResponse } from "next/server";
import {
  runEventRebalanceWithEvidence,
  persistRebalanceDiagnostics,
  runControlledLiveIntent,
  runFounderBattleBatch,
} from "@/lib/executor/eventExecutionQueue";

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
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dryRun") === "1";
  const controlledLiveIntent = searchParams.get("controlledLiveIntent");
  const founderBattleBatch = searchParams.get("founderBattleBatch") === "1";

  // Founder battle batch mode: an entirely separate, narrower branch that
  // reads generated_signal_pairs directly and creates 2-4 fresh READY rows.
  // Requires BOTH this explicit request param AND the FOUNDER_BATTLE_BATCH_MODE
  // env gate -- fails closed otherwise. Never touches Ireland executor code,
  // never invokes runEventRebalanceWithEvidence/job_runs evidence.
  if (founderBattleBatch) {
    try {
      const result = await runFounderBattleBatch(Date.now(), process.env, { write: !dryRun });
      const status = result.kind === "BLOCKED_GATE_DISABLED" ? 403 : 200;
      return NextResponse.json(
        {
          ok: result.kind === "CREATED",
          mode: "founder_battle_batch",
          dry_run: dryRun,
          kind: result.kind,
          reason: result.reason,
          wrote_count: result.wrote_count,
          skipped_count: result.skipped_count,
          created_rows: result.created_rows,
          skipped_reasons: result.skipped_reasons,
        },
        { status, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[cron/event-rebalance] founder_battle_batch error:", msg);
      return NextResponse.json(
        { ok: false, mode: "founder_battle_batch", error: msg },
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
    const result = await runEventRebalanceWithEvidence(Date.now(), {
      write: !dryRun,
      maxQueueWrites: maxQueueWritesParsed.value,
    });
    const diagResult = await persistRebalanceDiagnostics(result, {
      context: "event-rebalance-cron",
    });
    return NextResponse.json(
      {
        ok: !result.blocked_by_max_queue_writes,
        dry_run: dryRun,
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
