// Research-only frozen paper decisions over research_inplay_core_path_observations.
// DBClone-only consumer: no collector, money-path or serving import.
// Pure decision engine (no I/O) plus a bounded cursor runner at the bottom of the file.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const OBSERVATION_TABLE = "research_inplay_core_path_observations";
export const DECISION_TABLE = "research_inplay_paper_decisions";
export const CHECKPOINT_TABLE = "research_inplay_paper_checkpoints";
export const PROCESSOR_ID = "INPLAY_PAPER_DECISIONS_V1";
export const SCOPE_KEY = "MONEYLINE_FULL_GAME";
/** Policy configuration, not a claim about sport game clocks. */
export const ENTRY_WINDOW_MINUTES_AFTER_SCHEDULED_START = 30;
/** Source -> first-evaluation lag within which a decision may be called LIVE_PROSPECTIVE. */
export const MAX_LIVE_PROSPECTIVE_LAG_MS = 10 * 60_000;
/**
 * The only authorized source->DBClone path is the hourly `research-clone-daily-sync` Railway cron
 * (ops/railway/research-clone-daily-sync.toml, cronSchedule "0 * * * *"), so a decision is always frozen at least a
 * sync interval after the observation. A timely path has NOT been demonstrated; until it is, no decision may be
 * called LIVE_PROSPECTIVE regardless of the lag of an individual row.
 */
export const TIMELY_SOURCE_PATH_PROVEN = false;
export const COST_AUTHORITY = "FULL_STAKE_EXECUTABLE_BUY_VWAP";

export type PriceRange = { min: number; max: number };
export type StrategyKind = "CONTROL" | "ALPHA_RESEARCH";
export type Strategy = {
  id: string; version: string; kind: StrategyKind; canEmitBet: boolean;
  range: PriceRange | null; scopeKey: string;
};

/** Experimental controls, not alpha. Ranges are inclusive on the full-stake BUY VWAP. */
export const CONTROL_STRATEGIES: readonly Strategy[] = [
  { id: "CONTROL_PRICE_BUCKET_A", version: "v1", kind: "CONTROL", canEmitBet: true, range: { min: 0.48, max: 0.52 }, scopeKey: SCOPE_KEY },
  { id: "CONTROL_PRICE_BUCKET_B", version: "v1", kind: "CONTROL", canEmitBet: true, range: { min: 0.53, max: 0.58 }, scopeKey: SCOPE_KEY },
  { id: "CONTROL_PRICE_BUCKET_C", version: "v1", kind: "CONTROL", canEmitBet: true, range: { min: 0.35, max: 0.44 }, scopeKey: SCOPE_KEY },
];
/** Alpha programs preserve factual hooks only. They are structurally unable to produce BET. */
export const ALPHA_PROGRAMS: readonly Strategy[] = [
  { id: "VALUE_BACKED_TAIL_REPRICING", version: "v0-facts-only", kind: "ALPHA_RESEARCH", canEmitBet: false, range: null, scopeKey: SCOPE_KEY },
  { id: "STATEWISE_PAYOFF_ARBITRAGE", version: "v0-facts-only", kind: "ALPHA_RESEARCH", canEmitBet: false, range: null, scopeKey: SCOPE_KEY },
];

export type Observation = {
  id: string; physical_event_id: string; provider_game_id: string | null; provider_event_id: string;
  provider_sport_family: string; event_start_iso: string; observed_at: string; created_at: string | null;
  event_live_status: string; state_authority: string | null; state_phase: string | null;
  state_period_num: number | null; state_clock_seconds_remaining: number | null;
  side_a_score: number | null; side_b_score: number | null;
  condition_id: string; token_id: string; side: string;
  canonical_market_family: string; canonical_market_type: string; market_slug: string | null;
  best_bid: number | null; best_ask: number | null;
  bid_depth_relevant_usd: number | null; ask_depth_relevant_usd: number | null;
  full_stake_executable_vwap: number | null; full_stake_shares: number | null;
  full_stake_exit_vwap: number | null; full_stake_exit_fully_filled: boolean | null;
  taker_fee_usd: number | null; orderbook_fetch_status: string;
};

export type Provenance = "LIVE_PROSPECTIVE" | "DELAYED_PAPER" | "TIMING_UNPROVEN";
export type DecisionStatus = "WAITING" | "BET" | "SKIP";
export type DecisionRecord = Record<string, unknown> & { decision_id: string; status: DecisionStatus };
export type ExistingDecision = { decision_id: string; status: DecisionStatus; admission_observed_at: string; entry_window_end: string };

const micro = (n: number) => Math.round(n * 1e6);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function canonicalDefinition(strategy: Strategy): string {
  return JSON.stringify({
    id: strategy.id, version: strategy.version, kind: strategy.kind, canEmitBet: strategy.canEmitBet, range: strategy.range,
    scopeKey: strategy.scopeKey, priceAuthority: COST_AUTHORITY, windowMinutesAfterStart: ENTRY_WINDOW_MINUTES_AFTER_SCHEDULED_START,
    markets: "MONEYLINE", rank: "ABS_DISTANCE_TO_RANGE_CENTRE_THEN_TOKEN_ID", rangeInclusive: true, precision: "1e-6",
  });
}
export const strategyDefinitionHash = (s: Strategy) => createHash("sha256").update(canonicalDefinition(s)).digest("hex");

function uuidFrom(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Deterministic: the same physical event x strategy x version x scope always yields the same ID. */
export const decisionId = (physicalEventId: string, s: Strategy) => uuidFrom(physicalEventId, s.id, s.version, s.scopeKey);

export const entryWindowEndMs = (eventStartIso: string) => Date.parse(eventStartIso) + ENTRY_WINDOW_MINUTES_AFTER_SCHEDULED_START * 60_000;

/** Inclusive on both bounds; the 1e-9 slack only absorbs binary-float noise and cannot admit a real 1e-6 deviation. */
export function inRange(vwap: number, r: PriceRange): boolean {
  return vwap >= r.min - 1e-9 && vwap <= r.max + 1e-9;
}

/** Why one observation row cannot be a candidate for a strategy, or null when it qualifies. */
export function exclusionReason(s: Strategy, row: Observation, windowEnd: number): string | null {
  if (!s.range) return "NO_ENTRY_RULE";
  if (row.event_live_status !== "LIVE") return "NOT_LIVE";
  const t = ms(row.observed_at);
  if (!Number.isFinite(t)) return "OBSERVED_AT_INVALID";
  if (t > windowEnd) return "OUTSIDE_ENTRY_WINDOW";
  // Only exact provider-authored moneyline identity is proven in this telemetry. No line column exists, so
  // TOTALS / SPREADS / TOTAL_CORNERS can never be treated as identity-proven here.
  if (row.canonical_market_type === "SPREAD" || row.canonical_market_family === "SPREADS") return "SPREADS_QUARANTINED";
  if (row.canonical_market_type === "TOTAL" || row.canonical_market_family === "TOTALS") return "TOTALS_LINE_IDENTITY_UNPROVEN";
  if (row.canonical_market_family !== "MONEYLINE" || row.canonical_market_type !== "MONEYLINE") return "MARKET_IDENTITY_UNPROVEN";
  if (!row.condition_id || !row.token_id || !row.side) return "TOKEN_IDENTITY_MISSING";
  if (row.orderbook_fetch_status !== "SUCCESS") return "ORDERBOOK_UNAVAILABLE";
  const v = row.full_stake_executable_vwap;
  if (v === null || v === undefined || typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) return "FULL_STAKE_VWAP_MISSING_OR_INVALID";
  const q = row.full_stake_shares;
  if (q === null || q === undefined || typeof q !== "number" || !Number.isFinite(q) || q <= 0) return "FULL_STAKE_QUANTITY_MISSING";
  if (!inRange(v, s.range)) return "PRICE_OUT_OF_RANGE";
  return null;
}

/** Closest to the range centre wins; token_id is the deterministic tie-break. */
export function rankCandidates(s: Strategy, rows: readonly Observation[]): Observation[] {
  const centre = micro((s.range!.min + s.range!.max) / 2);
  return [...rows].sort((a, b) => {
    const da = Math.abs(micro(a.full_stake_executable_vwap!) - centre);
    const db = Math.abs(micro(b.full_stake_executable_vwap!) - centre);
    return da - db || (a.token_id < b.token_id ? -1 : a.token_id > b.token_id ? 1 : 0);
  });
}

/**
 * LIVE_PROSPECTIVE requires: a LIVE observation, a collector receipt that is consistent with the observation and
 * the first evaluation, a result not visible at evaluation and source->evaluation lag within the configured bound.
 * Evaluation time is an upper bound on DBClone availability (the row was read from the clone).
 */
export function classifyProvenance(i: { observedAt: string | null; receiptAt: string | null; evaluatedAtMs: number; resultVisible: boolean; live: boolean; timelyPathProven?: boolean }): Provenance {
  const o = ms(i.observedAt), r = ms(i.receiptAt);
  if (!Number.isFinite(o) || !Number.isFinite(r) || r < o - 1_000 || r > i.evaluatedAtMs || o > i.evaluatedAtMs) return "TIMING_UNPROVEN";
  if (i.resultVisible || !i.live || !(i.timelyPathProven ?? TIMELY_SOURCE_PATH_PROVEN)) return "DELAYED_PAPER";
  return i.evaluatedAtMs - o <= MAX_LIVE_PROSPECTIVE_LAG_MS ? "LIVE_PROSPECTIVE" : "DELAYED_PAPER";
}

function stateFacts(row: Observation) {
  const missing: string[] = [];
  if (row.side_a_score === null || row.side_b_score === null) missing.push("score");
  if (row.state_clock_seconds_remaining === null) missing.push("clock");
  if (row.state_period_num === null) missing.push("period");
  return {
    state_authority: row.state_authority, state_phase: row.state_phase,
    state_score_available: missing.length === 0,
    state_blocker: missing.length ? `SOURCE_STATE_NULL:${missing.join(",")}` : null,
  };
}

export type EvaluateInput = {
  strategy: Strategy;
  /** Observations of ONE physical event, ascending by (observed_at, id). Complete observed_at groups only. */
  rows: readonly Observation[];
  existing: ExistingDecision | null;
  /** Earliest FINAL observed_at for the event currently visible in DBClone, if any. */
  finalSeenAtMs: number | null;
  evaluatedAtMs: number;
  timelyPathProven?: boolean;
};
export type EvaluateOutput = { action: "NONE" | "INSERT" | "FREEZE"; decision: DecisionRecord | null };

/** Alpha programs are structurally barred from BET: this is the single construction point for every record. */
export function buildDecision(s: Strategy, status: DecisionStatus, fields: Record<string, unknown>): DecisionRecord {
  if (status === "BET" && (s.kind !== "CONTROL" || !s.canEmitBet)) throw new Error(`ALPHA_BET_FORBIDDEN:${s.id}`);
  return { ...fields, status, strategy_id: s.id, strategy_version: s.version, strategy_kind: s.kind, scope_key: s.scopeKey,
    strategy_definition_hash: strategyDefinitionHash(s), relation_state: "UNKNOWN" } as unknown as DecisionRecord;
}

const IMMUTABLE_IDENTITY = ["decision_id", "physical_event_id", "strategy_id", "strategy_version", "strategy_definition_hash", "strategy_kind", "scope_key", "admission_observed_at", "entry_window_end", "first_evaluated_at", "relation_state"];
/** WAITING -> BET|SKIP updates carry only the freeze fields; identity columns are DB-guarded immutable. */
export function toFreezePatch(d: DecisionRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(d).filter(([k]) => !IMMUTABLE_IDENTITY.includes(k)));
}
const isoMs = (v: string) => new Date(v).toISOString();

/**
 * One physical event x one strategy. Walks observations causally: the first observed_at group that contains a
 * qualifying candidate freezes the BET; later observations and outcomes are never consulted for that choice.
 */
export function evaluateEvent(input: EvaluateInput): EvaluateOutput {
  const { strategy: s, rows, existing, finalSeenAtMs, evaluatedAtMs, timelyPathProven } = input;
  if (!s.canEmitBet || s.kind !== "CONTROL") return { action: "NONE", decision: null };
  if (existing && existing.status !== "WAITING") return { action: "NONE", decision: null };
  if (!rows.length) return { action: "NONE", decision: null };
  const first = rows[0];
  const admissionIso = existing?.admission_observed_at ?? rows.find((r) => r.event_live_status === "LIVE")?.observed_at ?? null;
  if (!admissionIso) return { action: "NONE", decision: null };
  const windowEnd = entryWindowEndMs(first.event_start_iso);
  const id = existing?.decision_id ?? decisionId(first.physical_event_id, s);
  const base = {
    decision_id: id, physical_event_id: first.physical_event_id, provider_game_id: first.provider_game_id,
    provider_event_id: first.provider_event_id, provider_sport_family: first.provider_sport_family,
    event_start_iso: first.event_start_iso, admission_observed_at: admissionIso,
    entry_window_end: new Date(windowEnd).toISOString(), first_evaluated_at: new Date(evaluatedAtMs).toISOString(),
  };
  const resultVisible = finalSeenAtMs !== null;
  const exclusions: Record<string, number> = {};
  const note = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };

  const freezeSkip = (reason: string, ref: Observation | null): EvaluateOutput => {
    const provenance = ref
      ? classifyProvenance({ observedAt: ref.observed_at, receiptAt: ref.created_at, evaluatedAtMs, resultVisible, live: ref.event_live_status === "LIVE", timelyPathProven })
      : "TIMING_UNPROVEN";
    return { action: existing ? "FREEZE" : "INSERT", decision: buildDecision(s, "SKIP", {
      ...base, reject_reason: reason, exclusion_summary: exclusions, observed_at: ref?.observed_at ?? null,
      collector_receipt_at: ref?.created_at ?? null, frozen_at: new Date(evaluatedAtMs).toISOString(),
      processing_lag_ms: ref ? evaluatedAtMs - ms(ref.observed_at) : null, provenance_class: provenance, result_visible_at_freeze: resultVisible,
      admitted_candidate_n: 0,
    }) };
  };

  // group by observed_at (rows are ascending)
  const groups: Observation[][] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g[0].observed_at === r.observed_at) g.push(r); else groups.push([r]);
  }
  let lastLive: Observation | null = null;
  for (const group of groups) {
    const t = ms(group[0].observed_at);
    if (t < ms(admissionIso)) continue;
    if (t > windowEnd) return freezeSkip("ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE", lastLive);
    if (group.every((r) => r.event_live_status !== "LIVE")) return freezeSkip("EVENT_FINAL_BEFORE_QUALIFYING_ENTRY", lastLive ?? group[0]);
    const qualified: Observation[] = [];
    for (const r of group) {
      const reason = exclusionReason(s, r, windowEnd);
      if (reason) note(reason); else qualified.push(r);
    }
    lastLive = group[0];
    if (!qualified.length) continue;
    const winner = rankCandidates(s, qualified)[0];
    if (resultVisible) {
      note("RESULT_VISIBLE_AT_EVALUATION");
      return freezeSkip("RESULT_VISIBLE_AT_EVALUATION", winner);
    }
    const vwap = winner.full_stake_executable_vwap!, qty = winner.full_stake_shares!;
    return { action: existing ? "FREEZE" : "INSERT", decision: buildDecision(s, "BET", {
      ...base, source_observation_id: winner.id, condition_id: winner.condition_id, token_id: winner.token_id, side: winner.side,
      market_family: winner.canonical_market_family, market_scope: "FULL_GAME", market_line: null, market_slug: winner.market_slug,
      quote_batch_key: `${winner.physical_event_id}|${winner.observed_at}`,
      entry_vwap: vwap, entry_quantity: qty, entry_notional_usd: Math.round(vwap * qty * 1e6) / 1e6, entry_cost_authority: COST_AUTHORITY,
      entry_fee_usd: winner.taker_fee_usd, entry_fee_state: winner.taker_fee_usd === null ? "UNKNOWN" : "KNOWN",
      entry_best_bid: winner.best_bid, entry_best_ask: winner.best_ask, entry_ask_depth_usd: winner.ask_depth_relevant_usd,
      entry_bid_depth_usd: winner.bid_depth_relevant_usd, entry_exit_vwap: winner.full_stake_exit_vwap,
      entry_exit_fully_filled: winner.full_stake_exit_fully_filled, ...stateFacts(winner),
      admitted_candidate_n: qualified.length, exclusion_summary: exclusions, reject_reason: null,
      observed_at: winner.observed_at, collector_receipt_at: winner.created_at, frozen_at: new Date(evaluatedAtMs).toISOString(),
      processing_lag_ms: evaluatedAtMs - ms(winner.observed_at),
      provenance_class: classifyProvenance({ observedAt: winner.observed_at, receiptAt: winner.created_at, evaluatedAtMs, resultVisible: false, live: true, timelyPathProven }),
      result_visible_at_freeze: false,
    }) };
  }
  if (evaluatedAtMs > windowEnd) return freezeSkip("ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE", lastLive);
  if (resultVisible) return freezeSkip("EVENT_FINAL_BEFORE_QUALIFYING_ENTRY", lastLive);
  if (existing) return { action: "NONE", decision: null };
  return { action: "INSERT", decision: buildDecision(s, "WAITING", { ...base, exclusion_summary: null }) };
}

/** Which factual hooks the next missions can rely on, from observed rows (counts, not claims). */
export function factReadiness(rows: readonly Observation[]) {
  const n = rows.length;
  const c = (f: (r: Observation) => boolean) => rows.filter(f).length;
  const stateOk = c((r) => r.side_a_score !== null && r.side_b_score !== null && r.state_clock_seconds_remaining !== null && r.state_period_num !== null);
  const entryOk = c((r) => r.full_stake_executable_vwap !== null && r.full_stake_shares !== null);
  const exitOk = c((r) => r.full_stake_exit_vwap !== null && r.full_stake_exit_fully_filled !== null);
  return {
    rows: n, full_stake_entry_price_n: entryOk, exit_snapshot_n: exitOk, state_score_clock_n: stateOk,
    ALPHA_TAIL_FACTS_READY: n > 0 && stateOk === n && entryOk > 0 && exitOk > 0,
    // The telemetry persists only primary moneyline markets: no parent/derivative identity, no relation state.
    ALPHA_STRUCTURAL_FACTS_READY: false,
    EXECUTION_EXIT_FACTS_READY: n > 0 && entryOk > 0 && exitOk > 0,
  };
}

// ───────────────────────────── bounded runner ─────────────────────────────
export const PAGE_SIZE = 500;
/** 12 x 500 rows covers the 20,000 rows/UTC-day Production cap with room for a multi-hour catch-up. */
export const MAX_PAGES_PER_CYCLE = 12;
export const CURSOR_OVERLAP_MS = 120_000;
const EVENT_CHECK_CONCURRENCY = 10;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const COLUMNS = "id,physical_event_id,provider_game_id,provider_event_id,provider_sport_family,event_start_iso,observed_at,created_at,event_live_status,state_authority,state_phase,state_period_num,state_clock_seconds_remaining,side_a_score,side_b_score,condition_id,token_id,side,canonical_market_family,canonical_market_type,market_slug,best_bid,best_ask,bid_depth_relevant_usd,ask_depth_relevant_usd,full_stake_executable_vwap,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled,taker_fee_usd,orderbook_fetch_status";
const CONFLICT = "physical_event_id,strategy_id,strategy_version,scope_key";

export type CycleResult = {
  bootstrapped: boolean; pages: number; rows_read: number; events_seen: number; pre_bootstrap_events_skipped: number;
  inserted: number; frozen: number; swept: number; cursor_advanced: boolean; queries: number;
};

function fail(stage: string, error: { message: string } | null) { if (error) throw new Error(`INPLAY_PAPER_${stage}:${error.message}`); }
async function inBatches<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

/**
 * Bounded incremental cursor cycle. The checkpoint advances only after every decision write of the page succeeded.
 * The newest observed_at group is never evaluated: the clone sync appends in (observed_at, id) order, so only the
 * tail group can still be partial, and a partial group could change the ranked winner.
 */
export async function runPaperDecisionCycle(db: SupabaseClient, nowMs = Date.now(), strategies: readonly Strategy[] = CONTROL_STRATEGIES, timelyPathProven = TIMELY_SOURCE_PATH_PROVEN): Promise<CycleResult> {
  const result: CycleResult = { bootstrapped: false, pages: 0, rows_read: 0, events_seen: 0, pre_bootstrap_events_skipped: 0, inserted: 0, frozen: 0, swept: 0, cursor_advanced: false, queries: 0 };
  const nowIso = new Date(nowMs).toISOString();
  const cp = await db.from(CHECKPOINT_TABLE).select("cursor_observed_at,cursor_id,bootstrap_cursor_observed_at").eq("processor_id", PROCESSOR_ID).maybeSingle();
  result.queries++; fail("CHECKPOINT_READ", cp.error);
  if (!cp.data) {
    // Bootstrap: history is never processed. The cursor starts at the newest row existing now, and every event that
    // already has a row at or before it is permanently excluded (its true admission is unknown).
    const newest = await db.from(OBSERVATION_TABLE).select("observed_at,id").order("observed_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    result.queries++; fail("BOOTSTRAP_READ", newest.error);
    const top = (newest.data ?? [])[0] as { observed_at: string; id: string } | undefined;
    const at = top ? isoMs(top.observed_at) : nowIso;
    const w = await db.from(CHECKPOINT_TABLE).upsert({ processor_id: PROCESSOR_ID, cursor_observed_at: at, cursor_id: top?.id ?? ZERO_UUID, bootstrap_cursor_observed_at: at, bootstrapped_at: nowIso, updated_at: nowIso }, { onConflict: "processor_id", ignoreDuplicates: true });
    result.queries++; fail("BOOTSTRAP_WRITE", w.error);
    return { ...result, bootstrapped: true };
  }
  let cursor = { at: isoMs(cp.data.cursor_observed_at as string), id: cp.data.cursor_id as string };
  const bootstrapCursorAt = isoMs(cp.data.bootstrap_cursor_observed_at as string);
  // First page re-reads a short overlap window so a late-arriving clone row is not lost; decisions are idempotent.
  let from = { at: new Date(ms(cursor.at) - CURSOR_OVERLAP_MS).toISOString(), id: ZERO_UUID };
  const keyOf = (eventId: string, s: Strategy) => `${eventId}|${s.id}|${s.version}|${s.scopeKey}`;

  for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
    const q = await db.from(OBSERVATION_TABLE).select(COLUMNS)
      .or(`observed_at.gt.${from.at},and(observed_at.eq.${from.at},id.gt.${from.id})`)
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE);
    result.queries++; fail("OBSERVATION_READ", q.error);
    const fetched = (q.data ?? []) as unknown as Observation[];
    if (!fetched.length) break;
    const full = fetched.length === PAGE_SIZE;
    const tailAt = fetched[fetched.length - 1].observed_at;
    const rows = fetched.filter((r) => r.observed_at !== tailAt); // hold back the newest, possibly partial, group
    if (!rows.length) break;
    result.pages++; result.rows_read += rows.length;
    const byEvent = new Map<string, Observation[]>();
    for (const r of rows) { const g = byEvent.get(r.physical_event_id); if (g) g.push(r); else byEvent.set(r.physical_event_id, [r]); }
    const eventIds = [...byEvent.keys()];
    result.events_seen += eventIds.length;

    const existing = new Map<string, ExistingDecision>();
    for (let i = 0; i < eventIds.length; i += 25) {
      const d = await db.from(DECISION_TABLE).select("decision_id,physical_event_id,strategy_id,strategy_version,scope_key,status,admission_observed_at,entry_window_end").in("physical_event_id", eventIds.slice(i, i + 25)).limit(1000);
      result.queries++; fail("DECISION_READ", d.error);
      for (const e of (d.data ?? []) as Array<ExistingDecision & { physical_event_id: string; strategy_id: string; strategy_version: string; scope_key: string }>)
        existing.set(`${e.physical_event_id}|${e.strategy_id}|${e.strategy_version}|${e.scope_key}`, e);
    }
    // Per-event facts, one indexed single-row lookup each, only for events that can still change.
    const open = eventIds.filter((id) => strategies.some((s) => { const e = existing.get(keyOf(id, s)); return !e || e.status === "WAITING"; }));
    const finalSeen = new Map<string, number>();
    const preBootstrap = new Set<string>();
    await inBatches(open, EVENT_CHECK_CONCURRENCY, async (id) => {
      const f = await db.from(OBSERVATION_TABLE).select("observed_at").eq("physical_event_id", id).eq("event_live_status", "FINAL").order("observed_at", { ascending: true }).limit(1);
      result.queries++; fail("FINAL_READ", f.error);
      const fr = (f.data ?? [])[0] as { observed_at: string } | undefined;
      if (fr) finalSeen.set(id, ms(fr.observed_at));
      if (!strategies.some((s) => existing.has(keyOf(id, s)))) { // an event already holding a decision was admitted after bootstrap
        const p = await db.from(OBSERVATION_TABLE).select("id").eq("physical_event_id", id).lte("observed_at", bootstrapCursorAt).limit(1);
        result.queries++; fail("PRE_BOOTSTRAP_READ", p.error);
        if ((p.data ?? []).length) preBootstrap.add(id);
      }
    });

    for (const [eventId, eventRows] of byEvent) {
      // Admission before processor start cannot be proven: never create retroactive forward decisions.
      if (preBootstrap.has(eventId)) { result.pre_bootstrap_events_skipped++; continue; }
      for (const s of strategies) {
        const out = evaluateEvent({ strategy: s, rows: eventRows, existing: existing.get(keyOf(eventId, s)) ?? null, finalSeenAtMs: finalSeen.get(eventId) ?? null, evaluatedAtMs: nowMs, timelyPathProven });
        if (out.action === "NONE" || !out.decision) continue;
        if (out.action === "INSERT") {
          const w = await db.from(DECISION_TABLE).upsert(out.decision, { onConflict: CONFLICT, ignoreDuplicates: true });
          result.queries++; fail("DECISION_INSERT", w.error); result.inserted++;
        } else {
          const w = await db.from(DECISION_TABLE).update(toFreezePatch(out.decision)).eq("decision_id", out.decision.decision_id).eq("status", "WAITING");
          result.queries++; fail("DECISION_FREEZE", w.error); result.frozen++;
        }
      }
    }
    const last = rows[rows.length - 1];
    const next = { at: isoMs(last.observed_at), id: last.id };
    const adv = await db.from(CHECKPOINT_TABLE).update({ cursor_observed_at: next.at, cursor_id: next.id, last_batch_rows: rows.length, updated_at: nowIso })
      .eq("processor_id", PROCESSOR_ID).or(`cursor_observed_at.lt.${next.at},and(cursor_observed_at.eq.${next.at},cursor_id.lt.${next.id})`);
    result.queries++; fail("CHECKPOINT_WRITE", adv.error);
    if (next.at > cursor.at || (next.at === cursor.at && next.id > cursor.id)) { cursor = next; result.cursor_advanced = true; }
    from = next;
    if (!full) break;
  }

  // Sweep: windows that elapsed with no further observation freeze as SKIP with an exact reason.
  const waiting = await db.from(DECISION_TABLE).select("decision_id,strategy_id")
    .eq("status", "WAITING").lt("entry_window_end", nowIso).order("entry_window_end", { ascending: true }).limit(200);
  result.queries++; fail("SWEEP_READ", waiting.error);
  for (const w of (waiting.data ?? []) as Array<{ decision_id: string; strategy_id: string }>) {
    const s = strategies.find((x) => x.id === w.strategy_id);
    if (!s) continue;
    const rec = buildDecision(s, "SKIP", {
      reject_reason: "ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE", exclusion_summary: {}, frozen_at: nowIso,
      provenance_class: "TIMING_UNPROVEN", admitted_candidate_n: 0, result_visible_at_freeze: null,
    });
    const u = await db.from(DECISION_TABLE).update(toFreezePatch(rec)).eq("decision_id", w.decision_id).eq("status", "WAITING");
    result.queries++; fail("SWEEP_WRITE", u.error); result.swept++;
  }
  return result;
}
