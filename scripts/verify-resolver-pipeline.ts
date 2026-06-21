import * as envPkg from "@next/env";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

const loadEnvConfig =
  (envPkg as any).loadEnvConfig ?? (envPkg as any).default?.loadEnvConfig;
loadEnvConfig?.(process.cwd());

const DEFAULT_LEDGER = path.join(
  process.cwd(),
  "modeling",
  "morning_model_report",
  "20260618_0600UTC",
  "tables",
  "night_execution_detail.csv",
);

type Row = Record<string, any>;
type LiveTarget = {
  condition_id: string;
  selected_token_id: string;
  event: string;
  source_path: string;
};

function csvSplitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = csvSplitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = csvSplitLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function findLedgerPath(): string | null {
  const explicit = process.argv.find((arg) => arg.startsWith("--live-ledger-path="));
  if (explicit) {
    const value = explicit.split("=").slice(1).join("=");
    return existsSync(value) ? value : null;
  }
  if (existsSync(DEFAULT_LEDGER)) return DEFAULT_LEDGER;

  const roots = [
    path.join(process.cwd(), "modeling", "morning_model_report"),
    path.join(process.cwd(), "reports", "morning"),
  ].filter(existsSync);
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && /night_execution_(detail|truth).*\.csv$/i.test(entry.name)) {
        return full;
      }
    }
  }
  return null;
}

function loadLiveTargets(): { sourcePath: string | null; targets: LiveTarget[] } {
  const sourcePath = findLedgerPath();
  if (!sourcePath) return { sourcePath: null, targets: [] };

  const targets = new Map<string, LiveTarget>();
  for (const row of parseCsv(readFileSync(sourcePath, "utf8"))) {
    const executionType = row.execution_type ?? "";
    const orderStatus = row.order_status ?? "";
    const isLive =
      /live/i.test(executionType) || /\b(sent|filled|matched)\b/i.test(orderStatus);
    const isDryRun = /dry/i.test(executionType) || /dry-run/i.test(orderStatus);
    if (!isLive || isDryRun) continue;

    const sourceRef = row.source_ref ?? "";
    const conditionId = sourceRef.match(/condition_id=([^;\s]+)/i)?.[1];
    const tokenId = sourceRef.match(/(?:selected_token_id|token_id)=([^;\s]+)/i)?.[1];
    if (!conditionId || !tokenId) continue;

    const key = `${conditionId}::${tokenId}`;
    targets.set(key, {
      condition_id: conditionId,
      selected_token_id: tokenId,
      event: row.event ?? "",
      source_path: sourcePath,
    });
  }

  return { sourcePath, targets: [...targets.values()] };
}

function maxIso(rows: Row[], field: string): string {
  const values = rows.map((row) => Date.parse(String(row[field] ?? ""))).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : "";
}

async function fetchAllResolved(supabaseAdmin: any): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("condition_id, selected_token_id, signal_result, resolved_at")
      .not("signal_result", "is", null)
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  const mod = await import("../lib/supabase/server");
  const supabaseAdmin =
    (mod as any).supabaseAdmin ??
    (mod as any).default?.supabaseAdmin ??
    (mod as any)["module.exports"]?.supabaseAdmin;

  const resolvedRows = await fetchAllResolved(supabaseAdmin);
  const strictResolvedTotal = new Set(
    resolvedRows.map((row) => `${row.condition_id}::${row.selected_token_id}`),
  ).size;
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const resolvedLast24h = resolvedRows.filter(
    (row) => Date.parse(String(row.resolved_at ?? "")) >= since24h,
  ).length;

  const { sourcePath, targets } = loadLiveTargets();
  // Two distinct categories:
  //   pending  -> matching signal pair EXISTS in corpus but outcome not resolved yet (NORMAL,
  //               just an open/unsettled live position). Must NOT crash the morning email.
  //   missing  -> executed live target has NO matching row in generated_signal_pairs at all.
  //               That is a real data-integrity contradiction (executed something not in corpus)
  //               and stays FATAL.
  const unresolvedPending: LiveTarget[] = [];
  const missingFromCorpus: LiveTarget[] = [];
  for (const target of targets) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("id, signal_result, resolved_at")
      .eq("condition_id", target.condition_id)
      .eq("selected_token_id", target.selected_token_id);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (!rows.length) {
      missingFromCorpus.push(target);
    } else if (rows.some((row: Row) => !row.signal_result || !row.resolved_at)) {
      unresolvedPending.push(target);
    }
  }

  // Fatal only on real corruption / impossible state — never on a normal pending live row.
  const noResolvedCorpus = strictResolvedTotal === 0;
  const isFatal = noResolvedCorpus || missingFromCorpus.length > 0;
  const status: "PASS" | "PASS_WITH_WARNINGS" | "WARN" | "FAIL" = isFatal
    ? "FAIL"
    : !sourcePath
      ? "WARN"
      : unresolvedPending.length > 0
        ? "PASS_WITH_WARNINGS"
        : "PASS";

  const warningCode = isFatal
    ? noResolvedCorpus
      ? "RESOLVER_NO_RESOLVED_CORPUS"
      : "EXECUTED_LIVE_TARGET_MISSING_FROM_CORPUS"
    : unresolvedPending.length > 0
      ? "UNRESOLVED_EXECUTED_LIVE_ROWS"
      : !sourcePath
        ? "LIVE_LEDGER_ARTIFACT_MISSING"
        : null;

  const code =
    status === "FAIL"
      ? "RESOLVER_PIPELINE_VERIFY_FAIL"
      : status === "PASS_WITH_WARNINGS" || status === "WARN"
        ? "RESOLVER_PIPELINE_VERIFY_PASS_WITH_WARNINGS"
        : "RESOLVER_PIPELINE_VERIFY_PASS";

  console.log(JSON.stringify({
    code,
    status,
    warning_code: warningCode,
    strict_resolved_total: strictResolvedTotal,
    resolved_rows_last_24h: resolvedLast24h,
    max_resolved_at: maxIso(resolvedRows, "resolved_at"),
    live_ledger_artifact: sourcePath ?? "MISSING",
    live_ledger_artifact_warning: sourcePath
      ? null
      : "live ledger artifact missing; Railway must run with artifact present",
    executed_live_targets: targets.length,
    // Pending unresolved live rows are surfaced but tolerated (not fatal).
    unresolved_executed_live_rows: unresolvedPending.length,
    unresolved_examples: unresolvedPending.slice(0, 10),
    // Executed targets absent from corpus ARE fatal — surfaced separately.
    missing_from_corpus_rows: missingFromCorpus.length,
    missing_from_corpus_examples: missingFromCorpus.slice(0, 10),
  }, null, 2));

  if (status === "FAIL") process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
