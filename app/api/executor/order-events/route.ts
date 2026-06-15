import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

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

export async function GET() {
  return NextResponse.json(
    { ok: true, endpoint: "executor/order-events", version: "v1" },
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

  const s = sanitize(raw) as Record<string, unknown>;

  const record: Record<string, unknown> = {
    // identity / routing
    event_type:               str(s.event_type),
    source:                   str(s.source),
    environment:              str(s.environment),

    // dedup keys
    idempotency_key:          str(s.idempotency_key),
    clob_order_id:            str(s.clob_order_id),
    transaction_hashes:       s.transaction_hashes ?? null,

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
