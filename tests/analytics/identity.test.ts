import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDistinctId,
  resolveDistinctId,
  DISTINCT_ID_HEADER,
  DISTINCT_ID_BODY_FIELD,
} from "../../lib/analytics/identity";
import { referralEmailProps } from "../../lib/analytics/properties";

test("sanitizeDistinctId accepts safe anonymous ids", () => {
  assert.equal(sanitizeDistinctId("0190a-uuid-like-id"), "0190a-uuid-like-id");
  assert.equal(sanitizeDistinctId("  trimmed-id  "), "trimmed-id");
});

test("sanitizeDistinctId rejects unsafe / PII / malformed values", () => {
  // Email (PII) must never be accepted as a distinct id.
  assert.equal(sanitizeDistinctId("user@example.com"), null);
  assert.equal(sanitizeDistinctId(""), null);
  assert.equal(sanitizeDistinctId("   "), null);
  assert.equal(sanitizeDistinctId(null), null);
  assert.equal(sanitizeDistinctId(undefined), null);
  assert.equal(sanitizeDistinctId(12345), null);
  // Over-length values rejected.
  assert.equal(sanitizeDistinctId("x".repeat(201)), null);
});

test("resolveDistinctId prefers body field, falls back to header", () => {
  const headers = new Headers({ [DISTINCT_ID_HEADER]: "header-id" });
  assert.equal(
    resolveDistinctId({ body: { [DISTINCT_ID_BODY_FIELD]: "body-id" }, headers }),
    "body-id"
  );
  assert.equal(resolveDistinctId({ body: {}, headers }), "header-id");
  assert.equal(resolveDistinctId({ body: null, headers }), "header-id");
});

test("resolveDistinctId returns null when nothing safe is present", () => {
  assert.equal(resolveDistinctId({ body: {}, headers: new Headers() }), null);
  // An email smuggled into either source is rejected.
  const headers = new Headers({ [DISTINCT_ID_HEADER]: "a@b.com" });
  assert.equal(
    resolveDistinctId({ body: { [DISTINCT_ID_BODY_FIELD]: "x@y.com" }, headers }),
    null
  );
});

test("referralEmailProps captures only presence, never the raw email", () => {
  assert.deepEqual(referralEmailProps("someone@example.com"), { has_email: true });
  assert.deepEqual(referralEmailProps(""), { has_email: false });
  assert.deepEqual(referralEmailProps(null), { has_email: false });
  // The raw address/domain must never appear in the serialized properties.
  const serialized = JSON.stringify(referralEmailProps("private.user@secret-domain.io"));
  assert.ok(!serialized.includes("private.user"));
  assert.ok(!serialized.includes("secret-domain"));
  assert.ok(!serialized.includes("@"));
});
