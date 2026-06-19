import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { loadQueryRegistry } from "./queryRegistry";

loadEnvConfig(process.cwd());

export type FireRow = Record<string, any>;

export type QueryRunResult = {
  queryId: string;
  adapterMode: "SUPABASE_REST_REGISTERED_QUERY";
  sourceTable: string;
  rows: FireRow[];
  execution: QueryExecutionRecord;
  status: "OK" | "WARN";
  warning?: string;
};

export type QueryExecutionRecord = {
  query_id: string;
  sql_id: string;
  registry_path: string;
  registry_hash: string;
  adapter_mode: "SUPABASE_REST_REGISTERED_QUERY";
  source_table: string;
  selected_columns: string;
  filters_applied: string;
  order_by: string;
  page_size: number;
  pages_fetched: number;
  rows_fetched: number;
  started_at: string;
  finished_at: string;
  status: "OK" | "WARN" | "FAIL";
  warning: string;
};

const PUBLISHED_COLUMNS = [
  "id",
  "created_at",
  "resolved_at",
  "expires_at",
  "condition_id",
  "selected_token_id",
  "selected_outcome",
  "market_slug",
  "event_slug",
  "signal_result",
  "winning_outcome",
  "realized_return_pct",
  "signal_confidence_num",
  "pre_event_score_num",
  "score",
  "expected_return_pct_num",
  "smart_money_score_num",
  "whale_public_score_num",
  "entry_price_num",
  "metric_formula_version",
  "formula_version",
  "source",
  "market_source",
  "premium_signal",
  "diagnostics",
].join(",");

const RESEARCH_COLUMNS = [
  "id",
  "created_at",
  "snapshot_at",
  "condition_id",
  "selected_token_id",
  "opposing_token_id",
  "selected_outcome",
  "event_slug",
  "scope",
  "league",
  "market_family",
  "game_start_iso",
  "data_coverage_num",
  "selected_price_num",
  "formula_feature_version",
  "hours_until_start_num",
  "diagnostics",
].join(",");

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new Error("FIREMODEL_DB_ENV_MISSING: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchPaged(table: string, columns: string, options: {
  order?: { column: string; ascending: boolean };
  limit?: number;
  sinceIso?: string;
} = {}): Promise<{ rows: FireRow[]; pages: number }> {
  const client = supabaseAdmin();
  const pageSize = 1000;
  const limit = options.limit ?? 200000;
  const rows: FireRow[] = [];
  let pages = 0;
  for (let from = 0; from < limit; from += pageSize) {
    let query = client.from(table).select(columns);
    if (options.sinceIso) query = query.gte("created_at", options.sinceIso);
    if (options.order) query = query.order(options.order.column, { ascending: options.order.ascending });
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    pages += 1;
    rows.push(...((data ?? []) as FireRow[]));
    if (!data || data.length < pageSize) break;
  }
  return { rows, pages };
}

export async function runRegisteredQuery(queryId: string): Promise<QueryRunResult> {
  const registry = await loadQueryRegistry();
  if (!registry.has(queryId)) throw new Error(`UNREGISTERED_FIREMODEL_QUERY: ${queryId}`);
  const registered = registry.get(queryId)!;

  const startedAt = new Date().toISOString();
  const finish = (
    sourceTable: string,
    columns: string,
    orderBy: string,
    rows: FireRow[],
    pages: number,
    status: "OK" | "WARN",
    warning = "",
  ): QueryRunResult => ({
    queryId,
    adapterMode: "SUPABASE_REST_REGISTERED_QUERY",
    sourceTable,
    rows,
    status,
    warning: warning || undefined,
    execution: {
      query_id: queryId,
      sql_id: registered.sqlId,
      registry_path: registered.relativePath,
      registry_hash: registered.hash,
      adapter_mode: "SUPABASE_REST_REGISTERED_QUERY",
      source_table: sourceTable,
      selected_columns: columns,
      filters_applied: "runtime filters documented in registered SQL contract; REST adapter fetches candidate rows and filters in FireModel engine",
      order_by: orderBy,
      page_size: 1000,
      pages_fetched: pages,
      rows_fetched: rows.length,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      warning,
    },
  });

  if (queryId === "all_sports_published_signals_v1" || queryId === "all_sports_resolved_candidates_v1") {
    const result = await fetchPaged("generated_signal_pairs", PUBLISHED_COLUMNS, {
      order: { column: "created_at", ascending: false },
    });
    return finish("generated_signal_pairs", PUBLISHED_COLUMNS, "created_at desc", result.rows, result.pages, "OK");
  }

  if (queryId === "all_sports_research_candidates_v1" || queryId === "l0_raw_market_inventory_v1" || queryId === "l1_research_candidates_v1" || queryId === "l2_scored_candidates_v1") {
    const result = await fetchPaged("generated_signal_research_snapshots", RESEARCH_COLUMNS, {
      order: { column: "created_at", ascending: false },
    });
    return finish("generated_signal_research_snapshots", RESEARCH_COLUMNS, "created_at desc", result.rows, result.pages, "OK");
  }

  if (queryId === "live_contour_state_v1" || queryId === "l4_execution_layer_v1") {
    const result = await fetchPaged(
      "executor_audit_events",
      "id,created_at,run_id,trace_id,stage,event_slug,market_slug,side,condition_id,token_id,score,coverage,tier,stake_usd,live_eligible,status,reason,source,payload_json",
      { order: { column: "created_at", ascending: false }, limit: 10000 },
    ).catch((error) => ({ rows: [{ firemodel_warning: String(error instanceof Error ? error.message : error) }], pages: 0 }));
    const warning = result.rows.find((row) => row.firemodel_warning)?.firemodel_warning;
    return finish("executor_audit_events", "id,created_at,run_id,trace_id,stage,event_slug,market_slug,side,condition_id,token_id,score,coverage,tier,stake_usd,live_eligible,status,reason,source,payload_json", "created_at desc", result.rows, result.pages, warning ? "WARN" : "OK", warning);
  }

  if (queryId === "execution_ledger_v1") {
    const result = await fetchPaged(
      "executor_order_events",
      "id,created_at,run_id,trace_id,event_slug,market_slug,condition_id,token_id,side,stake_usd,status,reason,payload_json",
      { order: { column: "created_at", ascending: false }, limit: 10000 },
    ).catch((error) => ({ rows: [{ firemodel_warning: String(error instanceof Error ? error.message : error) }], pages: 0 }));
    const warning = result.rows.find((row) => row.firemodel_warning)?.firemodel_warning;
    return finish("executor_order_events", "id,created_at,run_id,trace_id,event_slug,market_slug,condition_id,token_id,side,stake_usd,status,reason,payload_json", "created_at desc", result.rows, result.pages, warning ? "WARN" : "OK", warning);
  }

  throw new Error(`REGISTERED_QUERY_HAS_NO_RUNTIME_ADAPTER: ${queryId}`);
}
