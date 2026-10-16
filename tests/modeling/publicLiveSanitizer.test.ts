import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizePublicLive, sanitizePublicLiveAsset } from "../../lib/modeling/publicLiveSanitizer";

const root = join(__dirname, "..", "..");
const now = Date.parse("2026-10-16T12:00:00.000Z");
const FORBIDDEN = /spendable|collateral|allowance|wallet|nbnldzfsxffztsfrrxqy|productionProjectRef|0x[0-9a-f]{16,}|service_role|supabase\.co/i;

test("committed LIVE asset is served without wallet, project ref or identifiers, aggregates preserved", () => {
  const raw = readFileSync(join(root, "modeling/evidence/modeling-dashboard-v1/LIVE_RUNTIME_DATA.js"), "utf8");
  assert.match(raw, /spendableUsd/); // the raw artifact really is sensitive
  const out = sanitizePublicLiveAsset(raw, now);
  assert.doesNotMatch(out, FORBIDDEN);
  const body = JSON.parse(out.slice(out.indexOf("{")).replace(/;\s*$/, ""));
  assert.equal(body.publicView, "AGGREGATE_ONLY_V1");
  assert.equal(body.days[0].planFunnel.orders.total, 17);
  assert.equal(body.days[0].planFunnel.orders.clobOrderN, 17);
  assert.equal(body.today.orders.submittedStakeUsd, 28);
  assert.equal(body.freshness.stale, true); // 2026-09-22 snapshot is labelled stale, never presented as current
});

test("request-time LIVE payload drops identifiers and operator detail but keeps counts and P&L", () => {
  const out = sanitizePublicLive({
    ARTIFACT: "LIVE_RUNTIME_DATA_V1", GENERATED_AT: "2026-10-16T11:30:00.000Z", status: "OK",
    productionProjectRef: "nbnldzfsxffztsfrrxqy",
    today: { wallet: { spendableUsd: 5, observedAt: "x" }, orders: { total: 2, submittedStakeUsd: 8, clobOrderId: "abc", exchangeOrderId: "def", tokenId: "123" } },
    days: [{ minskDate: "2026-10-16", provenance: { productionProjectRef: "nbnldzfsxffztsfrrxqy", source: "X" },
      planFunnel: { orders: { total: 2, clobOrderN: 2, reservationId: "9a1b2c3d-0000-4000-8000-000000000000" }, settled: { count: 1, realized_pnl_usd: 1.5, note: "see C:\\secret\\path" } } }],
  }, now);
  assert.doesNotMatch(JSON.stringify(out), FORBIDDEN);
  assert.doesNotMatch(JSON.stringify(out), /clobOrderId|exchangeOrderId|tokenId|reservationId|secret/);
  const day = (out.days as any[])[0];
  assert.equal(day.planFunnel.orders.clobOrderN, 2);
  assert.equal(day.planFunnel.settled.realized_pnl_usd, 1.5);
  assert.equal((out.freshness as any).stale, false);
});

test("stop reasons are reduced to a stable code (no env/config detail)", () => {
  const out = sanitizePublicLive({ status: "STOPPED", stopReason: "MEASUREMENT_MISSING: SUPABASE_SERVICE_ROLE_KEY unresolved for ref nbnld", days: [] }, now);
  assert.equal(out.stopReason, "MEASUREMENT_MISSING");
  assert.equal(sanitizePublicLive({ status: "STOPPED", stopReason: "weird lower", days: [] }, now).stopReason, "RUNTIME_STOPPED");
});

test("unparseable LIVE asset fails closed to a STOPPED artifact", () => {
  const out = sanitizePublicLiveAsset("garbage", now);
  assert.match(out, /LIVE_SNAPSHOT_UNREADABLE/);
});
