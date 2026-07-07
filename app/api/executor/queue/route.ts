import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  QUEUE_SCHEMA_VERSION,
  QUEUE_EXECUTION_MODE,
  QUEUE_SOURCE,
  mapQueueRowToIrelandCandidate,
  type EventExecutionQueueRow,
} from "@/lib/executor/executorQueueTypes";
import { REBALANCE_MINUTES_BEFORE_START } from "@/lib/executor/nightWindow";

// Contur3 queue-only executor endpoint — the ONLY executable source for Ireland.
//   GET /api/executor/queue
//
// Returns event_execution_queue rows (status=READY, latest_entry_iso>now), deterministically
// ordered by preferred_entry_iso asc, then queued_at asc. It does NOT rank by strategy, does
// NOT call buildFireModelCandidates, does NOT rebalance, and never returns Tier2/Tier3/halftime
// (those can never enter the queue upstream). Ireland mechanically consumes this list.
//
// Stake/price source of truth: each candidate's stake_usd/max_stake_usd and
// max_entry_price/price_cap come straight from the queue row (computed by
// buildFireModelCandidates), never from a hardcoded constant.

export const dynamic = "force-dynamic";

const DEFAULT_CAP = 15;

function envCap(): number {
  const raw = parseInt(process.env.EXECUTOR_QUEUE_MAX_CANDIDATES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CAP;
}

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // includeUpcoming=1 returns PENDING_WINDOW rows too (Ireland file-runner waits for window).
  const includeUpcoming = searchParams.get("includeUpcoming") === "1";
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const cap = envCap();

  try {
    const { data, error } = await supabaseAdmin
      .from("event_execution_queue")
      .select("*")
      .eq("status", "READY")
      .gt("latest_entry_iso", nowIso)
      .order("preferred_entry_iso", { ascending: true })
      .order("queued_at", { ascending: true })
      .limit(cap);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as EventExecutionQueueRow[];
    let candidates = rows.map((r) => mapQueueRowToIrelandCandidate(r, nowMs));
    if (!includeUpcoming) {
      candidates = candidates.filter((c) => c.entry_state === "IN_WINDOW");
    }

    const planRunId = rows[0]?.plan_run_id ?? null;

    // Next upcoming reservation not yet in rebalance window — for Ireland sleep guidance.
    const nextRebalanceThresholdIso = new Date(
      nowMs + REBALANCE_MINUTES_BEFORE_START * 60_000
    ).toISOString();
    const { data: nextResRows } = await supabaseAdmin
      .from("night_event_reservations")
      .select("match_family_key, game_start_iso, event_title, status")
      .in("status", ["RESERVED", "REBALANCE_PENDING"])
      .gt("game_start_iso", nextRebalanceThresholdIso)
      .order("game_start_iso", { ascending: true })
      .limit(1);
    const nextRes = nextResRows?.[0] ?? null;
    const nextDueIso = nextRes
      ? new Date(
          Date.parse(nextRes.game_start_iso) - REBALANCE_MINUTES_BEFORE_START * 60_000
        ).toISOString()
      : null;
    const nextCheckAfterSeconds = nextDueIso
      ? Math.max(0, Math.ceil((Date.parse(nextDueIso) - nowMs) / 1000))
      : null;

    return NextResponse.json(
      {
        ok: true,
        schema: QUEUE_SCHEMA_VERSION,
        execution_mode: QUEUE_EXECUTION_MODE,
        source: QUEUE_SOURCE,
        plan_run_id: planRunId,
        generated_at_iso: nowIso,
        max_candidate_count: cap,
        // Batch-level ceiling informational only — the enforceable cap per candidate
        // is candidate.max_stake_usd (dynamic, source of truth = queue row).
        max_stake_usd: candidates.length > 0 ? Math.max(...candidates.map((c) => c.max_stake_usd)) : 0,
        one_position_per_event: true,
        include_upcoming: includeUpcoming,
        candidate_count: candidates.length,
        candidates,
        next_due_iso: nextDueIso,
        next_check_after_seconds: nextCheckAfterSeconds,
        next_due_reservation: nextRes
          ? {
              match_family_key: nextRes.match_family_key,
              event_title: nextRes.event_title,
              game_start_iso: nextRes.game_start_iso,
              rebalance_starts_iso: nextDueIso,
            }
          : null,
        diagnostics: {
          ready_rows_total: rows.length,
          in_window_count: candidates.filter((c) => c.entry_state === "IN_WINDOW").length,
          pending_window_count: candidates.filter((c) => c.entry_state === "PENDING_WINDOW").length,
        },
        // Ireland contract reminder (informational).
        ireland_contract: {
          read_only_source: "event_execution_queue",
          do_not_rank: true,
          do_not_pull_broad_candidates: true,
          do_not_apply_tier2_tier3: true,
        },
      },
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[executor/queue] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
