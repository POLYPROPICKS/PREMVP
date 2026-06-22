import { NextRequest, NextResponse } from "next/server";
import {
  buildReservationPlan,
  persistReservationPlan,
} from "@/lib/executor/nightEventReservations";

// Contur3 17:00 Minsk event-first reservation cron.
//   GET/POST /api/cron/night-event-reservations        → freeze tonight's reserved events.
//   ?force=1                                            → rewrite an existing frozen plan.
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
  const force = searchParams.get("force") === "1";

  try {
    const plan = await buildReservationPlan(Date.now());
    const result = await persistReservationPlan(plan, { force });

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
        by_sport: plan.diagnostics.by_sport,
        by_tier: plan.diagnostics.by_tier,
        diagnostics: plan.diagnostics,
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
