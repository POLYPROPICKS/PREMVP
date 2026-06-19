import * as envPkg from "@next/env";

const loadEnvConfig =
  (envPkg as any).loadEnvConfig ?? (envPkg as any).default?.loadEnvConfig;
loadEnvConfig?.(process.cwd());

type Row = Record<string, any>;

async function main() {
  const mod = await import("../lib/supabase/server");
  const supabaseAdmin =
    (mod as any).supabaseAdmin ??
    (mod as any).default?.supabaseAdmin ??
    (mod as any)["module.exports"]?.supabaseAdmin;

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("executor_audit_events")
    .select("created_at, run_id, trace_id, stage, event_slug, market_slug, condition_id, token_id, live_eligible, status, reason, payload_json")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.log(JSON.stringify({
      code: "LIVE_CONTOUR_VERIFY_WARN",
      status: "WARN",
      reason: "executor_audit_events unavailable; apply migration or verify Supabase table",
      supabase_error: error.message,
    }, null, 2));
    return;
  }

  const rows = (data ?? []) as Row[];
  const apiRuns = rows.filter((r) => r.stage === "NIGHT_PLAN_API_RUN");
  const exposed = rows.filter((r) => r.stage === "EXPOSED_BY_API");
  const liveEligible = exposed.filter((r) => r.live_eligible === true || r.status === "LIVE_ELIGIBLE");
  const pulledTraceIds = new Set(rows.filter((r) => r.stage === "PULLED_BY_IRELAND").map((r) => r.trace_id));
  const attemptedTraceIds = new Set(rows.filter((r) => r.stage === "ORDER_ATTEMPTED").map((r) => r.trace_id));
  const missingIrelandPull = liveEligible.filter((r) => r.trace_id && !pulledTraceIds.has(r.trace_id));
  const pulledNoAttempt = rows
    .filter((r) => r.stage === "PULLED_BY_IRELAND" && r.live_eligible === true)
    .filter((r) => r.trace_id && !attemptedTraceIds.has(r.trace_id));

  const status = apiRuns.length === 0
    ? "WARN"
    : missingIrelandPull.length > 0
      ? "WARN"
      : "PASS";

  console.log(JSON.stringify({
    code: status === "PASS" ? "LIVE_CONTOUR_VERIFY_PASS" : "LIVE_CONTOUR_VERIFY_WARN",
    status,
    last_night_plan_api_run_time: apiRuns[0]?.created_at ?? null,
    api_runs_last_24h: apiRuns.length,
    candidates_exposed_last_24h: exposed.length,
    live_eligible_candidates_last_24h: liveEligible.length,
    candidates_with_no_ireland_pull_event: missingIrelandPull.length,
    candidates_with_ireland_pull_no_order_attempt: pulledNoAttempt.length,
    stale_candidates: missingIrelandPull.slice(0, 10).map((r) => ({
      created_at: r.created_at,
      trace_id: r.trace_id,
      event_slug: r.event_slug,
      market_slug: r.market_slug,
      condition_id: r.condition_id,
      token_id: r.token_id,
      reason: r.reason,
    })),
    note: missingIrelandPull.length > 0
      ? "Ireland JSONL/audit integration is not writing downstream stages yet, or live candidates were not pulled."
      : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
