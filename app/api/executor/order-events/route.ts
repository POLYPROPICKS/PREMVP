import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
  type OrderEventSubmission,
} from "@/lib/executor/executorQueueTypes";

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

  // Validate required fields before sanitisation
  if (!str(raw.token_id)) {
    return NextResponse.json({ error: "Missing required field: token_id" }, { status: 400 });
  }
  if (!str(raw.idempotency_key) && !str(raw.clob_order_id)) {
    return NextResponse.json(
      { error: "Missing required field: at least one of idempotency_key, clob_order_id" },
      { status: 400 }
    );
  }

  // PREMVP source-of-truth enforcement: without idempotency_key we cannot look up
  // the queue row this event claims to belong to, so we fail safe and reject
  // rather than silently record an unverifiable stake/price/identity claim.
  const idempotencyKey = str(raw.idempotency_key);
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "REJECTED_MISSING_IDEMPOTENCY_KEY_FOR_QUEUE_VALIDATION" },
      { status: 400 }
    );
  }

  const { data: queueRow, error: queueLookupError } = await supabaseAdmin
    .from("event_execution_queue")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (queueLookupError) {
    console.error("[executor/order-events] Queue lookup error:", queueLookupError.message);
    return NextResponse.json({ error: "QUEUE_LOOKUP_FAILED" }, { status: 500 });
  }
  if (!queueRow) {
    return NextResponse.json(
      { error: "REJECTED_QUEUE_ROW_NOT_FOUND_FOR_IDEMPOTENCY_KEY" },
      { status: 409 }
    );
  }

  const submission: OrderEventSubmission = {
    idempotency_key: idempotencyKey,
    token_id: str(raw.token_id),
    condition_id: str(raw.condition_id),
    side: str(raw.side ?? raw.selected_side),
    market_slug: str(raw.market_slug),
    submitted_size: num(raw.submitted_size ?? raw.stake_usd),
    submitted_price: num(raw.submitted_price),
  };

  const validation = validateOrderEventAgainstQueueRow(
    submission,
    queueRow as EventExecutionQueueRow
  );
  if (!validation.ok) {
    console.error(
      `[executor/order-events] REJECTED mismatch reason=${validation.reason} ` +
        `idempotency_key=${idempotencyKey} queue_token=${(queueRow as EventExecutionQueueRow).token_id} ` +
        `queue_stake=${(queueRow as EventExecutionQueueRow).stake_usd}`
    );
    return NextResponse.json(
      { error: "REJECTED_QUEUE_POLICY_MISMATCH", reason: validation.reason },
      { status: 409 }
    );
  }

  const s = sanitize(raw) as Record<string, unknown>;

  const queueRowTyped = queueRow as EventExecutionQueueRow;

  const record: Record<string, unknown> = {
    // identity / routing
    event_type:               str(s.event_type),
    source:                   str(s.source),
    environment:              str(s.environment),

    // dedup keys
    idempotency_key:          str(s.idempotency_key),
    clob_order_id:            str(s.clob_order_id),
    transaction_hashes:       s.transaction_hashes ?? null,

    // fixture/queue linkage — sourced from the verified queue row (not the
    // untrusted client payload) so downstream funnel monitoring can join
    // order events to reservations without nested-JSON archaeology.
    match_family_key:         str(queueRowTyped.match_family_key) ?? str(s.match_family_key),
    reservation_id:           queueRowTyped.reservation_id ?? null,
    queue_id:                 queueRowTyped.id ?? null,

    // signal linkage
    signal_id:                str(s.signal_id),
    candidate_id:             str(s.candidate_id),
    run_id:                   str(s.run_id),

    // market
    market_slug:              str(s.market_slug),
    condition_id:             str(s.condition_id),
    token_id:                 str(s.token_id),
    selected_side:            str(s.selected_side),
    side:                     str(s.side),

    // order outcome
    order_status:             str(s.order_status ?? s.status),
    success:                  bool(s.success),
    dry_run:                  bool(s.dry_run),
    live_confirm:             bool(s.live_confirm),

    // pricing
    submitted_price:          num(s.submitted_price),
    submitted_size:           num(s.submitted_size),
    stake_usd:                num(s.stake_usd),
    making_amount:            str(s.making_amount),
    taking_amount:            str(s.taking_amount),
    observed_best_bid:        num(s.observed_best_bid),
    observed_best_ask:        num(s.observed_best_ask),
    observed_price:           num(s.observed_price),
    observed_spread:          num(s.observed_spread),
    max_entry_price:          num(s.max_entry_price),

    // cost
    fee_usd:                  num(s.fee_usd),
    slippage_usd:             num(s.slippage_usd),
    cost_model_version:       str(s.cost_model_version),
    fee_notes:                str(s.fee_notes),

    // executor metadata
    executor_host_country:    str(s.executor_host_country),
    executor_version:         str(s.executor_version),
    model_rule_id:            str(s.model_rule_id),
    strategic_scope:          str(s.strategic_scope),

    // JSON blobs (sanitised before storage)
    candidate_snapshot_json:  s.candidate_snapshot_json ?? null,
    response_json_sanitized:  s.response_json_sanitized ?? null,
    executor_meta:            s.executor_meta ?? null,
    raw_event_json:           s, // full sanitised payload

    // error
    error_message:            str(s.error_message),
  };

  // Remove nulls to let DB defaults apply (preserves false / 0)
  for (const k of Object.keys(record)) {
    if (record[k] === null || record[k] === undefined) delete record[k];
  }

  const { data, error } = await supabaseAdmin
    .from("executor_order_events")
    .insert(record)
    .select("id, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      // Unique constraint violation → duplicate event, not an error
      return NextResponse.json(
        { success: true, duplicate: true, message: "Event already recorded" },
        { status: 200 }
      );
    }
    console.error("[executor/order-events] Insert error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { success: true, duplicate: false, id: data?.id, created_at: data?.created_at },
    { status: 200 }
  );
}
