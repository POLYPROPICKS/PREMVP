// Bounded ambient-Supabase audit of the shadow-reachable path, kept as an executable guard:
// producer/resolver -> serving -> Reservation -> rebalance -> queue/callback boundaries.
// Class A (active bypass) must be ZERO: no direct `process.env.SUPABASE_*` and no import of the
// process-global client in runtime-bound code. Every remaining importer of lib/supabase/server in the
// scanned scope is an explicitly classified B/C file; a NEW importer fails this test until classified.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCOPE = ["scripts/generate-signals.ts", "scripts/resolve-signals.ts", "lib/feed", "lib/executor", "lib/ops", "app/api/cron/night-event-reservations", "app/api/cron/event-rebalance", "app/api/executor"];

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((n) => files(path.join(rel, n))).filter((f) => /\.(ts|mjs)$/.test(f));
}
const code = (f: string) => readFileSync(path.join(ROOT, f), "latin1").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// B/C: the only files allowed to name the process-global client in scope.
const CLASSIFIED: Record<string, string> = {
  "lib/executor/nightEventReservations.ts": "B labelled legacy default getter; runtime-bound entries are guarded by reservationRuntime.test.ts",
  "lib/executor/modelingData.ts": "C offline modeling reader (scripts only)",
  "lib/executor/executorWalletStateDbPort.ts": "C wallet/money side; blocked on passive contours",
  "lib/executor/makerFallbackSupabasePort.ts": "C maker/money side; blocked on passive contours",
  "app/api/executor/queue/route.ts": "C passive guard returns 403 first; DEV = process client",
  "app/api/executor/queue/mark/route.ts": "C passive guard returns 403 first; DEV = process client",
  "app/api/executor/order-events/route.ts": "C passive guard returns 403 first; DEV = process client",
  "app/api/executor/candidates/route.ts": "B process client == booted process contour's own client",
  "app/api/executor/night-plan/route.ts": "B process client == booted process contour's own client",
};

test("class A = 0: no direct process.env SUPABASE_* anywhere in scope", () => {
  const hits = SCOPE.flatMap(files).filter((f) => /process\.env\.(NEXT_PUBLIC_)?SUPABASE_/.test(code(f)));
  assert.deepEqual(hits, []);
});

test("class A = 0: every importer of lib/supabase/server in scope is classified B/C", () => {
  const importers = SCOPE.flatMap(files).filter((f) => /supabase\/server["']/.test(code(f))).sort();
  assert.deepEqual(importers, Object.keys(CLASSIFIED).sort());
});

test("runtime-bound reservation/rebalance crons never use the process-global client", () => {
  for (const f of ["app/api/cron/night-event-reservations/route.ts", "app/api/cron/event-rebalance/route.ts"]) {
    assert.doesNotMatch(code(f), /import \{ supabaseAdmin \}/, f);
    assert.doesNotMatch(code(f), /supabase\/server/, f);
  }
});
