// EXECUTOR_WALLET_STATE_V1 — canonical PREMVP wallet-observation surface tests
// (node:test via tsx):
//   node --import tsx --test tests/contur3/executorWalletState.test.ts
//
// Covers the three things the canonicalization must guarantee:
//   1. an accepted callback's wallet block is shaped into structured,
//      queryable fields (and the route wires them into the insert record);
//   2. the one canonical read returns the latest valid spendable balance;
//   3. a stale / out-of-order observation can never become wallet authority.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  deriveWalletObservationFields,
  hasWalletObservation,
  selectCurrentSpendableWalletState,
  getCurrentSpendableWalletState,
  WALLET_STATE_VERSION,
  WALLET_OBSERVATION_COLUMN_NAMES,
  type WalletObservationRow,
  type WalletStateDbPort,
} from "../../lib/executor/executorWalletState";

const root = process.cwd();

// A live-shaped accepted Ireland/Polymarket order callback (top-level
// snake_case wallet block, as proven in production).
function acceptedCallback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_id: "token-1",
    idempotency_key: "idem-1",
    condition_id: "cond-1",
    side: "Argentina",
    clob_order_id: "clob-1",
    order_status: "matched",
    success: true,
    submitted_price: 0.47,
    spendable_balance_usd: 57.840124,
    collateral_balance_usd: 61.5,
    allowance_usd: 1000000,
    wallet_observed_at: "2026-09-08T21:00:00.000Z",
    wallet_observation_lifecycle_point: "POST_SUBMIT",
    ...overrides,
  };
}

function walletRow(overrides: Partial<WalletObservationRow> = {}): WalletObservationRow {
  return {
    id: "evt-1",
    idempotency_key: "idem-1",
    clob_order_id: "clob-1",
    created_at: "2026-09-08T21:00:05.000Z",
    spendable_balance_usd: 57.840124,
    collateral_balance_usd: 61.5,
    allowance_usd: 1000000,
    wallet_observed_at: "2026-09-08T21:00:00.000Z",
    wallet_observation_lifecycle_point: "POST_SUBMIT",
    ...overrides,
  };
}

// ── 1. FOCUSED CALLBACK PERSISTENCE ────────────────────────────────────────

test("persistence: an accepted callback's wallet block is shaped into structured fields", () => {
  const fields = deriveWalletObservationFields(acceptedCallback());
  assert.equal(fields.spendable_balance_usd, 57.840124);
  assert.equal(fields.collateral_balance_usd, 61.5);
  assert.equal(fields.allowance_usd, 1000000);
  assert.equal(fields.wallet_observed_at, "2026-09-08T21:00:00.000Z");
  assert.equal(fields.wallet_observation_lifecycle_point, "POST_SUBMIT");
  assert.equal(hasWalletObservation(fields), true);
});

test("persistence: numeric-string balances and the ECONOMIC_TELEMETRY_V1 nested wallet block are both accepted", () => {
  const topLevelStrings = deriveWalletObservationFields({
    spendable_balance_usd: "55.331044",
    allowance_usd: "0",
  });
  assert.equal(topLevelStrings.spendable_balance_usd, 55.331044);
  assert.equal(topLevelStrings.allowance_usd, 0);

  const nested = deriveWalletObservationFields({
    raw_event_json: {
      economic_telemetry_v1: {
        wallet: {
          lifecycle_point: "POST_SUBMIT",
          observed_at: "2026-09-08T20:00:00Z",
          spendable_balance_usd: 59.880704,
          collateral_balance_usd: 60,
          allowance_usd: 1000000,
        },
      },
    },
  });
  assert.equal(nested.spendable_balance_usd, 59.880704);
  assert.equal(nested.collateral_balance_usd, 60);
  assert.equal(nested.wallet_observed_at, "2026-09-08T20:00:00.000Z");
  assert.equal(nested.wallet_observation_lifecycle_point, "POST_SUBMIT");
});

test("persistence: a callback with no wallet evidence yields all-null and hasWalletObservation=false (no fabrication)", () => {
  const fields = deriveWalletObservationFields({ token_id: "t", idempotency_key: "i" });
  assert.deepEqual(fields, {
    spendable_balance_usd: null,
    collateral_balance_usd: null,
    allowance_usd: null,
    wallet_observed_at: null,
    wallet_observation_lifecycle_point: null,
  });
  assert.equal(hasWalletObservation(fields), false);
});

test("persistence: garbage values never throw and never fabricate a number; unknown lifecycle -> UNKNOWN", () => {
  const fields = deriveWalletObservationFields({
    spendable_balance_usd: "not-a-number",
    collateral_balance_usd: NaN,
    wallet_observed_at: "nonsense",
    wallet_observation_lifecycle_point: "MID_FLIGHT",
  });
  assert.equal(fields.spendable_balance_usd, null);
  assert.equal(fields.collateral_balance_usd, null);
  assert.equal(fields.wallet_observed_at, null);
  assert.equal(fields.wallet_observation_lifecycle_point, "UNKNOWN");
});

test("persistence (route wiring, static source check): the order-events route derives and inserts every wallet-observation column", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.match(source, /deriveWalletObservationFields\(s\)/);
  for (const col of WALLET_OBSERVATION_COLUMN_NAMES) {
    assert.match(source, new RegExp(`${col}:\\s*wallet\\.${col}`), `route must insert ${col}`);
  }
  // additive-migration safety net so a not-yet-applied column can't 500 the callback
  assert.match(source, /PGRST204|42703/);
});

// ── 2. FOCUSED LATEST WALLET READ ─────────────────────────────────────────

test("latest read: current spendable balance is the newest observation by wallet_observed_at", async () => {
  const rows: WalletObservationRow[] = [
    walletRow({ id: "evt-a", wallet_observed_at: "2026-09-08T18:00:00.000Z", spendable_balance_usd: 59.880704 }),
    walletRow({ id: "evt-b", wallet_observed_at: "2026-09-08T21:00:00.000Z", spendable_balance_usd: 55.331044 }),
    walletRow({ id: "evt-c", wallet_observed_at: "2026-09-08T20:00:00.000Z", spendable_balance_usd: 57.840124 }),
  ];
  const port: WalletStateDbPort = { async recentWalletObservations() { return rows; } };
  const state = await getCurrentSpendableWalletState(port);
  assert.ok(state);
  assert.equal(state.version, WALLET_STATE_VERSION);
  assert.equal(state.current_spendable_balance_usd, 55.331044);
  assert.equal(state.wallet_observed_at, "2026-09-08T21:00:00.000Z");
  assert.equal(state.source_order_event.id, "evt-b");
});

test("latest read: returns null when no row carries a usable spendable observation", () => {
  const state = selectCurrentSpendableWalletState([
    walletRow({ spendable_balance_usd: null }),
    walletRow({ id: "evt-x", wallet_observed_at: null }),
  ]);
  assert.equal(state, null);
});

test("latest read: allowance_usd is surfaced for evidence but is clearly separate from spendable cash", () => {
  const state = selectCurrentSpendableWalletState([walletRow({ allowance_usd: 250000, spendable_balance_usd: 12.5 })]);
  assert.ok(state);
  assert.equal(state.current_spendable_balance_usd, 12.5);
  assert.equal(state.allowance_usd, 250000);
});

// ── 3. STALE / OUT-OF-ORDER OBSERVATION GUARD ─────────────────────────────

test("stale guard: a later-delivered callback with an OLDER wallet_observed_at never becomes wallet authority", () => {
  const authoritative = walletRow({
    id: "evt-fresh",
    wallet_observed_at: "2026-09-08T21:00:00.000Z",
    created_at: "2026-09-08T21:00:02.000Z",
    spendable_balance_usd: 55.331044,
  });
  // Arrived AFTER evt-fresh (newer created_at) but observed the wallet EARLIER.
  const stale = walletRow({
    id: "evt-stale",
    wallet_observed_at: "2026-09-08T19:30:00.000Z",
    created_at: "2026-09-08T22:00:00.000Z",
    spendable_balance_usd: 80.0,
  });
  const state = selectCurrentSpendableWalletState([authoritative, stale]);
  assert.ok(state);
  assert.equal(state.current_spendable_balance_usd, 55.331044);
  assert.equal(state.source_order_event.id, "evt-fresh");
});

test("stale guard: an exact wallet_observed_at tie is broken by created_at (last writer wins only on a true tie)", () => {
  const earlier = walletRow({ id: "evt-1", wallet_observed_at: "2026-09-08T21:00:00.000Z", created_at: "2026-09-08T21:00:01.000Z", spendable_balance_usd: 10 });
  const later = walletRow({ id: "evt-2", wallet_observed_at: "2026-09-08T21:00:00.000Z", created_at: "2026-09-08T21:00:09.000Z", spendable_balance_usd: 20 });
  const state = selectCurrentSpendableWalletState([later, earlier]);
  assert.ok(state);
  assert.equal(state.source_order_event.id, "evt-2");
  assert.equal(state.current_spendable_balance_usd, 20);
});
