import test from "node:test";
import assert from "node:assert/strict";
import { validateTrace } from "../../lib/collector-kernel/trace";
test("trace rejects raw payloads and validates safe stage metrics", () => {
  assert.equal(validateTrace({ stage: "plan", inputCount: 0, outputCount: 1, targetIds: ["id"] }).stage, "plan");
  assert.throws(() => validateTrace({ stage: "", inputCount: -1, rawPayload: {} }));
});
