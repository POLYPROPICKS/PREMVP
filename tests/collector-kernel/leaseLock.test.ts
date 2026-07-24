import test from "node:test";
import assert from "node:assert/strict";
import { validateLeaseLockResult } from "../../lib/collector-kernel/leaseLock";
test("lease lock validates pure claim result contracts", () => { assert.equal(validateLeaseLockResult({ status: "CLAIMED", leaseId: "a", expiresAt: "2026-07-24T00:00:00.000Z" }).status, "CLAIMED"); assert.throws(() => validateLeaseLockResult({ status: "LOCKED" })); });
