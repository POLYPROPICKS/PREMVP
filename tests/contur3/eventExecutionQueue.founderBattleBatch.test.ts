// Contur3 founder battle batch feeder tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Founder-approved batch feeder: reads generated_signal_pairs directly (NOT
// buildFireModelCandidates/Contract A) and creates 2-4 fresh READY
// event_execution_queue rows, each stake_usd=1, for Ireland's batch runner.
// This module never imports or reaches any Ireland/callback/CLOB surface --
// through injected in-memory repo ports, no live Supabase, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runFounderBattleBatch,
  validateFounderBattleBatchGate,
  selectFounderBattleBatchCandidates,
  buildFounderBattleBatchQueueRow,
  computeFounderBattleBatchPriceCap,
  resolveFounderBattleBatchTitle,
  FOUNDER_BATTLE_BATCH_STAKE_USD,
  FOUNDER_BATTLE_BATCH_RUN_ID_PREFIX,
  FOUNDER_BATTLE_BATCH_PRICE_CAP_MIN,
  FOUNDER_BATTLE_BATCH_PRICE_CAP_MAX,
  FOUNDER_BATTLE_BATCH_BLOCKING_STATUSES,
  type BattleBatchRepoPort,
  type RawSignalPairRow,
} from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const GATE_ENV_ENABLED = { FOUNDER_BATTLE_BATCH_MODE: "YES" as const };

function signalRow(id: string, overrides: Partial<RawSignalPairRow> = {}): RawSignalPairRow {
  return {
    id,
    event_slug: `evt-${id}`,
    market_slug: `Market ${id}`,
    condition_id: `cond-${id}`,
    selected_outcome: `Outcome-${id}`,
    selected_token_id: `token-${id}`,
    entry_price_num: 0.42,
    signal_confidence_num: 70,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-21T20:00:00.000Z",
    diagnostics: { gameStartIso: new Date(NOW_MS + 60 * 60_000).toISOString() }, // +1h, inside 10m-14h window
    signal_result: null,
    premium_signal: null,
    market_source: null,
    ...overrides,
  };
}

function makeFakeRepo(rows: RawSignalPairRow[]): BattleBatchRepoPort & { queueRows: EventExecutionQueueRow[] } {
  const queueRows: EventExecutionQueueRow[] = [];
  return {
    queueRows,
    async fetchSignalPairs() {
      return rows;
    },
    async findBlockingQueueRowByIdentity(conditionId, tokenId, side) {
      return queueRows.filter(
        (r) =>
          r.condition_id === conditionId &&
          r.token_id === tokenId &&
          r.side === side &&
          ["READY", "CLAIMED", "SENT", "EXECUTED"].includes(r.status)
      );
    },
    async findQueueRowByIdempotencyKey(key) {
      return queueRows.find((r) => r.idempotency_key === key) ?? null;
    },
    async insertQueueRow(row) {
      queueRows.push({ ...row, id: `queue-${queueRows.length + 1}` });
    },
  };
}

test("1: creates 2-4 READY rows from fresh generated_signal_pairs", async () => {
  const rows = [signalRow("a"), signalRow("b"), signalRow("c")];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.kind, "CREATED");
  assert.equal(result.wrote_count, 3);
  assert.equal(repo.queueRows.length, 3);
  for (const row of repo.queueRows) assert.equal(row.status, "READY");
});

test("2: every created row has stake_usd = 1.10, even though source rows have no stake concept at all", async () => {
  const rows = [signalRow("a"), signalRow("b")];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 2);
  for (const row of repo.queueRows) assert.equal(row.stake_usd, FOUNDER_BATTLE_BATCH_STAKE_USD);
  assert.equal(FOUNDER_BATTLE_BATCH_STAKE_USD, 1.1);
});

test("3: excludes events that have already started and events within the final 3 minutes", async () => {
  const rows = [
    signalRow("already-started", { diagnostics: { gameStartIso: new Date(NOW_MS - 60_000).toISOString() } }),
    signalRow("within-3min", { diagnostics: { gameStartIso: new Date(NOW_MS + 2 * 60_000).toISOString() } }),
    signalRow("valid", { diagnostics: { gameStartIso: new Date(NOW_MS + 60 * 60_000).toISOString() } }),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-valid");
});

test("3b: excludes events starting less than 10 minutes from now, and more than 14 hours from now", async () => {
  const rows = [
    signalRow("too-soon", { diagnostics: { gameStartIso: new Date(NOW_MS + 5 * 60_000).toISOString() } }),
    signalRow("too-far", { diagnostics: { gameStartIso: new Date(NOW_MS + 15 * 60 * 60_000).toISOString() } }),
    signalRow("valid", { diagnostics: { gameStartIso: new Date(NOW_MS + 12 * 60 * 60_000).toISOString() } }),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-valid");
});

test("4: excludes stale/expired signal rows (signal_result already set, or missing identity fields)", async () => {
  const rows = [
    signalRow("resolved", { signal_result: "WON" }),
    signalRow("no-condition", { condition_id: null }),
    signalRow("no-token", { selected_token_id: null }),
    signalRow("no-outcome", { selected_outcome: null }),
    signalRow("low-confidence", { signal_confidence_num: 40 }),
    signalRow("bad-price", { entry_price_num: 0.9 }),
    signalRow("wrong-formula", { metric_formula_version: "some-other-version" }),
    signalRow("valid"),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-valid");
});

test("5: deduplicates rows sharing the same (condition_id, selected_token_id, selected_outcome)", async () => {
  const rows = [
    signalRow("dup1", { condition_id: "cond-x", selected_token_id: "token-x", selected_outcome: "Side-X", created_at: "2026-07-21T09:00:00.000Z" }),
    signalRow("dup2", { condition_id: "cond-x", selected_token_id: "token-x", selected_outcome: "Side-X", created_at: "2026-07-21T11:00:00.000Z" }),
    signalRow("distinct"),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 2, "the duplicate identity pair must only produce one row, plus the distinct one");
  const condIds = repo.queueRows.map((r) => r.condition_id).sort();
  assert.deepEqual(condIds, ["cond-distinct", "cond-x"]);
});

test("6: does not require exactly one candidate -- zero, one, or many are all valid outcomes", async () => {
  const zeroRepo = makeFakeRepo([]);
  const zeroResult = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo: zeroRepo });
  assert.equal(zeroResult.kind, "NO_SAFE_CANDIDATES");
  assert.equal(zeroResult.wrote_count, 0);

  const oneRepo = makeFakeRepo([signalRow("solo")]);
  const oneResult = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo: oneRepo });
  assert.equal(oneResult.kind, "CREATED");
  assert.equal(oneResult.wrote_count, 1);

  const manyRepo = makeFakeRepo([signalRow("m1"), signalRow("m2"), signalRow("m3"), signalRow("m4"), signalRow("m5")]);
  const manyResult = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo: manyRepo });
  assert.equal(manyResult.kind, "CREATED");
  assert.equal(manyResult.wrote_count, 4, "must cap at the absolute max of 4 even with 5 eligible candidates");
});

test("7: fails closed unless the explicit founder batch env gate is enabled", async () => {
  const rows = [signalRow("a"), signalRow("b")];

  const disabledRepo = makeFakeRepo(rows);
  const disabledResult = await runFounderBattleBatch(NOW_MS, {}, { write: true }, { repo: disabledRepo });
  assert.equal(disabledResult.kind, "BLOCKED_GATE_DISABLED");
  assert.equal(disabledResult.wrote_count, 0);
  assert.equal(disabledRepo.queueRows.length, 0);

  const wrongValueRepo = makeFakeRepo(rows);
  const wrongValueResult = await runFounderBattleBatch(
    NOW_MS,
    { FOUNDER_BATTLE_BATCH_MODE: "yes" },
    { write: true },
    { repo: wrongValueRepo }
  );
  assert.equal(wrongValueResult.kind, "BLOCKED_GATE_DISABLED");
  assert.equal(wrongValueRepo.queueRows.length, 0);

  // Stake override attempt via env must also fail closed, never silently ignored.
  const stakeOverrideResult = await runFounderBattleBatch(
    NOW_MS,
    { FOUNDER_BATTLE_BATCH_MODE: "YES", FOUNDER_BATTLE_BATCH_STAKE_USD: "5" },
    { write: true },
    { repo: makeFakeRepo(rows) }
  );
  assert.equal(stakeOverrideResult.kind, "BLOCKED_GATE_DISABLED");
  assert.equal(stakeOverrideResult.reason, "FOUNDER_BATTLE_BATCH_STAKE_OVERRIDE_NOT_ALLOWED");

  const enabledResult = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo: makeFakeRepo(rows) });
  assert.equal(enabledResult.kind, "CREATED");
});

test("8: never selects/reuses old event_execution_queue READY rows as a candidate source -- BattleBatchRepoPort has no bulk-queue-read method at all", async () => {
  // The port surface itself proves this: fetchSignalPairs() reads only
  // generated_signal_pairs; the only two queue-table reads are narrow,
  // identity-scoped lookups (findBlockingQueueRowByIdentity,
  // findQueueRowByIdempotencyKey) used purely for duplicate protection, never
  // to source candidates.
  let identityLookups = 0;
  let idempotencyLookups = 0;
  const repo: BattleBatchRepoPort = {
    async fetchSignalPairs() {
      return [signalRow("a")];
    },
    async findBlockingQueueRowByIdentity() {
      identityLookups += 1;
      return [];
    },
    async findQueueRowByIdempotencyKey() {
      idempotencyLookups += 1;
      return null;
    },
    async insertQueueRow() {},
  };
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 1);
  assert.equal(identityLookups, 1, "exactly one narrow identity-scoped lookup per candidate, never a bulk read");
  assert.equal(idempotencyLookups, 1);
});

test("9: builds rows using only live-schema-compatible event_execution_queue columns", () => {
  const rows = [signalRow("schema-check")];
  const { candidates } = selectFounderBattleBatchCandidates(rows, NOW_MS, 4);
  assert.equal(candidates.length, 1);
  const row = buildFounderBattleBatchQueueRow(candidates[0], NOW_MS, 0, new Date(NOW_MS).toISOString());

  const LIVE_COLUMNS = [
    "reservation_id", "plan_run_id", "rebalance_run_id", "match_family_key", "event_title",
    "event_slug", "sport", "league", "game_start_iso", "condition_id", "token_id", "side",
    "market_slug", "market_title", "market_family", "score", "coverage", "tier", "stake_usd",
    "preferred_entry_iso", "latest_entry_iso", "selection_rank", "selection_reason", "status",
    "order_key", "idempotency_key", "diagnostics",
  ];
  for (const key of Object.keys(row)) {
    assert.ok(LIVE_COLUMNS.includes(key), `field "${key}" is not a live event_execution_queue column`);
  }
  assert.equal(row.tier, "TIER1");
  assert.equal(row.status, "READY");
  assert.ok(row.rebalance_run_id.startsWith(FOUNDER_BATTLE_BATCH_RUN_ID_PREFIX));
  assert.notEqual(row.rebalance_run_id, "founder-live-order-20260721-001", "must never reuse the single-test CONTROLLED_LIVE_TEST_ID");
});

test("10: an active (READY) row for the same market blocks a rerun -- identity-based blocking, independent of idempotency_key salting", async () => {
  const rows = [signalRow("rerun-target")];
  const repo = makeFakeRepo(rows);

  const first = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(first.wrote_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].status, "READY");

  // Rerun the batch feeder later against the exact same underlying market
  // (same condition/token/side) while the first row is still READY -- must
  // create zero new rows, blocked by the identity check (not idempotency_key,
  // which now differs across runs by design -- see tests 9b/9c below).
  const second = await runFounderBattleBatch(NOW_MS + 60_000, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(second.wrote_count, 0);
  assert.equal(second.skipped_count, 1);
  assert.equal(second.skipped_reasons[0].reason, "IDENTITY_ALREADY_QUEUED");
  assert.equal(repo.queueRows.length, 1, "a rerun while the row is still active must never create a duplicate row");
});

test("11: dry-run mode performs zero writes", async () => {
  const rows = [signalRow("a"), signalRow("b")];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: false }, { repo });

  assert.equal(result.kind, "CREATED");
  assert.equal(result.wrote_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.created_rows.length, 2, "dry-run still reports what WOULD have been created");
});

test("12: validateFounderBattleBatchGate defaults max to 4 when unset, and clamps an oversized configured max down to the absolute cap of 4", () => {
  const defaultGate = validateFounderBattleBatchGate({ FOUNDER_BATTLE_BATCH_MODE: "YES" });
  assert.equal(defaultGate.ok, true);
  if (defaultGate.ok) assert.equal(defaultGate.max, 4);

  const oversizedGate = validateFounderBattleBatchGate({ FOUNDER_BATTLE_BATCH_MODE: "YES", FOUNDER_BATTLE_BATCH_MAX: "100" });
  assert.equal(oversizedGate.ok, true);
  if (oversizedGate.ok) assert.equal(oversizedGate.max, 4, "must never allow more than 4 regardless of configured max");
});

test("13: an identity already in a blocking status (READY/CLAIMED/SENT/EXECUTED) is skipped, never duplicated", async () => {
  const rows = [signalRow("already-queued", { condition_id: "cond-dup", selected_token_id: "token-dup", selected_outcome: "Side-dup" })];
  const repo: BattleBatchRepoPort & { queueRows: EventExecutionQueueRow[] } = {
    queueRows: [],
    async fetchSignalPairs() {
      return rows;
    },
    async findBlockingQueueRowByIdentity(conditionId, tokenId, side) {
      if (conditionId === "cond-dup" && tokenId === "token-dup" && side === "Side-dup") {
        return [{ id: "existing-1" } as EventExecutionQueueRow];
      }
      return [];
    },
    async findQueueRowByIdempotencyKey() {
      return null;
    },
    async insertQueueRow(row) {
      this.queueRows.push(row);
    },
  };
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.skipped_reasons[0].reason, "IDENTITY_ALREADY_QUEUED");
});

test("14: static proof -- this module's CODE (not prose comments) reaches no Ireland/CLOB/callback surface", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const source = readFileSync(path.join(process.cwd(), "lib/executor/eventExecutionQueue.ts"), "utf8");
  // Scoped to the battle-batch section only, to avoid false positives from
  // unrelated code elsewhere in this large shared file. Comments are stripped
  // first -- this section's prose legitimately explains WHY the stake buffer
  // exists by referencing "Polymarket CLOB minimum order size", which must
  // not itself trip a code-reaches-CLOB false positive.
  const sectionStart = source.indexOf("Founder battle batch feeder");
  assert.ok(sectionStart > -1);
  const section = source
    .slice(sectionStart)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(section, /clob|placeOrder|submitOrder|order-events|queue\/mark/i);
});

// ── Execution-fix regression: min-size buffer, price cap, retry-after-rejection ──
//
// Production incident (per prompt): $1.00 nominal stake rounded to an
// effective marketable-BUY amount slightly below Polymarket CLOB's $1 minimum
// order size ($0.9963, $0.9994 observed), and the feeder omitted the
// price-cap execution contract Ireland's order submission expects.

/** Seeds an existing queue row for a given market identity with an arbitrary status, using makeFakeRepo's real (non-mocked) status-filtering logic. */
function seedExistingRow(repo: ReturnType<typeof makeFakeRepo>, conditionId: string, tokenId: string, side: string, status: string) {
  // The live status column is `text` (no DB enum), so a downstream mark like
  // "ORDER_REJECTED" is representable even though it's not one of the
  // TypeScript QueueStatus literals this codebase's own writers use.
  repo.queueRows.push({
    id: `existing-${status}`,
    reservation_id: null,
    plan_run_id: "prior-run",
    rebalance_run_id: "prior-run-id",
    match_family_key: `battle:${conditionId}`,
    event_title: null,
    event_slug: null,
    sport: null,
    league: null,
    game_start_iso: new Date(NOW_MS + 60 * 60_000).toISOString(),
    condition_id: conditionId,
    token_id: tokenId,
    side,
    market_slug: null,
    market_title: null,
    market_family: null,
    score: null,
    coverage: null,
    tier: "TIER1",
    stake_usd: FOUNDER_BATTLE_BATCH_STAKE_USD,
    preferred_entry_iso: new Date(NOW_MS).toISOString(),
    latest_entry_iso: new Date(NOW_MS + 30 * 60_000).toISOString(),
    selection_rank: 1,
    selection_reason: "prior attempt",
    status,
    order_key: `${conditionId}:${tokenId}:${side}`,
    idempotency_key: "prior-idempotency-key",
    diagnostics: {},
  } as unknown as EventExecutionQueueRow);
}

test("T1: new rows include diagnostics.price_cap, diagnostics.submitted_price, diagnostics.max_entry_price", async () => {
  const rows = [signalRow("pricecap", { entry_price_num: 0.4 })];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 1);
  const diag = repo.queueRows[0].diagnostics as Record<string, unknown>;
  assert.equal(diag.price_cap, 0.5);
  assert.equal(diag.submitted_price, 0.4);
  assert.equal(diag.max_entry_price, 0.5);
});

test("T2: price cap is entry_price_num + 0.10, clamped to a ceiling of 0.75", () => {
  assert.equal(computeFounderBattleBatchPriceCap(0.4), 0.5);
  assert.equal(computeFounderBattleBatchPriceCap(0.7), FOUNDER_BATTLE_BATCH_PRICE_CAP_MAX, "0.7 + 0.10 = 0.80 must clamp down to the 0.75 ceiling");
  assert.equal(computeFounderBattleBatchPriceCap(0.05), FOUNDER_BATTLE_BATCH_PRICE_CAP_MIN, "an implausibly low price still clamps up to the 0.20 floor");
});

test("T3: a candidate with a missing/non-finite entry_price_num is skipped with MISSING_ENTRY_PRICE_FOR_PRICE_CAP, never silently defaulted", async () => {
  const rows = [
    signalRow("no-price", { entry_price_num: null as unknown as number }),
    signalRow("nan-price", { entry_price_num: Number.NaN }),
    signalRow("valid-price", { entry_price_num: 0.4 }),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-valid-price");
  const priceReasons = result.skipped_reasons.filter((s) => s.reason === "MISSING_ENTRY_PRICE_FOR_PRICE_CAP");
  assert.equal(priceReasons.length, 2, "both the null and NaN price rows must be explicitly tracked, not silently dropped");
});

test("T4: an existing row in READY status blocks a new row for the same market", async () => {
  const rows = [signalRow("blk", { condition_id: "cond-blk", selected_token_id: "token-blk", selected_outcome: "Side-blk" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-blk", "token-blk", "Side-blk", "READY");

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(result.skipped_reasons.some((s) => s.reason === "IDENTITY_ALREADY_QUEUED"), true);
});

test("T5: an existing row in CLAIMED status blocks a new row for the same market", async () => {
  const rows = [signalRow("blk", { condition_id: "cond-blk", selected_token_id: "token-blk", selected_outcome: "Side-blk" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-blk", "token-blk", "Side-blk", "CLAIMED");

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(result.skipped_reasons.some((s) => s.reason === "IDENTITY_ALREADY_QUEUED"), true);
});

test("T6: an existing row in SENT status blocks a new row for the same market", async () => {
  const rows = [signalRow("blk", { condition_id: "cond-blk", selected_token_id: "token-blk", selected_outcome: "Side-blk" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-blk", "token-blk", "Side-blk", "SENT");

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(result.skipped_reasons.some((s) => s.reason === "IDENTITY_ALREADY_QUEUED"), true);
});

test("T7: an existing row in EXECUTED status blocks a new row for the same market", async () => {
  const rows = [signalRow("blk", { condition_id: "cond-blk", selected_token_id: "token-blk", selected_outcome: "Side-blk" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-blk", "token-blk", "Side-blk", "EXECUTED");

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(result.skipped_reasons.some((s) => s.reason === "IDENTITY_ALREADY_QUEUED"), true);
});

test("T8: an existing row in ORDER_REJECTED status does NOT block a retry row for the same market", async () => {
  const rows = [signalRow("retry", { condition_id: "cond-retry", selected_token_id: "token-retry", selected_outcome: "Side-retry" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-retry", "token-retry", "Side-retry", "ORDER_REJECTED");
  assert.equal(
    (FOUNDER_BATTLE_BATCH_BLOCKING_STATUSES as readonly string[]).includes("ORDER_REJECTED"),
    false,
    "ORDER_REJECTED must not be a blocking status"
  );

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 1, "a rejected prior attempt must not prevent a corrected retry");
  assert.equal(repo.queueRows.filter((r) => r.condition_id === "cond-retry").length, 2, "the rejected row and the new retry row both exist");
});

test("T9: a retry row after a rejection gets a fresh idempotency_key, distinct from the rejected row's key", async () => {
  const rows = [signalRow("retry2", { condition_id: "cond-retry2", selected_token_id: "token-retry2", selected_outcome: "Side-retry2" })];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-retry2", "token-retry2", "Side-retry2", "ORDER_REJECTED");
  const rejectedKey = repo.queueRows[0].idempotency_key;

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 1);
  const retryRow = repo.queueRows.find((r) => r.id !== "existing-ORDER_REJECTED");
  assert.notEqual(retryRow?.idempotency_key, rejectedKey);

  // A second retry at a later time also gets yet another fresh key.
  const later = await runFounderBattleBatch(NOW_MS + 5 * 60_000, GATE_ENV_ENABLED, { write: true }, { repo: makeFakeRepo(rows) });
  assert.notEqual(later.created_rows[0]?.idempotency_key, retryRow?.idempotency_key);
});

test("T10: batch execution is resilient -- a skipped/duplicate candidate does not prevent later candidates in the same batch from being created", async () => {
  const rows = [
    signalRow("blocked", { condition_id: "cond-blocked", selected_token_id: "token-blocked", selected_outcome: "Side-blocked" }),
    signalRow("ok1"),
    signalRow("ok2"),
  ];
  const repo = makeFakeRepo(rows);
  seedExistingRow(repo, "cond-blocked", "token-blocked", "Side-blocked", "READY");

  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(result.wrote_count, 2, "the two unblocked candidates must still be created despite the first being skipped");
  assert.equal(result.skipped_reasons.some((s) => s.reason === "IDENTITY_ALREADY_QUEUED"), true);
});

test("T11: FOUNDER_BATTLE_BATCH_STAKE_USD env override above 1.10 fails closed; \"1.1\"/\"1.10\" are accepted (no-op, still 1.10)", async () => {
  const rows = [signalRow("a")];

  const tooHigh = await runFounderBattleBatch(NOW_MS, { FOUNDER_BATTLE_BATCH_MODE: "YES", FOUNDER_BATTLE_BATCH_STAKE_USD: "1.20" }, { write: true }, { repo: makeFakeRepo(rows) });
  assert.equal(tooHigh.kind, "BLOCKED_GATE_DISABLED");
  assert.equal(tooHigh.reason, "FOUNDER_BATTLE_BATCH_STAKE_OVERRIDE_NOT_ALLOWED");

  const exact = await runFounderBattleBatch(NOW_MS, { FOUNDER_BATTLE_BATCH_MODE: "YES", FOUNDER_BATTLE_BATCH_STAKE_USD: "1.1" }, { write: true }, { repo: makeFakeRepo(rows) });
  assert.equal(exact.kind, "CREATED");

  const exactAlt = await runFounderBattleBatch(NOW_MS, { FOUNDER_BATTLE_BATCH_MODE: "YES", FOUNDER_BATTLE_BATCH_STAKE_USD: "1.10" }, { write: true }, { repo: makeFakeRepo(rows) });
  assert.equal(exactAlt.kind, "CREATED");
});

// ── Bug 2: human-readable battle-batch titles ───────────────────────────────
//
// Production issue: event_title/market_title often displayed the generic
// "Live market activity" placeholder instead of a human-readable event name,
// even when event_slug/market_slug contained real context.

test("Title-1: a prose-like event_slug becomes the display title instead of a generic placeholder", () => {
  const row = signalRow("kf", {
    event_slug: "KF Víkingur vs. MH Hapoel Be'er Sheva: 1st Half O/U 0.5",
    market_slug: "Live market activity",
  });
  assert.equal(resolveFounderBattleBatchTitle(row), "KF Víkingur vs MH Hapoel Be'er Sheva: 1st Half O/U 0.5");
});

test("Title-2: a prose-like event_slug is preserved as readable", () => {
  const row = signalRow("larne", {
    event_slug: "Larne FC vs. FK Crvena zvezda: 1st Half O/U 0.5",
    market_slug: "Live market activity",
  });
  assert.equal(resolveFounderBattleBatchTitle(row), "Larne FC vs FK Crvena zvezda: 1st Half O/U 0.5");
});

test("Title-3: a full-match row with a kebab-case event_slug falls back to the human-readable market_slug", () => {
  const row = signalRow("dodgers", {
    event_slug: "mlb-lad-phi-2026-07-22",
    market_slug: "Los Angeles Dodgers vs. Philadelphia Phillies",
  });
  assert.equal(resolveFounderBattleBatchTitle(row), "Los Angeles Dodgers vs Philadelphia Phillies");
});

test("Title-4: a generic market_slug ('Live market activity') is used only when no better title exists -- resolves to null, never the generic string itself", () => {
  const row = signalRow("generic", {
    event_slug: "evt-generic", // kebab-case, not prose-like
    market_slug: "Live market activity",
    diagnostics: { gameStartIso: new Date(NOW_MS + 60 * 60_000).toISOString() },
    premium_signal: null,
    market_source: null,
  });
  assert.equal(resolveFounderBattleBatchTitle(row), null, "must never return the generic placeholder itself");
});

test("Title-5: a title from premium_signal/market_source is preferred over a generic market_slug when event_slug is not prose-like", () => {
  const row = signalRow("premium", {
    event_slug: "evt-premium",
    market_slug: "Live market activity",
    premium_signal: { eventTitle: "Real Madrid vs Barcelona: Full Match" },
  });
  assert.equal(resolveFounderBattleBatchTitle(row), "Real Madrid vs Barcelona: Full Match");
});

test("Title-6: the resolved title is used for BOTH event_title and market_title on the built row, and no live-schema-incompatible fields are produced", () => {
  const row = signalRow("schema", { event_slug: "Team X vs Team Y: Full Match", market_slug: "Live market activity" });
  const { candidates } = selectFounderBattleBatchCandidates([row], NOW_MS, 4);
  assert.equal(candidates.length, 1);
  const built = buildFounderBattleBatchQueueRow(candidates[0], NOW_MS, 0, new Date(NOW_MS).toISOString());

  assert.equal(built.event_title, "Team X vs Team Y: Full Match");
  assert.equal(built.market_title, "Team X vs Team Y: Full Match");
  assert.notEqual(built.event_title, "Live market activity");
  assert.notEqual(built.market_title, "Live market activity");

  const LIVE_COLUMNS = [
    "reservation_id", "plan_run_id", "rebalance_run_id", "match_family_key", "event_title",
    "event_slug", "sport", "league", "game_start_iso", "condition_id", "token_id", "side",
    "market_slug", "market_title", "market_family", "score", "coverage", "tier", "stake_usd",
    "preferred_entry_iso", "latest_entry_iso", "selection_rank", "selection_reason", "status",
    "order_key", "idempotency_key", "diagnostics",
  ];
  for (const key of Object.keys(built)) {
    assert.ok(LIVE_COLUMNS.includes(key), `field "${key}" is not a live event_execution_queue column`);
  }
});

test("Title-7: stake, price cap, and max batch size are unaffected by the title fix", async () => {
  const rows = [
    signalRow("t1", { event_slug: "Team A vs Team B: Full Match", entry_price_num: 0.4 }),
    signalRow("t2", { event_slug: "Team C vs Team D: Full Match" }),
    signalRow("t3", { event_slug: "Team E vs Team F: Full Match" }),
    signalRow("t4", { event_slug: "Team G vs Team H: Full Match" }),
    signalRow("t5", { event_slug: "Team I vs Team J: Full Match" }),
  ];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 4, "max batch size remains 4");
  for (const row of repo.queueRows) {
    assert.equal(row.stake_usd, FOUNDER_BATTLE_BATCH_STAKE_USD);
    const diag = row.diagnostics as Record<string, unknown>;
    assert.ok(typeof diag.price_cap === "number");
  }
});
