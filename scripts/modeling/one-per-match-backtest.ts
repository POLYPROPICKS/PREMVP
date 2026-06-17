import { loadEnvConfig } from "@next/env";
import path from "path";
import { mkdir } from "fs/promises";
import {
  persistOnePerMatchBacktest,
  runOnePerMatchBacktestFromRows,
  writeOnePerMatchSummary,
  type BacktestRawRow,
} from "../../lib/modeling/onePerMatchBacktest";

async function fetchRows(): Promise<BacktestRawRow[]> {
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const pageSize = 1000;
  const rows: BacktestRawRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("*")
      .not("signal_result", "is", null)
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`generated_signal_pairs read failed: ${error.message}`);
    const chunk = (data ?? []) as BacktestRawRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function main() {
  loadEnvConfig(process.cwd());
  const outDir = path.resolve(process.cwd(), "reports", "modeling", "one_per_match_backtest");
  await mkdir(outDir, { recursive: true });
  const rows = await fetchRows();
  if (rows.length === 0) throw new Error("BLOCKED_NO_RESOLVED_CORPUS");
  const result = await runOnePerMatchBacktestFromRows(rows, outDir);
  const dbStatus = await persistOnePerMatchBacktest(result);
  result.dbStatus = dbStatus;
  await writeOnePerMatchSummary(result);
  console.log(JSON.stringify({
    runId: result.runId,
    rawRows: result.rawRows,
    resolvedRows: result.resolvedRows,
    uniqueEventGroups: result.uniqueEventGroups,
    selectedRows: result.selectedRows,
    comparisonRows: result.comparisonRows,
    dbStatus,
    artifacts: result.artifactPaths,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
