import test from "node:test";
import assert from "node:assert/strict";
import { transitionRunLedger } from "../../lib/collector-kernel/runLedger";
const run = { state: "RUNNING" as const, sourceContractId: "source", sourceContractHash: "hash", gitSha: "sha" };
test("run ledger permits only explicit state transitions", () => { assert.equal(transitionRunLedger(run, "SUCCEEDED").state, "SUCCEEDED"); assert.throws(() => transitionRunLedger({ ...run, state: "FAILED" }, "RUNNING")); });
