import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FORWARD_BET_CONTRACT_VERSION, hasExecutableAuthority, isForwardPreMatch } from "@/lib/modeling/forwardBetContract";
import { MODEL_IDS } from "./prospective-selection-shadow";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const OUTPUT_DIR = "modeling/evidence/forward-bet-ledger-v1";
/** Documented reporting floor, not a strategy parameter: no verdict before this many independent settled forward games. */
export const MIN_FORWARD_GAMES_FOR_VERDICT = 100;
export const UNPROVEN = "UNPROVEN";

export type LedgerLine = {
  row_key: string; model_id: string; physical_event_key: string; settlement_state: string | null;
  first_persisted_at: string | null; contract_version: string | null; contract_status: string | null; timing_class: string | null;
  executable_buy_price: number | string | null; executable_price_authority: string | null;
};
export type TerminalLine = { bet_row_key: string; outcome: "WIN" | "LOSS" | "VOID" };

function wilson(wins: number, n: number): string {
  if (n === 0) return "n=0";
  const z = 1.96; const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return `[${((centre - half) * 100).toFixed(1)}%, ${((centre + half) * 100).toFixed(1)}%]`;
}
const pct = (wins: number, n: number) => n === 0 ? UNPROVEN : `${(wins / n * 100).toFixed(1)}%`;

export function buildCeoRows(ledger: readonly LedgerLine[], terminals: readonly TerminalLine[]) {
  const terminalByBet = new Map(terminals.map((t) => [t.bet_row_key, t.outcome]));
  const rows = (model: string) => {
    const mine = ledger.filter((r) => r.model_id === model);
    const historical = mine.filter((r) => !r.first_persisted_at);
    const legacyForward = mine.filter((r) => r.first_persisted_at && r.contract_version !== FORWARD_BET_CONTRACT_VERSION);
    const forward = mine.filter((r) => r.contract_version === FORWARD_BET_CONTRACT_VERSION);
    const proven = forward.filter((r) => r.contract_status === "COMPLETE" && isForwardPreMatch(r.timing_class));
    const provenGames = new Set(proven.map((r) => r.physical_event_key));
    const count = (set: readonly LedgerLine[], state: string) => set.filter((r) => r.settlement_state === state).length;
    const hw = count(historical, "WIN"), hl = count(historical, "LOSS"), hu = count(historical, "UNQUERIED");
    const fw = proven.filter((r) => terminalByBet.get(r.row_key) === "WIN").length;
    const fl = proven.filter((r) => terminalByBet.get(r.row_key) === "LOSS").length;
    const fv = proven.filter((r) => terminalByBet.get(r.row_key) === "VOID").length;
    const fu = proven.length - fw - fl - fv;
    const settled = fw + fl;
    const executable = proven.filter(hasExecutableAuthority).length;
    const economics = executable > 0 && executable === proven.length ? "REQUIRES_EXECUTABLE_PNL_RUN" : UNPROVEN;
    return {
      strategy: model,
      historical: {
        bet: historical.length, wlvu: `${hw}–${hl}–0–${hu}`, originalWinPct: pct(hw, hw + hl), originalWinPctInterval95: wilson(hw, hw + hl),
        independentProvenGames: 0, semanticallyValidatedWinPct: UNPROVEN, gross: UNPROVEN, fees: UNPROVEN, netRoi: UNPROVEN,
        verdict: "HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE",
      },
      legacyForwardWithoutContract: { bet: legacyForward.length, note: "DB-first persisted before the contract existed; not counted as proven" },
      forward: {
        independentProvenGames: provenGames.size, bet: forward.length, wlvu: `${fw}–${fl}–${fv}–${fu}`,
        originalWinPct: UNPROVEN, semanticallyValidatedWinPct: pct(fw, settled), semanticallyValidatedInterval95: wilson(fw, settled),
        gross: economics, fees: economics, netRoi: economics,
        confidence: settled < MIN_FORWARD_GAMES_FOR_VERDICT ? `INSUFFICIENT (settled n=${settled})` : "SUFFICIENT_FOR_COMPARISON",
        furtherGamesNeeded: Math.max(0, MIN_FORWARD_GAMES_FOR_VERDICT - settled),
        verdict: settled === 0 ? (provenGames.size === 0 ? "NO_FORWARD_CONTRACT_BETS_YET" : "TERMINAL_OUTCOME_PENDING") : settled < MIN_FORWARD_GAMES_FOR_VERDICT ? "NO_VERDICT_INSUFFICIENT_FORWARD_SAMPLE" : "ELIGIBLE_FOR_HOLDOUT_COMPARISON",
      },
    };
  };
  return MODEL_IDS.map(rows);
}

export function renderMarkdown(generatedAt: string, table: ReturnType<typeof buildCeoRows>): string {
  const head = "| Strategy | independent proven games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
  const forward = table.map((r) => `| ${r.strategy} | ${r.forward.independentProvenGames} | ${r.forward.bet} | ${r.forward.wlvu} | ${r.forward.originalWinPct} | ${r.forward.semanticallyValidatedWinPct} | ${r.forward.gross} | ${r.forward.fees} | ${r.forward.netRoi} | ${r.forward.confidence} | ${r.forward.furtherGamesNeeded} | ${r.forward.verdict} |`);
  const history = table.map((r) => `| ${r.strategy} | ${r.historical.independentProvenGames} | ${r.historical.bet} | ${r.historical.wlvu} | ${r.historical.originalWinPct} ${r.historical.originalWinPctInterval95} | ${r.historical.semanticallyValidatedWinPct} | ${r.historical.gross} | ${r.historical.fees} | ${r.historical.netRoi} | n/a (reference) | n/a | ${r.historical.verdict} |`);
  return [
    "# Forward BET ledger — CEO report (five SAFE strategies)", "", `Generated: ${generatedAt} (DBClone, read-only)`, "",
    "## Forward corpus (FORWARD_BET_V1, DB-first, independent CLOB settlement)", head, ...forward, "",
    "## Historical corpus (frozen, first persistence unknown, Gamma-settled — reference only)", head, ...history, "",
    "Legacy DB-first rows without the contract (not counted as proven): " + table.map((r) => `${r.strategy}=${r.legacyForwardWithoutContract.bet}`).join(", "), "",
    "`UNPROVEN` = not established by evidence (never zero). Gross/Fees/Net ROI stay UNPROVEN until every counted BET carries an executable BUY authority.", "",
  ].join("\n");
}

type Rows = Array<Record<string, unknown>>;
async function readLedgerRows(db: SupabaseClient, columns: string): Promise<Rows> {
  const out: Rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("prospective_selection_shadow_runtime").select(columns).eq("row_kind", "LEDGER").order("row_key", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`ledger:${error.code ?? error.message}`);
    out.push(...(data ?? []) as unknown as Rows);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const url = process.env.SUPABASE_CLONE_URL; const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  if (new URL(url).hostname.split(".")[0] !== CLONE_REF) throw new Error("REFUSING_NON_CLONE_TARGET");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await db.from("prospective_selection_shadow_runtime").select("contract_version").limit(1);
  const schema = !probe.error;
  const columns = "row_key,model_id,physical_event_key,settlement_state,first_persisted_at" + (schema ? ",contract_version,contract_status,timing_class,executable_buy_price,executable_price_authority" : "");
  const raw = await readLedgerRows(db, columns);
  const ledger: LedgerLine[] = raw.map((r) => ({ contract_version: null, contract_status: null, timing_class: null, executable_buy_price: null, executable_price_authority: null, ...r })) as unknown as LedgerLine[];
  let terminals: TerminalLine[] = [];
  if (schema) {
    const authority = await db.from("virtual_bet_settlement_authority").select("bet_row_key,outcome").eq("check_kind", "TERMINAL");
    if (!authority.error) terminals = (authority.data ?? []) as TerminalLine[];
  }
  const generatedAt = new Date().toISOString();
  const table = buildCeoRows(ledger, terminals);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, "CEO_REPORT.json"), `${JSON.stringify({ generatedAt, contractSchemaApplied: schema, ledgerRowN: ledger.length, table }, null, 2)}\n`);
  writeFileSync(join(OUTPUT_DIR, "CEO_REPORT.md"), renderMarkdown(generatedAt, table));
  console.log(renderMarkdown(generatedAt, table));
  console.log(`CONTRACT_SCHEMA_APPLIED=${schema} LEDGER_ROWS=${ledger.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
