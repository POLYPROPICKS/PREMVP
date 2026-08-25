import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEconomicTelemetry, mergeEconomicTelemetryMeta, readEconomicTelemetry } from "../../lib/executor/economicTelemetry";

const queue = { id: "943fb286-b92d-4d38-8924-dedc048bc297", reservation_id: "res-san-luis", condition_id: "condition-san-luis", token_id: "token-san-luis", side: "YES", idempotency_key: "idem-san-luis", stake_usd: 2.5 };
const event = { idempotency_key: "idem-san-luis", clob_order_id: "0x6f9a58fe1aa1a51b0c6c99694d65af9d0538ff922d16cc39022868df86b20b79", submitted_price: 0.46, submitted_size: 5.43 };

test("ECONOMIC_TELEMETRY_V1 keeps requested economics, ceiling, and later actual fill separately", () => {
  const initial = buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, order_status: "CONFIRMED" } });
  assert.equal(initial.requested.requested_notional_usd, 2.4978);
  assert.equal(initial.requested.authorized_stake_ceiling_usd, 2.5);
  assert.deepEqual(initial.executed.executed_shares, { value: null, evidence_state: "NOT_YET_AVAILABLE" });
  const enriched = buildEconomicTelemetry({ queue, event, prior: initial, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { execution_status: "MATCHED", executed_shares: 5.43, average_fill_price: 0.45, fee_rate_bps: 0, fee_usd_evidence_state: "NOT_RETURNED_BY_VENUE", fee_source: "VENUE_KNOWN", making_amount_evidence_state: "NOT_RETURNED_BY_VENUE", taking_amount_evidence_state: "NOT_RETURNED_BY_VENUE" } } });
  assert.equal(enriched.requested.requested_notional_usd, 2.4978);
  assert.equal(enriched.requested.authorized_stake_ceiling_usd, 2.5);
  assert.deepEqual(enriched.executed.executed_shares, { value: 5.43, evidence_state: "KNOWN" });
  assert.deepEqual(enriched.executed.average_fill_price, { value: 0.45, evidence_state: "KNOWN" });
  assert.deepEqual(enriched.executed.executed_notional_usd, { value: 2.4435, evidence_state: "KNOWN" });
  assert.deepEqual(enriched.costs.fee_rate_bps, { value: 0, evidence_state: "KNOWN" });
  assert.deepEqual(enriched.costs.fee_usd, { value: null, evidence_state: "NOT_RETURNED_BY_VENUE" });
});

test("ECONOMIC_TELEMETRY_V1 refuses inferred fills and preserves unknown wallet economics", () => {
  const telemetry = buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { execution_status: "MATCHED", fee_rate_bps: 0, fee_usd_evidence_state: "NOT_RETURNED_BY_VENUE" } } });
  assert.deepEqual(telemetry.executed.executed_shares, { value: null, evidence_state: "NOT_YET_AVAILABLE" });
  assert.deepEqual(telemetry.executed.executed_notional_usd, { value: null, evidence_state: "NOT_YET_AVAILABLE" });
  assert.deepEqual(telemetry.wallet.spendable_balance_usd, { value: null, evidence_state: "NOT_YET_AVAILABLE" });
  assert.equal(telemetry.wallet.lifecycle_point, "UNKNOWN");
});

test("venue-supplied executed notional is retained only when no contradictory fill calculation exists", () => {
  const venueOnly = buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { executed_notional_usd: 2.4435 } } });
  assert.deepEqual(venueOnly.executed.executed_notional_usd, { value: 2.4435, evidence_state: "KNOWN" });
  assert.throws(() => buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { executed_shares: 5.43, average_fill_price: 0.45, executed_notional_usd: 2.5 } } }), /EXECUTED_NOTIONAL_MISMATCH/);
});

test("current wallet snapshots cannot be relabelled as historical without capture evidence", () => {
  assert.throws(() => buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { wallet_observation_lifecycle_point: "PRE_SUBMIT", collateral_balance_usd: 12 } } }), /WALLET_LIFECYCLE_UNPROVEN/);
  const snapshot = buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { wallet_observation_lifecycle_point: "CURRENT_SNAPSHOT", wallet_observed_at: "2026-08-25T00:00:00.000Z", collateral_balance_usd: 12, allowance_usd: 9 } } });
  assert.equal(snapshot.wallet.lifecycle_point, "CURRENT_SNAPSHOT");
  assert.equal(snapshot.wallet.collateral_balance_usd.value, 12);
});

test("same identity enriches the same canonical record; strong identity conflicts fail closed", () => {
  const first = buildEconomicTelemetry({ queue, event, raw: { submitted_price: 0.46, submitted_size: 5.43 } });
  const second = buildEconomicTelemetry({ queue, event, prior: first, raw: { submitted_price: 0.46, submitted_size: 5.43, economic_telemetry_v1: { executed_shares: 5.43, average_fill_price: 0.45 } } });
  const stored = mergeEconomicTelemetryMeta({}, second);
  assert.equal(readEconomicTelemetry(stored), second);
  assert.throws(() => buildEconomicTelemetry({ queue: { ...queue, token_id: "other-token" }, event, prior: first, raw: { submitted_price: 0.46, submitted_size: 5.43 } }), /IDENTITY_CONFLICT_TOKEN_ID/);
});
