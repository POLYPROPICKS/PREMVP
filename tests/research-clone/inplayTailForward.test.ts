/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TAIL_STRATEGY, TAIL_RULE, TAIL_REASON, TAIL_PROCESSOR_ID, evaluateTailEvent, isTailCandidate, tailEvidenceReason, tailDefinitionHash, runTailForwardCycle,
  type TailObservation,
} from "../../lib/research/inplayTailForward";
import { CONTROL_STRATEGIES, ALPHA_PROGRAMS, TIMELY_SOURCE_PATH_PROVEN } from "../../lib/research/inplayPaperDecisions";

const START = "2026-10-20T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(START) + min * 60_000).toISOString();
const COHORT = Date.parse(START) - 10 * 60_000;
let n = 0;
function row(o: Partial<TailObservation> & { min?: number } = {}): TailObservation {
  const { min = 65, ...rest } = o;
  const observed = at(min);
  const t = Date.parse(observed);
  return {
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, physical_event_id: "ev1", provider_game_id: "g1", provider_event_id: "pe1",
    provider_sport_family: "soccer", event_start_iso: START, observed_at: observed, created_at: new Date(t + 900).toISOString(),
    event_live_status: "LIVE", state_authority: "SPORTS_WS_STRUCTURED_STATUS", state_phase: "2H", state_period_num: 2,
    state_clock_seconds_remaining: null, state_clock_seconds_elapsed: 65 * 60, state_received_at: new Date(t - 5_000).toISOString(),
    side_a_score: 0, side_b_score: 1, condition_id: "c1", token_id: "t1", side: "Draw",
    canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", market_slug: "m", best_bid: 0.14, best_ask: 0.15,
    bid_depth_relevant_usd: 100, ask_depth_relevant_usd: 100, full_stake_executable_vwap: 0.15, full_stake_shares: 2.5 / 0.15,
    full_stake_exit_vwap: 0.14, full_stake_exit_fully_filled: true, taker_fee_usd: 0.04, taker_fee_state: "KNOWN", taker_fee_reason: null,
    executable_full_stake_state: "EXECUTABLE", quote_cycle_span_ms: 400, orderbook_fetch_status: "SUCCESS",
    orderbook_fetch_started_at: new Date(t + 100).toISOString(), orderbook_fetch_completed_at: new Date(t + 900).toISOString(),
    orderbook_provider_timestamp_at: new Date(t + 500).toISOString(), ...rest,
  };
}
const ev = (rows: TailObservation[], o: Partial<{ finalSeenAtMs: number | null; evaluatedAtMs: number; hasDecision: boolean; cohortStartMs: number }> = {}) =>
  evaluateTailEvent({ rows, hasDecision: false, finalSeenAtMs: null, evaluatedAtMs: Date.parse(rows[rows.length - 1]?.observed_at ?? START) + 120_000, cohortStartMs: COHORT, admissionObservedAt: at(-3), ...o });

test("strategy is a new ALPHA_RESEARCH version that structurally cannot bet, with a frozen rule hash", () => {
  assert.equal(TAIL_STRATEGY.id, "VALUE_BACKED_TAIL_REPRICING");
  assert.notEqual(TAIL_STRATEGY.version, ALPHA_PROGRAMS[0].version);
  assert.equal(TAIL_STRATEGY.canEmitBet, false); assert.equal(TAIL_STRATEGY.kind, "ALPHA_RESEARCH");
  assert.deepEqual([TAIL_RULE.elapsedSecondsMin, TAIL_RULE.elapsedSecondsMax, TAIL_RULE.fullStakeBuyVwapMax, TAIL_RULE.virtualStakeUsd, TAIL_RULE.period], [3600, 4500, 0.2, 2.5, 2]);
  assert.match(tailDefinitionHash(), /^[0-9a-f]{64}$/);
});

test("candidate window: soccer MONEYLINE, 2H, 60-75 min inclusive, full-stake VWAP <= 0.20 inclusive", () => {
  assert.equal(isTailCandidate(row()), true);
  assert.equal(isTailCandidate(row({ state_clock_seconds_elapsed: 3600 })), true);
  assert.equal(isTailCandidate(row({ state_clock_seconds_elapsed: 4500 })), true);
  assert.equal(isTailCandidate(row({ state_clock_seconds_elapsed: 3599 })), false);
  assert.equal(isTailCandidate(row({ state_clock_seconds_elapsed: 4501 })), false);
  assert.equal(isTailCandidate(row({ state_period_num: 1 })), false);
  assert.equal(isTailCandidate(row({ provider_sport_family: "tennis" })), false);
  assert.equal(isTailCandidate(row({ canonical_market_type: "TOTAL", canonical_market_family: "TOTALS" })), false);
  assert.equal(isTailCandidate(row({ full_stake_executable_vwap: 0.2 })), true);
  assert.equal(isTailCandidate(row({ full_stake_executable_vwap: 0.2000004 })), false);
  assert.equal(isTailCandidate(row({ full_stake_executable_vwap: null })), false);
  assert.equal(isTailCandidate(row({ event_live_status: "FINAL" })), false);
  assert.equal(isTailCandidate(row({ orderbook_fetch_status: "FAILED" })), false);
});

test("fully evidenced fresh quote is recorded as an order-free SKIP row with receipts, provenance never LIVE_PROSPECTIVE", () => {
  assert.equal(TIMELY_SOURCE_PATH_PROVEN, false);
  const o = ev([row()]);
  assert.equal(o.action, "INSERT");
  const d: any = o.decision;
  assert.equal(d.status, "SKIP"); assert.equal(d.reject_reason, TAIL_REASON.RECORDED);
  assert.equal(d.strategy_kind, "ALPHA_RESEARCH"); assert.equal(d.strategy_version, "tail-forward-v1"); assert.equal(d.strategy_definition_hash, tailDefinitionHash());
  assert.equal(d.provenance_class, "DELAYED_PAPER"); assert.equal(d.result_visible_at_freeze, false);
  assert.equal(d.entry_vwap, 0.15); assert.equal(d.entry_fee_state, "KNOWN"); assert.equal(d.entry_notional_usd, 2.5);
  assert.ok(Date.parse(d.collector_receipt_at) <= Date.parse(d.frozen_at)); assert.ok(Date.parse(d.observed_at) <= Date.parse(d.collector_receipt_at));
  assert.equal(d.exclusion_summary.quote_evidence.fee_version, "UNKNOWN_NOT_SUPPORTED_BY_SCHEMA");
  assert.ok(d.exclusion_summary.quote_evidence.provider_timestamp_at);
  assert.equal(d.admission_observed_at, at(-3));
});

test("unknown fee state is preserved as UNKNOWN, never zero", () => {
  const d: any = ev([row({ taker_fee_state: null, taker_fee_usd: 0 })]).decision;
  assert.equal(d.entry_fee_state, "UNKNOWN"); assert.equal(d.entry_fee_usd, null);
});

test("explicit ineligibility reasons: late, incomplete, stale, unproven, hindsight", () => {
  const reason = (r: TailObservation, extra: { fin?: boolean; lagMs?: number } = {}) =>
    tailEvidenceReason(r, Date.parse(r.observed_at) + (extra.lagMs ?? 120_000), !!extra.fin);
  assert.equal(reason(row()), null);
  assert.equal(reason(row(), { lagMs: TAIL_RULE.maxFreezeLagMs + 1_000 }), TAIL_REASON.STALE_AT_FREEZE);
  assert.equal(reason(row(), { fin: true }), TAIL_REASON.RESULT_VISIBLE);
  assert.equal(reason(row({ orderbook_fetch_completed_at: null, orderbook_fetch_started_at: null })), TAIL_REASON.FETCH_TIMES_MISSING);
  assert.equal(reason(row({ orderbook_provider_timestamp_at: null })), TAIL_REASON.PROVIDER_TS_MISSING);
  assert.equal(reason(row({ side_a_score: null })), TAIL_REASON.STATE_INCOMPLETE);
  assert.equal(reason(row({ state_received_at: null })), TAIL_REASON.STATE_INCOMPLETE);
  assert.equal(reason(row({ state_received_at: new Date(Date.parse(at(65)) - 91_000).toISOString() })), TAIL_REASON.STATE_STALE);
  assert.equal(reason(row({ orderbook_fetch_completed_at: new Date(Date.parse(at(65)) + 70_000).toISOString() })), TAIL_REASON.CHAIN_INVALID);
  assert.equal(reason(row(), { lagMs: -10_000 }), TAIL_REASON.CHAIN_INVALID); // freeze before quote receipt
  assert.equal(reason(row({ full_stake_shares: 10 })), TAIL_REASON.STAKE_UNPROVEN);
  assert.equal(reason(row({ executable_full_stake_state: "UNKNOWN" })), TAIL_REASON.STAKE_UNPROVEN);
  assert.equal(reason(row({ ask_depth_relevant_usd: 1 })), TAIL_REASON.DEPTH_INSUFFICIENT);
});

test("event with only ineligible candidates freezes one SKIP carrying the reason; eligible later quote wins over an earlier late one", () => {
  const late = row({ min: 60 }), fresh = row({ min: 74 });
  const evalAtMs = Date.parse(at(74)) + 60_000;
  const only = evaluateTailEvent({ rows: [late], hasDecision: false, finalSeenAtMs: null, evaluatedAtMs: evalAtMs, cohortStartMs: COHORT, admissionObservedAt: at(-3) });
  assert.equal((only.decision as any).reject_reason, TAIL_REASON.STALE_AT_FREEZE);
  assert.equal((only.decision as any).admitted_candidate_n, 0);
  const both: any = evaluateTailEvent({ rows: [late, fresh], hasDecision: false, finalSeenAtMs: null, evaluatedAtMs: evalAtMs, cohortStartMs: COHORT, admissionObservedAt: at(-3) }).decision;
  assert.equal(both.reject_reason, TAIL_REASON.RECORDED); assert.equal(both.observed_at, fresh.observed_at); assert.equal(both.exclusion_summary.exclusions[TAIL_REASON.STALE_AT_FREEZE], 1);
});

test("historical rows and existing decisions are never (re)evaluated; price-out-of-range and non-window rows record nothing", () => {
  assert.equal(ev([row()], { cohortStartMs: Date.parse(at(65)) }).action, "NONE"); // row at/before the cohort boundary
  assert.equal(ev([row()], { hasDecision: true }).action, "NONE");
  assert.equal(ev([row({ full_stake_executable_vwap: 0.35 })]).action, "NONE");
  assert.equal(ev([row({ state_clock_seconds_elapsed: 40 * 60 })]).action, "NONE");
});

test("control and alpha-v0 definitions are untouched by the Tail version", () => {
  assert.deepEqual(CONTROL_STRATEGIES.map((s) => s.id + s.version), ["CONTROL_PRICE_BUCKET_Av1", "CONTROL_PRICE_BUCKET_Bv1", "CONTROL_PRICE_BUCKET_Cv1"]);
  assert.equal(ALPHA_PROGRAMS[0].version, "v0-facts-only");
});

// ── runner against an in-memory PostgREST-shaped fake ──
type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const st: { op: string; filters: Array<(r: Row) => boolean>; payload?: any; lim: number; order?: string; single: boolean; opts?: any } = { op: "select", filters: [], lim: 1e9, single: false };
    const exec = (): { data: any; error: any } => {
      const rows = (tables[table] ??= []);
      if (st.op === "select") {
        let out = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.order) out = [...out].sort((a, b) => (a.observed_at ?? "").localeCompare(b.observed_at ?? "") || String(a.id).localeCompare(String(b.id)));
        out = out.slice(0, st.lim);
        return { data: st.single ? out[0] ?? null : out, error: null };
      }
      if (st.op === "insert") {
        const conflict = (st.opts?.onConflict ?? "").split(",").filter(Boolean) as string[];
        for (const p of Array.isArray(st.payload) ? st.payload : [st.payload]) {
          if (conflict.length && rows.some((r) => conflict.every((c) => r[c] === p[c]))) continue;
          rows.push({ ...p });
        }
        return { data: null, error: null };
      }
      for (const r of rows.filter((x) => st.filters.every((f) => f(x)))) Object.assign(r, st.payload);
      return { data: null, error: null };
    };
    const b: any = {
      select: () => b, order: (c: string) => { st.order = c; return b; }, limit: (k: number) => { st.lim = k; return b; },
      eq: (c: string, v: any) => { st.filters.push((r) => r[c] === v); return b; },
      lte: (c: string, v: any) => { st.filters.push((r) => new Date(r[c]).getTime() <= Date.parse(v)); return b; },
      or: (expr: string) => {
        const m = expr.match(/^observed_at\.gt\.(\S+?),and\(observed_at\.eq\.(\S+?),id\.gt\.(\S+?)\)$/);
        if (m) st.filters.push((r) => new Date(r.observed_at).getTime() > Date.parse(m[1]) || (new Date(r.observed_at).getTime() === Date.parse(m[2]) && r.id > m[3]));
        else st.filters.push(() => true);
        return b;
      },
      maybeSingle: () => { st.single = true; return b; },
      upsert: (p: any, o: any) => { st.op = "insert"; st.payload = p; st.opts = o; return b; },
      update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      then: (res: any, rej: any) => { try { res(exec()); } catch (e) { rej?.(e); } },
    };
    return b;
  };
  return { db: { from } as any, tables };
}
const release = (min: number) => row({ min, physical_event_id: "release", token_id: "rel", full_stake_executable_vwap: 0.9, state_period_num: 1 }); // releases the held-back newest group

test("runner: first run only bootstraps; a historical in-window quote and its event never become forward decisions", async () => {
  const hist = row({ min: 65, physical_event_id: "hist" });
  const f = fakeDb({ research_inplay_core_path_observations: [hist] });
  const r1 = await runTailForwardCycle(f.db, Date.parse(hist.observed_at) + 60_000);
  assert.equal(r1.bootstrapped, true); assert.equal((f.tables.research_inplay_paper_decisions ?? []).length, 0);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].processor_id, TAIL_PROCESSOR_ID);
  // later row of the SAME historical event, plus a brand-new event
  const fresh = row({ min: 66, physical_event_id: "hist", token_id: "t2" });
  const fwd0 = row({ min: 100, physical_event_id: "fwd", state_period_num: 1, state_clock_seconds_elapsed: 600 });
  const fwd = row({ min: 130, physical_event_id: "fwd", token_id: "tf", observed_at: at(130), event_start_iso: START, state_clock_seconds_elapsed: 65 * 60 });
  f.tables.research_inplay_core_path_observations.push(fresh, fwd0, fwd, release(200));
  const evalMs = Date.parse(fwd.observed_at) + 120_000;
  const r2 = await runTailForwardCycle(f.db, evalMs);
  const dec = f.tables.research_inplay_paper_decisions ?? [];
  assert.equal(dec.some((d) => d.physical_event_id === "hist"), false, "historical event excluded");
  assert.equal(r2.pre_cohort_events_skipped >= 1, true);
  assert.equal(dec.length, 1); assert.equal(dec[0].physical_event_id, "fwd"); assert.equal(dec[0].reject_reason, TAIL_REASON.RECORDED);
  assert.equal(dec[0].provenance_class, "DELAYED_PAPER");
  // idempotent re-run writes nothing new
  await runTailForwardCycle(f.db, evalMs + 1_000);
  assert.equal(f.tables.research_inplay_paper_decisions.length, 1);
});

test("wiring: the existing cron entrypoint runs control cycle then Tail cycle; no new script, scheduler or railway change", () => {
  const s = readFileSync("scripts/research-inplay-paper-decisions.ts", "utf8");
  assert.ok(s.indexOf("runPaperDecisionCycle(db)") < s.indexOf("runTailForwardCycle(db)"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["research-clone:inplay-paper-decisions"], "tsx scripts/research-inplay-paper-decisions.ts");
  assert.ok(readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8").includes("npm run research-clone:inplay-paper-decisions"));
});
