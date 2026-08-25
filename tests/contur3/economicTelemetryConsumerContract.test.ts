import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const contract = JSON.parse(readFileSync(path.join(root, "docs/contracts/ECONOMIC_TELEMETRY_V1.consumer-contract.schema.json"), "utf8"));

test("portable economic telemetry contract preserves deployed identity, required economics, and evidence enums", () => {
  assert.equal(contract["x-contract-version"], "1.0.0");
  assert.deepEqual(contract["x-endpoint"], { method: "POST", path: "/api/executor/order-events", required_header: "x-executor-secret" });
  assert.deepEqual(contract.required, ["queue_id", "reservation_id", "condition_id", "token_id", "side", "idempotency_key", "clob_order_id", "stake_usd", "submitted_price", "submitted_size"]);
  assert.deepEqual(contract.$defs.evidenceState.enum, ["KNOWN", "NOT_RETURNED_BY_VENUE", "NOT_YET_AVAILABLE", "NOT_APPLICABLE"]);
  assert.deepEqual(contract.$defs.economicTelemetryInput.properties.wallet_observation_lifecycle_point.enum, ["PRE_SUBMIT", "POST_SUBMIT", "CURRENT_SNAPSHOT", "UNKNOWN"]);
});

test("portable contract remains tied to the deployed validator and deterministic route responses", () => {
  const validator = readFileSync(path.join(root, "lib/executor/economicTelemetry.ts"), "utf8");
  const route = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.match(validator, /ECONOMIC_TELEMETRY_VERSION = "ECONOMIC_TELEMETRY_V1"/);
  assert.match(validator, /assertSameIdentity/);
  assert.match(validator, /ECONOMIC_TELEMETRY_EXECUTED_NOTIONAL_MISMATCH/);
  assert.match(validator, /ECONOMIC_TELEMETRY_WALLET_LIFECYCLE_UNPROVEN/);
  assert.match(validator, /readPersistedEconomicTelemetry/);
  assert.match(route, /case "REJECTED_QUEUE_ROW_NOT_FOUND":\s*return NextResponse\.json\(\{ success: false, error: "QUEUE_ROW_NOT_FOUND" \}, \{ status: 404 \}\)/);
  assert.match(route, /\.select\("executor_meta"\)/);
  assert.match(route, /readPersistedEconomicTelemetry\(/);
  assert.match(route, /economic_telemetry: economicTelemetry/);
});
