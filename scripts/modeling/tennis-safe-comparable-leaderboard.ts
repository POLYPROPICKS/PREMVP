/**
 * TENNIS_SAFE_COMPARABLE_LEADERBOARD_V1 — rebuilds the CURRENT comparable
 * model leaderboard over ONE shared safe-tennis universe, on the
 * SELECTION_BEFORE_SETTLEMENT_V1 shared fixed path (PR #379): settlement
 * never participates in safe-tennis qualification, model qualification,
 * physical-event candidate selection, or daily capacity allocation. It is
 * joined back ONLY after selection+cap.
 *
 * The old generic tennis population mixed a profitable
 * tennis_completed_match regime with ordinary/low-tier tennis that should
 * never have been eligible. This runner filters TENNIS candidates to only
 * those that pass the shared live-money gate
 * (lib/executor/tennisLiveEligibility.ts resolveTennisMoneyEligibility —
 * imported verbatim, never re-implemented here) BEFORE any model predicate
 * runs, on DECISION-TIME candidates, so every _SAFE variant below shares the
 * exact same corrected tennis universe and settlement never influences which
 * tennis rows are even eligible. Non-tennis rows are unaffected.
 *
 * Reuses the existing engine verbatim — no second sync/capacity engine, no
 * duplicated tennis rule, no duplicated live-mix rule:
 *   - C0/C4/C5 frozen predicates: lib/modeling/research-engine/models.ts
 *   - PORTFOLIO_BROAD tiers: scripts/modeling/daily-portfolio-frontier.ts
 *   - QUALITY_FILL_A/D tiers: scripts/modeling/quality-fill-portfolio-test.ts
 *   - toDecisionTimeSelectionInput: scripts/modeling/factor-atlas.ts
 *   - runStandaloneStrict/runPortfolioStrict/applyDailyCap/
 *     computePartialCapacity/partialMetricsFor/settledBetsOnly/metricsFor:
 *     scripts/modeling/daily-portfolio-frontier.ts
 *   - selectLiveReservationMix: lib/executor/liveReservationAllocationPolicy.ts
 *     (the exact live allocation rule — QUALITY_FILL_A_SAFE cap30/40/50 no
 *     longer uses a local reimplementation)
 *   - resolveTennisMoneyEligibility: lib/executor/tennisLiveEligibility.ts
 *   - evaluateEvent/aggregateMetrics/settleBetU: lib/modeling/research-engine
 *
 * P50_52 (no _SAFE suffix) is the one unchanged generic RAW_LEGACY_BASELINE
 * (LEGACY_SETTLEMENT_FIRST, NOT_CURRENT_AUTHORITY) — computed over the FULL
 * unfiltered universe via the pre-#379 toAtlasInput()/runStandalone() path,
 * exactly as it always has been, for comparison only. It is never used to
 * choose the current SAFE model.
 *
 * Where canonical_row lacks tournament identity (event title/slug, market
 * type text), it is enriched ONLY with identity metadata joined from
 * generated_signal_pairs on the exact (condition_id, selected_token_id) key,
 * decision-time-safe (only a GSP row with created_at <= decisionAt is ever
 * used) — never future outcome/settlement/price/volume fields.
 *
 * Source: research_model_ready_rows (RESEARCH CLONE, read-only). Writes a
 * NEW aggregate artifact under modeling/evidence/ — never touches the
 * dashboard, never mutates old artifacts, never edits frozen model
 * definitions.
 *
 *   npx tsx scripts/modeling/tennis-safe-comparable-leaderboard.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import { enumerateMinskDates, type CorpusLabel, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { FROZEN_MODELS, SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import { settleBetU } from "@/lib/modeling/research-engine";
import {
  resolveTennisMoneyEligibility,
  type TennisMoneyEligibilityDecision,
} from "@/lib/executor/tennisLiveEligibility";
import { selectLiveReservationMix, type LiveReservationMixGuardConfig } from "@/lib/executor/liveReservationAllocationPolicy";
import { toAtlasInput, toDecisionTimeSelectionInput, type DecisionTimeCandidate } from "./factor-atlas";
import {
  PORTFOLIOS,
  runStandalone,
  runStandaloneStrict,
  runPortfolioStrict,
  applyDailyCap,
  settledBetsOnly,
  metricsFor,
  type SelectedCandidate,
  type TieredBet,
} from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const DISPLAY_CAPS = [30, 40, 50] as const;
const EVIDENCE_OUT_DIR = "modeling/evidence/safe-authority-review-a-repair-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";
const TENNIS_FAMILY = "tennis";
/** Chunk size for the .in("condition_id", ...) identity join, mirroring the established CID_CHUNK pattern. */
const CID_CHUNK = 200;
/** Explicitly page every Supabase read; never rely on its default max-row limit. */
const READ_PAGE = 1000;

/** Production live-mix configs, per this mission (LIVE_RESERVATION_MIX_GUARD_V1-shaped). */
export const QUALITY_FILL_A_SAFE_MIX_CONFIGS: Record<30 | 40 | 50, LiveReservationMixGuardConfig> = {
  30: { cap: 30, footballFirstSlots: 20, tennisMaxWhenFootballSufficient: 7 },
  40: { cap: 40, footballFirstSlots: 26, tennisMaxWhenFootballSufficient: 10 },
  50: { cap: 50, footballFirstSlots: 33, tennisMaxWhenFootballSufficient: 12 },
};

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

export const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
export async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

export async function fetchRows(): Promise<ScorecardReadyRow[]> {
  const db = await resolveDb();
  const rows: ScorecardReadyRow[] = [];
  // Keep offsets bounded to one model date. A growing full-range OFFSET is
  // both slow on the clone and vulnerable to PostgreSQL statement timeout.
  for (const modelDate of enumerateMinskDates(START, END)) {
    for (let from = 0;; from += READ_PAGE) {
      const { data, error } = await db
        .from("research_model_ready_rows")
        .select("canonical_row")
        .eq("model_date", modelDate)
        .order("population_id")
        .order("condition_id")
        .order("selected_token_id")
        .order("decision_at")
        .range(from, from + READ_PAGE - 1);
      if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
      if (data.length < READ_PAGE) break;
    }
  }
  return rows;
}

// ── Decision-time-safe tournament-identity enrichment ───────────────────────
// canonical_row carries no event title/slug/tournament-level text. Only the
// exact (condition_id, selected_token_id) identity is used to join back to
// generated_signal_pairs, and only a candidate row whose created_at <=
// decisionAt is ever used (no future leak) — mirrors the point-in-time cut
// contract in lib/modeling/forward-rich/materializeForwardRichResearch.ts.
// No outcome/settlement/price/volume field is read from this join.

export interface IdentityCandidate {
  createdAt: string;
  structuredMarketType: string | null;
  marketText: string | null;
  eventIdentityText: string | null;
}

export type IdentityLookup = (conditionId: string, selectedTokenId: string, decisionAt: string) => IdentityCandidate | null;

/** Builds a decision-time-safe lookup from an unordered list of GSP candidate rows. */
export function buildIdentityLookup(rowsByPair: Map<string, IdentityCandidate[]>): IdentityLookup {
  const sorted = new Map<string, IdentityCandidate[]>();
  for (const [key, arr] of rowsByPair) sorted.set(key, [...arr].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  return (conditionId, selectedTokenId, decisionAt) => {
    const arr = sorted.get(`${conditionId}::${selectedTokenId}`);
    if (!arr) return null;
    let best: IdentityCandidate | null = null;
    for (const candidate of arr) {
      if (candidate.createdAt <= decisionAt) best = candidate;
      else break;
    }
    return best;
  };
}

export async function fetchTennisIdentityLookup(db: any, conditionIds: string[]): Promise<IdentityLookup> {
  const rowsByPair = new Map<string, IdentityCandidate[]>();
  const unique = [...new Set(conditionIds)].filter(Boolean);
  for (let i = 0; i < unique.length; i += CID_CHUNK) {
    const slice = unique.slice(i, i + CID_CHUNK);
    // A 200-condition slice can contain thousands of rows. Order by a total
    // key and page exhaustively so every decision-time identity is visible.
    for (let from = 0;; from += READ_PAGE) {
      const { data, error } = await db
        .from("generated_signal_pairs")
        .select("id,condition_id,selected_token_id,created_at,event_slug,market_slug,diagnostics")
        .in("condition_id", slice)
        .order("condition_id")
        .order("selected_token_id")
        .order("created_at")
        .order("id")
        .range(from, from + READ_PAGE - 1);
      if (error) throw new Error(`FETCH_TENNIS_IDENTITY:${error.code ?? error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const conditionId = String(r.condition_id ?? "");
        const selectedTokenId = String(r.selected_token_id ?? "");
        if (!conditionId || !selectedTokenId) continue;
        const diag = (r.diagnostics ?? {}) as Record<string, unknown>;
        // Tennis GSP rows nest their identity under diagnostics.providerEventContext
        // (eventTitle/marketQuestion/marketType); some other sources carry a flat
        // diagnostics.marketTitle/marketType instead. Check both, flat first.
        const ctx = (diag.providerEventContext ?? {}) as Record<string, unknown>;
        const structuredMarketType = (typeof diag.marketType === "string" ? diag.marketType : null) ?? (typeof ctx.marketType === "string" ? ctx.marketType : null);
        const marketSlug = typeof r.market_slug === "string" ? r.market_slug : null;
        const eventSlug = typeof r.event_slug === "string" ? r.event_slug : null;
        const marketText =
          (typeof diag.marketTitle === "string" ? diag.marketTitle : null) ?? (typeof ctx.marketQuestion === "string" ? ctx.marketQuestion : null) ?? marketSlug;
        const eventIdentityText =
          (typeof diag.eventTitle === "string" ? diag.eventTitle : null) ?? (typeof ctx.eventTitle === "string" ? ctx.eventTitle : null) ?? eventSlug ?? marketSlug;
        const key = `${conditionId}::${selectedTokenId}`;
        const list = rowsByPair.get(key);
        const candidate: IdentityCandidate = { createdAt: String(r.created_at ?? ""), structuredMarketType, marketText, eventIdentityText };
        if (list) list.push(candidate);
        else rowsByPair.set(key, [candidate]);
      }
      if (data.length < READ_PAGE) break;
    }
  }
  return buildIdentityLookup(rowsByPair);
}

/**
 * Resolves the shared TENNIS live-money gate for one input row, reusing
 * resolveTennisMoneyEligibility() verbatim — never a re-derived rule.
 * marketTypeRaw already on canonical_row (when present) is preferred over
 * the joined identity's structuredMarketType; the join exists only to fill
 * in the identity/text fields canonical_row never carries. Only
 * decision-time fields (marketTypeRaw, joined identity text) feed this — no
 * settlement/outcome is read or available here.
 */
export function resolveSafeTennisDecision(
  e: Pick<DecisionTimeCandidate, "marketTypeRaw">,
  identity: IdentityCandidate | null,
): TennisMoneyEligibilityDecision {
  return resolveTennisMoneyEligibility({
    structuredMarketType: e.marketTypeRaw ?? identity?.structuredMarketType ?? null,
    marketText: identity?.marketText ?? null,
    eventIdentityText: identity?.eventIdentityText ?? null,
  });
}

export interface SafeUniverseResult {
  safeUniverse: DecisionTimeCandidate[];
  rawTennisN: number;
  approvedTennisN: number;
  excludedTennisInput: DecisionTimeCandidate[];
}

/**
 * ONE shared safe-tennis universe: non-tennis rows pass through unchanged;
 * a tennis row is retained only when resolveTennisMoneyEligibility says it
 * is eligible. Applied ONCE, upstream of every model predicate below — no
 * model-specific tennis logic exists anywhere else in this file. Runs on
 * DECISION-TIME candidates (no labelAsOf field exists on this type) — the
 * safe-tennis gate itself never sees settlement.
 */
export function buildSafeUniverse(input: DecisionTimeCandidate[], identityLookup: IdentityLookup): SafeUniverseResult {
  const safeUniverse: DecisionTimeCandidate[] = [];
  const excludedTennisInput: DecisionTimeCandidate[] = [];
  let rawTennisN = 0;
  let approvedTennisN = 0;
  for (const e of input) {
    if (e.sportFamily !== TENNIS_FAMILY) {
      safeUniverse.push(e);
      continue;
    }
    rawTennisN += 1;
    const identity = identityLookup(e.ref, e.candidateRef, e.decisionTimestamp);
    const decision = resolveSafeTennisDecision(e, identity);
    if (decision.eligible) {
      approvedTennisN += 1;
      safeUniverse.push(e);
    } else {
      excludedTennisInput.push(e);
    }
  }
  return { safeUniverse, rawTennisN, approvedTennisN, excludedTennisInput };
}

// ── Reconciled football authority + Exact Score pre-selection exclusion ────
// Review A repair. Sport and market type for SAFE qualification, football-first
// allocation and sport reporting come ONLY from the already-frozen fail-closed
// FOOTBALL_DENOMINATOR_RECONCILIATION_V1 overlay
// (scripts/modeling/build-football-denominator-reconciliation.ts), joined on
// the exact persisted identity (condition_id, selected_token_id, decision_at)
// — the same key as candidateIdentity. No second sport resolver: a candidate
// with no overlay record, or with conflicting overlay records, is unresolved
// (sportFamily ""), never inferred from title/slug/odds/outcome.

export const FOOTBALL_OVERLAY_PATH =
  "modeling/evidence/football-denominator-reconciliation-v1/FOOTBALL_DENOMINATOR_OVERLAY_2026-08-04_2026-09-20.jsonl.gz";
export const FOOTBALL_OVERLAY_RANGE = { start: "2026-08-04", end: "2026-09-20" } as const;
export const EXACT_SCORE_MARKET_TYPE = "soccer_exact_score";

export interface ReconciledClassification {
  sportFamily: string | null;
  marketType: string | null;
}

interface OverlayLine {
  condition_id: string;
  selected_token_id: string;
  decision_at: string;
  reconciled_sport_family: string | null;
  reconciled_market_type: string | null;
}

/** Overlay lines -> identity map. Conflicting duplicates for one identity fail closed to null. */
export function buildReconciledClassificationMap(lines: OverlayLine[]): Map<string, ReconciledClassification> {
  const map = new Map<string, ReconciledClassification>();
  for (const l of lines) {
    const key = `${l.condition_id}::${l.selected_token_id}::${l.decision_at}`;
    const next: ReconciledClassification = { sportFamily: l.reconciled_sport_family ?? null, marketType: l.reconciled_market_type ?? null };
    const prev = map.get(key);
    if (!prev) {
      map.set(key, next);
      continue;
    }
    map.set(key, {
      sportFamily: prev.sportFamily === next.sportFamily ? prev.sportFamily : null,
      marketType: prev.marketType === next.marketType ? prev.marketType : null,
    });
  }
  return map;
}

export function loadReconciledClassificationMap(path = FOOTBALL_OVERLAY_PATH): Map<string, ReconciledClassification> {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as OverlayLine);
  return buildReconciledClassificationMap(lines);
}

export function isExactScore(marketType: string | null | undefined): boolean {
  return typeof marketType === "string" && marketType.trim().toLowerCase() === EXACT_SCORE_MARKET_TYPE;
}

export interface ReconciledUniverseResult {
  eligible: DecisionTimeCandidate[];
  exactScoreExcludedIdentities: Set<string>;
  overlayMissN: number;
  sportChangedN: number;
}

/**
 * Applied ONCE, upstream of the safe-tennis gate, every model predicate,
 * physical-event selection and every daily cap: (1) sportFamily := reconciled
 * overlay sport ("" when unresolved/missing — fail closed); (2) Exact Score
 * candidates are removed so they can never claim a physical event or a cap
 * slot. Decision-time identity/classification only — no settlement is read.
 */
export function applyReconciledAuthority(input: DecisionTimeCandidate[], overlay: Map<string, ReconciledClassification>): ReconciledUniverseResult {
  const eligible: DecisionTimeCandidate[] = [];
  const exactScoreExcludedIdentities = new Set<string>();
  let overlayMissN = 0;
  let sportChangedN = 0;
  for (const e of input) {
    const cls = overlay.get(e.candidateIdentity);
    if (!cls) overlayMissN += 1;
    const sportFamily = cls?.sportFamily ?? "";
    if (sportFamily !== e.sportFamily) sportChangedN += 1;
    const marketType = cls?.marketType ?? e.marketTypeRaw;
    if (isExactScore(marketType) || isExactScore(e.marketTypeRaw)) {
      exactScoreExcludedIdentities.add(e.candidateIdentity);
      continue;
    }
    eligible.push({ ...e, sportFamily });
  }
  return { eligible, exactScoreExcludedIdentities, overlayMissN, sportChangedN };
}

// ── Sport composition + supply-coverage reporting ───────────────────────────

export function sportSplit(bets: SelectedCandidate[]) {
  const total = bets.length || 1;
  const footballN = bets.filter((b) => b.sportFamily === SOCCER_FAMILY).length;
  const tennisN = bets.filter((b) => b.sportFamily === TENNIS_FAMILY).length;
  const otherN = bets.length - footballN - tennisN;
  return {
    FOOTBALL_N: footballN,
    FOOTBALL_PCT: round((footballN / total) * 100, 1),
    TENNIS_N: tennisN,
    TENNIS_PCT: round((tennisN / total) * 100, 1),
    OTHER_N: otherN,
    OTHER_PCT: round((otherN / total) * 100, 1),
  };
}

/**
 * SUPPLY coverage, NOT venue fill probability: fraction of calendar days in
 * range whose UNCAPPED daily candidate supply meets `cap`. Settlement-neutral
 * and says nothing about whether any order would be matched on a venue.
 */
export function daysSupplyAtCapRate(uncapped: SelectedCandidate[], dates: string[], cap: number): number {
  if (dates.length === 0) return 0;
  const byDay = new Map<string, number>();
  for (const c of uncapped) byDay.set(c.day, (byDay.get(c.day) ?? 0) + 1);
  const daysMeetingCap = dates.filter((d) => (byDay.get(d) ?? 0) >= cap).length;
  return round(daysMeetingCap / dates.length, 4);
}

// ── QUALITY_FILL_A_SAFE cap30/40/50 exact live allocation ──────────────────
// Reuses selectLiveReservationMix() (lib/executor/liveReservationAllocationPolicy.ts)
// verbatim, per day, over already-selected (settlement-blind) candidates —
// no local reimplementation of the mix rule, no settlement input.

function withinDayOrder(a: SelectedCandidate, b: SelectedCandidate): number {
  return a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey);
}

export function applyLiveMixAllocation(bets: SelectedCandidate[], allDates: string[], config: LiveReservationMixGuardConfig): SelectedCandidate[] {
  const byDay = new Map<string, SelectedCandidate[]>();
  for (const bet of bets) {
    const list = byDay.get(bet.day);
    if (list) list.push(bet);
    else byDay.set(bet.day, [bet]);
  }
  const kept: SelectedCandidate[] = [];
  for (const date of allDates) {
    const dayBets = (byDay.get(date) ?? []).slice().sort(withinDayOrder);
    const football = dayBets.filter((b) => b.sportFamily === SOCCER_FAMILY);
    const tennis = dayBets.filter((b) => b.sportFamily === TENNIS_FAMILY);
    const other = dayBets.filter((b) => b.sportFamily !== SOCCER_FAMILY && b.sportFamily !== TENNIS_FAMILY);
    const { selected, finalN } = selectLiveReservationMix(football, tennis, other, config);
    if (finalN > config.cap) throw new Error(`LIVE_MIX_CAP_EXCEEDED: ${date} finalN=${finalN} cap=${config.cap}`);
    kept.push(...selected);
  }
  return kept;
}

// ── Model definitions: non-tennis semantics reused verbatim; tennis is
// governed ONLY by the shared safe universe built above — no per-model
// tennis predicate exists here. Settlement is joined back ONLY here, after
// selection+cap.
//
// Settlement status semantics (docs/modeling/RESEARCH_CORPUS_CONTRACT.md §5.3
// + §PRIMARY — existing contract, not a new convention):
//   WIN/LOSS -> terminal, settleBetU() reference PnL.
//   VOID     -> terminal, stake returned, 0 PnL; counted in TERMINAL_N and in
//               the reference ROI denominator ("Bets" = WIN/LOSS/VOID).
//   OPEN / NO_MATCH / AMBIGUOUS / any other label -> UNRESOLVED (nonterminal):
//               no realised PnL; every one of them is bounded LOSS (worst) /
//               WIN-at-own-entry-price (best) in the finality bounds.
// All PnL here is REFERENCE_PNL at display price (BETTING_ECONOMICS_CONTRACT_V2
// §2) — NOT_EXECUTION_AUTHORITY.
// ─────────────────────────────────────────────────────────────────────────

export const PNL_CLASS = "REFERENCE_PNL" as const;
export const PNL_AUTHORITY = "NOT_EXECUTION_AUTHORITY" as const;
const AUG_END = "2026-08-31";

export type StatusClass = "WIN_LOSS" | "VOID" | "UNRESOLVED";
export function classifyStatusForFinality(label: CorpusLabel | string): StatusClass {
  if (label === "WIN" || label === "LOSS") return "WIN_LOSS";
  if (label === "VOID") return "VOID";
  return "UNRESOLVED";
}

export interface ReferenceEconomics {
  SELECTED_N: number;
  SETTLED_N: number;
  VOID_N: number;
  TERMINAL_N: number;
  UNRESOLVED_N: number;
  UNRESOLVED_BY_STATUS: Record<string, number>;
  REFERENCE_PNL_U: number;
  REFERENCE_ROI_PCT: number;
  MAX_DD_U: number;
  REFERENCE_FINAL_PNL_WORST_U: number;
  REFERENCE_FINAL_PNL_BEST_U: number;
  REFERENCE_FINAL_ROI_WORST_PCT: number;
  REFERENCE_FINAL_ROI_BEST_PCT: number;
  STATUS: "PARTIAL_SETTLEMENT" | "FINAL_REPRODUCIBLE";
}

/** Post-selection/post-cap settlement join + finality bounds over EVERY nonterminal status. */
export function referenceEconomics(capped: SelectedCandidate[], settlementByCandidateIdentity: Map<string, CorpusLabel>): ReferenceEconomics {
  const settled: TieredBet[] = [];
  const unresolvedByStatus: Record<string, number> = {};
  let voidN = 0;
  let worstDelta = 0;
  let bestDelta = 0;
  for (const c of capped) {
    const label = settlementByCandidateIdentity.get(c.candidateIdentity);
    if (label === undefined) throw new Error(`SETTLEMENT_JOIN_MISS: no settlement entry for candidateIdentity=${c.candidateIdentity}`);
    const cls = classifyStatusForFinality(label);
    if (cls === "WIN_LOSS") {
      settled.push({
        physicalEventKey: c.physicalEventKey,
        decisionTimestamp: c.decisionTimestamp,
        eventStart: c.eventStart,
        leadTimeHours: c.leadTimeHours,
        entryPrice: c.entryPrice,
        sportFamily: c.sportFamily,
        outcome: label as "WIN" | "LOSS",
        pnlU: settleBetU(label as "WIN" | "LOSS", c.entryPrice),
        tier: c.tier,
        day: c.day,
      });
    } else if (cls === "VOID") {
      voidN += 1;
    } else {
      unresolvedByStatus[label] = (unresolvedByStatus[label] ?? 0) + 1;
      worstDelta += settleBetU("LOSS", c.entryPrice);
      bestDelta += settleBetU("WIN", c.entryPrice);
    }
  }
  const m = metricsFor(settled);
  const selectedN = capped.length;
  const terminalN = settled.length + voidN;
  const unresolvedN = selectedN - terminalN;
  const worst = round(m.pnl_u + worstDelta, 2);
  const best = round(m.pnl_u + bestDelta, 2);
  return {
    SELECTED_N: selectedN,
    SETTLED_N: settled.length,
    VOID_N: voidN,
    TERMINAL_N: terminalN,
    UNRESOLVED_N: unresolvedN,
    UNRESOLVED_BY_STATUS: unresolvedByStatus,
    REFERENCE_PNL_U: m.pnl_u,
    REFERENCE_ROI_PCT: terminalN ? round((m.pnl_u / terminalN) * 100, 4) : 0,
    MAX_DD_U: m.max_drawdown_u,
    REFERENCE_FINAL_PNL_WORST_U: worst,
    REFERENCE_FINAL_PNL_BEST_U: best,
    REFERENCE_FINAL_ROI_WORST_PCT: selectedN ? round((worst / selectedN) * 100, 4) : 0,
    REFERENCE_FINAL_ROI_BEST_PCT: selectedN ? round((best / selectedN) * 100, 4) : 0,
    STATUS: unresolvedN > 0 ? "PARTIAL_SETTLEMENT" : "FINAL_REPRODUCIBLE",
  };
}

interface CapRow extends ReferenceEconomics {
  MODEL: string;
  CAP: number | "UNCAPPED";
  PNL_CLASS: typeof PNL_CLASS;
  PNL_AUTHORITY: typeof PNL_AUTHORITY;
  DAYS_SUPPLY_AT_CAP_RATE: number;
  FOOTBALL_N: number;
  FOOTBALL_PCT: number;
  TENNIS_N: number;
  TENNIS_PCT: number;
  OTHER_N: number;
  OTHER_PCT: number;
  EXACT_SCORE_SELECTED_N: number;
  AUG: ReferenceEconomics & { FOOTBALL_N: number };
  SEP: ReferenceEconomics & { FOOTBALL_N: number };
}

function rowFor(
  modelId: string,
  cap: number | "UNCAPPED",
  capped: SelectedCandidate[],
  uncapped: SelectedCandidate[],
  dates: string[],
  settlementByCandidateIdentity: Map<string, CorpusLabel>,
  exactScoreIdentities: Set<string>,
): CapRow {
  const aug = capped.filter((c) => c.day <= AUG_END);
  const sep = capped.filter((c) => c.day > AUG_END);
  return {
    MODEL: modelId,
    CAP: cap,
    PNL_CLASS,
    PNL_AUTHORITY,
    ...referenceEconomics(capped, settlementByCandidateIdentity),
    DAYS_SUPPLY_AT_CAP_RATE: cap === "UNCAPPED" ? 1 : daysSupplyAtCapRate(uncapped, dates, cap),
    ...sportSplit(capped),
    EXACT_SCORE_SELECTED_N: capped.filter((c) => exactScoreIdentities.has(c.candidateIdentity)).length,
    AUG: { ...referenceEconomics(aug, settlementByCandidateIdentity), FOOTBALL_N: sportSplit(aug).FOOTBALL_N },
    SEP: { ...referenceEconomics(sep, settlementByCandidateIdentity), FOOTBALL_N: sportSplit(sep).FOOTBALL_N },
  };
}

async function main() {
  if (START < FOOTBALL_OVERLAY_RANGE.start || END > FOOTBALL_OVERLAY_RANGE.end) {
    throw new Error(`FOOTBALL_AUTHORITY_RANGE_UNCOVERED: ${START}..${END} outside ${FOOTBALL_OVERLAY_RANGE.start}..${FOOTBALL_OVERLAY_RANGE.end}`);
  }
  const rawRows = await fetchRows();
  const dates = enumerateMinskDates(START, END);

  // ── RAW_LEGACY_BASELINE — unchanged, pre-#379 settlement-first path, kept ONLY for comparison ──
  const legacyInput = toAtlasInput(rawRows);
  const p5052Raw = runStandalone(legacyInput, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52);
  const p5052RawMetrics = metricsFor(p5052Raw);

  // ── SELECTION_BEFORE_SETTLEMENT_V1 fixed path for every CURRENT _SAFE model ──
  const { candidates: rawDecisionTimeCandidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);

  // Review A repair: reconciled football authority + Exact Score exclusion BEFORE any selection/cap.
  const overlay = loadReconciledClassificationMap();
  const reconciled = applyReconciledAuthority(rawDecisionTimeCandidates, overlay);
  const decisionTimeCandidates = reconciled.eligible;

  const tennisConditionIds = decisionTimeCandidates.filter((e) => e.sportFamily === TENNIS_FAMILY).map((e) => e.ref).filter((v): v is string => !!v);
  const db = await resolveDb();
  const identityLookup = await fetchTennisIdentityLookup(db, tennisConditionIds);

  const { safeUniverse, rawTennisN, approvedTennisN, excludedTennisInput } = buildSafeUniverse(decisionTimeCandidates, identityLookup);
  const excludedTennisSelected = runStandaloneStrict(excludedTennisInput, () => true);
  const excludedTennisSettled = settledBetsOnly(excludedTennisSelected, settlementByCandidateIdentity).settledBets;
  const excludedTennisPnlU = metricsFor(excludedTennisSettled).pnl_u;

  const broadTiers = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")!.tiers;

  const modelBets: Record<string, SelectedCandidate[]> = {
    P50_52_SAFE: runStandaloneStrict(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52),
    P50_54_SAFE: runStandaloneStrict(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54),
    PORTFOLIO_BROAD_SAFE: runPortfolioStrict(safeUniverse, broadTiers as Parameters<typeof runPortfolioStrict>[1]),
    QUALITY_FILL_A_SAFE: runPortfolioStrict(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_A as Parameters<typeof runPortfolioStrict>[1]),
    QUALITY_FILL_D_SAFE: runPortfolioStrict(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_D as Parameters<typeof runPortfolioStrict>[1]),
    C0_SAFE: runStandaloneStrict(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e)),
    C4_SAFE: runStandaloneStrict(safeUniverse, (e) => FROZEN_MODELS.C4.predicate(e)),
    C5_SAFE: runStandaloneStrict(safeUniverse, (e) => FROZEN_MODELS.C5.predicate(e)),
    C0_ONLY_NOT_C1_SAFE: runStandaloneStrict(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e) && e.sportFamily !== SOCCER_FAMILY),
    SCORE63_64_SAFE: runStandaloneStrict(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65),
    TENNIS_P50_52_SAFE: runStandaloneStrict(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 && e.sportFamily === TENNIS_FAMILY),
  };

  const table: CapRow[] = [];
  for (const [modelId, bets] of Object.entries(modelBets)) {
    table.push(rowFor(modelId, "UNCAPPED", bets, bets, dates, settlementByCandidateIdentity, reconciled.exactScoreExcludedIdentities));
    for (const cap of DISPLAY_CAPS) {
      const capped = modelId === "QUALITY_FILL_A_SAFE" ? applyLiveMixAllocation(bets, dates, QUALITY_FILL_A_SAFE_MIX_CONFIGS[cap]) : applyDailyCap(bets, cap);
      table.push(rowFor(modelId, cap, capped, bets, dates, settlementByCandidateIdentity, reconciled.exactScoreExcludedIdentities));
    }
  }

  const artifact = {
    MISSION: "SAFE_MODELING_AUTHORITY_REVIEW_A_REPAIR_V1",
    PNL_CLASS,
    PNL_AUTHORITY,
    NOTE:
      "Every _SAFE model uses the selection-before-settlement fixed path (PR #379) with Review A repairs: reconciled fail-closed football authority, Exact Score excluded before physical-event selection and cap, causal (prefix-invariant) portfolio decision order, finality bounds over every nonterminal status. REFERENCE_PNL at display price, NOT_EXECUTION_AUTHORITY. DAYS_SUPPLY_AT_CAP_RATE is candidate-supply coverage, not venue fill probability.",
    DATASET_RANGE: { start: START, end: END },
    SOURCE_ROW_N: rawRows.length,
    PROCESSED_N: rawDecisionTimeCandidates.length,
    FOOTBALL_AUTHORITY: {
      SOURCE: FOOTBALL_OVERLAY_PATH,
      OVERLAY_IDENTITY_N: overlay.size,
      OVERLAY_MISS_N: reconciled.overlayMissN,
      SPORT_CHANGED_VS_CARRIER_N: reconciled.sportChangedN,
    },
    EXACT_SCORE_EXCLUDED_BEFORE_SELECTION_N: reconciled.exactScoreExcludedIdentities.size,
    TENNIS_SAFE_UNIVERSE: {
      RAW_TENNIS_N: rawTennisN,
      APPROVED_TENNIS_N: approvedTennisN,
      EXCLUDED_TENNIS_N: rawTennisN - approvedTennisN,
      EXCLUDED_TENNIS_REFERENCE_PNL_U: round(excludedTennisPnlU, 4),
    },
    RAW_LEGACY_BASELINE_P50_52: {
      LABEL: "RAW_LEGACY_BASELINE / LEGACY_SETTLEMENT_FIRST / NOT_CURRENT_AUTHORITY",
      PNL_CLASS,
      PNL_AUTHORITY,
      SELECTED_N: p5052RawMetrics.events,
      REFERENCE_PNL_U: p5052RawMetrics.pnl_u,
      REFERENCE_ROI_PCT: p5052RawMetrics.roi_pct,
      MAX_DD_U: p5052RawMetrics.max_drawdown_u,
    },
    TABLE: table,
  };

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/LEADERBOARD_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`Wrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
