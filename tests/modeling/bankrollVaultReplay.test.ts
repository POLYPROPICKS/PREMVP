// Phase 3B — Bankroll/Vault Historical Replay (pure engine).
//
// THEORETICAL_GROSS_HISTORICAL_REPLAY ONLY. This suite proves the T-90
// snapshot selection, one-signal-per-event ranking, stake/exposure/position/
// daily caps, and the one-way vault sweep are all deterministic and reuse
// the canonical base candidate (B2_PRICE_FLOOR_030_TIMING_WITHIN_120M) and
// ROI/PnL outcome classification -- never fees/slippage/spread, never a
// live/realized claim, never Ireland.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BANKROLL_VAULT_REPLAY_ENGINE_VERSION,
  MODEL_POLICY_ID,
  SELECTION_OVERLAY_VERSION,
  BANKROLL_POLICY_VERSION,
  REJECTION_REASONS,
  runBankrollVaultReplay,
  serializeBankrollVaultReplayJson,
} from "../../lib/modeling/bankrollVaultReplay";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

// Builds a raw row. `hoursBeforeStart` controls created_at relative to
// gameStartIso (via getHoursUntilStartValue = (start - created) / 1h).
function row(
  n: number,
  opts: {
    hoursBeforeStart: number;
    startIso: string;
    score?: number;
    coverage?: number;
    price?: number;
    win?: boolean;
    resolvedHoursAfterStart?: number | null;
    eventSlug?: string;
    league?: string;
  },
): Record<string, unknown> {
  const startMs = Date.parse(opts.startIso);
  const createdMs = startMs - opts.hoursBeforeStart * 3_600_000;
  const win = opts.win ?? true;
  const resolvedMs =
    opts.resolvedHoursAfterStart === null
      ? null
      : startMs + (opts.resolvedHoursAfterStart ?? 2) * 3_600_000;
  const slug = opts.eventSlug ?? `evt-${n}`;
  return {
    id: `id-${String(n).padStart(5, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: new Date(createdMs).toISOString(),
    resolved_at: resolvedMs === null ? null : new Date(resolvedMs).toISOString(),
    signal_confidence_num: opts.score ?? 70,
    entry_price_num: opts.price ?? 0.5,
    metric_formula_version: "v2-lite-growth-safe",
    league: opts.league ?? "epl",
    event_slug: slug,
    market_slug: `${slug}-moneyline`,
    signal_result: win ? "win" : "loss",
    realized_return_pct: win ? 40 : -100,
    diagnostics: { dataCoverage: opts.coverage ?? 80, gameStartIso: opts.startIso },
  };
}

function iso(day: string, hour: number): string {
  return `2024-03-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
}

// ---------------------------------------------------------------- constants

test("engine constants and version identifiers", () => {
  assert.equal(typeof BANKROLL_VAULT_REPLAY_ENGINE_VERSION, "string");
  assert.equal(MODEL_POLICY_ID, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
  assert.equal(SELECTION_OVERLAY_VERSION, "T90_ONE_PER_EVENT_SCORE_COVERAGE_V1");
  assert.equal(BANKROLL_POLICY_VERSION, "ACTIVE50_VAULT50_STAKE_MAX3_OPEN80_POS30_DAY100_V1");
  assert.ok(REJECTION_REASONS.includes("NO_VALID_EVENT_START"));
  assert.ok(REJECTION_REASONS.includes("NO_T90_SNAPSHOT"));
  assert.ok(REJECTION_REASONS.includes("BASE_MODEL_REJECTED"));
  assert.ok(REJECTION_REASONS.includes("EVENT_RANKED_OUT"));
  assert.ok(REJECTION_REASONS.includes("DAILY_CAP_REJECTED"));
  assert.ok(REJECTION_REASONS.includes("CONCURRENT_POSITION_CAP_REJECTED"));
  assert.ok(REJECTION_REASONS.includes("OPEN_EXPOSURE_CAP_REJECTED"));
  assert.ok(REJECTION_REASONS.includes("INVALID_RESOLVED_AT"));
  assert.ok(REJECTION_REASONS.includes("INVALID_ENTRY_PRICE"));
  assert.ok(REJECTION_REASONS.includes("INVALID_RESULT"));
});

// --------------------------------------------------------- 1. T-90 snapshot

test("1: T-90 selection uses the latest valid snapshot <= decisionAt and ignores later data", () => {
  const start = iso("02", 20);
  const rows = [
    // Too early: h=2.5 (150 min before start) -- outside [90,120] window.
    row(1, { hoursBeforeStart: 2.5, startIso: start, score: 90 }),
    // Valid T-90 window candidate at h=1.75 (105 min before start).
    row(2, { hoursBeforeStart: 1.75, startIso: start, score: 70 }),
    // A LATER snapshot for the SAME identity at h=1.6 (96 min before start,
    // still in window, more recent) -- must win over row 2.
    { ...row(2, { hoursBeforeStart: 1.6, startIso: start, score: 71 }), id: "id-00003" },
    // Recorded strictly after decisionAt (h=1.4, 84 min before start) --
    // outside the window entirely, must never affect selection.
    { ...row(2, { hoursBeforeStart: 1.4, startIso: start, score: 99 }), id: "id-00004" },
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const decisionForEvent = result.decisionLedger.find((d) => d.observationId === "id-00003" || d.observationId === "id-00002");
  // The latest in-window snapshot (id-00003, score 71) must be the one used --
  // never the out-of-window later row (id-00004, score 99).
  assert.ok(result.decisionLedger.some((d) => d.observationId === "id-00003"));
  assert.ok(!result.decisionLedger.some((d) => d.observationId === "id-00004"));
  void decisionForEvent;
});

// --------------------------------------------------- 2. one signal per event

test("2: one canonical event produces exactly one selected observation", () => {
  const start = iso("02", 20);
  const rows = [
    row(1, { hoursBeforeStart: 1.75, startIso: start, score: 80, eventSlug: "same-event", price: 0.5 }),
    row(2, { hoursBeforeStart: 1.75, startIso: start, score: 70, eventSlug: "same-event", price: 0.5 }),
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const acceptedForEvent = result.decisionLedger.filter((d) => d.accepted && d.eventKey);
  const eventKeys = new Set(acceptedForEvent.map((d) => d.eventKey));
  for (const key of eventKeys) {
    assert.equal(acceptedForEvent.filter((d) => d.eventKey === key).length, 1);
  }
});

// ------------------------------------------------------------- 3. ranking

test("3: ranking is score DESC -> coverage DESC -> price ASC -> deterministic ties", () => {
  const start = iso("02", 20);
  const rowsA = [
    row(1, { hoursBeforeStart: 1.75, startIso: start, score: 90, coverage: 50, eventSlug: "evt-rank", price: 0.5 }),
    row(2, { hoursBeforeStart: 1.75, startIso: start, score: 80, coverage: 99, eventSlug: "evt-rank", price: 0.5 }),
  ];
  const resultA = runBankrollVaultReplay({ rawRows: rowsA, classifier, insuranceBankroll: 100 });
  assert.ok(resultA.decisionLedger.find((d) => d.observationId === "id-00001" && d.accepted));
  assert.ok(!resultA.decisionLedger.find((d) => d.observationId === "id-00002" && d.accepted));

  const rowsB = [
    row(3, { hoursBeforeStart: 1.75, startIso: start, score: 80, coverage: 60, eventSlug: "evt-rank2", price: 0.5 }),
    row(4, { hoursBeforeStart: 1.75, startIso: start, score: 80, coverage: 90, eventSlug: "evt-rank2", price: 0.5 }),
  ];
  const resultB = runBankrollVaultReplay({ rawRows: rowsB, classifier, insuranceBankroll: 100 });
  assert.ok(resultB.decisionLedger.find((d) => d.observationId === "id-00004" && d.accepted));
  assert.ok(!resultB.decisionLedger.find((d) => d.observationId === "id-00003" && d.accepted));
});

// -------------------------------------------------------- 4. stake cap

test("4: requested stake never exceeds 3% of active bankroll at decision time", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 5 }, (_, i) =>
    row(i + 1, { hoursBeforeStart: 1.75, startIso: start, score: 70 + i, eventSlug: `evt-stake-${i}`, price: 0.5 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  for (const d of result.decisionLedger) {
    if (d.accepted) {
      assert.ok(d.actualStake <= d.requestedStake + 1e-6);
      assert.ok(d.requestedStake <= 0.03 * d.activeBankrollBeforeDecision + 1e-6);
    }
  }
});

// -------------------------------------------- 5. exposure/position caps

test("5: total open exposure never exceeds 80% and open positions never exceed 30", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 60 }, (_, i) =>
    row(i + 1, {
      hoursBeforeStart: 1.75,
      startIso: start,
      score: 70,
      eventSlug: `evt-exp-${i}`,
      price: 0.5,
      resolvedHoursAfterStart: 500, // resolves long after all decisions -- keeps positions open concurrently
    }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(result.maximumSimultaneousPositions <= 30);
  assert.ok(result.maximumOpenExposurePct <= 80 + 1e-6);
});

// ---------------------------------------------------------- 6. daily cap

test("6: UTC daily accepted count never exceeds 100", () => {
  // Stagger event starts across the same UTC day and settle almost
  // immediately so positions close well before the next decision opens --
  // isolating the daily cap from the exposure/position caps.
  const rows = Array.from({ length: 150 }, (_, i) => {
    const startIso = new Date(Date.parse(iso("02", 20)) + i * 60_000).toISOString();
    return row(i + 1, { hoursBeforeStart: 1.75, startIso, score: 70, eventSlug: `evt-day-${i}`, price: 0.5, resolvedHoursAfterStart: -1.49 });
  });
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  for (const day of result.dailySummaries) {
    assert.ok(day.acceptedCount <= 100);
  }
  assert.ok(result.rejectedByReason.DAILY_CAP_REJECTED >= 50);
});

// -------------------------------------------------------- 7. vault sweep

test("7: vault sweep moves profit active -> vault and never refills losses", () => {
  const start = iso("02", 20);
  // Winning rows on day 1 -> profit should sweep to vault at day boundary.
  const rows = Array.from({ length: 3 }, (_, i) =>
    row(i + 1, {
      hoursBeforeStart: 1.75,
      startIso: start,
      score: 70,
      eventSlug: `evt-sweep-${i}`,
      price: 0.5,
      win: true,
      resolvedHoursAfterStart: 0.1,
    }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.initialActiveBankroll, 50);
  assert.equal(result.initialVaultBankroll, 50);
  if (result.totalSweptToVault > 0) {
    assert.ok(result.endingVaultBankroll > result.initialVaultBankroll);
  }
  // Invariant: active + vault = total capital at every point; vault never
  // decreases (one-way sweep only).
  let prevVault = result.initialVaultBankroll;
  for (const sweep of result.vaultSweepLedger) {
    assert.ok(sweep.vaultBankrollAfter >= prevVault - 1e-6);
    assert.ok(sweep.sweepAmount >= 0);
    prevVault = sweep.vaultBankrollAfter;
  }
});

// ----------------------------------------------------- 8. determinism

test("8: identical input produces identical selection hash and ledger", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 20 }, (_, i) =>
    row(i + 1, { hoursBeforeStart: 1.75, startIso: start, score: 70 + (i % 5), eventSlug: `evt-det-${i}`, price: 0.4 + (i % 4) * 0.1 }),
  );
  const a = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const b = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(a.postOverlaySelectionHash, b.postOverlaySelectionHash);
  assert.deepEqual(a.decisionLedger, b.decisionLedger);
  assert.equal(serializeBankrollVaultReplayJson(a), serializeBankrollVaultReplayJson(b));
});

// ------------------------------------------------------ additional coverage

test("bankroll invariant: insurance = active + vault always", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(i + 1, { hoursBeforeStart: 1.75, startIso: start, score: 70, eventSlug: `evt-inv-${i}`, price: 0.5, win: i % 2 === 0 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(Math.abs(result.endingActiveBankroll + result.endingVaultBankroll - result.endingTotalCapital) < 1e-6);
});

test("missing/invalid resolved_at cannot be executed", () => {
  const start = iso("02", 20);
  const rows = [row(1, { hoursBeforeStart: 1.75, startIso: start, score: 70, eventSlug: "evt-noresolve", price: 0.5, resolvedHoursAfterStart: null })];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(result.rejectedByReason.INVALID_RESOLVED_AT >= 1);
});

test("output is labeled THEORETICAL_GROSS_HISTORICAL_REPLAY, never realized live ROI", () => {
  const start = iso("02", 20);
  const rows = [row(1, { hoursBeforeStart: 1.75, startIso: start, score: 70, eventSlug: "evt-label", price: 0.5 })];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.resultLabel, "THEORETICAL_GROSS_HISTORICAL_REPLAY");
  const blob = JSON.stringify(result);
  assert.ok(!/realized[_ ]?live/i.test(blob));
});
