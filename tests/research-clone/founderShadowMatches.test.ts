import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateShadowMatches, grossPnlU, minskDate, readFounderShadowMatches, SAFE_MODEL_IDS, type ShadowRow } from "../../lib/research/founderShadowMatches";
import { signPremiumSession } from "../../lib/auth/premiumSession";
import { GET } from "../../app/api/founder/modeling/research/shadow-matches/route";

const row = (model_id: string, key: string | null, over: Partial<ShadowRow> = {}): ShadowRow => ({
  model_id, decision_date: "2026-10-16", physical_event_key: key, sport_family: "football", event_start: null, entry_price: 0.5,
  selected_token_id: "tok-abcdefgh1234", settlement_state: "UNQUERIED", result: null, settlement_checked_at: null, first_persisted_at: null, ...over });

test("exposures, unique event keys and cross-model overlap are separated", () => {
  const rows = [row("P50_52_SAFE", "A"), row("PORTFOLIO_BROAD_SAFE", "A"), row("QUALITY_FILL_A_SAFE", "A"), row("P50_52_SAFE", "B"),
    row("TENNIS_P50_52_SAFE", "C", { sport_family: "tennis" }), row("P50_52_SAFE", null)];
  const day = aggregateShadowMatches(rows).days[0];
  assert.equal(day.model_exposures, 6);
  assert.equal(day.unique_event_keys, 3);
  assert.equal(day.keys_shared_across_models, 1);
  assert.equal(day.rows_without_event_key, 1);
  assert.deepEqual(day.overlap_by_model_count, { "3": 1, "1": 2 });
  assert.equal(day.models.length, SAFE_MODEL_IDS.length);
  assert.equal(day.models.find(m => m.model_id === "QUALITY_FILL_D_SAFE")!.exposures, 0);
});

test("unresolved outcomes never produce P&L and settled P&L uses entry price", () => {
  assert.equal(grossPnlU(0.5, "UNRESOLVED"), null);
  assert.equal(grossPnlU(0.5, "WIN"), 1);
  assert.equal(grossPnlU(0.25, "LOSS"), -1);
  assert.equal(grossPnlU(null, "WIN"), null);
  const open = aggregateShadowMatches([row("P50_52_SAFE", "A")]).days[0].overall;
  assert.equal(open.gross_pnl_u, null);
  assert.equal(open.unresolved, 1);
  const mixed = aggregateShadowMatches([row("P50_52_SAFE", "A", { result: "WIN" }), row("P50_52_SAFE", "B", { settlement_state: "LOSS" }), row("P50_52_SAFE", "C")]).days[0].overall;
  assert.equal(mixed.gross_pnl_u, 0);
  assert.equal(mixed.settled_roi, 0);
  assert.equal(mixed.unresolved, 1);
  const badPrice = aggregateShadowMatches([row("P50_52_SAFE", "A", { result: "WIN", entry_price: null })]).days[0].overall;
  assert.equal(badPrice.gross_pnl_u, null);
});

test("event rows only cover the newest two days and Minsk date is UTC+3", () => {
  const rows = ["2026-10-14", "2026-10-15", "2026-10-16"].map(d => row("P50_52_SAFE", `K-${d}`, { decision_date: d }));
  const agg = aggregateShadowMatches(rows);
  assert.deepEqual(agg.days.map(d => d.decision_date), ["2026-10-16", "2026-10-15", "2026-10-14"]);
  assert.equal(agg.events.length, 2);
  assert.equal(minskDate(Date.parse("2026-10-15T21:30:00Z")), "2026-10-16");
});

test("API denies absent and non-Founder sessions before any research read", async () => {
  process.env.PPP_SESSION_SECRET = "synthetic-test-secret-at-least-32-characters";
  process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW = "true";
  delete process.env.SUPABASE_CLONE_URL; delete process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  const ordinary = signPremiumSession({ checkoutSessionId: "customer", email: null, activePlan: "preview", accessUntil: new Date(Date.now() + 86_400_000).toISOString(), issuedAt: Date.now() });
  for (const cookie of [undefined, ordinary]) {
    const req = new NextRequest("http://localhost/api/founder/modeling/research/shadow-matches", cookie ? { headers: { cookie: `ppp_session=${cookie}` } } : undefined);
    assert.equal((await GET(req)).status, 404);
  }
});

function fakeDb(ledger: ShadowRow[], snapshot: Record<string, unknown> | null) {
  return { from() {
    let kind = "", head = false;
    const q: any = {
      select(cols: string) { head = cols.startsWith("updated_at"); return q; },
      eq(c: string, v: string) { if (c === "row_kind") kind = v; return q; },
      gte() { return q; }, lte() { return q; }, order() { return q; }, limit() { return q; },
      range(a: number, b: number) { return q.then0(ledger.slice(a, b + 1)); },
      then0(d: unknown) { return Promise.resolve({ data: d, error: null }); },
      then(res: (v: unknown) => unknown, rej: (r: unknown) => unknown) {
        const data = head ? (snapshot ? [snapshot] : []) : [{ decision_date: "2026-10-16" }];
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return q;
  } } as unknown as SupabaseClient;
}

test("reader flags STALE for missing, future and old snapshots, validates range and marks fallback", async () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const ledger = [row("P50_52_SAFE", "A", { entry_price: null })];
  const ok = await readFounderShadowMatches(fakeDb(ledger, { lastSuccessfulRefresh: "2026-10-16T11:30:00Z" }), new URLSearchParams(), now);
  assert.equal(ok.freshness, "CURRENT");
  assert.equal(ok.snapshot_refresh_source, "lastSuccessfulRefresh");
  assert.equal(ok.events[0].selections[0].entry_price, null);
  assert.equal(ok.events[0].selections[0].selected_outcome, null);
  assert.equal(ok.rows_without_selected_outcome, 1);
  const named = await readFounderShadowMatches(fakeDb([row("P50_52_SAFE", "A", { selected_outcome: "  Home  " })], { lastSuccessfulRefresh: "2026-10-16T11:30:00Z" }), new URLSearchParams(), now);
  assert.equal(named.events[0].selections[0].selected_outcome, "Home");
  assert.equal(named.rows_without_selected_outcome, 0);
  for (const snap of [null, { lastSuccessfulRefresh: "2026-10-16T08:00:00Z" }, { lastSuccessfulRefresh: "2026-10-16T13:00:00Z" }])
    assert.equal((await readFounderShadowMatches(fakeDb(ledger, snap), new URLSearchParams(), now)).freshness, "STALE");
  const fb = await readFounderShadowMatches(fakeDb(ledger, { updated_at: "2026-10-16T11:30:00Z" }), new URLSearchParams(), now);
  assert.equal(fb.snapshot_refresh_source, "row_updated_at_fallback");
  const behind = await readFounderShadowMatches(fakeDb(ledger, { lastSuccessfulRefresh: "2026-10-17T11:59:00Z" }), new URLSearchParams(), Date.parse("2026-10-17T12:00:00Z"));
  assert.equal(behind.freshness, "STALE");
  for (const days of ["0", "15", "x"]) await assert.rejects(readFounderShadowMatches(fakeDb(ledger, null), new URLSearchParams({ days }), now), /INVALID_RANGE/);
  const big = Array.from({ length: 4001 }, (_, i) => row("P50_52_SAFE", `K${i}`));
  await assert.rejects(readFounderShadowMatches(fakeDb(big, null), new URLSearchParams(), now), /SHADOW_WINDOW_TOO_LARGE/);
});
