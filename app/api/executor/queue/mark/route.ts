import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  isQueueMarkAcceptedStatus,
  rejectsExecutedRegression,
  handleQueueMarkExecuted,
  type QueueMarkDbPort,
  type QueueMarkRow,
  type StoredOrderEvent,
} from "@/lib/executor/executorCallbackContract";

// POST /api/executor/queue/mark
//
// Ireland calls this after acting on a queue candidate. Updates event_execution_queue status.
// Auth: x-executor-secret (same as all executor endpoints).
// No live order side effects. No broad candidate logic.
//
// EXECUTED is additionally server-verified: live_order_confirmed is treated as
// an Ireland assertion only, never sufficient by itself -- the queue row's own
// idempotency_key/condition_id/token_id/side must match a real stored
// executor_order_events row (see executorCallbackContract.handleQueueMarkExecuted).

export const dynamic = "force-dynamic";

function toQueueMarkRow(row: Record<string, unknown>): QueueMarkRow {
  return {
    id: String(row.id),
    status: String(row.status),
    idempotency_key: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    condition_id: typeof row.condition_id === "string" ? row.condition_id : null,
    token_id: typeof row.token_id === "string" ? row.token_id : null,
    side: typeof row.side === "string" ? row.side : null,
    order_key: typeof row.order_key === "string" ? row.order_key : null,
    match_family_key: typeof row.match_family_key === "string" ? row.match_family_key : null,
    stake_usd: typeof row.stake_usd === "number" ? row.stake_usd : null,
    diagnostics: (row.diagnostics as Record<string, unknown>) ?? {},
  };
}

function toStoredOrderEvent(row: Record<string, unknown>): StoredOrderEvent {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    idempotency_key: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    condition_id: typeof row.condition_id === "string" ? row.condition_id : null,
    token_id: String(row.token_id),
    side: typeof row.side === "string" ? row.side : null,
    selected_side: typeof row.selected_side === "string" ? row.selected_side : null,
    market_slug: typeof row.market_slug === "string" ? row.market_slug : null,
    submitted_size: typeof row.submitted_size === "number" ? row.submitted_size : null,
    submitted_price: typeof row.submitted_price === "number" ? row.submitted_price : null,
    clob_order_id: typeof row.clob_order_id === "string" ? row.clob_order_id : null,
  };
}

function createSupabaseQueueMarkDbPort(): QueueMarkDbPort {
  return {
    async findQueueRow(queueId) {
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("id", queueId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? toQueueMarkRow(data as Record<string, unknown>) : null;
    },
    async findOrderEventForIdentity(input) {
      const { data, error } = await supabaseAdmin
        .from("executor_order_events")
        .select("*")
        .eq("idempotency_key", input.idempotency_key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const row = toStoredOrderEvent(data as Record<string, unknown>);
      const eventSide = row.side ?? row.selected_side;
      if (row.condition_id !== input.condition_id || row.token_id !== input.token_id || eventSide !== input.side) return null;
      return row;
    },
    async updateQueueStatus(queueId, patch) {
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .update({ status: patch.status, updated_at: new Date().toISOString(), diagnostics: patch.diagnostics })
        .eq("id", queueId)
        .select("id, status, order_key, match_family_key, stake_usd, condition_id, token_id, side, idempotency_key, diagnostics, updated_at")
        .single();
      if (error) throw new Error(error.message);
      return toQueueMarkRow(data as Record<string, unknown>);
    },
  };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { queue_id, status, source, reason, live_order_confirmed,
    polymarket_order_id, tx_hash, sent_at_iso, executed_at_iso, diagnostics } = body as Record<string, unknown>;

  if (!queue_id || typeof queue_id !== "string") {
    return NextResponse.json({ ok: false, success: false, error: "queue_id required" }, { status: 400 });
  }
  if (source !== "ireland_queue_only") {
    return NextResponse.json({ ok: false, success: false, error: "source must be ireland_queue_only" }, { status: 400 });
  }
  if (!isQueueMarkAcceptedStatus(status)) {
    return NextResponse.json(
      { ok: false, success: false, error: "status must be one of the accepted mark statuses" },
      { status: 400 }
    );
  }

  const markHistoryEntry = {
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
  };

  try {
    if (status === "EXECUTED") {
      const outcome = await handleQueueMarkExecuted(createSupabaseQueueMarkDbPort(), {
        queueId: queue_id,
        liveOrderConfirmed: live_order_confirmed === true,
        markHistoryEntry,
      });
      switch (outcome.kind) {
        case "REJECTED_QUEUE_ROW_NOT_FOUND":
          return NextResponse.json({ ok: false, success: false, error: "Queue row not found", queue_id }, { status: 404 });
        case "REJECTED_CONFIRMATION_REQUIRED":
          return NextResponse.json({ ok: false, success: false, error: "status=EXECUTED requires live_order_confirmed=true" }, { status: 400 });
        case "REJECTED_MISSING_IDEMPOTENCY_KEY":
          return NextResponse.json({ ok: false, success: false, error: "EXECUTOR_ORDER_EVENT_REQUIRED" }, { status: 409 });
        case "REJECTED_ORDER_EVENT_REQUIRED":
          return NextResponse.json({ ok: false, success: false, error: "EXECUTOR_ORDER_EVENT_REQUIRED" }, { status: 409 });
        case "IDEMPOTENT_NO_OP":
          return NextResponse.json(
            { ok: true, success: true, duplicate: true, queue_id, status: outcome.row.status, updated: outcome.row },
            { status: 200 },
          );
        case "UPDATED":
          return NextResponse.json(
            { ok: true, success: true, duplicate: false, queue_id, status: outcome.row.status, updated: outcome.row },
            { status: 200 },
          );
      }
    }

    // Non-EXECUTED mutation path — read current row to enforce the shared
    // EXECUTED-immutability guard, then update as before.
    const { data: current, error: readErr } = await supabaseAdmin
      .from("event_execution_queue")
      .select("id, status, order_key, diagnostics")
      .eq("id", queue_id)
      .single();

    if (readErr || !current) {
      return NextResponse.json({ ok: false, success: false, error: "Queue row not found", queue_id }, { status: 404 });
    }

    const currentStatus = current.status as string;

    if (rejectsExecutedRegression(currentStatus, status)) {
      return NextResponse.json(
        { ok: false, success: false, error: `Row already EXECUTED; cannot overwrite with ${status}`, queue_id },
        { status: 409 }
      );
    }

    const prevDiag = (current.diagnostics ?? {}) as Record<string, unknown>;
    const newDiag: Record<string, unknown> = {
      ...prevDiag,
      mark_history: [...((prevDiag.mark_history as unknown[]) ?? []), markHistoryEntry],
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
      if (updateErr.message?.includes("updated_at")) {
        const { data: updated2, error: updateErr2 } = await supabaseAdmin
          .from("event_execution_queue")
          .update({ status, diagnostics: newDiag })
          .eq("id", queue_id)
          .select("id, status, order_key, match_family_key, stake_usd")
          .single();
        if (updateErr2) throw new Error(updateErr2.message);
        return NextResponse.json({ ok: true, success: true, duplicate: false, queue_id, status: updated2?.status, updated: updated2 }, { status: 200 });
      }
      throw new Error(updateErr.message);
    }

    return NextResponse.json({ ok: true, success: true, duplicate: false, queue_id, status: updated?.status, updated }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[executor/queue/mark] Error:", msg);
    return NextResponse.json({ ok: false, success: false, error: msg }, { status: 500 });
  }
}
