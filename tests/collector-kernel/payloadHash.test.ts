import test from "node:test";
import assert from "node:assert/strict";
import { hashCanonicalPayload } from "../../lib/collector-kernel/payloadHash";
test("payload hash canonicalizes objects but not arrays", () => {
  assert.equal(hashCanonicalPayload({ b: 2, a: [1, 2], n: null }), hashCanonicalPayload({ n: null, a: [1, 2], b: 2 }));
  assert.notEqual(hashCanonicalPayload([1, 2]), hashCanonicalPayload([2, 1])); assert.throws(() => hashCanonicalPayload(undefined));
});
