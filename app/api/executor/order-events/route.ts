import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  handleOrderEventSubmission,
  coerceNumericAmount,
  type OrderEventDbPort,
  type StoredOrderEvent,
  type InsertOrderEventFailure,
} from "@/lib/executor/executorCallbackContract";
import type { EventExecutionQueueRow } from "@/lib/executor/executorQueueTypes";

// Keys whose name (case-insensitive, normalised) triggers value removal
const BANNED_SUBSTRINGS = [
  "secret",
  "privatekey",
  "private_key",
  "apikey",
  "api_key",
  "passphrase",
  "pass_phrase",
];

function isBannedKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/-/g, "_");
  return BANNED_SUBSTRINGS.some((p) => norm.includes(p));
}

function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isBannedKey(k) ? null : sanitize(v);
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function safeJsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "";
  }
}

function compactEvent(row: Record<string, unknown>) {
  const meta = row.executor_meta as Record<string, unknown> | null;
  const raw = row.raw_event_json as Record<string, unknown> | null;
  return {
    created_at: row.created_at,
    event_type: row.event_type,
    status: row.order_status,
    action: meta?.action ?? raw?.action ?? null,
    market: row.market_slug ?? meta?.market_slug ?? raw?.market_slug ?? null,
    event: meta?.event_slug ?? raw?.event_slug ?? meta?.event_title ?? raw?.event_title ?? null,
    title: meta?.title ?? raw?.title ?? null,
    selected_outcome: row.selected_side ?? row.side ?? meta?.selected_outcome ?? raw?.selected_outcome ?? null,
    selected_token_id: row.token_id,
    stake_usd: row.stake_usd ?? row.submitted_size ?? null,
    order_id: row.clob_order_id ?? null,
    tx_hash: row.transaction_hashes ?? null,
    reason: row.error_message ?? meta?.reason ?? meta?.skip_reason ?? raw?.reason ?? raw?.skip_reason ?? null,
    source: row.source,
    route: meta?.route ?? raw?.route ?? row.source ?? null,
    dry_run: row.dry_run,
    live_confirm: row.live_confirm,
    success: row.success,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const rawSince = parseInt(searchParams.get("sinceMinutes") ?? "360", 10);
  const sinceMinutes = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 360;
  const eventFilter = searchParams.get("event")?.trim().toLowerCase() ?? "";
  const sinceIso = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("executor_order_events")
    .select(
      "created_at,event_type,source,market_slug,selected_side,side,token_id,order_status," +
      "success,dry_run,live_confirm,stake_usd,submitted_size,clob_order_id,transaction_hashes," +
      "error_message,executor_meta,raw_event_json"
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).filter((row) => {
    if (!eventFilter) return true;
    return safeJsonText(row).toLowerCase().includes(eventFilter);
  });

  return NextResponse.json(
    {
      ok: true,
      endpoint: "executor/order-events",
      version: "v1",
      count: rows.length,
      events: rows.map(compactEvent),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
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

/**
 * Wires the real Supabase-backed read/write primitives to the narrow
 * OrderEventDbPort the pure orchestration in executorCallbackContract.ts
 * depends on. All business logic lives in handleOrderEventSubmission; this
 * adapter is intentionally thin infrastructure glue.
 */
function createSupabaseOrderEventDbPort(): OrderEventDbPort {
  return {
    async findQueueRowByIdempotencyKey(key) {
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as EventExecutionQueueRow | null) ?? null;
    },
    async findOrderEventByIdempotencyKey(key) {
      const { data, error } = await supabaseAdmin
        .from("executor_order_events")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? toStoredOrderEvent(data as Record<string, unknown>) : null;
    },
    async findOrderEventByClobOrderId(clobOrderId) {
      const { data, error } = await supabaseAdmin
        .from("executor_order_events")
        .select("*")
        .eq("clob_order_id", clobOrderId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? toStoredOrderEvent(data as Record<string, unknown>) : null;
    },
    async insertOrderEvent(raw, _queueRow): Promise<{ ok: true; row: StoredOrderEvent } | InsertOrderEventFailure> {
      const s = sanitize(raw) as Record<string, unknown>;
      const record: Record<string, unknown> = {
        // identity / routing
        event_type: str(s.event_type),
        source: str(s.source),
        environment: str(s.environment),

        // dedup keys
        idempotency_key: str(s.idempotency_key),
        clob_order_id: str(s.clob_order_id),
        transaction_hashes: s.transaction_hashes ?? null,

        // NOTE: executor_order_events.queue_id, match_family_key, and
        // reservation_id are NOT real live columns (confirmed by a live
        // 42703 error and a full founder-provided information_schema
        // column dump of the exact 43-column live table) and are never
        // written here. queueRow is still loaded and validated above for
        // idempotency/policy cross-checks before this insert runs.

        // signal linkage
        signal_id: str(s.signal_id),
        candidate_id: str(s.candidate_id),
        run_id: str(s.run_id),

        // market
        market_slug: str(s.market_slug),
        condition_id: str(s.condition_id),
        token_id: str(s.token_id),
        selected_side: str(s.selected_side),
        side: str(s.side),

        // order outcome
        order_status: str(s.order_status ?? s.status),
        success: bool(s.success),
        dry_run: bool(s.dry_run),
        live_confirm: bool(s.live_confirm),

        // pricing
        submitted_price: num(s.submitted_price),
        submitted_size: num(s.submitted_size),
        stake_usd: num(s.stake_usd),
        making_amount: coerceNumericAmount(s.making_amount),
        taking_amount: coerceNumericAmount(s.taking_amount),
        observed_best_bid: num(s.observed_best_bid),
        observed_best_ask: num(s.observed_best_ask),
        observed_price: num(s.observed_price),
        observed_spread: num(s.observed_spread),
        max_entry_price: num(s.max_entry_price),

        // cost
        fee_usd: num(s.fee_usd),
        slippage_usd: num(s.slippage_usd),
        cost_model_version: str(s.cost_model_version),
        fee_notes: str(s.fee_notes),

        // executor metadata
        executor_host_country: str(s.executor_host_country),
        executor_version: str(s.executor_version),
        model_rule_id: str(s.model_rule_id),
        strategic_scope: str(s.strategic_scope),

        // JSON blobs (sanitised before storage)
        candidate_snapshot_json: s.candidate_snapshot_json ?? null,
        response_json_sanitized: s.response_json_sanitized ?? null,
        executor_meta: s.executor_meta ?? null,
        raw_event_json: s, // full sanitised payload

        // error
        error_message: str(s.error_message),
      };

      for (const k of Object.keys(record)) {
        if (record[k] === null || record[k] === undefined) delete record[k];
      }

      const { data, error } = await supabaseAdmin
        .from("executor_order_events")
        .insert(record)
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") {
          const message = error.message.toLowerCase();
          const code = message.includes("clob_order_id") ? "UNIQUE_VIOLATION_CLOB_ORDER_ID" : "UNIQUE_VIOLATION_IDEMPOTENCY_KEY";
          return { ok: false, code, message: "duplicate key value violates unique constraint" };
        }
        return { ok: false, code: "OTHER", message: error.message };
      }
      return { ok: true, row: toStoredOrderEvent(data as Record<string, unknown>) };
    },
  };
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;

  let outcome;
  try {
    outcome = await handleOrderEventSubmission(createSupabaseOrderEventDbPort(), raw);
  } catch (error) {
    console.error("[executor/order-events] Unexpected error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ success: false, error: "DB_ERROR" }, { status: 500 });
  }

  switch (outcome.kind) {
    case "REJECTED_MISSING_TOKEN_ID":
      return NextResponse.json({ error: "Missing required field: token_id" }, { status: 400 });
    case "REJECTED_MISSING_IDEMPOTENCY_KEY":
      return NextResponse.json({ error: "REJECTED_MISSING_IDEMPOTENCY_KEY_FOR_QUEUE_VALIDATION" }, { status: 400 });
    case "REJECTED_QUEUE_ROW_NOT_FOUND":
      return NextResponse.json({ error: "REJECTED_QUEUE_ROW_NOT_FOUND_FOR_IDEMPOTENCY_KEY" }, { status: 409 });
    case "REJECTED_QUEUE_POLICY_MISMATCH":
      return NextResponse.json({ error: "REJECTED_QUEUE_POLICY_MISMATCH", reason: outcome.reason }, { status: 409 });
    case "CONFLICT_IDEMPOTENCY":
      return NextResponse.json({ success: false, error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
    case "CONFLICT_CLOB_ORDER_ID":
      return NextResponse.json({ success: false, error: "CLOB_ORDER_ID_CONFLICT" }, { status: 409 });
    case "DB_ERROR":
      return NextResponse.json({ success: false, error: "DB_ERROR" }, { status: 500 });
    case "DUPLICATE":
      return NextResponse.json(
        { success: true, duplicate: true, event_id: outcome.row.id, idempotency_key: outcome.row.idempotency_key, id: outcome.row.id, created_at: outcome.row.created_at },
        { status: 200 },
      );
    case "INSERTED":
      return NextResponse.json(
        { success: true, duplicate: false, event_id: outcome.row.id, idempotency_key: outcome.row.idempotency_key, id: outcome.row.id, created_at: outcome.row.created_at },
        { status: 200 },
      );
  }
}
