/** Bounded, read-only Step 4B conservation and settlement audit. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadFrozenFootballDenominatorV2 } from "./load-frozen-football-denominator-v2";
import { buildStructuralCandidates, connectClone, displayOdds, isOrdinaryHold, computeCell, type StructuralCandidate } from "./football-structural-authority";
import { resolveGammaTerminal } from "./live-d1-research-corpus";
import { runStandaloneStrict } from "./daily-portfolio-frontier";
import type { SourceRow, OverlayRecord } from "./build-football-denominator-reconciliation";

const OUT = "modeling/evidence/step4b-sep1-12-authority-reconciliation-v1";
const START = "2026-09-01";
const END = "2026-09-12";
const ODDS_MIN = 1.75;
const ODDS_MAX = 2;
const key = (r: SourceRow | OverlayRecord) => [r.model_date, r.population_id, r.condition_id, r.selected_token_id, r.decision_at].join("::");
const pairKey = (r: Pick<SourceRow, "condition_id" | "selected_token_id">) => `${r.condition_id}::${r.selected_token_id}`;

function classifyEvent(rows: Array<{ row: SourceRow; overlay: OverlayRecord | null }>) {
  const ov = rows.map((x) => x.overlay).filter((x): x is OverlayRecord => x !== null);
  if (ov.length === 0) return "MISSING_OVERLAY";
  if (!ov.some((x) => x.reconciled_sport_family === "soccer")) return "NOT_CANONICAL_SOCCER";
  if (ov.some((x) => isOrdinaryHold(x.reconciled_market_type))) return "PROVEN_ORDINARY";
  if (ov.some((x) => x.reconciled_market_type === "soccer_exact_score")) return "EXACT_SCORE";
  if (ov.some((x) => x.market_type_source === "MARKET_TYPE_CONFLICT")) return "CONFLICT";
  return "UNRESOLVED";
}

async function main() {
  const db = await connectClone();
  const frozen = await loadFrozenFootballDenominatorV2(db);
  const overlayByKey = new Map(frozen.overlay.map((o) => [key(o), o]));
  const allBandRows = frozen.sourceRows.filter((r) => r.model_date >= START && r.model_date <= END
    && r.entry_price_num !== null && displayOdds(r.entry_price_num) >= ODDS_MIN && displayOdds(r.entry_price_num) < ODDS_MAX);
  const sourceRows = allBandRows.filter((r) => r.sport_family === "soccer");
  const joined = sourceRows.map((row) => ({ row, overlay: overlayByKey.get(key(row)) ?? null }));
  const fullJoined = allBandRows.map((row) => ({ row, overlay: overlayByKey.get(key(row)) ?? null }));
  const byEvent = new Map<string, typeof joined>();
  for (const entry of joined) {
    const id = entry.row.provider_event_id ?? "";
    const group = byEvent.get(id) ?? [];
    group.push(entry); byEvent.set(id, group);
  }
  const reasons: Record<string, number> = {};
  for (const group of byEvent.values()) {
    const reason = classifyEvent(group);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const canonicalJoined = fullJoined.filter((j) => j.overlay?.reconciled_sport_family === "soccer");
  const lineage: Record<string, number> = {};
  for (const { overlay } of canonicalJoined) {
    const source = overlay?.market_type_source ?? "MISSING_OVERLAY";
    lineage[source] = (lineage[source] ?? 0) + 1;
  }
  const canonicalByEvent = new Map<string, typeof joined>();
  for (const entry of canonicalJoined) {
    const id = entry.row.provider_event_id ?? "";
    const group = canonicalByEvent.get(id) ?? [];
    group.push(entry); canonicalByEvent.set(id, group);
  }
  const canonicalReasons: Record<string, number> = {};
  for (const group of canonicalByEvent.values()) {
    const reason = classifyEvent(group);
    canonicalReasons[reason] = (canonicalReasons[reason] ?? 0) + 1;
  }
  const canonicalEvents = new Set(canonicalJoined.map((j) => j.row.provider_event_id).filter(Boolean));
  const recoveredCanonicalEvents = new Set(canonicalJoined.filter((j) => j.row.sport_family !== "soccer")
    .map((j) => j.row.provider_event_id).filter(Boolean));
  const { candidates, settlementByCandidateIdentity } = buildStructuralCandidates(allBandRows, fullJoined.map((j) => j.overlay).filter((o): o is OverlayRecord => o !== null));
  const eligible = candidates.filter((c) => isOrdinaryHold(c.marketTypeRaw) && displayOdds(c.entryPrice) >= ODDS_MIN && displayOdds(c.entryPrice) < ODDS_MAX);
  const selected = runStandaloneStrict(candidates, (c) => isOrdinaryHold(c.marketTypeRaw) && displayOdds(c.entryPrice) >= ODDS_MIN && displayOdds(c.entryPrice) < ODDS_MAX);
  const rowEconomics = computeCell(candidates, settlementByCandidateIdentity,
    (c) => isOrdinaryHold(c.marketTypeRaw) && displayOdds(c.entryPrice) >= ODDS_MIN && displayOdds(c.entryPrice) < ODDS_MAX);
  const selectedRows = new Map(allBandRows.map((r) => [`${r.condition_id}::${r.selected_token_id}::${r.decision_at}`, r]));
  const selectedPairs = [...new Map(selected.map((s) => {
    const row = selectedRows.get(s.candidateIdentity);
    if (!row) throw new Error(`SELECTED_SOURCE_MISSING:${s.candidateIdentity}`);
    return [pairKey(row), row] as const;
  })).values()];
  const report: Record<string, unknown> = {
    MISSION: "STEP4B_SEP1_12_AUTHORITY_RECONCILIATION_V1",
    NOT_EXECUTION_AUTHORITY: true,
    FROZEN_OVERLAY_ROW_N: frozen.overlay.length,
    SOURCE_ROW_N: sourceRows.length,
    MARKET_IDENTITY_N: new Set(sourceRows.map(pairKey)).size,
    PHYSICAL_EVENT_N: byEvent.size,
    FULL_BAND_SOURCE_ROW_N: allBandRows.length,
    FULL_BAND_CANONICAL_SOCCER_EVENT_N: canonicalEvents.size,
    FULL_BAND_RECOVERED_SOCCER_EVENT_N: recoveredCanonicalEvents.size,
    CANONICAL_SOCCER_EVENT_N: byEvent.size - (reasons.NOT_CANONICAL_SOCCER ?? 0) - (reasons.MISSING_OVERLAY ?? 0),
    EVENT_EXCLUSIVE_REASONS: reasons,
    FULL_CANONICAL_EVENT_EXCLUSIVE_REASONS: canonicalReasons,
    MARKET_TYPE_LINEAGE_CANONICAL_SOCCER_ROWS: lineage,
    BAND_ELIGIBLE_EVENT_N: new Set(eligible.map((c) => c.physicalEventKey)).size,
    ONE_EVENT_SELECTED_N: selected.length,
    STRICT_SELECTED_SOURCE_SPORT: selected.reduce((acc, s) => {
      const source = selectedRows.get(s.candidateIdentity)?.sport_family ?? "NULL";
      acc[source] = (acc[source] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    ROW_SNAPSHOT_SETTLED_N: sourceRows.filter((r) => r.settlement_label === "WIN" || r.settlement_label === "LOSS").length,
    ROW_SNAPSHOT_OPEN_N: sourceRows.filter((r) => r.settlement_label === "OPEN").length,
    STRICT_ROW_SNAPSHOT: rowEconomics,
    REFERENCE_PROVENANCE: "UNRECOVERED",
  };
  if (sourceRows.length !== 302 || selected.length !== 68 || rowEconomics.N_SETTLED !== 50) {
    throw new Error(`KNOWN_AUTHORITY_BRIDGE_MISMATCH:${JSON.stringify({ SOURCE: sourceRows.length, SELECTED: selected.length, SETTLED: rowEconomics.N_SETTLED })}`);
  }
  mkdirSync(OUT, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(`${OUT}/${name}`, JSON.stringify(value, null, 2) + "\n");
  write("CONSERVATION.json", report);
  console.error(JSON.stringify({ STAGE: "CONSERVATION_READY", SOURCE: sourceRows.length, EVENTS: byEvent.size, REASONS: reasons, STRICT: rowEconomics }));
  if (!process.argv.includes("--gamma-selected")) return;

  const gammaByPair = new Map<string, Awaited<ReturnType<typeof resolveGammaTerminal>>>();
  for (let i = 0; i < selectedPairs.length; i += 8) {
    const chunk = selectedPairs.slice(i, i + 8);
    const results = await Promise.all(chunk.map((r) => resolveGammaTerminal(r.condition_id, r.selected_token_id, r.entry_price_num)));
    chunk.forEach((r, j) => gammaByPair.set(pairKey(r), results[j]));
    console.error(JSON.stringify({ STAGE: "GAMMA_SELECTED", DONE: Math.min(i + 8, selectedPairs.length), TOTAL: selectedPairs.length }));
  }
  const matches = { MATCH_WIN_N: 0, MATCH_LOSS_N: 0, MATCH_OPEN_N: 0, ROW_OPEN_GAMMA_WIN_N: 0,
    ROW_OPEN_GAMMA_LOSS_N: 0, ROW_TERMINAL_GAMMA_DIFFERENT_N: 0, GAMMA_UNAVAILABLE_N: 0 };
  const gammaSettlement = new Map(settlementByCandidateIdentity);
  const frozenLabels: Array<{ condition_id: string; selected_token_id: string; terminal: string | null; resolver_state: string }> = [];
  for (const row of selectedPairs) {
    const gamma = gammaByPair.get(pairKey(row))!;
    frozenLabels.push({ condition_id: row.condition_id, selected_token_id: row.selected_token_id,
      terminal: gamma.terminal, resolver_state: gamma.resolverState });
  }
  for (const selectedRow of selected) {
    const row = selectedRows.get(selectedRow.candidateIdentity)!;
    const gamma = gammaByPair.get(pairKey(row))!;
    const old = row.settlement_label;
    const next = gamma.terminal ?? "OPEN";
    gammaSettlement.set(selectedRow.candidateIdentity, next);
    if (gamma.terminal === null) matches.GAMMA_UNAVAILABLE_N++;
    if (old === "WIN" && next === "WIN") matches.MATCH_WIN_N++;
    else if (old === "LOSS" && next === "LOSS") matches.MATCH_LOSS_N++;
    else if (old === "OPEN" && next === "OPEN") matches.MATCH_OPEN_N++;
    else if (old === "OPEN" && next === "WIN") matches.ROW_OPEN_GAMMA_WIN_N++;
    else if (old === "OPEN" && next === "LOSS") matches.ROW_OPEN_GAMMA_LOSS_N++;
    else if ((old === "WIN" || old === "LOSS") && old !== next) matches.ROW_TERMINAL_GAMMA_DIFFERENT_N++;
  }
  const gammaEconomics = computeCell(candidates, gammaSettlement,
    (c) => isOrdinaryHold(c.marketTypeRaw) && displayOdds(c.entryPrice) >= ODDS_MIN && displayOdds(c.entryPrice) < ODDS_MAX);
  report.GAMMA_RECONCILIATION = matches;
  report.STRICT_FRESH_GAMMA = gammaEconomics;
  write("CONSERVATION.json", report);
  frozenLabels.sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  write("FRESH_GAMMA_SELECTED_LABELS.json", frozenLabels);
  const sha = createHash("sha256").update(JSON.stringify(frozenLabels, null, 2) + "\n").digest("hex");
  writeFileSync(`${OUT}/SHA256SUMS.txt`, `${sha}  FRESH_GAMMA_SELECTED_LABELS.json\n`);
  console.log(JSON.stringify({ STATUS: "PASS", MATCHES: matches, SNAPSHOT: rowEconomics, GAMMA: gammaEconomics, LABELS_SHA256: sha }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
}
