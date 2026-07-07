// READ-ONLY runtime extraction for the 2026-07-07 Contur3 audit.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Railway environment.
// Does not write, does not call cron/rebalance/order endpoints. SELECT-only.
//
// Usage (on Railway, where real env vars are present):
//   node scripts/contur3/runtime-extraction-2026-07-07.mjs

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — refusing to run.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: reservations, error: resErr } = await supabase
    .from("night_event_reservations")
    .select(
      "id,plan_run_id,plan_date_minsk,reserved_at,window_start_iso,window_end_iso," +
      "match_family_key,event_slug,event_title,sport,league,strategic_scope,game_start_iso," +
      "event_tier,event_score,reservation_rank,status,selection_reason,created_at,updated_at"
    )
    .eq("plan_date_minsk", "2026-07-07")
    .order("reservation_rank", { ascending: true });
  if (resErr) throw resErr;

  const uniqueEvents = new Set((reservations ?? []).map((r) => r.match_family_key)).size;

  const { data: queueRows, error: queueErr } = await supabase
    .from("event_execution_queue")
    .select(
      "id,reservation_id,plan_run_id,rebalance_run_id,queued_at,match_family_key," +
      "event_slug,event_title,sport,league,game_start_iso,condition_id,token_id,side," +
      "market_slug,market_title,market_family,score,coverage,tier,stake_usd,diagnostics," +
      "preferred_entry_iso,latest_entry_iso,selection_rank,selection_reason,status," +
      "order_key,idempotency_key,created_at,updated_at"
    )
    .gte("created_at", "2026-07-07T00:00:00Z")
    .lt("created_at", "2026-07-09T00:00:00Z")
    .order("created_at", { ascending: true });
  if (queueErr) throw queueErr;

  const isArgEgypt = (text) =>
    typeof text === "string" &&
    /argentina/i.test(text) &&
    /egypt/i.test(text);

  const argEgyptReservations = (reservations ?? []).filter(
    (r) => isArgEgypt(r.event_title) || isArgEgypt(r.match_family_key) || isArgEgypt(r.event_slug)
  );
  const argEgyptQueue = (queueRows ?? []).filter(
    (r) => isArgEgypt(r.event_title) || isArgEgypt(r.match_family_key) || isArgEgypt(r.event_slug)
  );

  const idemKeys = argEgyptQueue.map((r) => r.idempotency_key).filter(Boolean);
  let orderEvents = [];
  if (idemKeys.length > 0) {
    const { data, error } = await supabase
      .from("executor_order_events")
      .select(
        "created_at,event_type,source,market_slug,selected_side,side,token_id,order_status," +
        "success,dry_run,live_confirm,stake_usd,submitted_size,submitted_price,fee_usd," +
        "slippage_usd,cost_model_version,fee_notes,clob_order_id,transaction_hashes," +
        "error_message,raw_event_json"
      )
      .order("created_at", { ascending: true });
    if (error) throw error;
    orderEvents = (data ?? []).filter((row) =>
      idemKeys.includes(row.raw_event_json?.idempotency_key)
    );
  }

  console.log(JSON.stringify({
    reservations_count: reservations?.length ?? 0,
    unique_events: uniqueEvents,
    queue_rows_count: queueRows?.length ?? 0,
    arg_egypt_reservations: argEgyptReservations,
    arg_egypt_queue: argEgyptQueue,
    arg_egypt_order_events: orderEvents,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
