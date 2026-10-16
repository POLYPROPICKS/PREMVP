// TAIL_FORWARD_EVIDENCE_V1: research-only forward observation of Value-Backed Tail Repricing.
// DBClone-only consumer of research_inplay_core_path_observations; writes ONLY through the existing
// research_inplay_paper_decisions / research_inplay_paper_checkpoints tables. No collector, money-path or serving import,
// no order, no BET (canEmitBet=false, ALPHA_RESEARCH). Pre-registered research criteria, NOT validated alpha.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OBSERVATION_TABLE, DECISION_TABLE, CHECKPOINT_TABLE, SCOPE_KEY, COST_AUTHORITY, TIMELY_SOURCE_PATH_PROVEN, PAGE_SIZE, MAX_PAGES_PER_CYCLE,
  CURSOR_OVERLAP_MS, MAX_LIVE_PROSPECTIVE_LAG_MS, buildDecision, classifyProvenance, decisionId,
  type Observation, type Strategy, type DecisionRecord,
} from "./inplayPaperDecisions";

export const TAIL_PROCESSOR_ID = "TAIL_FORWARD_EVIDENCE_V1";
export const TAIL_STRATEGY: Strategy = {
  id: "VALUE_BACKED_TAIL_REPRICING", version: "tail-forward-v1", kind: "ALPHA_RESEARCH", canEmitBet: false,
  range: { min: 0, max: 0.2 }, scopeKey: SCOPE_KEY,
};

/** Frozen rule candidate. Changing ANY value requires a new strategy version. */
export const TAIL_RULE = {
  sportFamily: "soccer", market: "MONEYLINE", period: 2, elapsedSecondsMin: 60 * 60, elapsedSecondsMax: 75 * 60,
  fullStakeBuyVwapMax: 0.2, virtualStakeUsd: 2.5, stakeNotionalToleranceUsd: 0.01, priceAuthority: COST_AUTHORITY,
  /** Quote must be at most this old at freeze; equals the LIVE_PROSPECTIVE lag bound of the control processor. */
  maxFreezeLagMs: MAX_LIVE_PROSPECTIVE_LAG_MS,
  /** Mirror of the collector's validated bounds (not imported: this module must not depend on the collector). */
  maxQuoteAcquisitionMs: 60_000, maxStateAgeMs: 90_000, providerTsMaxLeadMs: 2_000,
  /** Upper bound (minutes after scheduled start) used only to fill the NOT NULL entry_window_end identity column. */
  identityWindowMinutesAfterStart: 150,
  rank: "EARLIEST_ELIGIBLE_QUOTE_GROUP_THEN_TOKEN_ID", oneDecisionPerPhysicalEvent: true,
  cohort: "RUNTIME_BOOTSTRAP_CURSOR_EXCLUDES_EVENTS_WITH_ANY_ROW_AT_OR_BEFORE_IT",
} as const;
export const tailDefinitionHash = () => createHash("sha256").update(JSON.stringify({ strategy: TAIL_STRATEGY, rule: TAIL_RULE })).digest("hex");

export const TAIL_REASON = {
  RECORDED: "TAIL_OBSERVATION_RECORDED_NO_ORDER",
  RESULT_VISIBLE: "TAIL_RESULT_VISIBLE_AT_FREEZE",
  FETCH_TIMES_MISSING: "TAIL_QUOTE_FETCH_TIMES_MISSING",
  PROVIDER_TS_MISSING: "TAIL_PROVIDER_SOURCE_TIMESTAMP_MISSING",
  STATE_INCOMPLETE: "TAIL_STATE_INCOMPLETE",
  STATE_STALE: "TAIL_STATE_STALE_AT_QUOTE",
  CHAIN_INVALID: "TAIL_TIMESTAMP_CHAIN_INVALID",
  STAKE_UNPROVEN: "TAIL_STAKE_OR_EXECUTABILITY_UNPROVEN",
  DEPTH_INSUFFICIENT: "TAIL_EXECUTION_DEPTH_INSUFFICIENT",
  STALE_AT_FREEZE: "TAIL_QUOTE_STALE_AT_FREEZE",
} as const;

/** Observation columns the Tail rule needs beyond the control-processor set. */
export type TailObservation = Observation & {
  state_clock_seconds_elapsed: number | null; state_received_at: string | null;
  orderbook_fetch_started_at: string | null; orderbook_fetch_completed_at: string | null; orderbook_provider_timestamp_at: string | null;
  taker_fee_state: string | null; taker_fee_reason: string | null; executable_full_stake_state: string | null; quote_cycle_span_ms: number | null;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** True when the row is inside the frozen Tail window and has a valid full-stake BUY VWAP at or below the cap. */
export function isTailCandidate(r: TailObservation): boolean {
  if (r.event_live_status !== "LIVE" || r.provider_sport_family !== TAIL_RULE.sportFamily) return false;
  if (r.canonical_market_family !== "MONEYLINE" || r.canonical_market_type !== TAIL_RULE.market) return false;
  if (!r.condition_id || !r.token_id || !r.side || r.orderbook_fetch_status !== "SUCCESS") return false;
  if (r.state_period_num !== TAIL_RULE.period || !num(r.state_clock_seconds_elapsed)) return false;
  if (r.state_clock_seconds_elapsed < TAIL_RULE.elapsedSecondsMin || r.state_clock_seconds_elapsed > TAIL_RULE.elapsedSecondsMax) return false;
  const v = r.full_stake_executable_vwap;
  return num(v) && v > 0 && v < 1 && v <= TAIL_RULE.fullStakeBuyVwapMax + 1e-9;
}

/** First failed evidence requirement for a candidate at freeze time, or null when it is fully eligible. */
export function tailEvidenceReason(r: TailObservation, evaluatedAtMs: number, resultVisible: boolean): string | null {
  if (resultVisible) return TAIL_REASON.RESULT_VISIBLE;
  const obs = ms(r.observed_at), started = ms(r.orderbook_fetch_started_at), done = ms(r.orderbook_fetch_completed_at), prov = ms(r.orderbook_provider_timestamp_at);
  if (!Number.isFinite(started) || !Number.isFinite(done)) return TAIL_REASON.FETCH_TIMES_MISSING;
  if (!Number.isFinite(prov)) return TAIL_REASON.PROVIDER_TS_MISSING;
  if (r.side_a_score === null || r.side_b_score === null || !r.state_received_at) return TAIL_REASON.STATE_INCOMPLETE;
  const stateAt = ms(r.state_received_at);
  if (!Number.isFinite(obs) || !Number.isFinite(stateAt) || stateAt > obs + 1_000) return TAIL_REASON.CHAIN_INVALID;
  if (obs - stateAt > TAIL_RULE.maxStateAgeMs) return TAIL_REASON.STATE_STALE;
  // source (provider) <= receipt (completed) <= freeze, and the request interval is inside one bounded acquisition window.
  if (done < started || done - started > TAIL_RULE.maxQuoteAcquisitionMs || prov > done + TAIL_RULE.providerTsMaxLeadMs
    || done > evaluatedAtMs || started < obs - 1_000) return TAIL_REASON.CHAIN_INVALID;
  const v = r.full_stake_executable_vwap!, q = r.full_stake_shares;
  if (!num(q) || q <= 0 || Math.abs(v * q - TAIL_RULE.virtualStakeUsd) > TAIL_RULE.stakeNotionalToleranceUsd || r.executable_full_stake_state !== "EXECUTABLE") return TAIL_REASON.STAKE_UNPROVEN;
  if (!num(r.ask_depth_relevant_usd) || r.ask_depth_relevant_usd < TAIL_RULE.virtualStakeUsd) return TAIL_REASON.DEPTH_INSUFFICIENT;
  if (evaluatedAtMs - done > TAIL_RULE.maxFreezeLagMs) return TAIL_REASON.STALE_AT_FREEZE;
  return null;
}

export type TailEvaluateInput = {
  /** Observations of ONE physical event, ascending by (observed_at, id). Complete observed_at groups only. */
  rows: readonly TailObservation[];
  hasDecision: boolean;
  /** Earliest FINAL observed_at for the event currently visible in DBClone, if any. */
  finalSeenAtMs: number | null;
  evaluatedAtMs: number;
  /** Runtime bootstrap cursor: rows at or before it are historical and never part of the forward cohort. */
  cohortStartMs: number;
  /** observed_at of the event's earliest row in DBClone (identity context only; never used for the rule). */
  admissionObservedAt: string;
};
export type TailEvaluateOutput = { action: "NONE" | "INSERT"; decision: DecisionRecord | null };

/** Pure: one physical event -> at most one frozen, order-free research observation (stored as SKIP; the schema forbids alpha BET). */
export function evaluateTailEvent(input: TailEvaluateInput): TailEvaluateOutput {
  const { hasDecision, finalSeenAtMs, evaluatedAtMs, cohortStartMs } = input;
  if (hasDecision) return { action: "NONE", decision: null };
  const rows = input.rows.filter((r) => ms(r.observed_at) > cohortStartMs);
  const candidates = rows.filter(isTailCandidate);
  if (!candidates.length) return { action: "NONE", decision: null };
  const resultVisible = finalSeenAtMs !== null;
  const exclusions: Record<string, number> = {};
  const graded = candidates.map((r) => {
    const reason = tailEvidenceReason(r, evaluatedAtMs, resultVisible);
    if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    return { r, reason };
  });
  const eligible = graded.filter((g) => !g.reason);
  const key = (g: { r: TailObservation }) => g.r.observed_at;
  eligible.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.r.token_id < b.r.token_id ? -1 : a.r.token_id > b.r.token_id ? 1 : 0));
  const pick = eligible[0] ?? graded[graded.length - 1]; // no eligible quote: explain with the freshest candidate
  const w = pick.r;
  const first = candidates[0];
  const groupN = candidates.filter((c) => c.observed_at === w.observed_at).length;
  const feeKnown = w.taker_fee_state === "KNOWN" && num(w.taker_fee_usd);
  const done = ms(w.orderbook_fetch_completed_at);
  const base: Record<string, unknown> = {
    decision_id: decisionId(first.physical_event_id, TAIL_STRATEGY), physical_event_id: first.physical_event_id,
    provider_game_id: first.provider_game_id, provider_event_id: first.provider_event_id, provider_sport_family: first.provider_sport_family,
    event_start_iso: first.event_start_iso, admission_observed_at: input.admissionObservedAt,
    entry_window_end: new Date(Date.parse(first.event_start_iso) + TAIL_RULE.identityWindowMinutesAfterStart * 60_000).toISOString(),
    first_evaluated_at: new Date(evaluatedAtMs).toISOString(), frozen_at: new Date(evaluatedAtMs).toISOString(),
    result_visible_at_freeze: resultVisible, admitted_candidate_n: eligible.length ? groupN : 0,
    observed_at: w.observed_at,
    // Quote receipt (CLOB /book accepted) is the earliest moment the complete quote exists; it is the receipt of record.
    collector_receipt_at: Number.isFinite(done) ? new Date(done).toISOString() : null,
    processing_lag_ms: Number.isFinite(done) ? evaluatedAtMs - done : evaluatedAtMs - ms(w.observed_at),
    provenance_class: classifyProvenance({ observedAt: w.observed_at, receiptAt: w.orderbook_fetch_completed_at, evaluatedAtMs, resultVisible, live: true, timelyPathProven: TIMELY_SOURCE_PATH_PROVEN }),
    exclusion_summary: {
      tail_rule_version: TAIL_STRATEGY.version, tail_rule_hash: tailDefinitionHash(), tail_candidates_n: candidates.length,
      tail_cohort_start: new Date(cohortStartMs).toISOString(), exclusions,
      quote_evidence: {
        provider_timestamp_at: w.orderbook_provider_timestamp_at, fetch_started_at: w.orderbook_fetch_started_at,
        fetch_completed_at: w.orderbook_fetch_completed_at, state_received_at: w.state_received_at, quote_cycle_span_ms: w.quote_cycle_span_ms,
        elapsed_seconds: w.state_clock_seconds_elapsed, period: w.state_period_num, score: [w.side_a_score, w.side_b_score],
        fee_state: feeKnown ? "KNOWN" : "UNKNOWN", fee_reason: w.taker_fee_reason, fee_version: "UNKNOWN_NOT_SUPPORTED_BY_SCHEMA",
        stake_usd: TAIL_RULE.virtualStakeUsd, executable_state: w.executable_full_stake_state,
      },
    },
    source_observation_id: w.id, condition_id: w.condition_id, token_id: w.token_id, side: w.side, market_family: w.canonical_market_family,
    market_scope: "FULL_GAME", market_line: null, market_slug: w.market_slug, quote_batch_key: `${w.physical_event_id}|${w.observed_at}`,
    entry_vwap: w.full_stake_executable_vwap, entry_quantity: w.full_stake_shares, entry_cost_authority: COST_AUTHORITY,
    entry_notional_usd: num(w.full_stake_executable_vwap) && num(w.full_stake_shares) ? Math.round(w.full_stake_executable_vwap * w.full_stake_shares * 1e6) / 1e6 : null,
    entry_fee_usd: feeKnown ? w.taker_fee_usd : null, entry_fee_state: feeKnown ? "KNOWN" : "UNKNOWN",
    entry_best_bid: w.best_bid, entry_best_ask: w.best_ask, entry_ask_depth_usd: w.ask_depth_relevant_usd, entry_bid_depth_usd: w.bid_depth_relevant_usd,
    entry_exit_vwap: w.full_stake_exit_vwap, entry_exit_fully_filled: w.full_stake_exit_fully_filled,
    state_authority: w.state_authority, state_phase: w.state_phase,
    state_score_available: w.side_a_score !== null && w.side_b_score !== null && w.state_period_num !== null && w.state_clock_seconds_elapsed !== null,
    state_blocker: null,
    reject_reason: pick.reason ?? TAIL_REASON.RECORDED,
  };
  const decision = { ...buildDecision(TAIL_STRATEGY, "SKIP", base), strategy_definition_hash: tailDefinitionHash() } as DecisionRecord;
  return { action: "INSERT", decision };
}

// ───────────────────────────── bounded runner ─────────────────────────────
const COLUMNS = "id,physical_event_id,provider_game_id,provider_event_id,provider_sport_family,event_start_iso,observed_at,created_at,event_live_status,state_authority,state_phase,state_period_num,state_clock_seconds_remaining,state_clock_seconds_elapsed,state_received_at,side_a_score,side_b_score,condition_id,token_id,side,canonical_market_family,canonical_market_type,market_slug,best_bid,best_ask,bid_depth_relevant_usd,ask_depth_relevant_usd,full_stake_executable_vwap,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled,taker_fee_usd,taker_fee_state,taker_fee_reason,executable_full_stake_state,quote_cycle_span_ms,orderbook_fetch_status,orderbook_fetch_started_at,orderbook_fetch_completed_at,orderbook_provider_timestamp_at";
const CONFLICT = "physical_event_id,strategy_id,strategy_version,scope_key";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const isoMs = (v: string) => new Date(v).toISOString();

export type TailCycleResult = {
  bootstrapped: boolean; pages: number; rows_read: number; events_seen: number; pre_cohort_events_skipped: number;
  inserted: number; recorded: number; ineligible: number; cursor_advanced: boolean; queries: number;
};
function fail(stage: string, error: { message: string } | null) { if (error) throw new Error(`TAIL_FORWARD_${stage}:${error.message}`); }

/**
 * Same keyset-cursor discipline as the control processor, with its OWN durable checkpoint row (no new table). The first
 * run only records the cohort boundary at runtime; nothing that exists at that moment is ever evaluated.
 */
export async function runTailForwardCycle(db: SupabaseClient, nowMs = Date.now()): Promise<TailCycleResult> {
  const result: TailCycleResult = { bootstrapped: false, pages: 0, rows_read: 0, events_seen: 0, pre_cohort_events_skipped: 0, inserted: 0, recorded: 0, ineligible: 0, cursor_advanced: false, queries: 0 };
  const nowIso = new Date(nowMs).toISOString();
  const cp = await db.from(CHECKPOINT_TABLE).select("cursor_observed_at,cursor_id,bootstrap_cursor_observed_at").eq("processor_id", TAIL_PROCESSOR_ID).maybeSingle();
  result.queries++; fail("CHECKPOINT_READ", cp.error);
  if (!cp.data) {
    const newest = await db.from(OBSERVATION_TABLE).select("observed_at,id").order("observed_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    result.queries++; fail("BOOTSTRAP_READ", newest.error);
    const top = (newest.data ?? [])[0] as { observed_at: string; id: string } | undefined;
    const at = top ? isoMs(top.observed_at) : nowIso;
    const w = await db.from(CHECKPOINT_TABLE).upsert({ processor_id: TAIL_PROCESSOR_ID, cursor_observed_at: at, cursor_id: top?.id ?? ZERO_UUID, bootstrap_cursor_observed_at: at, bootstrapped_at: nowIso, updated_at: nowIso }, { onConflict: "processor_id", ignoreDuplicates: true });
    result.queries++; fail("BOOTSTRAP_WRITE", w.error);
    return { ...result, bootstrapped: true };
  }
  let cursor = { at: isoMs(cp.data.cursor_observed_at as string), id: cp.data.cursor_id as string };
  const cohortStartMs = ms(isoMs(cp.data.bootstrap_cursor_observed_at as string));
  const cohortStartIso = new Date(cohortStartMs).toISOString();
  let from = { at: new Date(ms(cursor.at) - CURSOR_OVERLAP_MS).toISOString(), id: ZERO_UUID };

  for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
    const q = await db.from(OBSERVATION_TABLE).select(COLUMNS)
      .or(`observed_at.gt.${from.at},and(observed_at.eq.${from.at},id.gt.${from.id})`)
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE);
    result.queries++; fail("OBSERVATION_READ", q.error);
    const fetched = (q.data ?? []) as unknown as TailObservation[];
    if (!fetched.length) break;
    const full = fetched.length === PAGE_SIZE;
    const tailAt = fetched[fetched.length - 1].observed_at;
    const rows = fetched.filter((r) => r.observed_at !== tailAt); // newest group may still be partial
    if (!rows.length) break;
    result.pages++; result.rows_read += rows.length;
    const byEvent = new Map<string, TailObservation[]>();
    for (const r of rows) {
      if (ms(r.observed_at) <= cohortStartMs || !isTailCandidate(r)) continue;
      const g = byEvent.get(r.physical_event_id); if (g) g.push(r); else byEvent.set(r.physical_event_id, [r]);
    }
    // Only events that produced a candidate row in this page need further reads.
    const eventIds = [...byEvent.keys()];
    result.events_seen += eventIds.length;
    for (const eventId of eventIds) {
      const has = await db.from(DECISION_TABLE).select("decision_id").eq("physical_event_id", eventId).eq("strategy_id", TAIL_STRATEGY.id).eq("strategy_version", TAIL_STRATEGY.version).eq("scope_key", TAIL_STRATEGY.scopeKey).limit(1);
      result.queries++; fail("DECISION_READ", has.error);
      if ((has.data ?? []).length) continue;
      // Admission before the cohort boundary cannot be proven: any earlier row excludes the whole event permanently.
      const pre = await db.from(OBSERVATION_TABLE).select("id").eq("physical_event_id", eventId).lte("observed_at", cohortStartIso).limit(1);
      result.queries++; fail("PRE_COHORT_READ", pre.error);
      if ((pre.data ?? []).length) { result.pre_cohort_events_skipped++; continue; }
      const fin = await db.from(OBSERVATION_TABLE).select("observed_at").eq("physical_event_id", eventId).eq("event_live_status", "FINAL").order("observed_at", { ascending: true }).limit(1);
      result.queries++; fail("FINAL_READ", fin.error);
      const finalAt = ((fin.data ?? [])[0] as { observed_at: string } | undefined)?.observed_at;
      // Admission context: the event's earliest row, so the identity column is not derived from a mid-event page.
      const firstRow = await db.from(OBSERVATION_TABLE).select("observed_at").eq("physical_event_id", eventId).order("observed_at", { ascending: true }).limit(1);
      result.queries++; fail("ADMISSION_READ", firstRow.error);
      const evRows = byEvent.get(eventId)!;
      const admissionObservedAt = ((firstRow.data ?? [])[0] as { observed_at: string } | undefined)?.observed_at ?? evRows[0].observed_at;
      const out = evaluateTailEvent({ rows: evRows, hasDecision: false, finalSeenAtMs: finalAt ? ms(finalAt) : null, evaluatedAtMs: nowMs, cohortStartMs, admissionObservedAt });
      if (out.action !== "INSERT" || !out.decision) continue;
      const w = await db.from(DECISION_TABLE).upsert(out.decision, { onConflict: CONFLICT, ignoreDuplicates: true });
      result.queries++; fail("DECISION_INSERT", w.error); result.inserted++;
      if (out.decision.reject_reason === TAIL_REASON.RECORDED) result.recorded++; else result.ineligible++;
    }
    const last = rows[rows.length - 1];
    const next = { at: isoMs(last.observed_at), id: last.id };
    const adv = await db.from(CHECKPOINT_TABLE).update({ cursor_observed_at: next.at, cursor_id: next.id, last_batch_rows: rows.length, updated_at: nowIso })
      .eq("processor_id", TAIL_PROCESSOR_ID).or(`cursor_observed_at.lt.${next.at},and(cursor_observed_at.eq.${next.at},cursor_id.lt.${next.id})`);
    result.queries++; fail("CHECKPOINT_WRITE", adv.error);
    if (next.at > cursor.at || (next.at === cursor.at && next.id > cursor.id)) { cursor = next; result.cursor_advanced = true; }
    from = next;
    if (!full) break;
  }
  return result;
}
