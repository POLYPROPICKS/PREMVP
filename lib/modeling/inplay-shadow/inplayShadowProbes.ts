// INPLAY_SHADOW_PROBES_V1. Pure, deterministic, read-only mechanism probes over
// research_inplay_core_path_observations rows. No I/O, no clock, no money-path consumer.
// Outputs are mechanism evidence only: no strategy, threshold, fair value or net PnL.

export type InplayObservation = {
  id?: string | null;
  physical_event_id: string;
  provider_sport_family: string;
  observed_at: string;
  event_live_status: string;
  state_phase: string | null;
  side_a_score?: number | string | null;
  side_b_score?: number | string | null;
  condition_id: string;
  token_id: string;
  canonical_market_type: string;
  mid_price: number | string | null;
  spread_abs: number | string | null;
  bid_depth_relevant_usd?: number | string | null;
  ask_depth_relevant_usd?: number | string | null;
  full_stake_executable_vwap: number | string | null;
  full_stake_exit_vwap: number | string | null;
  full_stake_exit_fully_filled: boolean | null;
  orderbook_fetch_status: string;
  persistence_reason: string;
  sequence_in_event?: number | null;
};

export const PROBE_COLUMNS = [
  "id", "physical_event_id", "provider_sport_family", "observed_at", "event_live_status", "state_phase",
  "side_a_score", "side_b_score", "condition_id", "token_id", "canonical_market_type", "mid_price", "spread_abs",
  "bid_depth_relevant_usd", "ask_depth_relevant_usd", "full_stake_executable_vwap", "full_stake_exit_vwap",
  "full_stake_exit_fully_filled", "orderbook_fetch_status", "persistence_reason", "sequence_in_event",
] as const;

export const SYNC_WINDOW_MS = 5_000;
export const ECONOMICS_LABEL = "GROSS_BEFORE_EXIT_FEE";
const CORE_TYPES = new Set(["MONEYLINE", "SPREAD", "TOTAL"]);
const FAVORABLE_BUCKETS: ReadonlyArray<[string, number]> = [["<=60s", 60], ["<=300s", 300], ["<=900s", 900], ["<=3600s", 3600]];

type Num = number | null;
const num = (v: unknown): Num => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ms = (r: InplayObservation): number => Date.parse(r.observed_at);
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function median(values: readonly number[]): Num {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return r6(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) { const k = key(i); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Total order independent of input order: time, then sequence, then id. */
export function sortObservations(rows: readonly InplayObservation[]): InplayObservation[] {
  return rows.filter((r) => Number.isFinite(ms(r))).sort((a, b) =>
    ms(a) - ms(b) || (a.sequence_in_event ?? 0) - (b.sequence_in_event ?? 0) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

function tokenPaths(rows: readonly InplayObservation[]): Map<string, InplayObservation[]> {
  const paths = new Map<string, InplayObservation[]>();
  for (const r of sortObservations(rows)) {
    const key = `${r.physical_event_id}\u0000${r.token_id}`;
    const p = paths.get(key) ?? [];
    p.push(r);
    paths.set(key, p);
  }
  return paths;
}

// ---------------------------------------------------------------- corpus summary
export function summarizeCorpus(rows: readonly InplayObservation[]) {
  const sorted = sortObservations(rows);
  return {
    CORPUS_ROW_N: rows.length,
    PHYSICAL_EVENT_N: new Set(rows.map((r) => r.physical_event_id)).size,
    TOKEN_N: new Set(rows.map((r) => r.token_id)).size,
    SPORT_BREAKDOWN: countBy(rows, (r) => r.provider_sport_family),
    MARKET_BREAKDOWN: countBy(rows, (r) => r.canonical_market_type),
    PERSISTENCE_REASON_BREAKDOWN: countBy(rows, (r) => r.persistence_reason),
    OBSERVED_FROM: sorted.length ? sorted[0].observed_at : null,
    OBSERVED_TO: sorted.length ? sorted[sorted.length - 1].observed_at : null,
  };
}

// ---------------------------------------------------------------- 1. SHOCK_REVERSION_V1
export const SHOCK_REVERSION_BLOCKED = "BLOCKED_NO_NUMERIC_STATE_AUTHORITY";

/**
 * Blocked by contract. Only typed numeric side scores on a row could ever lift this, and the
 * probe never parses formatted text and never substitutes price movement for a score shock.
 */
export function probeShockReversion(rows: readonly InplayObservation[]) {
  const typed = rows.filter((r) => num(r.side_a_score) !== null && num(r.side_b_score) !== null).length;
  return {
    probe: "SHOCK_REVERSION_V1",
    state: typed === 0 ? SHOCK_REVERSION_BLOCKED : "BLOCKED_PROBE_LOGIC_NOT_IMPLEMENTED_V1",
    status: typed === 0 ? SHOCK_REVERSION_BLOCKED : "BLOCKED_PROBE_LOGIC_NOT_IMPLEMENTED_V1",
    eligible_n: 0,
    event_n: 0,
    typed_numeric_score_row_n: typed,
    blocker: "provider proves structured live/ended/status/period only; no typed numeric side score; score text is never parsed",
  };
}

// ---------------------------------------------------------------- 2. TAIL_PATH_OPTIONALITY_V1
export function isExecutableDecisionRow(r: InplayObservation): boolean {
  const v = num(r.full_stake_executable_vwap);
  return r.orderbook_fetch_status === "SUCCESS" && v !== null && v > 0;
}
export function executableExitPrice(r: InplayObservation): Num {
  const v = num(r.full_stake_exit_vwap);
  return r.full_stake_exit_fully_filled === true && v !== null ? v : null;
}

export type TailDecision = { physical_event_id: string; token_id: string; decision_at: string; entry_price: number; row_index: number };

/** Eligibility and entry price come from the decision row alone; nothing later is read. */
export function tailDecisions(rows: readonly InplayObservation[]): TailDecision[] {
  const out: TailDecision[] = [];
  for (const path of tokenPaths(rows).values()) {
    path.forEach((r, i) => {
      if (isExecutableDecisionRow(r)) out.push({ physical_event_id: r.physical_event_id, token_id: r.token_id, decision_at: r.observed_at, entry_price: num(r.full_stake_executable_vwap)!, row_index: i });
    });
  }
  return out;
}

export function probeTailPathOptionality(rows: readonly InplayObservation[]) {
  const entryPrices: number[] = [], futureExits: number[] = [], deltas: number[] = [], mfes: number[] = [], maes: number[] = [];
  const bucketCounts: Record<string, number> = {};
  const decisionEvents = new Set<string>(), decisionTokens = new Set<string>(), exitEvents = new Set<string>();
  let decisionN = 0, evaluableDecisionN = 0, futureExitN = 0, favorableDecisionN = 0;
  for (const path of tokenPaths(rows).values()) {
    path.forEach((r, i) => {
      if (!isExecutableDecisionRow(r)) return;
      decisionN++;
      const entry = num(r.full_stake_executable_vwap)!;
      entryPrices.push(entry);
      decisionEvents.add(r.physical_event_id);
      decisionTokens.add(r.token_id);
      const t0 = ms(r);
      const pairDeltas: number[] = [];
      let firstFavorableS: Num = null;
      for (let j = i + 1; j < path.length; j++) {
        const f = path[j];
        if (!(ms(f) > t0)) continue; // strictly after the decision instant
        const exit = executableExitPrice(f);
        if (exit === null) continue;
        futureExitN++;
        futureExits.push(exit);
        exitEvents.add(f.physical_event_id);
        const d = exit - entry;
        pairDeltas.push(d);
        deltas.push(d);
        if (d > 0 && firstFavorableS === null) firstFavorableS = (ms(f) - t0) / 1000;
      }
      if (pairDeltas.length === 0) return;
      evaluableDecisionN++;
      mfes.push(Math.max(0, ...pairDeltas));
      maes.push(Math.min(0, ...pairDeltas));
      if (firstFavorableS !== null) {
        favorableDecisionN++;
        const label = (FAVORABLE_BUCKETS.find(([, cap]) => firstFavorableS! <= cap) ?? [">3600s"])[0];
        bucketCounts[label] = (bucketCounts[label] ?? 0) + 1;
      }
    });
  }
  const noSupport = decisionN === 0;
  return {
    probe: "TAIL_PATH_OPTIONALITY_V1",
    status: noSupport ? "NO_SAMPLE" : evaluableDecisionN === 0 ? "DECISIONS_WITHOUT_FUTURE_EXECUTABLE_EXIT" : "EVIDENCE_AVAILABLE",
    eligible_n: decisionN,
    event_n: decisionEvents.size,
    economics: ECONOMICS_LABEL,
    net_pnl: "UNKNOWN",
    metrics: {
      decision_n: decisionN,
      evaluable_decision_n: evaluableDecisionN,
      future_exit_n: futureExitN,
      physical_event_n: decisionEvents.size,
      future_exit_physical_event_n: exitEvents.size,
      token_n: decisionTokens.size,
      median_entry_price: median(entryPrices),
      median_future_executable_exit: median(futureExits),
      median_gross_executable_price_delta: median(deltas),
      median_max_favorable_executable_excursion: median(mfes),
      median_max_adverse_executable_excursion: median(maes),
      max_favorable_executable_excursion: mfes.length ? r6(Math.max(...mfes)) : null,
      max_adverse_executable_excursion: maes.length ? r6(Math.min(...maes)) : null,
      favorable_decision_n: favorableDecisionN,
      time_to_first_favorable_bucket_n: Object.fromEntries(Object.entries(bucketCounts).sort(([a], [b]) => (a < b ? -1 : 1))),
      tail_threshold: "NONE_IMPOSED_ALL_EXECUTABLE_DECISIONS",
    },
  };
}

// ---------------------------------------------------------------- 3. LATE_LOCK_V1
type Transition = { family: string; from: string; to: string; kind: "PHASE" | "FINAL"; before: InplayObservation; after: InplayObservation };

/** Explicit provider state only: a phase string change while LIVE, or LIVE -> FINAL. No clock, text or path-length inference. */
export function lateLockTransitions(rows: readonly InplayObservation[]): Transition[] {
  const out: Transition[] = [];
  for (const path of tokenPaths(rows).values()) {
    for (let i = 1; i < path.length; i++) {
      const b = path[i - 1], a = path[i];
      if (b.event_live_status === "LIVE" && a.event_live_status === "FINAL") {
        out.push({ family: a.provider_sport_family, from: b.state_phase ?? "NULL", to: a.state_phase ?? "NULL", kind: "FINAL", before: b, after: a });
      } else if (b.event_live_status === "LIVE" && a.event_live_status === "LIVE" && b.state_phase !== null && a.state_phase !== null && b.state_phase !== a.state_phase) {
        out.push({ family: a.provider_sport_family, from: b.state_phase, to: a.state_phase, kind: "PHASE", before: b, after: a });
      }
    }
  }
  return out;
}

export function probeLateLock(rows: readonly InplayObservation[]) {
  const t = lateLockTransitions(rows);
  const events = new Set(t.map((x) => x.before.physical_event_id));
  const groups = new Map<string, Transition[]>();
  for (const x of t) {
    const k = `${x.family}|${x.kind}|${x.from}->${x.to}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const summary = (xs: readonly Transition[]) => {
    const pb = xs.map((x) => num(x.before.mid_price)), pa = xs.map((x) => num(x.after.mid_price));
    const both = xs.filter((x) => num(x.before.mid_price) !== null && num(x.after.mid_price) !== null);
    return {
      transition_n: xs.length,
      price_before_transition_median: median(pb.filter((v): v is number => v !== null)),
      price_after_transition_median: median(pa.filter((v): v is number => v !== null)),
      price_change_median: median(both.map((x) => num(x.after.mid_price)! - num(x.before.mid_price)!)),
      spread_before_median: median(xs.map((x) => num(x.before.spread_abs)).filter((v): v is number => v !== null)),
      spread_after_median: median(xs.map((x) => num(x.after.spread_abs)).filter((v): v is number => v !== null)),
      executable_exit_available_before_n: xs.filter((x) => executableExitPrice(x.before) !== null).length,
      executable_exit_available_after_n: xs.filter((x) => executableExitPrice(x.after) !== null).length,
    };
  };
  return {
    probe: "LATE_LOCK_V1",
    status: t.length === 0 ? "NO_SAMPLE" : "PARTIAL",
    late_lock_ready: "PARTIAL",
    eligible_n: t.length,
    event_n: events.size,
    metrics: {
      phase_transition_n: t.filter((x) => x.kind === "PHASE").length,
      final_transition_n: t.filter((x) => x.kind === "FINAL").length,
      executable_exit_available_n: t.filter((x) => executableExitPrice(x.before) !== null || executableExitPrice(x.after) !== null).length,
      overall: summary(t),
      by_sport_family_phase: Object.fromEntries([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, summary(v)])),
    },
    blocker: "no numeric game clock; only explicit provider phase/FINAL transitions are used; no universal phase order",
  };
}

// ---------------------------------------------------------------- 4. CORE_RELATIVE_VALUE_V1
export function isCoreMarketRow(r: InplayObservation): boolean {
  return CORE_TYPES.has(r.canonical_market_type) || (r.canonical_market_type === "TOTAL_CORNERS" && r.provider_sport_family === "soccer");
}

export type SyncGroup = { physical_event_id: string; rows: InplayObservation[]; exact: boolean };

/**
 * Groups never cross physical events. Within an event: anchor-based window (<= 5s from the group's first row,
 * no chaining), the latest row per token. A group needs >= 2 distinct tokens.
 */
export function synchronizedGroups(rows: readonly InplayObservation[]): SyncGroup[] {
  const byEvent = new Map<string, InplayObservation[]>();
  for (const r of sortObservations(rows.filter(isCoreMarketRow))) byEvent.set(r.physical_event_id, [...(byEvent.get(r.physical_event_id) ?? []), r]);
  const out: SyncGroup[] = [];
  for (const [eventId, list] of [...byEvent.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let i = 0;
    while (i < list.length) {
      const anchor = ms(list[i]);
      let j = i;
      while (j < list.length && ms(list[j]) - anchor <= SYNC_WINDOW_MS) j++;
      const latest = new Map<string, InplayObservation>();
      for (const r of list.slice(i, j)) latest.set(r.token_id, r);
      const members = [...latest.values()];
      if (members.length >= 2) out.push({ physical_event_id: eventId, rows: members, exact: new Set(members.map(ms)).size === 1 });
      i = j;
    }
  }
  return out;
}

export function probeCoreRelativeValue(rows: readonly InplayObservation[]) {
  const groups = synchronizedGroups(rows);
  const types = (g: SyncGroup) => new Set(g.rows.map((r) => r.canonical_market_type));
  const multi = groups.filter((g) => types(g).size >= 2);
  const mlOnly = groups.filter((g) => types(g).size === 1 && types(g).has("MONEYLINE"));
  const complementSums: number[] = [], complementSpreadSums: number[] = [];
  let completeConditionN = 0;
  for (const g of groups) {
    const byCond = new Map<string, InplayObservation[]>();
    for (const r of g.rows) byCond.set(r.condition_id, [...(byCond.get(r.condition_id) ?? []), r]);
    for (const pair of byCond.values()) {
      if (pair.length !== 2) continue;
      completeConditionN++;
      const [m1, m2] = pair.map((p) => num(p.mid_price)), [s1, s2] = pair.map((p) => num(p.spread_abs));
      if (m1 !== null && m2 !== null) complementSums.push(m1 + m2);
      if (s1 !== null && s2 !== null) complementSpreadSums.push(s1 + s2);
    }
  }
  const perFamily: Record<string, { rows: number[]; spreads: number[]; bidDepth: number[]; askDepth: number[] }> = {};
  for (const g of multi) for (const r of g.rows) {
    const f = (perFamily[r.canonical_market_type] ??= { rows: [], spreads: [], bidDepth: [], askDepth: [] });
    const m = num(r.mid_price), s = num(r.spread_abs), bd = num(r.bid_depth_relevant_usd), ad = num(r.ask_depth_relevant_usd);
    if (m !== null) f.rows.push(m);
    if (s !== null) f.spreads.push(s);
    if (bd !== null) f.bidDepth.push(bd);
    if (ad !== null) f.askDepth.push(ad);
  }
  return {
    probe: "CORE_RELATIVE_VALUE_V1",
    status: groups.length === 0 ? "NO_SAMPLE" : multi.length === 0 ? "MULTI_FAMILY_SAMPLE_N_0" : "EVIDENCE_AVAILABLE",
    eligible_n: groups.length,
    event_n: new Set(groups.map((g) => g.physical_event_id)).size,
    metrics: {
      same_event_synchronized_group_n: groups.length,
      exact_same_observed_at_group_n: groups.filter((g) => g.exact).length,
      multi_family_group_n: multi.length,
      MULTI_FAMILY_SAMPLE_N: multi.length,
      moneyline_only_group_n: mlOnly.length,
      complete_condition_pair_n: completeConditionN,
      complement_mid_sum_median: median(complementSums),
      complement_spread_sum_median: median(complementSpreadSums),
      cross_family_structure: Object.fromEntries(Object.entries(perFamily).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, {
        mid_median: median(v.rows), spread_median: median(v.spreads), bid_depth_usd_median: median(v.bidDepth), ask_depth_usd_median: median(v.askDepth),
      }])),
      sync_window_ms: SYNC_WINDOW_MS,
      fair_value_model: "NONE_NO_MISPRICING_CLAIM",
    },
  };
}

// ---------------------------------------------------------------- orchestration
export function runInplayShadowProbes(rows: readonly InplayObservation[]) {
  return {
    corpus: summarizeCorpus(rows),
    probes: {
      SHOCK_REVERSION_V1: probeShockReversion(rows),
      TAIL_PATH_OPTIONALITY_V1: probeTailPathOptionality(rows),
      LATE_LOCK_V1: probeLateLock(rows),
      CORE_RELATIVE_VALUE_V1: probeCoreRelativeValue(rows),
    },
    claims: "MECHANISM_EVIDENCE_ONLY_NO_ALPHA_NO_THRESHOLD_FITTING",
  };
}
