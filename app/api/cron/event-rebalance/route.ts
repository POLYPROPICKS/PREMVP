import { NextRequest, NextResponse } from "next/server";
import { runEventRebalance, persistRebalanceDiagnostics } from "@/lib/executor/eventExecutionQueue";

// Contur3 per-event rebalance cron (run every 5-10 minutes).
//   GET/POST /api/cron/event-rebalance          → select one market per due reserved event,
//                                                  write READY rows to event_execution_queue.
//   ?dryRun=1                                    → compute outcomes without writing.
//
// Auth: same x-executor-secret pattern as /api/executor/*. NO live orders, NO Ireland calls.

export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dryRun") === "1";

  try {
    const result = await runEventRebalance(Date.now(), { write: !dryRun });
    const diagResult = await persistRebalanceDiagnostics(result, {
      context: "event-rebalance-cron",
    });
    return NextResponse.json(
      {
        ok: true,
        dry_run: dryRun,
        rebalance_diagnostics_version: "blocked-candidates-v2",
        rebalance_run_id: result.rebalance_run_id,
        due_count: result.due_count,
        queued_count: result.queued_count,
        skipped_count: result.skipped_count,
        already_queued_count: result.already_queued_count,
        expired_count: result.expired_count,
        diagnostic_report_path: diagResult.path,
        next_due_iso: result.next_due_reservations[0]?.rebalance_starts_iso ?? null,
        next_check_after_seconds: result.next_check_after_seconds,
        next_due_reservations: result.next_due_reservations,
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
      { status: 200, headers: { "Cache-Control": "no-store" } }
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
