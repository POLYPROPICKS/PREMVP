import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FORWARD_BET_CONTRACT_VERSION, hasExecutableAuthority, isAuthoritativePreMatch, isScheduledOnlyPreMatch } from "@/lib/modeling/forwardBetContract";
import { buildTrackRegistry, type TrackInfo } from "@/lib/research/strategyTrackLabels";
import { MODEL_IDS } from "./prospective-selection-shadow";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const OUTPUT_DIR = "modeling/evidence/forward-bet-ledger-v1";
/** Documented reporting floor, not a strategy parameter: no verdict before this many independent settled forward games. */
export const MIN_FORWARD_GAMES_FOR_VERDICT = 100;
export const UNPROVEN = "UNPROVEN";

export type LedgerLine = {
  row_key: string; model_id: string; physical_event_key: string; settlement_state: string | null;
  first_persisted_at: string | null; contract_version: string | null; contract_status: string | null; timing_class: string | null;
  verification_status?: string | null; game_identity_basis?: string | null; canonical_game_key?: string | null;
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

/**
 * Six separate counts per strategy, never merged into one "proven" number:
 *  recordedBet                       every stored BET (historical corpus + legacy DB-first + contract);
 *  dbFirstPersisted                  rows with a database-owned first-save time;
 *  scheduledOnlyPreMatch             contract rows saved before the SCHEDULED start (actual start unproven);
 *  authoritativelyProvenPreMatchGames  saved before an independently sourced actual start (distinct games);
 *  verifiedIndependentGames          timing + physical-game identity + scope each proven (distinct games);
 *  settled                           independent CLOB terminal results (W/L/V) and the remainder UNKNOWN.
 */
export function buildCeoRows(ledger: readonly LedgerLine[], terminals: readonly TerminalLine[]) {
  const terminalByBet = new Map(terminals.map((t) => [t.bet_row_key, t.outcome]));
  const gameKey = (r: LedgerLine) => r.canonical_game_key ?? r.physical_event_key;
  const distinctGames = (rows: readonly LedgerLine[]) => new Set(rows.map(gameKey)).size;
  const wlvu = (rows: readonly LedgerLine[]) => {
    const w = rows.filter((r) => terminalByBet.get(r.row_key) === "WIN").length;
    const l = rows.filter((r) => terminalByBet.get(r.row_key) === "LOSS").length;
    const v = rows.filter((r) => terminalByBet.get(r.row_key) === "VOID").length;
    return { w, l, v, u: rows.length - w - l - v, text: `${w}–${l}–${v}–${rows.length - w - l - v}` };
  };
  const rows = (model: string) => {
    const mine = ledger.filter((r) => r.model_id === model);
    const historical = mine.filter((r) => !r.first_persisted_at);
    const legacyForward = mine.filter((r) => r.first_persisted_at && r.contract_version !== FORWARD_BET_CONTRACT_VERSION);
    const forward = mine.filter((r) => r.contract_version === FORWARD_BET_CONTRACT_VERSION);
    const scheduledOnly = forward.filter((r) => isScheduledOnlyPreMatch(r.timing_class));
    const authoritative = forward.filter((r) => isAuthoritativePreMatch(r.timing_class));
    const verified = forward.filter((r) => r.verification_status === "VERIFIED");
    const lateOrReplay = forward.filter((r) => r.timing_class === "LATE_OR_REPLAY");
    const timingUnproven = forward.filter((r) => r.timing_class === "TIMING_UNPROVEN" || !r.timing_class);
    const count = (set: readonly LedgerLine[], state: string) => set.filter((r) => r.settlement_state === state).length;
    const hw = count(historical, "WIN"), hl = count(historical, "LOSS"), hu = count(historical, "UNQUERIED");
    const allSettlement = wlvu(forward);
    const verifiedSettlement = wlvu(verified);
    const verifiedDecided = verifiedSettlement.w + verifiedSettlement.l;
    const executable = forward.filter(hasExecutableAuthority).length;
    const economics = verified.length > 0 && executable === forward.length ? "REQUIRES_EXECUTABLE_PNL_RUN" : UNPROVEN;
    const unprovenLinks = forward.reduce<Record<string, number>>((acc, r) => {
      const status = r.verification_status ?? "UNVERIFIED:contract_incomplete";
      if (status === "VERIFIED") return acc;
      for (const link of status.replace("UNVERIFIED:", "").split(",")) acc[link] = (acc[link] ?? 0) + 1;
      return acc;
    }, {});
    const verdict = forward.length === 0 ? "NO_FORWARD_CONTRACT_BETS_YET"
      : verified.length === 0 ? "FORWARD_RECORDED_NOT_VERIFIED"
      : verifiedDecided === 0 ? "TERMINAL_OUTCOME_PENDING"
      : verifiedDecided < MIN_FORWARD_GAMES_FOR_VERDICT ? "NO_VERDICT_INSUFFICIENT_FORWARD_SAMPLE" : "ELIGIBLE_FOR_HOLDOUT_COMPARISON";
    return {
      strategy: model,
      historical: {
        bet: historical.length, wlvu: `${hw}–${hl}–0–${hu}`, originalWinPct: pct(hw, hw + hl), originalWinPctInterval95: wilson(hw, hw + hl),
        independentProvenGames: 0, semanticallyValidatedWinPct: UNPROVEN, gross: UNPROVEN, fees: UNPROVEN, netRoi: UNPROVEN,
        verdict: "HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE",
      },
      legacyForwardWithoutContract: { bet: legacyForward.length, note: "DB-first persisted before the contract existed; timing and identity unproven" },
      funnel: {
        recordedBet: mine.length,
        dbFirstPersisted: mine.filter((r) => !!r.first_persisted_at).length,
        scheduledOnlyPreMatch: scheduledOnly.length,
        authoritativelyProvenPreMatchGames: distinctGames(authoritative),
        verifiedIndependentGames: distinctGames(verified),
        settled: { contractWlvu: allSettlement.text, verifiedWlvu: verifiedSettlement.text },
        lateOrReplay: lateOrReplay.length, timingUnproven: timingUnproven.length, unprovenLinks,
      },
      forward: {
        // Display key kept for the table: only verified games are "independent".
        independentProvenGames: distinctGames(verified), verifiedIndependentGames: distinctGames(verified), bet: forward.length, wlvu: allSettlement.text,
        originalWinPct: UNPROVEN,
        semanticallyValidatedWinPct: pct(verifiedSettlement.w, verifiedDecided), semanticallyValidatedInterval95: wilson(verifiedSettlement.w, verifiedDecided),
        settlementOnlyWinPctUnverifiedScope: pct(allSettlement.w, allSettlement.w + allSettlement.l),
        gross: economics, fees: economics, netRoi: economics,
        confidence: verifiedDecided < MIN_FORWARD_GAMES_FOR_VERDICT ? `INSUFFICIENT (verified settled n=${verifiedDecided})` : "SUFFICIENT_FOR_COMPARISON",
        furtherGamesNeeded: Math.max(0, MIN_FORWARD_GAMES_FOR_VERDICT - verifiedDecided),
        verdict,
      },
    };
  };
  return MODEL_IDS.map(rows);
}

export type DecisionLine = { strategy_id: string; status: string; provenance_class: string | null; entry_cost_authority: string | null; physical_event_id: string };
export const TEN_TRACK_HEADER = "| Стратегия | Independent games | BET | WIN–LOSS–VOID–UNKNOWN | Timing proof | Price proof | Gross/Fees/Net ROI | Confidence | Verdict |\n|---|---|---|---|---|---|---|---|---|";

/** One compact row per approved research track. Labels are display-only; modes come from the strategy registries. */
export function buildTenTrackRows(safe: ReturnType<typeof buildCeoRows>, decisions: readonly DecisionLine[], registry: readonly TrackInfo[] = buildTrackRegistry()) {
  return registry.map((track) => {
    const base = { canonicalId: track.canonicalId, displayName: track.displayName, group: track.group, mode: track.mode, canEmitBet: track.canEmitBet };
    if (track.group === "PREMATCH") {
      const row = safe.find((r) => r.strategy === track.canonicalId)!;
      const f = row.funnel;
      const noTime = row.historical.bet + row.legacyForwardWithoutContract.bet;
      return {
        ...base, independentGames: f.verifiedIndependentGames, bet: row.forward.bet, wlvu: row.forward.wlvu,
        timingProof: `авторитетно до старта: ${f.authoritativelyProvenPreMatchGames}; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): ${f.scheduledOnlyPreMatch}; поздно/повтор: ${f.lateOrReplay}; без доказательства: ${f.timingUnproven + noTime}`,
        priceProof: row.forward.bet > 0 ? "REFERENCE (не исполнимая цена)" : UNPROVEN,
        economics: `${row.forward.gross}/${row.forward.fees}/${row.forward.netRoi}`, confidence: row.forward.confidence, verdict: row.forward.verdict,
      };
    }
    const mine = decisions.filter((d) => d.strategy_id === track.canonicalId);
    const bets = mine.filter((d) => d.status === "BET");
    const count = (cls: string) => bets.filter((d) => d.provenance_class === cls).length;
    if (!track.canEmitBet) {
      return { ...base, independentGames: 0, bet: bets.length, wlvu: "n/a", timingProof: "n/a (facts-only)", priceProof: "n/a (facts-only)", economics: `${UNPROVEN}/${UNPROVEN}/${UNPROVEN}`, confidence: "n/a", verdict: bets.length === 0 ? "FACTS_ONLY_NO_BET" : "VIOLATION_ALPHA_BET_PRESENT" };
    }
    const executable = bets.filter((d) => d.entry_cost_authority === "FULL_STAKE_EXECUTABLE_BUY_VWAP").length;
    const games = new Set(bets.map((d) => d.physical_event_id)).size;
    return {
      ...base, independentGames: games, bet: bets.length, wlvu: `${UNPROVEN} (результат не сохраняется в Ledger)`,
      timingProof: `DELAYED_PAPER: ${count("DELAYED_PAPER")}; LIVE_PROSPECTIVE: ${count("LIVE_PROSPECTIVE")}; TIMING_UNPROVEN: ${count("TIMING_UNPROVEN")}`,
      priceProof: bets.length === 0 ? UNPROVEN : `исполнимый BUY VWAP полного стейка: ${executable}/${bets.length}`,
      economics: `${UNPROVEN}/${UNPROVEN}/${UNPROVEN}`, confidence: games < MIN_FORWARD_GAMES_FOR_VERDICT ? `INSUFFICIENT (games n=${games})` : "SUFFICIENT_FOR_COMPARISON",
      verdict: count("LIVE_PROSPECTIVE") === bets.length && bets.length > 0 ? "LIVE_PROSPECTIVE" : "DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE",
    };
  });
}

export function renderTenTrackMarkdown(rows: ReturnType<typeof buildTenTrackRows>): string {
  const body = rows.map((r) => `| ${r.displayName} (\`${r.canonicalId}\`) | ${r.independentGames} | ${r.bet} | ${r.wlvu} | ${r.timingProof} | ${r.priceProof} | ${r.economics} | ${r.confidence} | ${r.verdict} |`);
  const modes = rows.map((r) => `| ${r.displayName} | \`${r.canonicalId}\` | ${r.group} | ${r.mode} | ${r.canEmitBet} |`);
  return [
    "## Десять исследовательских дорожек", TEN_TRACK_HEADER, ...body, "",
    "## Режимы дорожек (из реестров стратегий, названия — только отображение)", "| Название | Canonical ID | Группа | Режим | canEmitBet |\n|---|---|---|---|---|", ...modes, "",
  ].join("\n");
}

export function renderFunnelMarkdown(table: ReturnType<typeof buildCeoRows>): string {
  const head = "| Стратегия | Все записанные BET | DB-first (время в БД) | До старта по расписанию | Авторитетно до старта (игры) | Проверенные независимые игры | Независимый расчёт W–L–VOID–UNKNOWN | Первые недоказанные звенья |\n|---|---|---|---|---|---|---|---|";
  const body = table.map((r) => `| ${r.strategy} | ${r.funnel.recordedBet} | ${r.funnel.dbFirstPersisted} | ${r.funnel.scheduledOnlyPreMatch} | ${r.funnel.authoritativelyProvenPreMatchGames} | ${r.funnel.verifiedIndependentGames} | ${r.funnel.settled.contractWlvu} | ${Object.entries(r.funnel.unprovenLinks).map(([k, v]) => `${k}:${v}`).join(", ") || (r.forward.bet === 0 ? "контрактных BET ещё нет" : "—")} |`);
  return ["## Воронка доказательств (пять прематч-стратегий; уровни не смешиваются)", head, ...body, ""].join("\n");
}

export function renderMarkdown(generatedAt: string, table: ReturnType<typeof buildCeoRows>): string {
  const head = "| Strategy | verified independent games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
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
  const columns = "row_key,model_id,physical_event_key,settlement_state,first_persisted_at" + (schema ? ",contract_version,contract_status,verification_status,game_identity_basis,canonical_game_key,timing_class,executable_buy_price,executable_price_authority" : "");
  const raw = await readLedgerRows(db, columns);
  const ledger: LedgerLine[] = raw.map((r) => ({ contract_version: null, contract_status: null, timing_class: null, executable_buy_price: null, executable_price_authority: null, ...r })) as unknown as LedgerLine[];
  let terminals: TerminalLine[] = [];
  if (schema) {
    const authority = await db.from("virtual_bet_settlement_authority").select("bet_row_key,outcome").eq("check_kind", "TERMINAL");
    if (!authority.error) terminals = (authority.data ?? []) as TerminalLine[];
  }
  const decisionLines: DecisionLine[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("research_inplay_paper_decisions").select("strategy_id,status,provenance_class,entry_cost_authority,physical_event_id").order("decision_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`decisions:${error.code ?? error.message}`);
    decisionLines.push(...(data ?? []) as DecisionLine[]);
    if ((data ?? []).length < 1000) break;
  }
  const generatedAt = new Date().toISOString();
  const table = buildCeoRows(ledger, terminals);
  const tenTracks = buildTenTrackRows(table, decisionLines);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, "CEO_REPORT.json"), `${JSON.stringify({ generatedAt, contractSchemaApplied: schema, ledgerRowN: ledger.length, decisionRowN: decisionLines.length, tenTracks, table }, null, 2)}\n`);
  const markdown = `${renderTenTrackMarkdown(tenTracks)}\n${renderFunnelMarkdown(table)}\n${renderMarkdown(generatedAt, table)}`;
  writeFileSync(join(OUTPUT_DIR, "CEO_REPORT.md"), markdown);
  console.log(markdown);
  console.log(`CONTRACT_SCHEMA_APPLIED=${schema} LEDGER_ROWS=${ledger.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
