// TODAY_REAL_MONEY_PAUSE_KEEP_TELEMETRY_V1 -- PREMVP_QUEUE_PUBLICATION_KILL_SWITCH
//   node --import tsx --test tests/contur3/realMoneyPauseKillSwitch.test.ts
//
// T10_REAL_MONEY_EXECUTION_ENABLED=false keeps the normal write=true orchestration (telemetry, economic
// evaluation, lifecycle, settlement) and blocks ONLY the creation of NEW executable Queue authority.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import {
  admitExecutableQueueRow,
  runControlledLiveIntent,
  runEventRebalance,
  runFounderBattleBatch,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import {
  REAL_MONEY_PAUSED_SHADOW_ONLY,
  RealMoneyPausedError,
  SHADOW_ECONOMIC_ACTION_KEY,
  T10_REAL_MONEY_EXECUTION_ENV,
  isRealMoneyExecutionEnabled,
  readRealMoneyExecutionSwitch,
  type ShadowEconomicActionMarker,
} from "../../lib/executor/t10RealMoneyPause";
import { reconcileExecutionLifecycleWithPort, type ExecutionLifecycleDbPort } from "../../lib/executor/executionLifecycle";
import { reconcileStaleClaims } from "../../lib/executor/staleQueueClaims";
import type { FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";
import { getActiveContour } from "../../lib/constructor/registry";
import { T10_ECONOMIC_ACTION_POLICY_VERSION } from "../../lib/executor/t10EconomicActionPolicy";

const KICKOFF = "2026-07-19T19:00:00.000Z";
const NOW = Date.parse("2026-07-19T18:46:30.000Z");
const T10_AT = "2026-07-19T18:46:00.000Z";
const EVENT = "provider:polymarket:event-1:2026-07-19";
const RES_ID = "res-pause";
const CAPTURE = "T_MINUS_10-run";

type Row = { cond: string; token: string; family: string; type: string; t10: [number | null, number]; side?: string };
const obs = (r: Row): FinalT3MarketObservation => ({
  capture_run_id: CAPTURE, reservation_id: RES_ID, physical_event_id: EVENT, provider_event_id: "event-1",
  event_start_iso: KICKOFF, observation_phase: "T_MINUS_10", condition_id: r.cond, token_id: r.token, side: r.side ?? "Yes",
  canonical_market_family: r.family, canonical_market_type: r.type, market_slug: r.cond,
  best_bid: r.t10[0], best_ask: r.t10[1], ask_decimal_odds: 1 / r.t10[1], orderbook_fetch_status: "SUCCESS", observed_at: T10_AT,
});

// Same fixtures as the released T10 activation tests: A = SPREADS, B = TOTALS.
const A: Row = { cond: "a-spread", token: "a-token", family: "SPREADS", type: "SPREAD", t10: [0.50, 0.52] };
const B: Row = { cond: "b-total", token: "b-token", family: "TOTALS", type: "TOTAL", t10: [0.52, 0.53] };
const SB: Row = { cond: "sb-spread", token: "sb-token", family: "SPREADS", type: "SPREAD", t10: [0.05, 0.50] };

type Lv = [number, number];
const bookOf = (tokenId: string, bids: Lv[], asks: Lv[], tick = 0.01, min = 5): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 3,
  book: { tokenId, bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })),
    tickSize: tick, minimumOrderSize: min, providerTimestampMs: NOW },
});
const LIVE: Record<string, FetchOrderBookResult> = {
  "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 100]]),
  "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]]),
  "sb-token": bookOf("sb-token", [[0.05, 100]], [[0.50, 1], [0.60, 100]]),
};
const LIVE_A_MAKER: Record<string, FetchOrderBookResult> = { ...LIVE, "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 1], [0.60, 100]]) };
const fee = (tokenId: string): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: 0.05, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID",
  observedAtIso: new Date(NOW).toISOString(), latencyMs: 1,
});

function reservation(): NightEventReservationRow {
  return {
    id: RES_ID, plan_run_id: "night-plan:2026-07-19", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: "pair:a-vs-b:2026-07-19", event_slug: "a-vs-b", event_title: "A vs B", sport: "soccer", league: null,
    strategic_scope: "WC", game_start_iso: KICKOFF, event_tier: "TIER1", event_score: 80, best_snapshot_id: null,
    reservation_rank: 1, status: "RESERVED", selection_reason: null, physical_event_id: EVENT, event_start_iso: KICKOFF,
    diagnostics: { contract_a_stage: "PLANNING", source_lineage: { provider_event_id: "event-1" },
      planning_final_identity_evidence: { condition_id: "a-spread", token_id: "a-token", side: "Yes" } },
  } as NightEventReservationRow;
}

function repoOf(reservations: NightEventReservationRow[]) {
  const queueRows: EventExecutionQueueRow[] = [];
  const queued = new Set<string>();
  const shadowWrites: ShadowEconomicActionMarker[] = [];
  const statusWrites: string[] = [];
  const repo: RebalanceRepoPort = {
    async loadEventExposureQueueRows(r) {
      return queueRows.filter((q) => q.reservation_id === r.id || q.match_family_key === r.match_family_key);
    },
    async loadActiveReservations() { return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING"); },
    async loadQueuedReservationIds() { return new Set(queued); },
    async markReservationsExpired() {},
    async markReservationSkipped(id, reason) {
      const r = reservations.find((x) => x.id === id);
      if (r) { r.status = "SKIPPED"; r.selection_reason = reason; }
      statusWrites.push(`SKIPPED:${id}`);
    },
    async insertQueueRow(row) { queueRows.push(row); if (row.reservation_id) queued.add(row.reservation_id); },
    async markReservationQueued(id) {
      const r = reservations.find((x) => x.id === id);
      if (r) r.status = "QUEUED";
      statusWrites.push(`QUEUED:${id}`);
    },
    // Mirrors the Supabase port: merges ONLY the shadow key into diagnostics; status is never touched.
    async recordReservationShadowDecision(id, marker) {
      const r = reservations.find((x) => x.id === id && (x.status === "RESERVED" || x.status === "REBALANCE_PENDING"));
      if (!r) return;
      r.diagnostics = { ...(r.diagnostics ?? {}), [SHADOW_ECONOMIC_ACTION_KEY]: marker };
      shadowWrites.push(marker);
    },
  };
  return Object.assign(repo, { queueRows, queued, shadowWrites, statusWrites });
}

async function run(
  flag: boolean | undefined,
  rows: Row[],
  books: Record<string, FetchOrderBookResult>,
  o: { repo?: ReturnType<typeof repoOf>; res?: NightEventReservationRow; telemetry?: unknown[]; booksCalls?: string[]; strategyCalls?: { n: number } } = {},
) {
  const res = o.res ?? reservation();
  const repo = o.repo ?? repoOf([res]);
  const calls = o.booksCalls ?? [];
  const telemetry = o.telemetry ?? [];
  const strategy = o.strategyCalls ?? { n: 0 };
  const result = await runEventRebalance(NOW, { write: true }, {
    repo, readFinalT3Universe: async () => rows.map(obs), readT30Universe: async () => [],
    recordStrategyDecision: async () => { strategy.n++; return { total: 2, selected: 1, written: 2 }; },
    fetchExactTokenOrderbook: async (tokenId) => { calls.push(tokenId); return books[tokenId] ?? { ok: false, tokenId, latencyMs: 1, errorCode: "HTTP_ERROR" }; },
    fetchTokenFeeSchedule: async (tokenId) => fee(tokenId),
    writeGuardTelemetry: async (_r, input) => { telemetry.push(input); },
    t10EconomicActivation: true,
    ...(flag === undefined ? {} : { realMoneyExecutionEnabled: flag }),
  });
  return { result, repo, res, calls, telemetry, strategy };
}

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[T10_REAL_MONEY_EXECUTION_ENV];
  if (value === undefined) delete process.env[T10_REAL_MONEY_EXECUTION_ENV];
  else process.env[T10_REAL_MONEY_EXECUTION_ENV] = value;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env[T10_REAL_MONEY_EXECUTION_ENV];
    else process.env[T10_REAL_MONEY_EXECUTION_ENV] = prior;
  }
}

const shadowOf = (res: NightEventReservationRow) => res.diagnostics?.[SHADOW_ECONOMIC_ACTION_KEY] as ShadowEconomicActionMarker | undefined;

// ── switch semantics ────────────────────────────────────────────────────────

test("switch: unset=TRUE, true/1/yes=TRUE, false/0/no=FALSE, malformed (incl. empty) fails closed", () => {
  assert.deepEqual(readRealMoneyExecutionSwitch({}), { enabled: true, malformed: false });
  for (const v of ["true", "1", "yes", " TRUE ", "Yes"]) assert.deepEqual(readRealMoneyExecutionSwitch({ [T10_REAL_MONEY_EXECUTION_ENV]: v }), { enabled: true, malformed: false }, v);
  for (const v of ["false", "0", "no", " FALSE ", "No"]) assert.deepEqual(readRealMoneyExecutionSwitch({ [T10_REAL_MONEY_EXECUTION_ENV]: v }), { enabled: false, malformed: false }, v);
  for (const v of ["", "  ", "maybe", "on", "off", "2", "tru", "null"]) assert.deepEqual(readRealMoneyExecutionSwitch({ [T10_REAL_MONEY_EXECUTION_ENV]: v }), { enabled: false, malformed: true }, JSON.stringify(v));
  assert.equal(isRealMoneyExecutionEnabled({}), true);
});

// ── 1 / 2: released behaviour is byte-identical when enabled ────────────────

for (const [label, flag, env] of [["1: flag unset", undefined, undefined], ["2: flag=true (seam)", true, undefined], ["2b: flag=true (env)", undefined, "true"]] as const) {
  test(`${label} -> identical current Queue publication`, async () => {
    await withEnv(env, async () => {
      const { result, repo, res } = await run(flag, [A, B], LIVE);
      assert.equal(result.queued_count, 1);
      assert.equal(repo.queueRows.length, 1);
      assert.equal(repo.queueRows[0].selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
      assert.equal(res.status, "QUEUED");
      assert.equal(repo.shadowWrites.length, 0, "no shadow marker when enabled");
      assert.equal(shadowOf(res), undefined);
      assert.equal(result.real_money_paused_count, 0);
      assert.equal(result.outcomes[0].result, "QUEUED");
    });
  });
}

// ── 3 / 4: paused TAKER_FIRST / MAKER_FIRST ─────────────────────────────────

test("3: flag=false + TAKER_FIRST -> full telemetry/economic evaluation, shadow persisted once, zero Queue row, Reservation untouched", async () => {
  const { result, repo, res, calls, telemetry, strategy } = await run(false, [A, B], LIVE);
  assert.equal(repo.queueRows.length, 0, "no event_execution_queue row");
  assert.equal(result.queued_count, 0);
  assert.equal(repo.statusWrites.length, 0, "never markReservationQueued, never markReservationSkipped just to stop repeats");
  assert.equal(res.status, "RESERVED", "Reservation status untouched");
  assert.ok(calls.length >= 2, "exact-token books were fetched for the sibling economic evaluation and the LIVE_GUARD re-verification");
  assert.equal(telemetry.length, 1, "live guard telemetry still written");
  assert.equal(strategy.n, 2, "A/B strategy decisions still recorded");
  assert.equal(repo.shadowWrites.length, 1, "shadow decision persisted exactly once");
  const o = result.outcomes[0];
  assert.equal(o.result, REAL_MONEY_PAUSED_SHADOW_ONLY);
  assert.equal(o.shadow_persisted, true);
  assert.equal(o.shadow_repeat, false);
  assert.equal(result.real_money_paused_count, 1);
  assert.equal(result.fail_due_reservations_not_queued, false, "an intended pause is not a silent failure");
  const m = shadowOf(res)!;
  assert.equal(m.marker_version, "shadow_economic_action_v1");
  assert.equal(m.physical_event_id, EVENT);
  assert.deepEqual([m.condition_id, m.token_id, m.side, m.market_family], ["b-total", "b-token", "Yes", "TOTALS"]);
  assert.equal(m.shadow_execution_mode, "TAKER_FIRST");
  assert.equal(m.raw_vwap, 0.5);
  assert.equal(m.effective_cost, 0.5125);
  assert.equal(m.maker_limit, null, "not invented for a TAKER");
  assert.equal(m.reject_reason, null);
  assert.equal(m.policy_version, T10_ECONOMIC_ACTION_POLICY_VERSION);
  assert.equal(m.capture_run_id, CAPTURE);
  assert.equal(m.live_authority, false);
  assert.equal(m.real_money_paused, true);
  assert.equal(m.decision_timestamp, new Date(NOW).toISOString());
  assert.ok((m.ranking_inputs as Record<string, unknown>).p_buy_max === 0.555);
  assert.ok(!JSON.stringify(m).includes("\"asks\""), "no order book persisted");
  assert.ok(res.diagnostics?.planning_final_identity_evidence, "other diagnostics keys carried through");
});

test("4: flag=false + MAKER_FIRST -> same: evaluation, one shadow marker with maker_limit, zero Queue", async () => {
  const { result, repo, res } = await run(false, [A], LIVE_A_MAKER);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(res.status, "RESERVED");
  assert.equal(repo.statusWrites.length, 0);
  assert.equal(repo.shadowWrites.length, 1);
  assert.equal(result.outcomes[0].result, REAL_MONEY_PAUSED_SHADOW_ONLY);
  const m = shadowOf(res)!;
  assert.equal(m.shadow_execution_mode, "MAKER_FIRST");
  assert.equal(m.maker_limit, 0.5);
  assert.equal(m.raw_vwap, null);
  assert.equal(m.effective_cost, null);
  assert.equal(m.token_id, "a-token");
});

// ── 5: natural SKIP ─────────────────────────────────────────────────────────

test("5: flag=false + natural SKIP -> reason recoverable, zero Queue, no exposure manufactured", async () => {
  const { result, repo, res, telemetry } = await run(false, [SB], LIVE);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.outcomes[0].result, "SKIPPED");
  assert.match(result.outcomes[0].reason, /T10_ECON_SKIP/);
  assert.equal(res.status, "SKIPPED", "a natural economic SKIP stays a SKIP exactly as when enabled");
  assert.match(String(res.selection_reason), /T10_ECON_SKIP/);
  assert.equal(telemetry.length, 0, "no selected action => no guard telemetry, same as enabled");
});

// ── 6: second tick for the same completed T20 ───────────────────────────────

test("6: second cron tick for the same completed capture while paused -> no recompute, no duplicate persistence, zero Queue", async () => {
  const first = await run(false, [A, B], LIVE);
  const callsAfterFirst = first.calls.length;
  const second = await run(false, [A, B], LIVE, { repo: first.repo, res: first.res, booksCalls: first.calls, telemetry: first.telemetry, strategyCalls: first.strategy });
  assert.equal(first.repo.shadowWrites.length, 1, "exactly one shadow write across both ticks");
  assert.equal(first.repo.queueRows.length, 0);
  assert.equal(second.calls.length, callsAfterFirst, "no new book fetch on the repeat tick");
  assert.equal(first.telemetry.length, 1, "no second telemetry write");
  assert.equal(first.strategy.n, 2, "no second strategy-decision write");
  const o = second.result.outcomes[0];
  assert.equal(o.result, REAL_MONEY_PAUSED_SHADOW_ONLY, "returns the existing typed outcome");
  assert.equal(o.shadow_repeat, true);
  assert.equal(second.result.real_money_paused_count, 1);
  assert.equal(second.res.status, "RESERVED");
});

test("6b: a marker for another capture run or policy version is not reused -- the decision is evaluated once more", async () => {
  const first = await run(false, [A, B], LIVE);
  assert.equal(first.repo.shadowWrites.length, 1);
  const m = shadowOf(first.res)!;
  first.res.diagnostics = { ...first.res.diagnostics, [SHADOW_ECONOMIC_ACTION_KEY]: { ...m, capture_run_id: "older-capture" } };
  const again = await run(false, [A, B], LIVE, { repo: first.repo, res: first.res });
  assert.equal(again.result.outcomes[0].shadow_repeat, false);
  assert.equal(first.repo.shadowWrites.length, 2);
  assert.equal(first.repo.queueRows.length, 0);
  first.res.diagnostics = { ...first.res.diagnostics, [SHADOW_ECONOMIC_ACTION_KEY]: { ...shadowOf(first.res)!, policy_version: "OTHER_POLICY" } };
  const third = await run(false, [A, B], LIVE, { repo: first.repo, res: first.res });
  assert.equal(third.result.outcomes[0].shadow_repeat, false);
  assert.equal(first.repo.shadowWrites.length, 3);
});

// ── 7: rollback ─────────────────────────────────────────────────────────────

test("7: flag false->true before latest safe entry -> the shadow marker never blocks normal Queue execution", async () => {
  const paused = await run(false, [A, B], LIVE);
  assert.equal(paused.repo.queueRows.length, 0);
  assert.ok(shadowOf(paused.res));
  assert.equal(paused.res.status, "RESERVED");
  const live = await run(true, [A, B], LIVE, { repo: paused.repo, res: paused.res });
  assert.equal(live.repo.queueRows.length, 1, "normal Queue publication resumes for the same Reservation");
  assert.equal(live.result.queued_count, 1);
  assert.equal(live.res.status, "QUEUED");
  assert.equal(live.repo.queueRows[0].selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
  assert.equal(live.result.outcomes[0].result, "QUEUED");
  // The inert marker is not counted as Queue exposure: the exposure loader only reads Queue rows.
  assert.equal(live.repo.queueRows.filter((q) => q.reservation_id === RES_ID).length, 1);
});

// ── 8 / 9: existing lifecycle and settlement are NOT disabled ───────────────

test("8: existing CLAIMED rows are still reconciled while the flag is false", async () => {
  await withEnv("false", async () => {
    const expired: string[] = [];
    const summary = await reconcileStaleClaims({
      async loadExpiredClaims() {
        return [{ id: "q-1", status: "CLAIMED", latest_entry_iso: "2026-07-19T18:00:00.000Z", idempotency_key: "idem-1",
          condition_id: "c-1", token_id: "t-1", side: "Yes", diagnostics: {} }] as never;
      },
      async hasMatchingOrderEvent() { return false; },
      async expireClaim(row) { expired.push(String(row.id)); return true; },
    }, "2026-07-19T18:46:30.000Z", true);
    assert.deepEqual(expired, ["q-1"], "stale-claim reconciliation still writes");
    assert.ok(summary);
  });
});

test("9: existing settlement still progresses while the flag is false", async () => {
  await withEnv("false", async () => {
    const eventId = "a4aefc93-edfd-4967-8564-6077c8f00a24";
    const meta: Record<string, Record<string, unknown>> = { [eventId]: { reconciliation_v1: {
      version: "EXECUTION_RECONCILIATION_V1", reconciliation_key: "idem-1", queue_id: "queue-1", reservation_id: "reservation-1",
      source_signal_pair_id: null, provider_event_id: null, order_event_id: eventId, condition_id: "condition-1", token_id: "token-yes",
      side: "Yes", idempotency_key: "idem-1", clob_order_id: "clob-1", submitted_price: 0.37, requested_shares: 6.75,
      requested_notional_usd: 2.4975, authorized_stake_ceiling_usd: 2.5, fill_status: "MATCHED_CONFIRMED", executed_shares: 6.75,
      actual_fill_price: 0.35, executed_notional_usd: 2.3625, settlement_status: "PENDING_MARKET_RESOLUTION", result_status: "PENDING",
      resolved_at: null, winning_outcome: null, winning_token_id: null, fee_status: "NOT_REPORTED", fee_usd: null, gross_pnl_usd: null, net_pnl_usd: null,
    } } };
    let writes = 0;
    const port: ExecutionLifecycleDbPort = {
      async loadEvents() { return Object.entries(meta).map(([id, executor_meta]) => ({ id, executor_meta })); },
      async persistEvent(input) { writes++; meta[input.id] = input.executor_meta; },
    };
    const summary = await reconcileExecutionLifecycleWithPort(port, {
      writeMode: true,
      resolver: async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" }),
    });
    assert.equal(summary.updated, 1);
    assert.equal(writes, 1);
    assert.equal((meta[eventId].reconciliation_v1 as Record<string, unknown>).settlement_status, "RESOLVED_FEE_PENDING");
  });
});

// ── 10: malformed explicit value ────────────────────────────────────────────

test("10: malformed explicit flag (env) -> fail closed to no NEW Queue publication, evaluation still runs", async () => {
  for (const bad of ["maybe", "", "off"]) {
    await withEnv(bad, async () => {
      const { result, repo, res } = await run(undefined, [A, B], LIVE);
      assert.equal(repo.queueRows.length, 0, JSON.stringify(bad));
      assert.equal(res.status, "RESERVED");
      assert.equal(result.outcomes[0].result, REAL_MONEY_PAUSED_SHADOW_ONLY);
      assert.equal(repo.shadowWrites.length, 1);
    });
  }
  await withEnv("false", async () => {
    const { repo } = await run(undefined, [A, B], LIVE);
    assert.equal(repo.queueRows.length, 0, "explicit false via env, no seam");
  });
});

// ── 11: no alternate execution branch becomes active ────────────────────────

test("11: the Queue money boundary, the controlled live-intent seam and the legacy batch all stay shut while paused", async () => {
  // (a) the single money boundary refuses, before touching the repo.
  let inserted = 0;
  const probe = { async insertQueueRow() { inserted++; } };
  const row = { reservation_id: "x" } as unknown as EventExecutionQueueRow;
  await assert.rejects(() => admitExecutableQueueRow(getActiveContour(), probe, row, { realMoneyEnabled: false }), RealMoneyPausedError);
  await withEnv("false", async () => {
    await assert.rejects(() => admitExecutableQueueRow(getActiveContour(), probe, row), RealMoneyPausedError);
  });
  assert.equal(inserted, 0);
  // (b) enabled => unchanged admission.
  await admitExecutableQueueRow(getActiveContour(), probe, row, { realMoneyEnabled: true });
  assert.equal(inserted, 1);

  // (c) controlled one-shot live-intent seam: no READY row while paused.
  const res = reservation();
  const repo = repoOf([res]);
  const withCurrent = { ...repo, async findQueueRowsByRebalanceRunId() { return []; } } as RebalanceRepoPort & { queueRows: EventExecutionQueueRow[] };
  const controlled = await runControlledLiveIntent(NOW, "founder-live-order-20260721-001", { write: true }, {
    repo: withCurrent, readFinalT3Universe: async () => [A, B].map(obs), recordStrategyDecision: async () => ({ total: 2, selected: 1, written: 2 }),
    fetchExactTokenOrderbook: async (t) => LIVE[t], writeGuardTelemetry: async () => {}, realMoneyExecutionEnabled: false,
  });
  assert.equal(repo.queueRows.length, 0);
  assert.notEqual(controlled.kind, "CREATED");
  assert.equal(controlled.wrote, false);
  assert.equal(res.status, "RESERVED");

  // (d) legacy founder battle batch: write path already blocked at the source.
  const batch = await runFounderBattleBatch(NOW, { FOUNDER_BATTLE_BATCH_MODE: "YES" }, { write: true }, { repo: {} as never });
  assert.equal(batch.wrote_count, 0);
});

test("11b: the pause is its own authority -- it never touches T10_ECONOMIC_ACTION_ACTIVATION and the Queue insert has exactly one caller", () => {
  const src = readFileSync("lib/executor/eventExecutionQueue.ts", "utf8");
  const insertCalls = src.split("\n").filter((l) => /\.insertQueueRow\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(insertCalls.length, 1, `insertQueueRow must be called only inside admitExecutableQueueRow, found: ${insertCalls.join(" | ")}`);
  const pause = readFileSync("lib/executor/t10RealMoneyPause.ts", "utf8");
  assert.ok(!/T10_ECONOMIC_ACTION_ACTIVATION/.test(pause.replace(/\/\/.*$/gm, "")), "the pause module never reads the activation switch");
  // Existing lifecycle / settlement / callback / maker-reconciliation code never consults the pause.
  for (const f of [
    "lib/executor/executionLifecycle.ts", "lib/executor/staleQueueClaims.ts", "lib/executor/makerFallbackAuthorization.ts",
    "lib/executor/executionReconciliation.ts", "app/api/executor/order-events/route.ts", "app/api/executor/queue/mark/route.ts",
    "app/api/executor/queue/route.ts",
  ]) {
    assert.ok(!/t10RealMoneyPause|T10_REAL_MONEY_EXECUTION_ENABLED/.test(readFileSync(f, "utf8")), `${f} must not be gated by the pause`);
  }
  // The cron route keeps write=true orchestration: lifecycle and stale-claim reconciliation stay driven by !dryRun, never by the pause.
  const route = readFileSync("app/api/cron/event-rebalance/route.ts", "utf8");
  assert.ok(/reconcileStaleClaims\([\s\S]*?!dryRun\)/.test(route));
  assert.ok(/reconcileExecutionLifecycle\([\s\S]*?writeMode: !dryRun/.test(route));
  assert.ok(!/T10_REAL_MONEY_EXECUTION_ENABLED|t10RealMoneyPause/.test(route.replace(/\/\/.*$/gm, "")), "route code must not translate the pause into dryRun");
});

// ── Supabase port: merge, status guard, optimistic concurrency ──────────────

import { createSupabaseRebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";

function stubClient(o: { diagnostics: Record<string, unknown>; updatedAt?: string | null; active?: boolean; matchedRows?: number }) {
  const log: { op: string; args: unknown[] }[] = [];
  let mode: "select" | "update" = "select";
  let payload: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {
    select(...a: unknown[]) { log.push({ op: "select", args: a }); return builder; },
    update(v: Record<string, unknown>) { mode = "update"; payload = v; log.push({ op: "update", args: [v] }); return builder; },
    eq(...a: unknown[]) { log.push({ op: "eq", args: a }); return builder; },
    in(...a: unknown[]) { log.push({ op: "in", args: a }); return builder; },
    async maybeSingle() { return { data: o.active === false ? null : { diagnostics: o.diagnostics, updated_at: o.updatedAt === undefined ? "2026-07-19T18:00:00Z" : o.updatedAt }, error: null }; },
    then(resolve: (v: unknown) => void) { resolve(mode === "update" ? { data: Array.from({ length: o.matchedRows ?? 1 }, () => ({ id: RES_ID })), error: null } : { data: null, error: null }); },
  };
  return { client: { from: () => builder } as never, log, get payload() { return payload; } };
}

test("port: merges ONLY the shadow key, guards on active status and updated_at, never touches status/selection_reason", async () => {
  const c = stubClient({ diagnostics: { keep: { a: 1 }, contract_a_stage: "PLANNING" } });
  const repo = createSupabaseRebalanceRepoPort(async () => c.client);
  const marker = { marker_version: SHADOW_ECONOMIC_ACTION_KEY } as unknown as ShadowEconomicActionMarker;
  await repo.recordReservationShadowDecision!(RES_ID, marker);
  assert.deepEqual(c.payload, { diagnostics: { keep: { a: 1 }, contract_a_stage: "PLANNING", [SHADOW_ECONOMIC_ACTION_KEY]: marker } });
  assert.ok(c.log.some((l) => l.op === "eq" && l.args[0] === "updated_at" && l.args[1] === "2026-07-19T18:00:00Z"), "optimistic concurrency token");
  assert.equal(c.log.filter((l) => l.op === "in" && JSON.stringify(l.args) === JSON.stringify(["status", ["RESERVED", "REBALANCE_PENDING"]])).length, 2, "read and write both limited to active rows");
});

test("port: a lost race, a terminal/missing row or a missing token is a failure (retried next tick), never a silent success", async () => {
  const marker = {} as ShadowEconomicActionMarker;
  for (const o of [{ diagnostics: {}, matchedRows: 0 }, { diagnostics: {}, active: false }, { diagnostics: {}, updatedAt: null }]) {
    const repo = createSupabaseRebalanceRepoPort(async () => stubClient(o).client);
    await assert.rejects(() => repo.recordReservationShadowDecision!(RES_ID, marker));
  }
});

test("a failing shadow persistence never aborts the tick (lifecycle reconciliation must still run) and is reported as not persisted", async () => {
  const res = reservation();
  const repo = repoOf([res]);
  repo.recordReservationShadowDecision = async () => { throw new Error("boom"); };
  const { result } = await run(false, [A, B], LIVE, { repo, res });
  assert.equal(result.outcomes[0].result, REAL_MONEY_PAUSED_SHADOW_ONLY);
  assert.equal(result.outcomes[0].shadow_persisted, false);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(res.status, "RESERVED");
});
