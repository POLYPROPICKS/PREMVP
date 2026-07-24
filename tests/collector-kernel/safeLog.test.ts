import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeLogFields } from "../../lib/collector-kernel/safeLog";
test("safe log redacts sensitive values while preserving counts", () => {
  const value = sanitizeLogFields({ status: "FAILED", count: 2, Authorization: "Bearer abc", nested: { SUPABASE_SERVICE_ROLE_KEY: "secret" } });
  assert.deepEqual(value, { status: "FAILED", count: 2, Authorization: "[REDACTED]", nested: { SUPABASE_SERVICE_ROLE_KEY: "[REDACTED]" } });
});
