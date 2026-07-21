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
  FOUNDER_BATTLE_BATCH_STAKE_USD,
  FOUNDER_BATTLE_BATCH_RUN_ID_PREFIX,
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

test("2: every created row has stake_usd = 1, even though source rows have no stake concept at all", async () => {
  const rows = [signalRow("a"), signalRow("b")];
  const repo = makeFakeRepo(rows);
  const result = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });

  assert.equal(result.wrote_count, 2);
  for (const row of repo.queueRows) assert.equal(row.stake_usd, FOUNDER_BATTLE_BATCH_STAKE_USD);
  assert.equal(FOUNDER_BATTLE_BATCH_STAKE_USD, 1);
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
  const candidates = selectFounderBattleBatchCandidates(rows, NOW_MS, 4);
  assert.equal(candidates.length, 1);
  const row = buildFounderBattleBatchQueueRow(candidates[0], NOW_MS, 0);

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

test("10: deterministic idempotency_key prevents duplicate batch rerun for the same market", async () => {
  const rows = [signalRow("rerun-target")];
  const repo = makeFakeRepo(rows);

  const first = await runFounderBattleBatch(NOW_MS, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(first.wrote_count, 1);
  assert.equal(repo.queueRows.length, 1);

  // Rerun the batch feeder later against the exact same underlying market
  // (same condition/token/side) -- must create zero new rows.
  const second = await runFounderBattleBatch(NOW_MS + 60_000, GATE_ENV_ENABLED, { write: true }, { repo });
  assert.equal(second.wrote_count, 0);
  assert.equal(second.skipped_count, 1);
  assert.equal(repo.queueRows.length, 1, "a rerun for the same market must never create a duplicate row");
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

test("14: static proof -- this module reaches no Ireland/CLOB/callback surface", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const source = readFileSync(path.join(process.cwd(), "lib/executor/eventExecutionQueue.ts"), "utf8");
  // Scoped to the battle-batch section only, to avoid false positives from
  // unrelated code elsewhere in this large shared file.
  const sectionStart = source.indexOf("Founder battle batch feeder");
  assert.ok(sectionStart > -1);
  const section = source.slice(sectionStart);
  assert.doesNotMatch(section, /clob|placeOrder|submitOrder|order-events|queue\/mark/i);
});
