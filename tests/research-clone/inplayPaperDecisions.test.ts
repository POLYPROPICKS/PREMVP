/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTROL_STRATEGIES, ALPHA_PROGRAMS, evaluateEvent, rankCandidates, inRange, exclusionReason, classifyProvenance, buildDecision,
  decisionId, strategyDefinitionHash, factReadiness, toFreezePatch, entryWindowEndMs, runPaperDecisionCycle, TIMELY_SOURCE_PATH_PROVEN, PAGE_SIZE,
  type Observation, type Strategy, type ExistingDecision,
} from "../../lib/research/inplayPaperDecisions";

const [A, B, C] = CONTROL_STRATEGIES;
const START = "2026-10-10T10:00:00.000Z";
const T = (min: number) => new Date(Date.parse(START) + min * 60_000).toISOString();
let n = 0;
function obs(o: Partial<Observation> & { at: number }): Observation {
  const { at, ...rest } = o;
  const observed = T(at);
  return {
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, physical_event_id: "ev1", provider_game_id: "g1", provider_event_id: "pe1",
    provider_sport_family: "tennis", event_start_iso: START, observed_at: observed, created_at: new Date(Date.parse(observed) + 1500).toISOString(),
    event_live_status: "LIVE", state_authority: "SPORTS_WS_STRUCTURED_STATUS", state_phase: "S1", state_period_num: null, state_clock_seconds_remaining: null,
    side_a_score: null, side_b_score: null, condition_id: "c1", token_id: "t1", side: "Player A",
    canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", market_slug: "m", best_bid: 0.49, best_ask: 0.5,
    bid_depth_relevant_usd: 100, ask_depth_relevant_usd: 100, full_stake_executable_vwap: 0.5, full_stake_shares: 5,
    full_stake_exit_vwap: 0.48, full_stake_exit_fully_filled: true, taker_fee_usd: 0.05, orderbook_fetch_status: "SUCCESS", ...rest,
  };
}
const evalAt = (min: number) => Date.parse(START) + min * 60_000;
const run = (s: Strategy, rows: Observation[], extra: Partial<{ existing: ExistingDecision | null; finalSeenAtMs: number | null; at: number }> = {}) =>
  evaluateEvent({ strategy: s, rows, existing: extra.existing ?? null, finalSeenAtMs: extra.finalSeenAtMs ?? null, evaluatedAtMs: extra.at ?? evalAt(rows.length ? Number.parseFloat(String((Date.parse(rows[rows.length - 1].observed_at) - Date.parse(START)) / 60_000)) + 0.5 : 0) });

test("A/B/C price boundaries are inclusive and exact", () => {
  for (const [s, lo, hi] of [[A, 0.48, 0.52], [B, 0.53, 0.58], [C, 0.35, 0.44]] as const) {
    assert.equal(inRange(lo, s.range!), true); assert.equal(inRange(hi, s.range!), true);
    assert.equal(inRange(lo - 0.000002, s.range!), false); assert.equal(inRange(hi + 0.000002, s.range!), false);
  }
  assert.equal(inRange(0.1 + 0.2 + 0.18, A.range!), true); // 0.48000000000000004 float noise stays inside
  assert.equal(inRange(0.5200004, A.range!), false); assert.equal(inRange(0.5299999, B.range!), false); assert.equal(inRange(0.4399999999, C.range!), true);
  assert.equal(inRange(0.4400004, C.range!), false);
  assert.equal(exclusionReason(B, obs({ at: 1, full_stake_executable_vwap: 0.5 }), entryWindowEndMs(START)), "PRICE_OUT_OF_RANGE");
});

test("price authority is the full-stake VWAP only: best ask/mid never substitute; invalid VWAP excluded", () => {
  const w = entryWindowEndMs(START);
  for (const v of [null, 0, 1, -0.2, NaN, 1.4]) assert.equal(exclusionReason(A, obs({ at: 1, full_stake_executable_vwap: v as number | null, best_ask: 0.5 }), w), "FULL_STAKE_VWAP_MISSING_OR_INVALID");
  assert.equal(exclusionReason(A, obs({ at: 1, full_stake_shares: null }), w), "FULL_STAKE_QUANTITY_MISSING");
  assert.equal(exclusionReason(A, obs({ at: 1, full_stake_executable_vwap: null, best_ask: 0.5 }), w), "FULL_STAKE_VWAP_MISSING_OR_INVALID");
  assert.equal(exclusionReason(A, obs({ at: 1, orderbook_fetch_status: "FAILED" }), w), "ORDERBOOK_UNAVAILABLE");
});

test("no entry outside the configured window; window is scheduled start + 30 minutes", () => {
  const w = entryWindowEndMs(START);
  assert.equal(w - Date.parse(START), 30 * 60_000);
  assert.equal(exclusionReason(A, obs({ at: 30 }), w), null);
  assert.equal(exclusionReason(A, obs({ at: 30.1 }), w), "OUTSIDE_ENTRY_WINDOW");
  const out = run(A, [obs({ at: 31 })], { existing: { decision_id: "d", status: "WAITING", admission_observed_at: T(1), entry_window_end: T(30) } });
  assert.equal(out.decision!.status, "SKIP");
  assert.equal(out.decision!.reject_reason, "ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE");
});

test("non-live and unproven market identity are excluded; TOTALS/SPREAD cannot enter", () => {
  const w = entryWindowEndMs(START);
  assert.equal(exclusionReason(A, obs({ at: 1, event_live_status: "FINAL" }), w), "NOT_LIVE");
  const mk = (family: string, type: string) => exclusionReason(A, obs({ at: 1, canonical_market_family: family, canonical_market_type: type }), w);
  assert.equal(mk("TOTALS", "TOTAL"), "TOTALS_LINE_IDENTITY_UNPROVEN");
  assert.equal(mk("SPREADS", "SPREAD"), "SPREADS_QUARANTINED");
  assert.equal(mk("TOTAL_CORNERS", "TOTAL_CORNERS"), "MARKET_IDENTITY_UNPROVEN");
});

test("WAITING -> BET and WAITING -> SKIP without rewriting identity facts", () => {
  const waiting = run(A, [obs({ at: 1, full_stake_executable_vwap: 0.7 })]);
  assert.equal(waiting.action, "INSERT"); assert.equal(waiting.decision!.status, "WAITING");
  assert.equal(waiting.decision!.token_id, undefined); assert.equal(waiting.decision!.entry_vwap, undefined);
  const ex: ExistingDecision = { decision_id: waiting.decision!.decision_id, status: "WAITING", admission_observed_at: waiting.decision!.admission_observed_at as string, entry_window_end: waiting.decision!.entry_window_end as string };
  const bet = run(A, [obs({ at: 2, full_stake_executable_vwap: 0.5 })], { existing: ex });
  assert.equal(bet.action, "FREEZE"); assert.equal(bet.decision!.status, "BET");
  assert.equal(bet.decision!.decision_id, waiting.decision!.decision_id);
  const patch = toFreezePatch(bet.decision!);
  for (const k of ["decision_id", "physical_event_id", "strategy_id", "scope_key", "admission_observed_at", "entry_window_end", "first_evaluated_at"]) assert.equal(k in patch, false);
  const skip = run(A, [obs({ at: 5, event_live_status: "FINAL" })], { existing: ex });
  assert.equal(skip.decision!.status, "SKIP"); assert.equal(skip.decision!.reject_reason, "EVENT_FINAL_BEFORE_QUALIFYING_ENTRY");
});

test("one BET per physical event x strategy x scope: frozen decisions never re-evaluate; later prices are ignored", () => {
  const first = run(A, [obs({ at: 1, full_stake_executable_vwap: 0.49, token_id: "ta" }), obs({ at: 2, full_stake_executable_vwap: 0.5, token_id: "tb" })]);
  assert.equal(first.decision!.token_id, "ta"); // first qualifying group wins; later (better-centred) price ignored
  const again = run(A, [obs({ at: 3 })], { existing: { decision_id: first.decision!.decision_id, status: "BET", admission_observed_at: T(1), entry_window_end: T(30) } });
  assert.equal(again.action, "NONE");
  assert.equal(decisionId("ev1", A), decisionId("ev1", A));
  assert.notEqual(decisionId("ev1", A), decisionId("ev1", B));
  assert.notEqual(decisionId("ev1", A), decisionId("ev2", A));
});

test("deterministic token choice: centre distance then token_id; candidate counts and exclusions kept", () => {
  const rows = [
    obs({ at: 1, token_id: "tz", full_stake_executable_vwap: 0.51 }),
    obs({ at: 1, token_id: "ta", full_stake_executable_vwap: 0.49 }), // same distance as tz
    obs({ at: 1, token_id: "tc", full_stake_executable_vwap: 0.7 }),
  ];
  assert.deepEqual(rankCandidates(A, rows.filter((r) => r.token_id !== "tc")).map((r) => r.token_id), ["ta", "tz"]);
  const a = run(A, rows); const b = run(A, [...rows].reverse());
  assert.equal(a.decision!.token_id, "ta"); assert.equal(b.decision!.token_id, "ta");
  assert.equal(a.decision!.admitted_candidate_n, 2);
  assert.deepEqual(a.decision!.exclusion_summary, { PRICE_OUT_OF_RANGE: 1 });
  assert.equal(rankCandidates(C, [obs({ at: 1, token_id: "t1", full_stake_executable_vwap: 0.35 }), obs({ at: 1, token_id: "t2", full_stake_executable_vwap: 0.395 })])[0].token_id, "t2");
});

test("BET carries exact entry cost, source lineage and alpha hooks; fee UNKNOWN is explicit", () => {
  const r = obs({ at: 1, taker_fee_usd: null, full_stake_executable_vwap: 0.5, full_stake_shares: 5 });
  const d = run(A, [r]).decision!;
  assert.equal(d.source_observation_id, r.id); assert.equal(d.entry_vwap, 0.5); assert.equal(d.entry_quantity, 5);
  assert.equal(d.entry_notional_usd, 2.5); assert.equal(d.entry_cost_authority, "FULL_STAKE_EXECUTABLE_BUY_VWAP");
  assert.equal(d.entry_fee_state, "UNKNOWN"); assert.equal(d.entry_exit_fully_filled, true);
  assert.equal(d.state_score_available, false); assert.match(String(d.state_blocker), /^SOURCE_STATE_NULL:score,clock,period$/);
  assert.equal(d.relation_state, "UNKNOWN"); assert.equal(d.quote_batch_key, `ev1|${r.observed_at}`);
  assert.equal(d.strategy_definition_hash, strategyDefinitionHash(A));
  assert.notEqual(strategyDefinitionHash(A), strategyDefinitionHash(B));
});

test("no later outcome influence: result visible at evaluation can never produce a BET", () => {
  const out = run(A, [obs({ at: 1 })], { finalSeenAtMs: evalAt(100), at: evalAt(200) });
  assert.equal(out.decision!.status, "SKIP"); assert.equal(out.decision!.reject_reason, "RESULT_VISIBLE_AT_EVALUATION");
  assert.equal(out.decision!.provenance_class, "DELAYED_PAPER");
});

test("provenance: LIVE_PROSPECTIVE only with timely proven timing; otherwise DELAYED_PAPER or TIMING_UNPROVEN", () => {
  const o = T(1), r = new Date(Date.parse(o) + 1000).toISOString(), now = Date.parse(o) + 5_000;
  const base = { observedAt: o, receiptAt: r, evaluatedAtMs: now, resultVisible: false, live: true, timelyPathProven: true };
  assert.equal(classifyProvenance(base), "LIVE_PROSPECTIVE");
  // no timely source->DBClone path is proven (hourly cron): a 5-second lag still cannot be called prospective
  assert.equal(TIMELY_SOURCE_PATH_PROVEN, false);
  assert.equal(classifyProvenance({ ...base, timelyPathProven: undefined }), "DELAYED_PAPER");
  assert.equal(run(A, [obs({ at: 1 })], { at: evalAt(1) + 5_000 }).decision!.provenance_class, "DELAYED_PAPER");
  assert.equal(classifyProvenance({ ...base, evaluatedAtMs: Date.parse(o) + 3_600_000 }), "DELAYED_PAPER");
  assert.equal(classifyProvenance({ ...base, resultVisible: true }), "DELAYED_PAPER");
  assert.equal(classifyProvenance({ ...base, receiptAt: null }), "TIMING_UNPROVEN");
  assert.equal(classifyProvenance({ ...base, receiptAt: new Date(now + 60_000).toISOString() }), "TIMING_UNPROVEN");
  const lagged = run(A, [obs({ at: 1 })], { at: evalAt(120) }).decision!;
  assert.equal(lagged.provenance_class, "DELAYED_PAPER");
  assert.equal(lagged.processing_lag_ms, 119 * 60_000);
});

test("alpha programs cannot emit BET by construction", () => {
  for (const s of ALPHA_PROGRAMS) {
    assert.equal(s.canEmitBet, false);
    assert.equal(evaluateEvent({ strategy: s, rows: [obs({ at: 1 })], existing: null, finalSeenAtMs: null, evaluatedAtMs: evalAt(2) }).action, "NONE");
    assert.throws(() => buildDecision(s, "BET", {}), /ALPHA_BET_FORBIDDEN/);
  }
  const forged: Strategy = { ...ALPHA_PROGRAMS[0], canEmitBet: true };
  assert.throws(() => buildDecision(forged, "BET", {}), /ALPHA_BET_FORBIDDEN/);
  assert.equal(evaluateEvent({ strategy: forged, rows: [obs({ at: 1 })], existing: null, finalSeenAtMs: null, evaluatedAtMs: evalAt(2) }).action, "NONE");
});

test("fact readiness reports the exact state gap and no structural relation source", () => {
  const f = factReadiness([obs({ at: 1 }), obs({ at: 2 })]);
  assert.equal(f.ALPHA_TAIL_FACTS_READY, false); assert.equal(f.ALPHA_STRUCTURAL_FACTS_READY, false);
  assert.equal(f.EXECUTION_EXIT_FACTS_READY, true); assert.equal(f.state_score_clock_n, 0);
  const ok = factReadiness([obs({ at: 1, state_period_num: 1, state_clock_seconds_remaining: 10, side_a_score: 0, side_b_score: 0 })]);
  assert.equal(ok.ALPHA_TAIL_FACTS_READY, true);
});

test("schema: DBClone-only, unique scope, alpha-never-bets, frozen guard, least privilege; not a production migration", () => {
  const sql = readFileSync("ops/research-clone/inplay-paper-decisions-schema.sql", "utf8");
  assert.match(sql, /nppznoujvnyjargjkmnv/); assert.match(sql, /NEVER apply to production/);
  assert.match(sql, /unique \(physical_event_id, strategy_id, strategy_version, scope_key\)/);
  assert.match(sql, /status <> 'BET' or strategy_kind = 'CONTROL'/);
  assert.match(sql, /INPLAY_PAPER_DECISION_FROZEN/); assert.match(sql, /INPLAY_PAPER_DECISION_DELETE_FORBIDDEN/);
  assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on public\.research_inplay_paper_decisions from anon, authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*delete/i); assert.doesNotMatch(sql, /grant[^;]*to (anon|authenticated|public)/i);
  assert.match(sql, /create table if not exists/); assert.match(sql, /drop trigger if exists/);
  assert.match(sql, /bootstrap_cursor_observed_at timestamptz not null/); assert.match(sql, /inplay_paper_live_prospective_pre_result/);
  const migrations = readFileSync("package.json", "utf8");
  assert.match(migrations, /research-clone:inplay-paper-decisions/);
});

test("runner and CLI: DBClone only; collector, live-money and Ireland paths not imported", () => {
  const lib = readFileSync("lib/research/inplayPaperDecisions.ts", "utf8");
  const cli = readFileSync("scripts/research-inplay-paper-decisions.ts", "utf8");
  assert.doesNotMatch(lib, /from "\.\.\/(executor|feed|liquidity)|inplayCorePath|night_event_reservations|current_signal_pair_serving|ireland|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.match(cli, /SUPABASE_CLONE_URL/); assert.match(cli, /INPLAY_PAPER_NOT_THE_RESEARCH_CLONE/);
  assert.doesNotMatch(cli, /process\.env\.SUPABASE_URL|process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
});

// ── runner behaviour against an in-memory PostgREST-shaped fake ──
type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>, failOn?: { table: string; op: string; once?: boolean }) {
  const log: string[] = [];
  const from = (table: string) => {
    const st: { op: string; filters: Array<(r: Row) => boolean>; payload?: any; lim: number; order?: string; single: boolean; opts?: any } = { op: "select", filters: [], lim: 1e9, single: false };
    const exec = (): { data: any; error: any } => {
      if (failOn && failOn.table === table && failOn.op === st.op) { if (failOn.once) { const f = failOn; failOn = undefined; void f; } return { data: null, error: { message: "boom" } }; }
      const rows = (tables[table] ??= []);
      log.push(`${st.op}:${table}`);
      if (st.op === "select") {
        let out = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.order) out = [...out].sort((a, b) => (a.observed_at ?? "").localeCompare(b.observed_at ?? "") || String(a.id).localeCompare(String(b.id)));
        out = out.slice(0, st.lim);
        return { data: st.single ? out[0] ?? null : out, error: null };
      }
      if (st.op === "insert") {
        const conflict = (st.opts?.onConflict ?? "").split(",").filter(Boolean) as string[];
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        for (const p of list) {
          if (conflict.length && rows.some((r) => conflict.every((c: string) => r[c] === p[c]))) continue;
          rows.push({ ...p });
        }
        return { data: null, error: null };
      }
      for (const r of rows.filter((x) => st.filters.every((f) => f(x)))) Object.assign(r, st.payload);
      return { data: null, error: null };
    };
    const b: any = {
      select: () => b, order: (c: string) => { st.order = c; return b; }, limit: (n: number) => { st.lim = n; return b; },
      eq: (c: string, v: any) => { st.filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: any[]) => { st.filters.push((r) => v.includes(r[c])); return b; },
      lt: (c: string, v: any) => { st.filters.push((r) => r[c] < v); return b; },
      lte: (c: string, v: any) => { st.filters.push((r) => r[c] <= v); return b; },
      or: (expr: string) => {
        const m = expr.match(/^observed_at\.gt\.(\S+?),and\(observed_at\.eq\.(\S+?),id\.gt\.(\S+?)\)$/);
        if (m) st.filters.push((r) => new Date(r.observed_at).getTime() > Date.parse(m[1]) || (new Date(r.observed_at).getTime() === Date.parse(m[2]) && r.id > m[3]));
        else st.filters.push(() => true); // checkpoint monotone guard handled by caller ordering in this fake
        return b;
      },
      maybeSingle: () => { st.single = true; return b; },
      upsert: (p: any, o: any) => { st.op = "insert"; st.payload = p; st.opts = o; return b; },
      update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      then: (res: any, rej: any) => { try { res(exec()); } catch (e) { rej?.(e); } },
    };
    return b;
  };
  return { db: { from } as any, tables, log };
}

const tailRow = (at: number) => obs({ at, physical_event_id: "tail", token_id: "tail_t", full_stake_executable_vwap: 0.9 }); // releases the held-back newest group
const withHistory = () => fakeDb({ research_inplay_core_path_observations: [obs({ at: -20, physical_event_id: "old" })] });

test("runner: first run only bootstraps and records the bootstrap cursor; no history becomes a forward decision", async () => {
  const f = withHistory();
  const r = await runPaperDecisionCycle(f.db, evalAt(5));
  assert.equal(r.bootstrapped, true);
  assert.equal((f.tables.research_inplay_paper_decisions ?? []).length, 0);
  assert.equal(f.tables.research_inplay_paper_checkpoints.length, 1);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].bootstrap_cursor_observed_at, T(-20));
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(-20));
});

test("runner: new live rows freeze one BET per strategy, idempotent on re-run, checkpoint advances after writes", async () => {
  const f = withHistory();
  await runPaperDecisionCycle(f.db, evalAt(-10));
  f.tables.research_inplay_core_path_observations.push(
    obs({ at: 1, token_id: "tA", full_stake_executable_vwap: 0.5 }),   // A
    obs({ at: 1, token_id: "tB", full_stake_executable_vwap: 0.55 }),  // B
    obs({ at: 1, token_id: "tC", full_stake_executable_vwap: 0.4 }),   // C
    tailRow(2),
  );
  const r1 = await runPaperDecisionCycle(f.db, evalAt(1.1));
  const decisions = f.tables.research_inplay_paper_decisions;
  assert.equal(decisions.length, 3); assert.deepEqual(decisions.map((d) => d.status), ["BET", "BET", "BET"]);
  assert.deepEqual(Object.fromEntries(decisions.map((d) => [d.strategy_id, d.token_id])), { CONTROL_PRICE_BUCKET_A: "tA", CONTROL_PRICE_BUCKET_B: "tB", CONTROL_PRICE_BUCKET_C: "tC" });
  assert.ok(decisions.every((d) => d.provenance_class === "DELAYED_PAPER" && d.result_visible_at_freeze === false));
  assert.equal(r1.cursor_advanced, true); assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(1));
  const before = JSON.stringify(decisions);
  await runPaperDecisionCycle(f.db, evalAt(1.2));
  assert.equal(JSON.stringify(f.tables.research_inplay_paper_decisions), before); // duplicate-free, nothing rewritten
  assert.equal(new Set(decisions.map((d) => d.decision_id)).size, 3);
});

test("runner: the newest observed_at group is held back until a newer group proves it complete", async () => {
  const f = withHistory();
  await runPaperDecisionCycle(f.db, evalAt(-10));
  f.tables.research_inplay_core_path_observations.push(obs({ at: 1, token_id: "tA", full_stake_executable_vwap: 0.5 }));
  await runPaperDecisionCycle(f.db, evalAt(1.1));
  assert.equal((f.tables.research_inplay_paper_decisions ?? []).length, 0);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(-20));
  f.tables.research_inplay_core_path_observations.push(tailRow(2));
  await runPaperDecisionCycle(f.db, evalAt(2.1));
  assert.equal(f.tables.research_inplay_paper_decisions.filter((d) => d.status === "BET").length, 1);
});

test("runner: an observation group straddling the page boundary is never split", async () => {
  const f = withHistory();
  await runPaperDecisionCycle(f.db, evalAt(-10));
  const rows = f.tables.research_inplay_core_path_observations;
  for (let i = 0; i < PAGE_SIZE - 2; i++) rows.push(obs({ at: 0.1 + i * 0.001, physical_event_id: `f${i}`, full_stake_executable_vwap: 0.9 }));
  // 3-row group: the first two rows fit in page 1, the best candidate (highest id) would be cut off
  rows.push(obs({ at: 1, physical_event_id: "X", token_id: "t1", full_stake_executable_vwap: 0.52 }));
  rows.push(obs({ at: 1, physical_event_id: "X", token_id: "t2", full_stake_executable_vwap: 0.5 }));
  rows.push(obs({ at: 1, physical_event_id: "X", token_id: "t3", full_stake_executable_vwap: 0.5 })); // ties t2, token_id decides
  rows.push(tailRow(2));
  await runPaperDecisionCycle(f.db, evalAt(1.1));
  const x = f.tables.research_inplay_paper_decisions.find((d) => d.physical_event_id === "X" && d.strategy_id === "CONTROL_PRICE_BUCKET_A")!;
  assert.equal(x.status, "BET"); assert.equal(x.token_id, "t2"); assert.equal(x.admitted_candidate_n, 3);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(1));
});

test("runner: events first seen before bootstrap are never turned into forward decisions", async () => {
  const f = fakeDb({ research_inplay_core_path_observations: [obs({ at: -20, physical_event_id: "mid" })] });
  await runPaperDecisionCycle(f.db, evalAt(0));
  f.tables.research_inplay_core_path_observations.push(obs({ at: 2, physical_event_id: "mid" }), tailRow(3));
  const r = await runPaperDecisionCycle(f.db, evalAt(2.1));
  assert.equal(r.pre_bootstrap_events_skipped, 1);
  assert.equal((f.tables.research_inplay_paper_decisions ?? []).some((d) => d.physical_event_id === "mid"), false);
});

test("runner: a failed decision write never advances the checkpoint; a re-run yields no loss and no duplicate", async () => {
  const f = fakeDb({ research_inplay_core_path_observations: [obs({ at: -20, physical_event_id: "old" })] }, { table: "research_inplay_paper_decisions", op: "insert", once: true });
  await runPaperDecisionCycle(f.db, evalAt(-10));
  f.tables.research_inplay_core_path_observations.push(obs({ at: 1, physical_event_id: "E1" }), obs({ at: 1.1, physical_event_id: "E2" }), tailRow(3));
  await assert.rejects(() => runPaperDecisionCycle(f.db, evalAt(1.5)), /INPLAY_PAPER_DECISION_INSERT:boom/);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(-20));
  await runPaperDecisionCycle(f.db, evalAt(1.6));
  const keys = f.tables.research_inplay_paper_decisions.map((d) => `${d.physical_event_id}|${d.strategy_id}`);
  assert.equal(keys.length, 6); assert.equal(new Set(keys).size, 6);
  assert.equal(f.tables.research_inplay_paper_checkpoints[0].cursor_observed_at, T(1.1));
});

test("runner: a result already visible in DBClone can never produce a BET (delayed cohort stays pre-result)", async () => {
  const f = withHistory();
  await runPaperDecisionCycle(f.db, evalAt(-10));
  f.tables.research_inplay_core_path_observations.push(obs({ at: 1, physical_event_id: "E1" }), obs({ at: 40, physical_event_id: "E1", event_live_status: "FINAL" }), tailRow(60));
  await runPaperDecisionCycle(f.db, evalAt(61));
  const d = f.tables.research_inplay_paper_decisions.filter((x) => x.physical_event_id === "E1");
  assert.equal(d.length, 3); assert.ok(d.every((x) => x.status === "SKIP"));
  const a = d.find((x) => x.strategy_id === "CONTROL_PRICE_BUCKET_A")!; // the only strategy whose band the 0.50 candidate satisfies
  assert.equal(a.reject_reason, "RESULT_VISIBLE_AT_EVALUATION"); assert.equal(a.result_visible_at_freeze, true); assert.equal(a.provenance_class, "DELAYED_PAPER");
  assert.ok(d.filter((x) => x !== a).every((x) => x.reject_reason === "ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE"));
});

test("runner: elapsed WAITING decisions freeze to SKIP with an exact reason, by evaluation or by sweep", async () => {
  const f = withHistory();
  await runPaperDecisionCycle(f.db, evalAt(-10));
  f.tables.research_inplay_core_path_observations.push(obs({ at: 1, full_stake_executable_vwap: 0.9 }), tailRow(2));
  await runPaperDecisionCycle(f.db, evalAt(1.1));
  assert.ok(f.tables.research_inplay_paper_decisions.every((d) => d.status === "WAITING"));
  // a WAITING row whose event produced no further observations is closed by the sweep
  f.tables.research_inplay_paper_decisions.push({ decision_id: "sweep-1", physical_event_id: "Z", strategy_id: "CONTROL_PRICE_BUCKET_A", strategy_version: "v1", scope_key: "MONEYLINE_FULL_GAME", status: "WAITING", admission_observed_at: T(0), entry_window_end: T(30) });
  const r = await runPaperDecisionCycle(f.db, evalAt(45));
  assert.equal(r.swept, 1);
  const z = f.tables.research_inplay_paper_decisions.find((d) => d.physical_event_id === "Z")!;
  assert.equal(z.status, "SKIP"); assert.equal(z.provenance_class, "TIMING_UNPROVEN");
  assert.ok(f.tables.research_inplay_paper_decisions.every((d) => d.status === "SKIP" && d.reject_reason === "ENTRY_WINDOW_ELAPSED_NO_QUALIFYING_CANDIDATE"));
});

test("scheduling: the runner is chained into the live hourly clone-sync cron and no timely path exists", () => {
  const toml = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8");
  const start = toml.split("\n").find((l) => l.startsWith("startCommand"))!;
  assert.match(toml, /cronSchedule\s*=\s*"0 \* \* \* \*"/); // hourly: source->DBClone latency >= one cron interval
  assert.equal((start.match(/research-clone:inplay-paper-decisions/g) ?? []).length, 2); // both the 02:00 and hourly branches
  assert.match(start, /research-clone:sync -- --telemetry-only; npm run research-clone:inplay-paper-decisions/);
  assert.match(start, /research-clone:modeling-dashboard-refresh -- --runtime-only; npm run research-clone:inplay-paper-decisions/);
  assert.equal(TIMELY_SOURCE_PATH_PROVEN, false);
});
