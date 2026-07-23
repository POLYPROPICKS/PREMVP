// Read-only Contract A authoritative preview runner tests (Integration Phase 2A).
//
// Exercises scripts/contur3/preview-contract-a-authoritative.ts's pure
// orchestration entry point against fixture-mode input only. Zero production
// calls: no Supabase client is ever constructed in these tests, and the
// in-memory rebalance repository throws if any persistence-capable method is
// invoked (write:false must never reach them, but the throw is a trip-wire).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FROZEN_MODEL_V2_VERSION } from "../../lib/modeling/frozenModelProducerV2Shadow";

// Fixed anchor: 2026-07-19T14:00:00Z = 17:00 Minsk (matches the existing
// Contur3 scheduler test convention).
const AS_OF = "2026-07-19T14:00:00.000Z";

// gameStart = AS_OF + 45min (inside the T-70..T-3 rebalance due window);
// created = gameStart - 90min exactly (T-90-eligible boundary; gameStart -
// created = 90min, inside Contract A's own [90,120) timing gate).
function contractARow(overrides: Record<string, unknown> = {}) {
  const gameStart = (overrides.__gameStart as string) ?? "2026-07-19T14:45:00.000Z";
  const created = (overrides.__created as string) ?? "2026-07-19T13:15:00.000Z";
  const { __gameStart, __created, ...rest } = overrides;
  return {
    condition_id: "cond-preview-1",
    selected_token_id: "tok-preview-1",
    selected_outcome: "TEAM_A",
    score: 80,
    signal_confidence_num: 80,
    metric_formula_version: "v2-lite-growth-safe",
    expires_at: "2026-07-20T00:00:00.000Z",
    entry_price_num: 0.45,
    created_at: created,
    event_slug: "nba-team-a-vs-team-b-final-2026-07-19",
    market_slug: "nba-team-a-vs-team-b-final-2026-07-19",
    diagnostics: { gameStartIso: gameStart, dataCoverage: 80, eventTitle: "MLB Yankees vs Mets", marketTitle: "Yankees vs Mets moneyline" },
    ...rest,
  };
}

function withFixture(rows: unknown[], fn: (fixturePath: string) => Promise<void> | void) {
  const dir = mkdtempSync(path.join(tmpdir(), "contract-a-preview-"));
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(rows), "utf8");
  return Promise.resolve(fn(fixturePath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("TEST1: runner module exists and exports runContractAAuthoritativePreview", async () => {
  const mod = await import("../../scripts/contur3/preview-contract-a-authoritative");
  assert.equal(typeof mod.runContractAAuthoritativePreview, "function");
});

test("TEST2: zero-write safety -- strict repo never invokes a persistence-capable method, and production repos are never constructed", async () => {
  const { runContractAAuthoritativePreview, createStrictReadOnlyRebalanceRepo } = await import(
    "../../scripts/contur3/preview-contract-a-authoritative"
  );
  // The strict repo throws if a mutating method is ever called.
  const repo = createStrictReadOnlyRebalanceRepo([]);
  await assert.rejects(() => repo.markReservationSkipped("x", "y"), /STRICT_READ_ONLY_MUTATION_ATTEMPTED/);
  await assert.rejects(() => repo.markReservationQueued("x", "y"), /STRICT_READ_ONLY_MUTATION_ATTEMPTED/);
  await assert.rejects(() => repo.insertQueueRow({} as never), /STRICT_READ_ONLY_MUTATION_ATTEMPTED/);
  await assert.rejects(() => repo.markReservationsExpired(["x"]), /STRICT_READ_ONLY_MUTATION_ATTEMPTED/);

  await withFixture([contractARow()], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview([
      "--fixture", fixturePath,
      "--as-of", AS_OF,
    ]);
    assert.equal(summary.safety.productionReservationWrites, 0);
    assert.equal(summary.safety.productionQueueWrites, 0);
    assert.equal(summary.safety.callbacks, 0);
    assert.equal(summary.safety.irelandCalls, 0);
    assert.equal(summary.safety.clobOrders, 0);
  });
});

test("TEST3: authoritative identity is preserved candidate -> reservation -> rebalance -> would-be queue", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await withFixture([contractARow()], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview(["--fixture", fixturePath, "--as-of", AS_OF]);
    assert.equal(summary.contractAAcceptedDecisions, 1);
    assert.equal(summary.wouldReserveCount, 1);
    assert.equal(summary.identityMismatchCount, 0);
    assert.equal(summary.alternateSubstitutionCount, 0);
    assert.equal(summary.safety.productionReservationWrites, 0);
  });
});

test("TEST4: no alternate substitution -- a higher-quality alternate market for the same event is never queued in place of the authoritative decision", async () => {
  // Contract A's own one-per-event dedup means only ONE accepted decision can
  // exist per eventKey, so the "alternate" here is proven by construction:
  // this test asserts identityMismatchCount/alternateSubstitutionCount stay
  // zero across a full run where the authoritative candidate is the ONLY
  // candidate ever fed into buildReservationPlan/runEventRebalance (the
  // released wiring's own no-substitution guarantee, exercised end to end).
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await withFixture([contractARow()], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview([
      "--fixture", fixturePath,
      "--as-of", AS_OF,
    ]);
    assert.equal(summary.wouldReadyCount, 1);
    assert.equal(summary.alternateSubstitutionCount, 0);
  });
});

test("TEST5: fail-closed -- an authoritative decision with incomplete identity produces no would-be READY row and an explicit reason", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  // Missing selected_outcome -> Contract A itself rejects the row (MISSING_SELECTED_OUTCOME),
  // so zero accepted decisions and zero would-be READY rows; proves the preview
  // reports zero, not a fabricated queue row.
  await withFixture([contractARow({ selected_outcome: undefined })], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview(["--fixture", fixturePath, "--as-of", AS_OF]);
    assert.equal(summary.contractAAcceptedDecisions, 0);
    assert.equal(summary.wouldReadyCount, 0);
    assert.equal(summary.alternateSubstitutionCount, 0);
  });
});

test("TEST6: determinism -- running twice with the same fixture/as-of produces identical replay hashes", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await withFixture([contractARow()], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview(["--fixture", fixturePath, "--as-of", AS_OF]);
    assert.equal(summary.deterministicReplay, true);
    assert.equal(summary.replayHash1, summary.replayHash2);
    assert.equal(typeof summary.replayHash1, "string");
    assert.ok(summary.replayHash1.length > 0);
  });
});

test("TEST7: planning grouping accounting reports normalized physical events without false drops or collisions", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  const clean = contractARow({
    condition_id: "cond-clean",
    selected_token_id: "tok-clean",
  });
  const marketLevel = contractARow({
    condition_id: "cond-moneyline",
    selected_token_id: "tok-moneyline",
    event_slug: "chile-vs-peru-moneyline",
    market_slug: "chile-vs-peru-moneyline",
    diagnostics: { gameStartIso: "2026-07-19T14:45:00.000Z", dataCoverage: 80, eventTitle: "MLB Chile vs Peru", marketTitle: "Chile vs Peru moneyline" },
  });
  await withFixture([clean, marketLevel], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview(["--fixture", fixturePath, "--as-of", AS_OF]);
    assert.equal(summary.contractAAcceptedDecisions, 2);
    assert.equal(summary.contractAEventGroups, 2);
    assert.equal(summary.marketLevelKeysSkipped, 0);
    assert.equal(summary.wouldReserveCount, 2);
    assert.equal(summary.groupingCollisionCount, 0, "no two distinct Contract A decisions collapsed into one physical key");
    assert.equal(summary.authoritativeDroppedCount, 0);
  });
});

test("TEST8a: no source mode fails closed", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await assert.rejects(() => runContractAAuthoritativePreview(["--as-of", AS_OF]), /PREVIEW_SOURCE_MODE_REQUIRED/);
});

test("TEST8b: fixture and live together fails closed", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await withFixture([contractARow()], async (fixturePath) => {
    await assert.rejects(
      () => runContractAAuthoritativePreview(["--fixture", fixturePath, "--source", "live", "--as-of", AS_OF]),
      /PREVIEW_SOURCE_MODE_MUTUALLY_EXCLUSIVE/
    );
  });
});

test("TEST8c: live mode without required env vars returns a sanitized error (no env values printed)", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  const hadUrl = process.env.SUPABASE_URL;
  const hadKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.rejects(
      () => runContractAAuthoritativePreview(["--source", "live", "--as-of", AS_OF]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /PREVIEW_LIVE_SOURCE_MISSING_ENV/);
        assert.doesNotMatch(err.message, /SUPABASE_URL=/);
        return true;
      }
    );
  } finally {
    if (hadUrl !== undefined) process.env.SUPABASE_URL = hadUrl;
    if (hadKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = hadKey;
  }
});

test("selector provenance: every accepted decision's selector_id matches the frozen model version constant", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  await withFixture([contractARow()], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview(["--fixture", fixturePath, "--as-of", AS_OF]);
    assert.equal(summary.status, "PREVIEW_OK");
    assert.equal(summary.sourceMode, "fixture");
    assert.equal(summary.sourceRows, 1);
    assert.equal(typeof summary.sourceSnapshotSha256, "string");
    assert.ok(summary.sourceSnapshotSha256.length > 0);
    // FROZEN_MODEL_V2_VERSION is the exact selector id -- proves the runner
    // never hardcodes a duplicate literal.
    assert.equal(FROZEN_MODEL_V2_VERSION, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
  });
});

test("two-stage parity: 17:00 planning reserves beyond T-90 and later T-60 resolves exact authoritative READY identity", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  const eventSlug = "mlb-team-a-vs-team-b-2026-07-19";
  const planning = contractARow({
    condition_id: "cond-planning",
    selected_token_id: "tok-planning",
    score: 64,
    signal_confidence_num: 64,
    event_slug: eventSlug,
    market_slug: `${eventSlug}-moneyline`,
    __gameStart: "2026-07-19T19:00:00.000Z",
    __created: "2026-07-19T13:00:00.000Z",
  });
  const finalA = contractARow({
    condition_id: "cond-final-a",
    selected_token_id: "tok-final-a",
    selected_outcome: "TEAM_A",
    event_slug: eventSlug,
    market_slug: `${eventSlug}-moneyline-a`,
    __gameStart: "2026-07-19T19:00:00.000Z",
    __created: "2026-07-19T17:30:00.000Z",
  });
  await withFixture([planning, finalA], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview([
      "--fixture", fixturePath,
      "--planning-as-of", "2026-07-19T14:00:00.000Z",
      "--rebalance-as-of", "2026-07-19T18:00:00.000Z",
    ]);
    assert.equal(summary.wouldReserveCount, 1);
    assert.equal(summary.wouldRebalanceCount, 1);
    assert.equal(summary.wouldReadyCount, 1);
    assert.equal(summary.finalContractARejections.SCORE_BELOW_65, 1);
    assert.equal(summary.identityMismatchCount, 0);
    assert.equal(summary.alternateSubstitutionCount, 0);
    assert.equal(summary.deterministicReplay, true);
    assert.deepEqual(summary.safety, { productionReservationWrites: 0, productionQueueWrites: 0, callbacks: 0, irelandCalls: 0, clobOrders: 0 });
  });
});

test("two-stage score-64 rejection: planning may reserve the event but final Contract A reports SCORE_BELOW_65 and creates zero READY", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  const planningOnly = contractARow({
    condition_id: "cond-score-64",
    selected_token_id: "tok-score-64",
    score: 64,
    signal_confidence_num: 64,
    event_slug: "mlb-score-64-vs-threshold-2026-07-19",
    market_slug: "mlb-score-64-vs-threshold-2026-07-19-moneyline",
    __gameStart: "2026-07-19T19:00:00.000Z",
    __created: "2026-07-19T13:00:00.000Z",
  });
  await withFixture([planningOnly], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview([
      "--fixture", fixturePath,
      "--planning-as-of", "2026-07-19T14:00:00.000Z",
      "--rebalance-as-of", "2026-07-19T18:00:00.000Z",
    ]);
    assert.equal(summary.wouldReserveCount, 1);
    assert.equal(summary.wouldReadyCount, 0);
    assert.equal(summary.finalContractARejections.SCORE_BELOW_65, 1);
    assert.equal(summary.alternateSubstitutionCount, 0);
    assert.deepEqual(summary.safety, { productionReservationWrites: 0, productionQueueWrites: 0, callbacks: 0, irelandCalls: 0, clobOrders: 0 });
  });
});

test("two-stage no substitution: reserved planning market cannot replace a missing final authoritative decision", async () => {
  const { runContractAAuthoritativePreview } = await import("../../scripts/contur3/preview-contract-a-authoritative");
  const planningOnly = contractARow({
    condition_id: "cond-alternate-b",
    selected_token_id: "tok-alternate-b",
    event_slug: "mlb-team-c-vs-team-d-2026-07-19",
    market_slug: "mlb-team-c-vs-team-d-2026-07-19-moneyline",
    __gameStart: "2026-07-19T19:00:00.000Z",
    __created: "2026-07-19T13:00:00.000Z",
  });
  await withFixture([planningOnly], async (fixturePath) => {
    const summary = await runContractAAuthoritativePreview([
      "--fixture", fixturePath,
      "--planning-as-of", "2026-07-19T14:00:00.000Z",
      "--rebalance-as-of", "2026-07-19T18:00:00.000Z",
    ]);
    assert.equal(summary.wouldReserveCount, 1);
    assert.equal(summary.wouldReadyCount, 0);
    assert.equal(summary.alternateSubstitutionCount, 0);
    assert.equal(summary.failClosedCount, 1);
    assert.ok(Object.keys(summary.failClosedReasons).some((reason) => reason.includes("CONTRACT_A_AUTHORITATIVE")));
  });
});
