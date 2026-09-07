import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDatabaseTimeout,
  resolveSignalProducerMode,
} from "../../lib/feed/moneyProducerMode";

test("normal producer mode is money-only and research is explicit", () => {
  assert.equal(resolveSignalProducerMode(undefined), "money");
  assert.equal(resolveSignalProducerMode(""), "money");
  assert.equal(resolveSignalProducerMode("money"), "money");
  assert.equal(resolveSignalProducerMode("research"), "research");
  assert.throws(
    () => resolveSignalProducerMode("full"),
    /INVALID_SIGNAL_PRODUCER_MODE/,
  );
});

test("database timeout telemetry recognizes provider timeout forms", () => {
  assert.equal(isDatabaseTimeout(new Error("canceling statement due to statement timeout")), true);
  assert.equal(isDatabaseTimeout(new Error("request timed out")), true);
  assert.equal(isDatabaseTimeout(new Error("postgres 57014")), true);
  assert.equal(isDatabaseTimeout(new Error("constraint violation")), false);
});
