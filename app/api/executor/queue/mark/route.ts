import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

// POST /api/executor/queue/mark
//
// Ireland calls this after acting on a queue candidate. Updates event_execution_queue status.
// Auth: x-executor-secret (same as all executor endpoints).
// No live order side effects. No broad candidate logic.

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["CLAIMED", "EXECUTED", "SKIPPED", "FAILED", "EXPIRED"] as const;
type MarkStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(s: unknown): s is MarkStatus {
  return typeof s === "string" && (VALID_STATUSES as readonly string[]).includes(s);
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { queue_id, order_key, status, source, reason, live_order_confirmed,
    polymarket_order_id, tx_hash, sent_at_iso, executed_at_iso, diagnostics } = body as Record<string, unknown>;

  if (!queue_id || typeof queue_id !== "string") {
    return NextResponse.json({ ok: false, error: "queue_id required" }, { status: 400 });
  }
  if (source !== "ireland_queue_only") {
    return NextResponse.json({ ok: false, error: "source must be ireland_queue_only" }, { status: 400 });
  }
  if (!isValidStatus(status)) {
    return NextResponse.json(
      { ok: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // EXECUTED only when confirmed.
  if (status === "EXECUTED" && !live_order_confirmed) {
    return NextResponse.json(
      { ok: false, error: "status=EXECUTED requires live_order_confirmed=true" },
      { status: 400 }
    );
  }

  try {
    // Read current row first to enforce conservative transitions.
    const { data: current, error: readErr } = await supabaseAdmin
      .from("event_execution_queue")
      .select("id, status, order_key, diagnostics")
      .eq("id", queue_id)
      .single();

    if (readErr || !current) {
      return NextResponse.json({ ok: false, error: "Queue row not found", queue_id }, { status: 404 });
    }

    const currentStatus = current.status as string;

    // Do not overwrite EXECUTED with a non-executed status.
    if (currentStatus === "EXECUTED" && status !== "EXECUTED") {
      return NextResponse.json(
        { ok: false, error: `Row already EXECUTED; cannot overwrite with ${status}`, queue_id },
        { status: 409 }
      );
    }

    // Merge diagnostics into existing jsonb.
    const prevDiag = (current.diagnostics ?? {}) as Record<string, unknown>;
    const newDiag: Record<string, unknown> = {
      ...prevDiag,
      mark_history: [
        ...((prevDiag.mark_history as unknown[]) ?? []),
        {
          status,
          source,
          reason: reason ?? null,
          live_order_confirmed: live_order_confirmed ?? false,
          polymarket_order_id: polymarket_order_id ?? null,
          tx_hash: tx_hash ?? null,
          sent_at_iso: sent_at_iso ?? null,
          executed_at_iso: executed_at_iso ?? null,
          marked_at_iso: new Date().toISOString(),
          extra: diagnostics ?? null,
        },
      ],
    };

    const updatePayload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
      diagnostics: newDiag,
    };

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("event_execution_queue")
      .update(updatePayload)
      .eq("id", queue_id)
      .select("id, status, order_key, match_family_key, stake_usd, updated_at")
      .single();

    if (updateErr) {
      // updated_at column may not exist — retry without it.
      if (updateErr.message?.includes("updated_at")) {
        const { data: updated2, error: updateErr2 } = await supabaseAdmin
          .from("event_execution_queue")
          .update({ status, diagnostics: newDiag })
          .eq("id", queue_id)
          .select("id, status, order_key, match_family_key, stake_usd")
          .single();
        if (updateErr2) throw new Error(updateErr2.message);
        return NextResponse.json({ ok: true, queue_id, updated: updated2 }, { status: 200 });
      }
      throw new Error(updateErr.message);
    }

    return NextResponse.json({ ok: true, queue_id, updated }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[executor/queue/mark] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
