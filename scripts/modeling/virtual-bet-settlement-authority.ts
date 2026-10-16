import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { pathToFileURL } from "node:url";

import {
  classifyClobSettlement,
  reconcileSettlement,
  type ClobMarket,
  type GammaAuxiliary,
  type SettlementCheck,
  type StoredSettlementCheck,
} from "@/lib/modeling/virtualBetSettlement";
import { FORWARD_BET_CONTRACT_VERSION } from "@/lib/modeling/forwardBetContract";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const LEDGER_TABLE = "prospective_selection_shadow_runtime";
const AUTHORITY_TABLE = "virtual_bet_settlement_authority";
const MAX_CONDITIONS_PER_RUN = 200;
const TERMINAL_RECHECK_WINDOW_MS = 72 * 60 * 60_000;
const CLOB_BASE = "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

type Bet = { row_key: string; condition_id: string; selected_token_id: string; model_id: string };

function resolveClone(): SupabaseClient {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== CLONE_REF) throw new Error(`REFUSING_NON_CLONE_TARGET: expected ${CLONE_REF}, got ${ref}`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function fetchClob(conditionId: string): Promise<ClobMarket | null> {
  try {
    const response = await fetch(`${CLOB_BASE}/markets/${encodeURIComponent(conditionId)}`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    return body && typeof body === "object" ? body as ClobMarket : null;
  } catch {
    return null;
  }
}

/** Auxiliary only: supplies a provider resolution time and a disagreement cross-check, never a terminal result. */
async function fetchGammaAuxiliary(conditionId: string): Promise<GammaAuxiliary | null> {
  try {
    const response = await fetch(`${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    return Array.isArray(body) && body[0] && typeof body[0] === "object" ? body[0] as GammaAuxiliary : null;
  } catch {
    return null;
  }
}

export async function authorityTableAvailable(db: SupabaseClient): Promise<boolean> {
  const { error } = await db.from(AUTHORITY_TABLE).select("check_id").limit(1);
  if (!error) return true;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST204") return false;
  throw new Error(`SETTLEMENT_AUTHORITY_PROBE:${error.code ?? "FAILED"}`);
}

async function readForwardBets(db: SupabaseClient): Promise<Bet[]> {
  const bets: Bet[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(LEDGER_TABLE)
      .select("row_key,condition_id,selected_token_id,model_id")
      .eq("row_kind", "LEDGER").eq("contract_version", FORWARD_BET_CONTRACT_VERSION)
      .not("condition_id", "is", null).not("selected_token_id", "is", null)
      .order("row_key", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`FORWARD_BET_READ:${error.code ?? "FAILED"}`);
    const page = (data ?? []) as Bet[];
    bets.push(...page);
    if (page.length < 1000) break;
  }
  return bets;
}

async function readHistory(db: SupabaseClient, rowKeys: readonly string[]): Promise<Map<string, StoredSettlementCheck[]>> {
  const history = new Map<string, StoredSettlementCheck[]>();
  for (let from = 0; from < rowKeys.length; from += 100) {
    const { data, error } = await db.from(AUTHORITY_TABLE)
      .select("check_id,bet_row_key,check_kind,outcome,reason,provider_digest,checked_at")
      .in("bet_row_key", rowKeys.slice(from, from + 100)).order("check_id", { ascending: false });
    if (error) throw new Error(`SETTLEMENT_HISTORY_READ:${error.code ?? "FAILED"}`);
    for (const row of (data ?? []) as Array<StoredSettlementCheck & { bet_row_key: string }>) {
      const list = history.get(row.bet_row_key) ?? [];
      list.push(row);
      history.set(row.bet_row_key, list);
    }
  }
  return history;
}

/**
 * Budget order: conditions with an unresolved bet first, then least recently checked first, so a backlog of pending or
 * never-closing conditions cannot starve later models (row_key order) and already-terminal rechecks never outrank them.
 */
export function prioritizeConditions(byCondition: Map<string, Array<{ row_key: string }>>, history: Map<string, Array<Pick<StoredSettlementCheck, "check_kind" | "checked_at">>>): string[] {
  const rank = (bets: Array<{ row_key: string }>) => {
    const rows = bets.map((bet) => history.get(bet.row_key) ?? []);
    const unresolved = rows.some((list) => !list.some((row) => row.check_kind === "TERMINAL"));
    const lastChecked = Math.min(...rows.map((list) => (list[0] ? Date.parse(list[0].checked_at) : 0)));
    return { unresolved, lastChecked };
  };
  return [...byCondition.entries()]
    .map(([condition, bets]) => ({ condition, ...rank(bets) }))
    .sort((a, b) => Number(b.unresolved) - Number(a.unresolved) || a.lastChecked - b.lastChecked || a.condition.localeCompare(b.condition))
    .map((entry) => entry.condition);
}

export type SettlementRunSummary = {
  schemaApplied: boolean;
  forwardBetN: number;
  conditionsQueried: number;
  terminalInserted: number;
  conflictsRecorded: number;
  pendingOrDiagnosticRecorded: number;
  skippedIdentical: number;
  providerAnswerMissing: number;
  duplicateTerminalRejectedByDb: number;
};

/**
 * One reconciliation pass. Idempotent: re-running with an unchanged provider answer writes nothing, and a second
 * terminal economic outcome for a bet is impossible (application check plus a partial unique index).
 */
export async function runSettlementAuthority(db: SupabaseClient, now = new Date(), fetchMarket = fetchClob, fetchAux = fetchGammaAuxiliary): Promise<SettlementRunSummary> {
  const summary: SettlementRunSummary = { schemaApplied: false, forwardBetN: 0, conditionsQueried: 0, terminalInserted: 0, conflictsRecorded: 0, pendingOrDiagnosticRecorded: 0, skippedIdentical: 0, providerAnswerMissing: 0, duplicateTerminalRejectedByDb: 0 };
  if (!(await authorityTableAvailable(db))) return summary;
  summary.schemaApplied = true;
  const bets = await readForwardBets(db);
  summary.forwardBetN = bets.length;
  if (bets.length === 0) return summary;
  const history = await readHistory(db, bets.map((bet) => bet.row_key));
  const nowMs = now.getTime();
  const due = bets.filter((bet) => {
    const rows = history.get(bet.row_key) ?? [];
    const terminal = rows.find((row) => row.check_kind === "TERMINAL");
    return !terminal || nowMs - Date.parse(terminal.checked_at) < TERMINAL_RECHECK_WINDOW_MS;
  });
  const byCondition = new Map<string, Bet[]>();
  for (const bet of due) {
    const list = byCondition.get(bet.condition_id.toLowerCase()) ?? [];
    list.push(bet);
    byCondition.set(bet.condition_id.toLowerCase(), list);
  }
  const conditions = prioritizeConditions(byCondition, history).slice(0, MAX_CONDITIONS_PER_RUN);
  for (const conditionId of conditions) {
    const market = await fetchMarket(conditionId);
    summary.conditionsQueried += 1;
    if (!market) { summary.providerAnswerMissing += byCondition.get(conditionId)!.length; continue; }
    const closed = market.closed === true;
    const gamma = closed ? await fetchAux(conditionId) : null;
    for (const bet of byCondition.get(conditionId)!) {
      const fresh: SettlementCheck = classifyClobSettlement({ conditionId: bet.condition_id, selectedTokenId: bet.selected_token_id }, market, gamma);
      const decision = reconcileSettlement(history.get(bet.row_key) ?? [], fresh, nowMs);
      if (decision.action === "SKIP_IDENTICAL") { summary.skippedIdentical += 1; continue; }
      const { error } = await db.from(AUTHORITY_TABLE).insert({
        bet_row_key: bet.row_key, condition_id: bet.condition_id, selected_token_id: bet.selected_token_id,
        check_kind: decision.check.check_kind, outcome: decision.check.outcome, source_authority: decision.check.source_authority,
        independent_of_selection: decision.check.independent_of_selection, winner_token_id: decision.check.winner_token_id,
        provider_closed: decision.check.provider_closed, provider_resolved_at: decision.check.provider_resolved_at,
        reason: decision.check.reason, provider_digest: decision.check.provider_digest, provider_answer: decision.check.provider_answer,
        conflicts_with_check_id: decision.check.conflicts_with_check_id ?? null,
      });
      if (error) {
        if (error.code === "23505" && decision.check.check_kind === "TERMINAL") { summary.duplicateTerminalRejectedByDb += 1; continue; }
        throw new Error(`SETTLEMENT_WRITE:${error.code ?? "FAILED"}`);
      }
      if (decision.action === "INSERT_CONFLICT") summary.conflictsRecorded += 1;
      else if (decision.check.check_kind === "TERMINAL") summary.terminalInserted += 1;
      else summary.pendingOrDiagnosticRecorded += 1;
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const summary = await runSettlementAuthority(resolveClone());
  console.log(JSON.stringify({ VIRTUAL_BET_SETTLEMENT_AUTHORITY: summary.schemaApplied ? "SUCCESS" : "SCHEMA_NOT_APPLIED", ...summary, productionMoneyWrites: 0, productionWrites: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ VIRTUAL_BET_SETTLEMENT_AUTHORITY: "FAILED", reason: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}
