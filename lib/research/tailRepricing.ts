// Research-only VALUE_BACKED_TAIL_REPRICING slice (soccer full-game TOTALS). Pure functions, no I/O.
// Traces: physical game -> authoritative score/period/clock -> exact condition/token -> authoritative payoff line
//   -> executable full-size BUY -> supported probability/EV -> frozen research decision -> terminal settlement replay.
// It never emits BET (ALPHA_PROGRAMS tail is canEmitBet=false), never invents a probability, and never touches the
// frozen A/B/C controls, settlement or sync. A price discrepancy is not an alpha: EV needs an independent calibrated model.
import { createHash } from "node:crypto";
import type { GammaMarket } from "../feed/resolveSignalOutcome";
import { classifySiblingSettlement, type SiblingSettlementState } from "../modeling/t10-offpolicy/siblingOffPolicy";
import { ALPHA_PROGRAMS, inRange, type Observation, type PriceRange } from "./inplayPaperDecisions";

export const TAIL_PROGRAM_ID = "VALUE_BACKED_TAIL_REPRICING";
export const TAIL_VERSION = "v1-totals-line-authority";
export const TAIL_SCOPE_KEY = "SOCCER_TOTALS_FULL_GAME";
/** Policy configuration (not alpha claims). */
/** PROVISIONAL_RESEARCH_GATES: values below were chosen by the executor, not approved by the Founder. Never read them as production policy. */
export const PROVISIONAL_RESEARCH_GATES = {
  status: "PROVISIONAL_RESEARCH_GATE_PENDING_FOUNDER_APPROVAL",
  max_state_age_ms: 90_000,
  min_holdout_independent_games: 100,
} as const;
export const MAX_STATE_AGE_MS = PROVISIONAL_RESEARCH_GATES.max_state_age_ms; // PROVISIONAL_RESEARCH_GATE
export const MAX_STATE_FUTURE_SKEW_MS = 2_000;
export const MAX_ELAPSED_SECONDS = 9_000;
export const MAX_SOCCER_PERIOD = 5;
/** Sanity bounds for the BUY price a tail candidate may sit at; outside it the contract is not a tail/sane quote. */
export const TAIL_PRICE_RANGE: PriceRange = { min: 0.02, max: 0.35 };
export const MIN_HOLDOUT_INDEPENDENT_GAMES = PROVISIONAL_RESEARCH_GATES.min_holdout_independent_games; // PROVISIONAL_RESEARCH_GATE
export const MIN_EV_LCB_MARGIN = 0.05;
/** An EV this large on a liquid market is evidence of a broken model/line/state, not of alpha. */
export const SUSPECT_EV_CEILING = 1.0;

const tailProgram = ALPHA_PROGRAMS.find((p) => p.id === TAIL_PROGRAM_ID);
if (!tailProgram || tailProgram.canEmitBet) throw new Error("TAIL_PROGRAM_AUTHORITY_CHANGED");
/** Existing approved authority: the tail alpha program is facts-only and structurally unable to BET. */
export const TAIL_CAN_EMIT_BET = tailProgram.canEmitBet;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ───────────────────────────── edge 1: authoritative payoff line ─────────────────────────────
export type LineStatus = "PROVEN" | "AMBIGUOUS" | "UNAVAILABLE" | "UNSUPPORTED";
export type Direction = "OVER" | "UNDER";
export type LineAuthority = {
  status: LineStatus; reason: string; line: number | null; direction: Direction | null;
};
const lineAuth = (status: LineStatus, reason: string, line: number | null = null, direction: Direction | null = null): LineAuthority => ({ status, reason, line, direction });

function parseArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
}
/** "…-YYYY-MM-DD-total-2pt5" -> 2.5. Only the date-anchored full-game main-totals suffix counts; "-first-half-total-…" style sub-scope slugs never match. */
export function lineFromSlug(slug: unknown): number | null {
  if (typeof slug !== "string") return null;
  const m = /\d{4}-\d{2}-\d{2}-total-(\d+)pt(\d+)$/.exec(slug);
  return m ? Number(`${m[1]}.${m[2]}`) : null;
}
/** "A vs. B: O/U 2.5" or "O/U 2.5" -> 2.5. */
export function lineFromLabel(label: unknown): number | null {
  if (typeof label !== "string") return null;
  const m = /O\/U\s+(\d+(?:\.\d+)?)\s*$/.exec(label.trim());
  return m ? Number(m[1]) : null;
}

export type ProviderMarketRaw = GammaMarket & { sportsMarketType?: unknown; line?: unknown; groupItemTitle?: unknown };

/**
 * Exact-identity pick from a provider `/markets?condition_ids=` payload: only an element whose own conditionId equals the
 * requested one is returned (never `arr[0]` blindly). Gamma omits settled markets unless `closed=true`, so a settled
 * soccer game needs the closed query; the CLOB fallback carries no sportsMarketType and can never prove a line.
 */
export function selectExactConditionMarket(payload: unknown, conditionId: string): ProviderMarketRaw | null {
  const arr = Array.isArray(payload) ? payload : Array.isArray((payload as { markets?: unknown } | null)?.markets) ? (payload as { markets: unknown[] }).markets : null;
  const want = conditionId.trim().toLowerCase();
  const hit = arr?.find((m) => typeof (m as ProviderMarketRaw | null)?.conditionId === "string" && ((m as ProviderMarketRaw).conditionId as string).toLowerCase() === want);
  return (hit as ProviderMarketRaw | undefined) ?? null;
}

// ───────────────────────────── bounded diagnostic reads ─────────────────────────────
export const RAW_ROWS_PER_STAGE_CAP = 50;
export const RAW_ROWS_PER_MISSION_CAP = 200;
/** Hard raw-row budget for diagnostic DB reads; a read is reserved BEFORE it is issued so an over-budget read never happens. */
export class RawRowBudget {
  private readonly perStage: Record<string, number> = {};
  private total = 0;
  reserve(stage: string, rows: number): number {
    if (!Number.isInteger(rows) || rows < 0) throw new Error("RAW_ROW_BUDGET_INVALID_REQUEST");
    if (rows > RAW_ROWS_PER_STAGE_CAP) throw new Error(`RAW_ROW_BUDGET_STAGE_CAP_EXCEEDED:${stage}`);
    if (this.total + rows > RAW_ROWS_PER_MISSION_CAP) throw new Error("RAW_ROW_BUDGET_MISSION_CAP_EXCEEDED");
    this.perStage[stage] = (this.perStage[stage] ?? 0) + rows;
    this.total += rows;
    return rows;
  }
  /** Return unused reservation after a read came back short. */
  release(stage: string, rows: number) { const r = Math.min(rows, this.perStage[stage] ?? 0); this.perStage[stage] = (this.perStage[stage] ?? 0) - r; this.total -= r; }
  snapshot() { return { stages: { ...this.perStage }, total: this.total, per_stage_cap: RAW_ROWS_PER_STAGE_CAP, mission_cap: RAW_ROWS_PER_MISSION_CAP }; }
}

export type ContractHandoff = { physical_event_id: string; condition_id: string; token_id: string; side: string; slug: string; eligible_observation_count: number };
/** Public-identifier handoff `physical_event_id,condition_id,token_id,side,slug,eligible_observation_count` (header optional). Malformed rows are rejected, not repaired. */
export function parseContractHandoff(csv: string): ContractHandoff[] {
  const out: ContractHandoff[] = [], seen = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("physical_event_id,")) continue;
    const [physical_event_id, condition_id, token_id, side, slug, n] = s.split(",").map((x) => x.trim());
    const count = Number(n);
    if (!physical_event_id || !/^0x[0-9a-fA-F]{64}$/.test(condition_id ?? "") || !/^\d+$/.test(token_id ?? "") || !/^(Over|Under)$/.test(side ?? "") || !slug || !Number.isInteger(count) || count < 0) throw new Error(`CONTRACT_HANDOFF_MALFORMED_ROW:${s.slice(0, 40)}`);
    const k = `${physical_event_id}|${condition_id.toLowerCase()}|${token_id}`;
    if (seen.has(k)) throw new Error("CONTRACT_HANDOFF_DUPLICATE_CONTRACT");
    seen.add(k);
    out.push({ physical_event_id, condition_id, token_id, side, slug, eligible_observation_count: count });
  }
  return out;
}

/**
 * Exact condition/token -> payoff line. The ONLY accepted authority is the provider market fetched BY CONDITION ID:
 * `sportsMarketType === "totals"`, numeric `line`, outcomes exactly Over/Under aligned with clobTokenIds, and at least
 * one independent corroboration (slug suffix or question/groupItemTitle label) that agrees with `line`. Any
 * disagreement is AMBIGUOUS. The observation `market_slug` is a cross-check only, never a line source.
 */
export function resolveLineAuthority(input: { conditionId: string; tokenId: string; side: string; observationSlug?: string | null; market: ProviderMarketRaw | null }): LineAuthority {
  const { conditionId, tokenId, side, observationSlug, market } = input;
  if (!conditionId || !tokenId) return lineAuth("UNAVAILABLE", "NO_EXACT_IDENTITY");
  if (!market) return lineAuth("UNAVAILABLE", "NO_PROVIDER_MARKET");
  if (typeof market.conditionId !== "string" || market.conditionId.toLowerCase() !== conditionId.toLowerCase()) return lineAuth("AMBIGUOUS", "PROVIDER_CONDITION_MISMATCH");
  if (market.sportsMarketType === undefined || market.sportsMarketType === null) return lineAuth("UNAVAILABLE", "PROVIDER_MARKET_TYPE_METADATA_ABSENT");
  if (market.sportsMarketType !== "totals") return lineAuth("UNSUPPORTED", `PROVIDER_MARKET_TYPE_${String(market.sportsMarketType).toUpperCase()}`);
  if (!finite(market.line) || market.line <= 0) return lineAuth("UNAVAILABLE", "PROVIDER_LINE_ABSENT");
  const line = market.line;
  const outcomes = parseArray(market.outcomes)?.map((o) => String(o).trim().toLowerCase()) ?? null;
  const tokens = parseArray(market.clobTokenIds)?.map(String) ?? null;
  if (!outcomes || !tokens || outcomes.length !== 2 || tokens.length !== 2 || !(outcomes.includes("over") && outcomes.includes("under"))) return lineAuth("AMBIGUOUS", "OUTCOME_TOKEN_STRUCTURE_NOT_OVER_UNDER", line);
  const idx = tokens.indexOf(tokenId);
  if (idx < 0) return lineAuth("AMBIGUOUS", "TOKEN_NOT_IN_PROVIDER_MARKET", line);
  const direction: Direction = outcomes[idx] === "over" ? "OVER" : "UNDER";
  if (side.trim().toLowerCase() !== outcomes[idx]) return lineAuth("AMBIGUOUS", "OBSERVATION_SIDE_CONTRADICTS_PROVIDER_OUTCOME", line, direction);
  const corroborations: Array<[string, number | null]> = [
    ["SLUG", lineFromSlug(market.slug)], ["QUESTION", lineFromLabel(market.question)], ["GROUP_TITLE", lineFromLabel(market.groupItemTitle)],
  ];
  const stated = corroborations.filter(([, v]) => v !== null) as Array<[string, number]>;
  if (stated.some(([, v]) => Math.abs(v - line) > 1e-9)) return lineAuth("AMBIGUOUS", "LINE_SOURCES_DISAGREE", line, direction);
  if (typeof market.slug === "string" && !/\d{4}-\d{2}-\d{2}-total-\d+pt\d+$/.test(market.slug)) return lineAuth("UNSUPPORTED", "SCOPE_SUFFIX_NOT_FULL_GAME_MAIN_TOTAL", line, direction);
  if (observationSlug && typeof market.slug === "string" && observationSlug !== market.slug) return lineAuth("AMBIGUOUS", "OBSERVATION_SLUG_DIFFERS_FROM_PROVIDER_SLUG", line, direction);
  if (!stated.length) return lineAuth("AMBIGUOUS", "LINE_UNCORROBORATED", line, direction);
  // Two-way unambiguous payoff only: x.5 lines. Integer lines can push, quarter lines split stakes.
  if (Math.abs(line * 2 - Math.round(line * 2)) > 1e-9 || Number.isInteger(line)) return lineAuth("UNSUPPORTED", "NON_HALF_LINE_PAYOFF_NOT_TWO_WAY", line, direction);
  return lineAuth("PROVEN", "PROVIDER_LINE_CORROBORATED", line, direction);
}

// ───────────────────────────── edge 2: authoritative game state ─────────────────────────────
export type StateVerdict = { ok: boolean; blocker: string | null; total_goals: number | null };
const isCount = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0;

/** Exact score + period + elapsed clock + authoritative receipt time that is neither missing, future-dated nor stale. */
export function validateGameState(r: Pick<Observation, "observed_at" | "state_authority" | "side_a_score" | "side_b_score" | "state_period_num"> & { state_clock_seconds_elapsed?: number | null; state_received_at?: string | null }): StateVerdict {
  const fail = (blocker: string): StateVerdict => ({ ok: false, blocker, total_goals: null });
  if (!r.state_authority) return fail("STATE_AUTHORITY_ABSENT");
  const missing = [
    !isCount(r.side_a_score) && "score", !isCount(r.state_period_num) && "period", !isCount(r.state_clock_seconds_elapsed) && "clock",
    !r.state_received_at && "receipt",
  ].filter(Boolean);
  if (missing.length) return fail(`SOURCE_STATE_NULL_OR_INVALID:${missing.join(",")}`);
  if (!isCount(r.side_b_score)) return fail("SOURCE_STATE_NULL_OR_INVALID:score");
  if (r.state_period_num! < 1 || r.state_period_num! > MAX_SOCCER_PERIOD || r.state_clock_seconds_elapsed! > MAX_ELAPSED_SECONDS) return fail("STATE_PERIOD_OR_CLOCK_OUT_OF_RANGE");
  const age = ms(r.observed_at) - ms(r.state_received_at);
  if (!Number.isFinite(age)) return fail("STATE_TIMESTAMP_INVALID");
  if (age < -MAX_STATE_FUTURE_SKEW_MS) return fail("STATE_RECEIVED_AFTER_QUOTE");
  if (age > MAX_STATE_AGE_MS) return fail("STATE_DELAYED");
  return { ok: true, blocker: null, total_goals: r.side_a_score! + r.side_b_score! };
}

/** Goals only accumulate: a falling total between consecutive observations of one game proves one of them wrong. */
export function findScoreInconsistencies(rows: ReadonlyArray<Pick<Observation, "id" | "observed_at" | "side_a_score" | "side_b_score">>): Set<string> {
  const bad = new Set<string>();
  const sorted = [...rows].filter((r) => isCount(r.side_a_score) && isCount(r.side_b_score)).sort((a, b) => ms(a.observed_at) - ms(b.observed_at) || (a.id < b.id ? -1 : 1));
  let maxA = -1, maxB = -1;
  for (const r of sorted) {
    if ((r.side_a_score as number) < maxA || (r.side_b_score as number) < maxB) bad.add(r.id);
    else { maxA = r.side_a_score as number; maxB = r.side_b_score as number; }
  }
  return bad;
}

// ───────────────────────────── edge 3: executable BUY ─────────────────────────────
export function validateExecutableBuy(r: Pick<Observation, "orderbook_fetch_status" | "full_stake_executable_vwap" | "full_stake_shares" | "best_ask" | "event_live_status">): { ok: boolean; blocker: string | null } {
  if (r.event_live_status !== "LIVE") return { ok: false, blocker: "NOT_LIVE" };
  if (r.orderbook_fetch_status !== "SUCCESS") return { ok: false, blocker: "ORDERBOOK_UNAVAILABLE" };
  const v = r.full_stake_executable_vwap, q = r.full_stake_shares;
  if (!finite(v) || !finite(q) || q <= 0) return { ok: false, blocker: "BUY_DEPTH_INSUFFICIENT_FOR_FULL_STAKE" };
  if (v <= 0 || v >= 1) return { ok: false, blocker: "FULL_STAKE_VWAP_INVALID" };
  if (finite(r.best_ask) && v + 1e-9 < r.best_ask) return { ok: false, blocker: "VWAP_BELOW_BEST_ASK_INCONSISTENT" };
  return { ok: true, blocker: null };
}

// ───────────────────────────── edge 4: independent, calibrated EV authority ─────────────────────────────
export type CalibrationReceipt = {
  method: string; frozen_before_decision: boolean; holdout_independent_games_n: number;
  brier_model: number; brier_market_baseline: number; reliability_ok: boolean;
};
export type ProbabilityEstimate = {
  model_id: string; model_version: string;
  /** P(this token pays 1). */
  p_win: number;
  /** Lower confidence bound used for the EV test. */
  p_lcb: number;
  /** The model must not be a function of the quote it is compared with. */
  inputs_exclude_market_price: boolean;
  calibration: CalibrationReceipt | null;
};
export type EvInput = {
  goals_now: number; elapsed_seconds: number; period: number; line: number; direction: Direction;
};
export type ProbabilityModel = { id: string; version: string; estimate(input: EvInput): ProbabilityEstimate | null };

export function validateEvAuthority(e: ProbabilityEstimate | null | undefined): string | null {
  if (!e) return "EV_MODEL_AUTHORITY_ABSENT";
  if (!finite(e.p_win) || !finite(e.p_lcb) || e.p_win <= 0 || e.p_win >= 1 || e.p_lcb <= 0 || e.p_lcb > e.p_win) return "PROBABILITY_INVALID";
  if (!e.inputs_exclude_market_price) return "PROBABILITY_DERIVED_FROM_MARKET_PRICE";
  const c = e.calibration;
  if (!c) return "CALIBRATION_RECEIPT_ABSENT";
  if (!c.frozen_before_decision) return "MODEL_NOT_FROZEN_BEFORE_DECISION";
  if (!finite(c.holdout_independent_games_n) || c.holdout_independent_games_n < MIN_HOLDOUT_INDEPENDENT_GAMES) return "HOLDOUT_INDEPENDENT_GAMES_BELOW_MINIMUM";
  if (!finite(c.brier_model) || !finite(c.brier_market_baseline) || c.brier_model >= c.brier_market_baseline) return "NOT_BETTER_THAN_MARKET_BASELINE";
  if (!c.reliability_ok) return "CALIBRATION_RELIABILITY_FAILED";
  return null;
}

/** Per-1u expected return of buying at the executable VWAP. Fee is not an input: net economics stay UNKNOWN. */
export const evPer1u = (p: number, vwap: number) => r6(p / vwap - 1);

// ───────────────────────────── decision for one contract row ─────────────────────────────
export type TailEdge = "NONE" | "GAME_STATE" | "CONTRACT_LINE_AUTHORITY" | "EXECUTABLE_BUY" | "TAIL_PRICE_RANGE" | "EV_MODEL_AUTHORITY" | "BET_AUTHORITY";
export type TailStatus = "BET" | "SKIP" | "WAITING";
export type TailRowAssessment = {
  observation_id: string; physical_event_id: string; condition_id: string; token_id: string;
  state_ok: boolean; line_proven: boolean; buy_ok: boolean; ev_valid: boolean;
  status: TailStatus; first_broken_edge: TailEdge; blockers: string[];
  line: number | null; direction: Direction | null; goals_now: number | null; goals_needed: number | null;
  entry_vwap: number | null; p_win: number | null; ev_lcb_per_1u: number | null; ev_qualified: boolean;
};

export function assessTailRow(input: {
  row: Observation & { state_clock_seconds_elapsed?: number | null; state_received_at?: string | null };
  line: LineAuthority; scoreInconsistent: boolean; model: ProbabilityModel | null;
}): TailRowAssessment {
  const { row, line, scoreInconsistent, model } = input;
  const state = validateGameState(row);
  const buy = validateExecutableBuy(row);
  const blockers: string[] = [];
  let edge: TailEdge = "NONE";
  let hardSkip = false;
  const stateBlocker = state.ok && scoreInconsistent ? "SCORE_NON_MONOTONIC_ACROSS_OBSERVATIONS" : state.blocker;
  if (stateBlocker) { blockers.push(stateBlocker); edge = "GAME_STATE"; }
  if (line.status !== "PROVEN") { blockers.push(`LINE_${line.status}:${line.reason}`); if (edge === "NONE") edge = "CONTRACT_LINE_AUTHORITY"; if (line.status !== "UNAVAILABLE") hardSkip = true; }
  if (!buy.ok) { blockers.push(buy.blocker as string); if (edge === "NONE") edge = "EXECUTABLE_BUY"; }
  const stateOk = state.ok && !scoreInconsistent, lineOk = line.status === "PROVEN", buyOk = buy.ok;
  const goalsNow = state.total_goals;
  const goalsNeeded = lineOk && goalsNow !== null && line.direction === "OVER" ? Math.max(0, Math.ceil(line.line as number) - goalsNow) : null;
  const vwap = buyOk ? (row.full_stake_executable_vwap as number) : null;
  const out = (status: TailStatus, extra: Partial<TailRowAssessment> = {}): TailRowAssessment => ({
    observation_id: row.id, physical_event_id: row.physical_event_id, condition_id: row.condition_id, token_id: row.token_id,
    state_ok: stateOk, line_proven: lineOk, buy_ok: buyOk, ev_valid: false, status, first_broken_edge: edge, blockers,
    line: line.line, direction: line.direction, goals_now: goalsNow, goals_needed: goalsNeeded, entry_vwap: vwap, p_win: null, ev_lcb_per_1u: null, ev_qualified: false, ...extra,
  });
  if (edge !== "NONE") {
    // Contradictory/unsupported facts are final; merely absent or delayed facts may still arrive on a later observation.
    const finalFact = hardSkip || stateBlocker === "SCORE_NON_MONOTONIC_ACROSS_OBSERVATIONS" || stateBlocker === "STATE_PERIOD_OR_CLOCK_OUT_OF_RANGE";
    return out(finalFact ? "SKIP" : "WAITING");
  }
  if (goalsNow === null || vwap === null) return out("WAITING");
  if (!inRange(vwap, TAIL_PRICE_RANGE)) { blockers.push("PRICE_OUTSIDE_TAIL_RANGE"); edge = "TAIL_PRICE_RANGE"; return out("SKIP"); }
  if (!model) { blockers.push("EV_MODEL_AUTHORITY_ABSENT"); edge = "EV_MODEL_AUTHORITY"; return out("WAITING"); }
  const est = model.estimate({ goals_now: goalsNow, elapsed_seconds: row.state_clock_seconds_elapsed as number, period: row.state_period_num as number, line: line.line as number, direction: line.direction as Direction });
  const invalid = validateEvAuthority(est);
  if (invalid) { blockers.push(invalid); edge = "EV_MODEL_AUTHORITY"; return out("WAITING"); }
  const e = est as ProbabilityEstimate;
  const evLcb = evPer1u(e.p_lcb, vwap), evMid = evPer1u(e.p_win, vwap);
  if (evMid > SUSPECT_EV_CEILING) { blockers.push("SUSPECT_EV_ABOVE_CEILING_REJECTED"); edge = "EV_MODEL_AUTHORITY"; return out("SKIP", { ev_valid: true, p_win: e.p_win, ev_lcb_per_1u: evLcb }); }
  if (evLcb < MIN_EV_LCB_MARGIN) { blockers.push("NO_POSITIVE_EV_AFTER_UNCERTAINTY_MARGIN"); edge = "EV_MODEL_AUTHORITY"; return out("SKIP", { ev_valid: true, p_win: e.p_win, ev_lcb_per_1u: evLcb }); }
  // Validated EV survives, but the approved authority for this alpha program is facts-only: no BET.
  blockers.push("BET_AUTHORITY_NOT_GRANTED_FOR_ALPHA_PROGRAM"); edge = "BET_AUTHORITY";
  return out("WAITING", { ev_valid: true, p_win: e.p_win, ev_lcb_per_1u: evLcb, ev_qualified: true });
}

// ───────────────────────────── contract-level frozen decision + coverage ─────────────────────────────
export const tailDecisionId = (physicalEventId: string, conditionId: string, tokenId: string) => {
  const h = createHash("sha256").update([physicalEventId, conditionId, tokenId, TAIL_PROGRAM_ID, TAIL_VERSION, TAIL_SCOPE_KEY].join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const progress = (a: TailRowAssessment) => (a.state_ok ? 1 : 0) + (a.line_proven ? 1 : 0) + (a.buy_ok ? 1 : 0) + (a.ev_valid ? 1 : 0);

/**
 * One frozen research decision per physical game x condition x token, causally: the first assessed row with every
 * factual edge proven is the decision row (later rows are never consulted); otherwise the furthest-progressed earliest row.
 * `rows` must be ascending by observed time. BET is unreachable by construction.
 */
export function freezeContractDecision(assessments: readonly TailRowAssessment[]): (TailRowAssessment & { decision_id: string; research_only: true; can_emit_bet: false }) | null {
  if (!assessments.length) return null;
  const complete = assessments.find((a) => a.state_ok && a.line_proven && a.buy_ok && a.status !== "SKIP");
  let pick = complete;
  if (!pick) pick = assessments.reduce((best, a) => (progress(a) > progress(best) ? a : best), assessments[0]);
  if (pick.status === "BET") throw new Error("TAIL_BET_FORBIDDEN");
  return { ...pick, decision_id: tailDecisionId(pick.physical_event_id, pick.condition_id, pick.token_id), research_only: true, can_emit_bet: false };
}

export type TailCoverage = {
  physical_games_n: number; contracts_n: number; rows_n: number;
  line_proven_contracts_n: number; line_status_counts: Record<string, number>;
  full_state_rows_n: number; executable_buy_rows_n: number; state_and_buy_rows_n: number; full_facts_rows_n: number;
  ev_valid_rows_n: number; ev_qualified_contracts_n: number;
  bet_n: number; skip_n: number; waiting_n: number;
  blocker_counts: Record<string, number>; first_broken_edge_counts: Record<string, number>;
  independent_games_with_full_facts_n: number; any_economic_advantage_demonstrated: false;
};

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export function summarizeCoverage(assessments: readonly TailRowAssessment[], lineByContract: ReadonlyMap<string, LineAuthority>): TailCoverage {
  const games = new Set(assessments.map((a) => a.physical_event_id));
  const byContract = new Map<string, TailRowAssessment[]>();
  for (const a of assessments) { const k = `${a.physical_event_id}|${a.condition_id}|${a.token_id}`; const g = byContract.get(k); if (g) g.push(a); else byContract.set(k, [a]); }
  const line_status_counts: Record<string, number> = {};
  let lineProven = 0;
  for (const [k] of byContract) {
    const la = lineByContract.get(k);
    bump(line_status_counts, la?.status ?? "UNAVAILABLE");
    if (la?.status === "PROVEN") lineProven++;
  }
  const blocker_counts: Record<string, number> = {}, first_broken_edge_counts: Record<string, number> = {};
  let bet = 0, skip = 0, waiting = 0, evQualified = 0;
  const factGames = new Set<string>();
  for (const [, rows] of byContract) {
    const d = freezeContractDecision(rows);
    if (!d) continue;
    if (d.status === "BET") bet++; else if (d.status === "SKIP") skip++; else waiting++;
    if (d.ev_qualified) evQualified++;
    bump(first_broken_edge_counts, d.first_broken_edge);
    for (const b of d.blockers) bump(blocker_counts, b);
    if (d.state_ok && d.line_proven && d.buy_ok) factGames.add(d.physical_event_id);
  }
  return {
    physical_games_n: games.size, contracts_n: byContract.size, rows_n: assessments.length,
    line_proven_contracts_n: lineProven, line_status_counts,
    full_state_rows_n: assessments.filter((a) => a.state_ok).length, executable_buy_rows_n: assessments.filter((a) => a.buy_ok).length,
    state_and_buy_rows_n: assessments.filter((a) => a.state_ok && a.buy_ok).length,
    full_facts_rows_n: assessments.filter((a) => a.state_ok && a.line_proven && a.buy_ok).length,
    ev_valid_rows_n: assessments.filter((a) => a.ev_valid).length, ev_qualified_contracts_n: evQualified,
    bet_n: bet, skip_n: skip, waiting_n: waiting, blocker_counts, first_broken_edge_counts,
    independent_games_with_full_facts_n: factGames.size,
    // Demonstrating an advantage needs validated EV AND settled independent-game outcomes; this slice supplies neither.
    any_economic_advantage_demonstrated: false,
  };
}

// ───────────────────────────── edge 5: terminal settlement replay ─────────────────────────────
export type ReplayVerdict = { state: "WIN" | "LOSS" | "NOT_REPLAYABLE"; reason: string };
/** Totals payoff from the final regulation score and the proven line. Extra time makes the provider rule scope ambiguous. */
export function replayTotalsPayoff(input: { line: LineAuthority; finalSideAScore: number | null; finalSideBScore: number | null; maxPeriodObserved: number | null }): ReplayVerdict {
  const { line, finalSideAScore: a, finalSideBScore: b, maxPeriodObserved } = input;
  if (line.status !== "PROVEN" || line.line === null || line.direction === null) return { state: "NOT_REPLAYABLE", reason: "LINE_AUTHORITY_NOT_PROVEN" };
  if (!isCount(a) || !isCount(b)) return { state: "NOT_REPLAYABLE", reason: "FINAL_SCORE_UNAVAILABLE" };
  if (maxPeriodObserved !== null && maxPeriodObserved > 2) return { state: "NOT_REPLAYABLE", reason: "EXTRA_TIME_REGULATION_SCOPE_AMBIGUOUS" };
  const over = a + b > line.line;
  return { state: (line.direction === "OVER") === over ? "WIN" : "LOSS", reason: "REPLAYED_FROM_FINAL_SCORE_AND_LINE" };
}

export type SettlementReconciliation = "CONSISTENT" | "CONTRADICTION" | "NOT_REPLAYABLE" | "PROVIDER_UNSETTLED";
/** Independent check of the provider's token settlement against the score+line replay. */
export function reconcileSettlement(input: { conditionId: string; tokenId: string; market: GammaMarket | null; replay: ReplayVerdict }): { state: SettlementReconciliation; provider_state: SiblingSettlementState; reason: string } {
  const p = classifySiblingSettlement({ conditionId: input.conditionId, tokenId: input.tokenId, market: input.market });
  if (p.state !== "SETTLED_WIN" && p.state !== "SETTLED_LOSS") return { state: "PROVIDER_UNSETTLED", provider_state: p.state, reason: p.reason };
  if (input.replay.state === "NOT_REPLAYABLE") return { state: "NOT_REPLAYABLE", provider_state: p.state, reason: input.replay.reason };
  const agree = (p.state === "SETTLED_WIN") === (input.replay.state === "WIN");
  return { state: agree ? "CONSISTENT" : "CONTRADICTION", provider_state: p.state, reason: agree ? "PROVIDER_MATCHES_REPLAY" : "PROVIDER_CONTRADICTS_REPLAY" };
}
