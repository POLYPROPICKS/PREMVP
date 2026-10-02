// A process selected as PROD_SHADOW via the runtime selector must refuse to hand an executable
// instruction to the executor. Selector env is set BEFORE the first getActiveContour() call (the
// selection is pinned per process, so this lives in its own test file / process). Dummy values only;
// the 403 is returned before any Supabase query, so no network is touched.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "PROD_SHADOW";
process.env.SHADOW_EXECUTOR_CANDIDATES_SECRET = "shadow-secret-placeholder";
process.env.SHADOW_SUPABASE_URL = "http://shadow.invalid";
process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY = "shadow-key-placeholder";
delete process.env.EXECUTOR_CANDIDATES_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

test("selector env pins the process to PROD_SHADOW before any consumer runs", async () => {
  const { getActiveContour } = await import("../../lib/constructor/registry");
  const c = getActiveContour();
  assert.equal(c.profile.contourId, "PROD_SHADOW");
  assert.equal(c.profile.capabilities.moneyMovement, "disabled");
  process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "DEV_LIVE";
  assert.equal(getActiveContour(), c, "later env changes cannot re-select inside a running process");
  process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "PROD_SHADOW";
});

test("passive process: queue handoff is 401 without the shadow secret and 403 (blocked) with it", async () => {
  const { GET } = await import("../../app/api/executor/queue/route");
  const url = "http://localhost/api/executor/queue";

  const noSecret = await GET(new Request(url) as never);
  assert.equal(noSecret.status, 401);

  const withSecret = await GET(
    new Request(url, { headers: { "x-executor-secret": "shadow-secret-placeholder" } }) as never,
  );
  assert.equal(withSecret.status, 403);
  const body = (await withSecret.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/);
});
