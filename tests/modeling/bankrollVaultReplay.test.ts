// Phase 3B / 3B-patch — Bankroll/Vault Historical Replay (pure engine).
//
// THEORETICAL_GROSS_HISTORICAL_REPLAY ONLY. This suite proves the corrected
// pipeline order (strict dedup -> exact B2A base-candidate selector,
// verbatim -> T-90 overlay -> one-sporting-match ranking -> bankroll/vault
// simulation) reuses canonical selection/grouping/metrics functions rather
// than reimplementing them, fails closed on eSports via the unmodified ALT4
// bundle, collapses multi-market same-match signals to one execution, and
// preserves all founder-frozen bankroll/vault limits.

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
import { evaluateHistoricalFunnelVariant } from "../../lib/modeling/historicalFunnelVariants";
import { BASE_COMPARATOR_ID, passesPriceFloor, passesTimingWithin120m } from "../../lib/modeling/boundedRoutingExperiments";
import { computeSegmentMetrics } from "../../lib/modeling/extendedHistoricalDecomposition";
import { projectGeneratedSignalPairsStrictDedup } from "../../lib/modeling/generatedSignalPairsDedupPolicy";

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
    marketSlug?: string;
    // Explicit `null` means "no strong sporting-match key" (Fix 3 test
    // fixture); undefined defaults to a per-fixture-unique strong key so
    // every other test keeps exercising one signal per (already-unique)
    // sporting match without needing to restate it everywhere.
    matchFamilyKey?: string | null;
    league?: string;
    sport?: string;
  },
): Record<string, unknown> {
  const startMs = Date.parse(opts.startIso);
  const createdMs = startMs - opts.hoursBeforeStart * 3_600_000;
  const win = opts.win ?? true;
  const resolvedMs =
    opts.resolvedHoursAfterStart === null || opts.resolvedHoursAfterStart === undefined
      ? startMs + 2 * 3_600_000
      : startMs + opts.resolvedHoursAfterStart * 3_600_000;
  const slug = opts.eventSlug ?? `evt-${n}`;
  const row: Record<string, unknown> = {
    id: `id-${String(n).padStart(5, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: new Date(createdMs).toISOString(),
    resolved_at: opts.resolvedHoursAfterStart === null ? null : new Date(resolvedMs).toISOString(),
    signal_confidence_num: opts.score ?? 70,
    entry_price_num: opts.price ?? 0.5,
    metric_formula_version: "v2-lite-growth-safe",
    league: opts.league ?? "epl",
    event_slug: slug,
    market_slug: opts.marketSlug ?? `${slug}-moneyline`,
    signal_result: win ? "win" : "loss",
    realized_return_pct: win ? 40 : -100,
    diagnostics: { dataCoverage: opts.coverage ?? 80, gameStartIso: opts.startIso },
  };
  if (opts.sport !== undefined) row.sport = opts.sport;
  if (opts.matchFamilyKey !== null) row.match_family_key = opts.matchFamilyKey ?? slug;
  return row;
}

function iso(day: string, hour: number): string {
  return `2024-03-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
}

// A T-90-window row (h=1.75, i.e. 105 minutes before start -- inside [90,120]).
function t90Row(n: number, opts: Omit<Parameters<typeof row>[1], "hoursBeforeStart"> & { hoursBeforeStart?: number }): Record<string, unknown> {
  return row(n, { hoursBeforeStart: opts.hoursBeforeStart ?? 1.75, ...opts });
}

// ---------------------------------------------------------------- constants

test("engine constants and version identifiers", () => {
  assert.equal(typeof BANKROLL_VAULT_REPLAY_ENGINE_VERSION, "string");
  assert.equal(BANKROLL_VAULT_REPLAY_ENGINE_VERSION, "3B-bankroll-vault-replay-v1.2");
  assert.equal(MODEL_POLICY_ID, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
  assert.equal(SELECTION_OVERLAY_VERSION, "T90_STRONG_MATCH_SCORE_COVERAGE_V1");
  assert.equal(BANKROLL_POLICY_VERSION, "ACTIVE50_VAULT50_STAKE_MAX3_OPEN80_POS30_DAY100_V1");
  for (const r of [
    "NO_VALID_EVENT_START",
    "NO_T90_SNAPSHOT",
    "BASE_MODEL_REJECTED",
    "EVENT_RANKED_OUT",
    "NO_STRONG_SPORTING_MATCH_KEY",
    "DAILY_CAP_REJECTED",
    "CONCURRENT_POSITION_CAP_REJECTED",
    "OPEN_EXPOSURE_CAP_REJECTED",
    "INVALID_RESOLVED_AT",
    "INVALID_ENTRY_PRICE",
    "INVALID_RESULT",
  ]) {
    assert.ok(REJECTION_REASONS.includes(r as (typeof REJECTION_REASONS)[number]), `missing reason ${r}`);
  }
});

// ----------------------------------------------- T90-1/T90-2: true snapshot

test("T90-1: a later post-T-90 raw snapshot never displaces an earlier valid pre-T-90 snapshot", () => {
  const start = iso("02", 20);
  const decisionAtMs = Date.parse(start) - 1.5 * 3_600_000;
  const earlyValidMs = decisionAtMs - 5 * 60_000; // 5 min before decisionAt -- valid
  const lateInvalidMs = decisionAtMs + 5 * 60_000; // 5 min AFTER decisionAt -- must never be picked
  const rows = [
    { ...t90Row(1, { startIso: start, score: 70, price: 0.5, eventSlug: "evt-later-snap", matchFamilyKey: "evt-later-snap" }), id: "id-00001", created_at: new Date(earlyValidMs).toISOString() },
    { ...t90Row(1, { startIso: start, score: 95, price: 0.5, eventSlug: "evt-later-snap", matchFamilyKey: "evt-later-snap" }), id: "id-00002", created_at: new Date(lateInvalidMs).toISOString() },
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  // The engine must use the EARLY valid snapshot's own finalScore (60), not
  // the later post-decisionAt snapshot's score (95) -- provable via the
  // decision ledger's recorded finalScore for the executed identity.
  const decision = result.decisionLedger.find((d) => d.identity === "cond-1::tok-1");
  assert.ok(decision, "the identity must still execute using its valid pre-T-90 snapshot");
  assert.equal(decision!.finalScore, 70);
});

test("T90-2: the latest eligible raw snapshot at or before decisionAt is selected among several", () => {
  const start = iso("02", 20);
  const decisionAtMs = Date.parse(start) - 1.5 * 3_600_000;
  const rows = [
    { ...t90Row(1, { startIso: start, score: 10, price: 0.5, eventSlug: "evt-pick-latest", matchFamilyKey: "evt-pick-latest" }), id: "id-00001", created_at: new Date(decisionAtMs - 20 * 60_000).toISOString() },
    { ...t90Row(1, { startIso: start, score: 77, price: 0.5, eventSlug: "evt-pick-latest", matchFamilyKey: "evt-pick-latest" }), id: "id-00002", created_at: new Date(decisionAtMs - 5 * 60_000).toISOString() },
    { ...t90Row(1, { startIso: start, score: 20, price: 0.5, eventSlug: "evt-pick-latest", matchFamilyKey: "evt-pick-latest" }), id: "id-00003", created_at: new Date(decisionAtMs - 40 * 60_000).toISOString() },
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const decision = result.decisionLedger.find((d) => d.identity === "cond-1::tok-1");
  assert.ok(decision);
  assert.equal(decision!.finalScore, 77); // the latest-created eligible snapshot (id-00002, 5 min before decisionAt)
});

test("T90-3: identities with no pre-decisionAt snapshot are rejected NO_T90_SNAPSHOT", () => {
  const start = iso("02", 20);
  const decisionAtMs = Date.parse(start) - 1.5 * 3_600_000;
  const rows = [
    { ...t90Row(1, { startIso: start, score: 80, price: 0.5, eventSlug: "evt-no-t90", matchFamilyKey: "evt-no-t90" }), id: "id-00001", created_at: new Date(decisionAtMs + 10 * 60_000).toISOString() },
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.decisionLedger.length, 0);
  assert.ok(result.rejectedByReason.NO_T90_SNAPSHOT >= 1);
});

// -------------------------------------------------- 1 & 2: exact base reuse

test("1: the exact B2A base-candidate selector rejects eSports (ALT4 EXCLUDE_ESPORTS, unmodified)", () => {
  const start = iso("02", 20);
  const rows = [
    // A clean, qualifying epl signal (control).
    t90Row(1, { startIso: start, score: 80, eventSlug: "epl-control", price: 0.5 }),
    // An eSports signal (League of Legends) that otherwise satisfies every
    // other filter (score, price, T-90 timing) -- must still be rejected
    // purely because it is eSports, via the unmodified ALT4 bundle.
    t90Row(2, {
      startIso: start,
      score: 90,
      price: 0.5,
      eventSlug: "league-of-legends-flyquest-vs-sentinels",
      marketSlug: "league-of-legends-flyquest-vs-sentinels-match-winner",
    }),
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const esportsDecision = result.decisionLedger.find((d) => d.observationId === "id-00002");
  assert.equal(esportsDecision, undefined, "an eSports row rejected at the base-candidate stage never reaches the decision ledger");
  assert.equal(result.acceptedEsportsObservations, 0);
  assert.ok(result.rejectedByReason.BASE_MODEL_REJECTED >= 1);
});

test("2: base candidate metrics are sourced from the exact existing B2A selector, not locally recomputed", () => {
  const start = iso("02", 20);
  const rows = [
    t90Row(1, { startIso: start, score: 80, eventSlug: "evt-a", price: 0.5 }),
    t90Row(2, { startIso: start, score: 75, eventSlug: "evt-b", price: 0.6, win: false }),
    t90Row(3, { startIso: start, score: 60, eventSlug: "evt-c", price: 0.5 }), // score < 65 -> ALT4-rejected
    row(4, { hoursBeforeStart: 5, startIso: start, score: 80, eventSlug: "evt-d", price: 0.5 }), // outside T-90 window but still ALT4-eligible
  ];

  // Independently reconstruct the canonical base-candidate row set using the
  // exact same reusable functions the engine must call -- proving the engine
  // does not silently duplicate or diverge from this math.
  const dedup = projectGeneratedSignalPairsStrictDedup(rows as never[]);
  const alt4Rows = evaluateHistoricalFunnelVariant(dedup.dedupedRows as never[], classifier, BASE_COMPARATOR_ID).selectedRows;
  const expectedBaseRows = alt4Rows.filter((r) => passesPriceFloor(r) && passesTimingWithin120m(r));
  const expectedMetrics = computeSegmentMetrics(expectedBaseRows);

  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });

  assert.equal(result.baseCandidateSelectedObservations, expectedBaseRows.length);
  assert.equal(result.baseCandidateWins, expectedMetrics.wins);
  assert.equal(result.baseCandidateLosses, expectedMetrics.losses);
  assert.equal(result.baseCandidateFlatUnitPnl, expectedMetrics.flatUnitPnl);
  assert.equal(result.baseCandidateFlatUnitRoi, expectedMetrics.flatUnitRoi);
  assert.equal(result.baseCandidateWorkingEventGroups, expectedMetrics.workingEventGroups);
});

// --------------------------------------------------- 3: one sporting match

test("3: three markets on one canonical sporting match produce exactly one execution", () => {
  const start = iso("02", 20);
  const rows = [
    t90Row(1, {
      startIso: start,
      score: 80,
      coverage: 90,
      price: 0.5,
      eventSlug: "korea-vs-czechia",
      marketSlug: "korea-vs-czechia-match-winner",
      matchFamilyKey: "korea-vs-czechia-2024-03-02",
    }),
    t90Row(2, {
      startIso: start,
      score: 75,
      coverage: 70,
      price: 0.45,
      eventSlug: "korea-vs-czechia-ou25",
      marketSlug: "korea-vs-czechia-over-under-2.5",
      matchFamilyKey: "korea-vs-czechia-2024-03-02",
    }),
    t90Row(3, {
      startIso: start,
      score: 65,
      coverage: 60,
      price: 0.4,
      eventSlug: "korea-vs-czechia-corners",
      marketSlug: "korea-vs-czechia-total-corners-8.5",
      matchFamilyKey: "korea-vs-czechia-2024-03-02",
    }),
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const forMatch = result.decisionLedger.filter((d) => d.eventKey && d.eventKey.includes("korea-vs-czechia-2024-03-02"));
  assert.equal(forMatch.filter((d) => d.accepted).length, 1);
  assert.equal(forMatch.filter((d) => !d.accepted).length, 0); // ranked-out rows never reach the decision ledger
  assert.equal(result.qualifiedSportingMatchGroups >= 1, true);
  assert.ok(result.rejectedByReason.EVENT_RANKED_OUT >= 2);
  // The winner must be the highest finalScore (id-00001, score 80).
  assert.equal(forMatch[0].observationId, "id-00001");
});

test("3b: three market-specific slugs without any strong key are all rejected NO_STRONG_SPORTING_MATCH_KEY", () => {
  const start = iso("02", 20);
  const rows = [
    t90Row(1, { startIso: start, score: 80, price: 0.5, eventSlug: "korea-vs-czechia-match-winner", matchFamilyKey: null }),
    t90Row(2, { startIso: start, score: 75, price: 0.45, eventSlug: "korea-vs-czechia-over-under-2-5", matchFamilyKey: null }),
    t90Row(3, { startIso: start, score: 65, price: 0.4, eventSlug: "korea-vs-czechia-total-corners-8-5", matchFamilyKey: null }),
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.decisionLedger.length, 0);
  assert.equal(result.rejectedByReason.NO_STRONG_SPORTING_MATCH_KEY, 3);
  assert.equal(result.rowsRejectedNoStrongSportingMatchKey, 3);
});

test("3c: eventGroupKeySourceCounts reflects only match_family_key/canonical_event_key/parent_event_key", () => {
  const start = iso("02", 20);
  const rows = [
    t90Row(1, { startIso: start, score: 80, price: 0.5, eventSlug: "evt-src-a", matchFamilyKey: "match-a" }),
    { ...t90Row(2, { startIso: start, score: 75, price: 0.5, eventSlug: "evt-src-b", matchFamilyKey: null }), canonical_event_key: "canon-b" },
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.eventGroupKeySourceCounts.match_family_key, 1);
  assert.equal(result.eventGroupKeySourceCounts.canonical_event_key, 1);
  assert.equal(result.eventGroupKeySourceCounts.parent_event_key, 0);
});

// ------------------------------------------------------------- 4. ranking

test("4: ranking is score DESC -> coverage DESC -> price ASC -> deterministic ties", () => {
  const start = iso("02", 20);
  const rowsA = [
    t90Row(1, { startIso: start, score: 90, coverage: 50, eventSlug: "evt-rank", marketSlug: "evt-rank-a", matchFamilyKey: "evt-rank", price: 0.5 }),
    t90Row(2, { startIso: start, score: 80, coverage: 99, eventSlug: "evt-rank", marketSlug: "evt-rank-b", matchFamilyKey: "evt-rank", price: 0.5 }),
  ];
  const resultA = runBankrollVaultReplay({ rawRows: rowsA, classifier, insuranceBankroll: 100 });
  assert.ok(resultA.decisionLedger.find((d) => d.observationId === "id-00001" && d.accepted));
  assert.equal(resultA.decisionLedger.find((d) => d.observationId === "id-00002"), undefined);

  const rowsB = [
    t90Row(3, { startIso: start, score: 80, coverage: 60, eventSlug: "evt-rank2", marketSlug: "evt-rank2-a", matchFamilyKey: "evt-rank2", price: 0.5 }),
    t90Row(4, { startIso: start, score: 80, coverage: 90, eventSlug: "evt-rank2", marketSlug: "evt-rank2-b", matchFamilyKey: "evt-rank2", price: 0.5 }),
  ];
  const resultB = runBankrollVaultReplay({ rawRows: rowsB, classifier, insuranceBankroll: 100 });
  assert.ok(resultB.decisionLedger.find((d) => d.observationId === "id-00004" && d.accepted));
  assert.equal(resultB.decisionLedger.find((d) => d.observationId === "id-00003"), undefined);
});

// --------------------------------------------- 5 & 6: invariants

test("5: selectedObservations === executedSportingMatchGroups", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 10 }, (_, i) =>
    t90Row(i + 1, { startIso: start, score: 70 + i, eventSlug: `evt-inv-${i}`, matchFamilyKey: `evt-inv-${i}`, price: 0.5 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.selectedObservations, result.executedSportingMatchGroups);
});

test("6: no duplicate executed sporting-match keys", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 25 }, (_, i) =>
    t90Row(i + 1, { startIso: start, score: 70 + (i % 5), eventSlug: `evt-dup-${i % 8}`, matchFamilyKey: `evt-dup-${i % 8}`, price: 0.4 + (i % 4) * 0.1 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const executedKeys = result.decisionLedger.filter((d) => d.accepted).map((d) => d.eventKey);
  assert.equal(new Set(executedKeys).size, executedKeys.length);
});

// -------------------------------------------------- 7: bankroll caps green

test("7a: requested stake never exceeds 3% of active bankroll at decision time", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 5 }, (_, i) =>
    t90Row(i + 1, { startIso: start, score: 70 + i, eventSlug: `evt-stake-${i}`, matchFamilyKey: `evt-stake-${i}`, price: 0.5 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  for (const d of result.decisionLedger) {
    if (d.accepted) {
      assert.ok(d.actualStake <= d.requestedStake + 1e-6);
      assert.ok(d.requestedStake <= 0.03 * d.activeBankrollBeforeDecision + 1e-6);
    }
  }
});

test("7b: total open exposure never exceeds 80% and open positions never exceed 30", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 60 }, (_, i) =>
    t90Row(i + 1, {
      startIso: start,
      score: 70,
      eventSlug: `evt-exp-${i}`,
      matchFamilyKey: `evt-exp-${i}`,
      price: 0.5,
      resolvedHoursAfterStart: 500,
    }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(result.maximumSimultaneousPositions <= 30);
  assert.ok(result.maximumOpenExposurePct <= 80 + 1e-6);
});

test("7c: UTC daily accepted count never exceeds 100", () => {
  const rows = Array.from({ length: 150 }, (_, i) => {
    const startIso = new Date(Date.parse(iso("02", 20)) + i * 60_000).toISOString();
    return t90Row(i + 1, {
      startIso,
      score: 70,
      eventSlug: `evt-day-${i}`,
      matchFamilyKey: `evt-day-${i}`,
      price: 0.5,
      resolvedHoursAfterStart: -1.49,
    });
  });
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  for (const day of result.dailySummaries) {
    assert.ok(day.acceptedCount <= 100);
  }
});

test("7d: vault sweep moves profit active -> vault and never refills losses", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 3 }, (_, i) =>
    t90Row(i + 1, {
      startIso: start,
      score: 70,
      eventSlug: `evt-sweep-${i}`,
      matchFamilyKey: `evt-sweep-${i}`,
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
  let prevVault = result.initialVaultBankroll;
  for (const sweep of result.vaultSweepLedger) {
    assert.ok(sweep.vaultBankrollAfter >= prevVault - 1e-6);
    assert.ok(sweep.sweepAmount >= 0);
    prevVault = sweep.vaultBankrollAfter;
  }
});

test("7e: bankroll invariant active + vault = total capital", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 10 }, (_, i) =>
    t90Row(i + 1, { startIso: start, score: 70, eventSlug: `evt-inv2-${i}`, matchFamilyKey: `evt-inv2-${i}`, price: 0.5, win: i % 2 === 0 }),
  );
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(Math.abs(result.endingActiveBankroll + result.endingVaultBankroll - result.endingTotalCapital) < 1e-6);
});

// ------------------------------------------------------------- misc

test("8: final accepted rows contain zero independently detected eSports rows, on realistic slugs", () => {
  const start = iso("02", 20);
  const rows = [
    t90Row(1, { startIso: start, score: 80, price: 0.5, eventSlug: "epl-control-8", matchFamilyKey: "epl-control-8" }),
    t90Row(2, { startIso: start, score: 90, price: 0.5, eventSlug: "lol-flyquest-vs-sentinels-bo5-lcs-playoffs", matchFamilyKey: "lol-flyquest-vs-sentinels" }),
    t90Row(3, { startIso: start, score: 90, price: 0.5, eventSlug: "team-a-vs-team-b", sport: "esports", matchFamilyKey: "team-a-vs-team-b" }),
  ];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.acceptedEsportsObservations, 0);
  assert.equal(result.decisionLedger.length, 1);
  assert.equal(result.decisionLedger[0].identity, "cond-1::tok-1");
});

test("missing/invalid resolved_at cannot be executed", () => {
  const start = iso("02", 20);
  const rows = [t90Row(1, { startIso: start, score: 70, eventSlug: "evt-noresolve", matchFamilyKey: "evt-noresolve", price: 0.5, resolvedHoursAfterStart: null })];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.ok(result.rejectedByReason.INVALID_RESOLVED_AT >= 1);
});

test("output is labeled THEORETICAL_GROSS_HISTORICAL_REPLAY, never realized live ROI", () => {
  const start = iso("02", 20);
  const rows = [t90Row(1, { startIso: start, score: 70, eventSlug: "evt-label", matchFamilyKey: "evt-label", price: 0.5 })];
  const result = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(result.resultLabel, "THEORETICAL_GROSS_HISTORICAL_REPLAY");
  assert.ok(!/realized[_ ]?live/i.test(JSON.stringify(result)));
});

test("determinism: identical input produces identical selection hash and ledger", () => {
  const start = iso("02", 20);
  const rows = Array.from({ length: 20 }, (_, i) =>
    t90Row(i + 1, { startIso: start, score: 70 + (i % 5), eventSlug: `evt-det-${i}`, matchFamilyKey: `evt-det-${i}`, price: 0.4 + (i % 4) * 0.1 }),
  );
  const a = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  const b = runBankrollVaultReplay({ rawRows: rows, classifier, insuranceBankroll: 100 });
  assert.equal(a.postOverlaySelectionHash, b.postOverlaySelectionHash);
  assert.deepEqual(a.decisionLedger, b.decisionLedger);
  assert.equal(serializeBankrollVaultReplayJson(a), serializeBankrollVaultReplayJson(b));
});
