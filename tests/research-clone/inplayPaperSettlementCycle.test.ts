/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runSettlementCycle, selectTargetDays, classifyReportStatus, REPORT_TABLE, REPORT_VERSION, MIN_REVISIT_MS, type ExistingReport,
} from "../../lib/research/inplayPaperSettlementCycle";

const NOW = Date.parse("2026-10-11T08:00:00.000Z");
const WIN = "tok-win", LOSE = "tok-lose";
const mkt = (cond: string, o: Record<string, unknown> = {}) => ({
  conditionId: cond, closed: true, outcomes: JSON.stringify(["A", "B"]), outcomePrices: JSON.stringify(["1", "0"]), clobTokenIds: JSON.stringify([WIN, LOSE]), ...o,
});

type Dec = Record<string, any>;
function fakeDb(decisions: Dec[], observations: Dec[] = [], opts: { reportTable?: boolean; boxB?: Dec[]; boxBError?: boolean } = {}) {
  const reports = new Map<string, Dec>();
  const mutations: string[] = [];
  const key = (r: Dec) => `${r.utc_day}|${r.report_version}`;
  const q = (table: string) => {
    const f: { op: string; c: string; v: any }[] = [];
    let mode: "select" | "update" = "select", patch: Dec = {}, lim = Infinity, from = 0;
    const rows = () => {
      let src: Dec[] = table === "research_inplay_paper_decisions" ? decisions : table === "research_inplay_core_path_observations" ? observations : table === "market_outcome_revisions" ? opts.boxB ?? [] : [...reports.values()];
      for (const x of f) src = src.filter((r) => x.op === "in" ? x.v.includes(r[x.c]) : x.op === "eq" ? r[x.c] === x.v : x.op === "gte" ? String(r[x.c]) >= String(x.v) : String(r[x.c]) < String(x.v));
      return src;
    };
    const run = () => {
      if (table === "market_outcome_revisions" && opts.boxBError) return { data: null, error: { code: "42501", message: "permission denied" } };
      if (table === REPORT_TABLE && opts.reportTable === false) return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
      if (mode === "update") { for (const r of rows()) { Object.assign(r, patch); } mutations.push(`update:${table}`); return { data: null, error: null }; }
      return { data: rows().slice(from, from + lim).map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => b, in: (c: string, v: any[]) => (f.push({ op: "in", c, v }), b), eq: (c: string, v: any) => (f.push({ op: "eq", c, v }), b), gte: (c: string, v: any) => (f.push({ op: "gte", c, v }), b), lt: (c: string, v: any) => (f.push({ op: "lt", c, v }), b),
      or: () => b, order: () => b, limit: (n: number) => ((lim = n), Promise.resolve(run())), range: (a: number, z: number) => ((from = a), (lim = z - a + 1), Promise.resolve(run())),
      update: (p: Dec) => ((mode = "update"), (patch = p), b),
      upsert: (row: Dec) => {
        mutations.push(`upsert:${table}`);
        if (table !== REPORT_TABLE) return Promise.resolve({ error: { message: "FORBIDDEN_TABLE_WRITE" } });
        if (opts.reportTable === false) return Promise.resolve({ error: { code: "PGRST205", message: "Could not find the table" } });
        reports.set(key(row), { ...(reports.get(key(row)) ?? {}), ...row }); return Promise.resolve({ error: null });
      },
      insert: () => { mutations.push(`insert:${table}`); return Promise.resolve({ error: { message: "FORBIDDEN" } }); },
      delete: () => { mutations.push(`delete:${table}`); return Promise.resolve({ error: { message: "FORBIDDEN" } }); },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { db: { from: q } as any, reports, mutations };
}

let n = 0;
const dec = (o: Dec = {}): Dec => ({
  decision_id: `d${++n}`, strategy_id: "CONTROL_PRICE_BUCKET_A", physical_event_id: "ev1", status: "BET", provenance_class: "DELAYED_PAPER",
  admission_observed_at: "2026-10-10T08:00:00.000Z", provider_game_id: "g1", condition_id: "0xc1", token_id: WIN, side: "A", market_family: "MONEYLINE", market_slug: null,
  entry_vwap: 0.5, entry_quantity: 2, entry_notional_usd: 1, entry_fee_usd: null, entry_fee_state: "UNKNOWN", observed_at: "2026-10-10T08:00:00.000Z", source_observation_id: "s", ...o,
});
const fetchOf = (m: Record<string, any>) => async (id: string) => m[id.toLowerCase()] ?? null;

test("closed WIN/LOSS/VOID are settled from provider authority; skip and waiting are counted; independent games counted once", async () => {
  const ds = [
    dec({ physical_event_id: "e1", condition_id: "0xw", token_id: WIN, entry_vwap: 0.4 }), dec({ physical_event_id: "e2", condition_id: "0xl", token_id: LOSE }),
    dec({ physical_event_id: "e3", condition_id: "0xv", token_id: WIN }), dec({ physical_event_id: "e1", strategy_id: "CONTROL_PRICE_BUCKET_B", status: "SKIP", token_id: null, condition_id: null }),
  ];
  const { db, reports } = fakeDb(ds);
  const r = await runSettlementCycle(db, fetchOf({ "0xw": mkt("0xw"), "0xl": mkt("0xl"), "0xv": mkt("0xv", { outcomePrices: JSON.stringify(["0.5", "0.5"]) }) }), { nowMs: NOW });
  assert.equal(r.ok, true);
  const row = reports.get(`2026-10-10|${REPORT_VERSION}`)!;
  assert.deepEqual([row.bet_n, row.skip_n, row.waiting_n, row.win_n, row.loss_n, row.void_n, row.open_n], [3, 1, 0, 1, 1, 1, 0]);
  assert.equal(row.settled_gross_pnl_u, 0.5); // +1.5 -1 +0
  assert.equal(row.status, "FULLY_RESOLVED"); assert.equal(row.independent_bet_games_n, 3); assert.equal(row.distinct_games_n, 3);
  assert.equal(row.net_pnl_status, "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY"); assert.equal(row.missing_authority.exit_fees_unknown_n, 3);
  assert.ok(!JSON.stringify(row).includes("service_role"));
  assert.equal(r.days.filter((d) => d.outcome === "WRITTEN").length >= 1, true);
});

test("OPEN market stays OPEN with null ROI (never 0), then the SAME row is reconciled on a later run", async () => {
  const { db, reports } = fakeDb([dec(), dec({ physical_event_id: "ev2", condition_id: "0xc2", token_id: LOSE })]);
  let m: Record<string, any> = { "0xc1": mkt("0xc1", { closed: false }), "0xc2": mkt("0xc2", { closed: false }) };
  await runSettlementCycle(db, async (id) => m[id.toLowerCase()] ?? null, { nowMs: NOW });
  const k = `2026-10-10|${REPORT_VERSION}`;
  let row = reports.get(k)!;
  assert.deepEqual([row.status, row.settled_n, row.open_n, row.settled_roi, row.settled_gross_pnl_u], ["INCOMPLETE", 0, 2, null, null]);
  assert.match(row.first_broken_edge, /TOKEN_TO_OUTCOME:MARKET_OPEN/);
  // within the revisit interval: nothing is re-read or rewritten
  const before = JSON.stringify(row);
  await runSettlementCycle(db, async (id) => m[id.toLowerCase()] ?? null, { nowMs: NOW + 3600_000 });
  assert.equal(JSON.stringify(reports.get(k)), before);
  // one market closes -> partial; then the other -> fully resolved. Same primary key throughout.
  m = { "0xc1": mkt("0xc1"), "0xc2": mkt("0xc2", { closed: false }) };
  await runSettlementCycle(db, async (id) => m[id.toLowerCase()] ?? null, { nowMs: NOW + MIN_REVISIT_MS });
  row = reports.get(k)!;
  assert.deepEqual([row.status, row.settled_n, row.open_n, row.win_n, row.settled_roi], ["PARTIALLY_SETTLED", 1, 1, 1, 1]);
  m["0xc2"] = mkt("0xc2");
  await runSettlementCycle(db, async (id) => m[id.toLowerCase()] ?? null, { nowMs: NOW + 2 * MIN_REVISIT_MS });
  row = reports.get(k)!;
  assert.deepEqual([row.status, row.settled_n, row.loss_n, row.attempts_n], ["FULLY_RESOLVED", 2, 1, 3]);
  assert.equal([...reports.keys()].filter((x) => x.startsWith("2026-10-10")).length, 1);
  assert.equal(row.first_generated_at, new Date(row.first_generated_at).toISOString());
  // FULLY_RESOLVED is not recomputed hourly
  const frozen = JSON.stringify(row);
  await runSettlementCycle(db, async () => { throw new Error("must not be called"); }, { nowMs: NOW + 10 * MIN_REVISIT_MS });
  assert.equal(JSON.stringify(reports.get(k)), frozen);
});

test("Gamma unavailable: FAILED row with exact diagnostic, cycle not ok, retried next run; malformed market stays OPEN", async () => {
  const { db, reports } = fakeDb([dec()]);
  const r = await runSettlementCycle(db, async () => null, { nowMs: NOW });
  const row = reports.get(`2026-10-10|${REPORT_VERSION}`)!;
  assert.equal(r.ok, false); assert.equal(r.first_broken_edge, "PROVIDER_ALL_LOOKUPS_EMPTY");
  assert.deepEqual([row.status, row.last_attempt_status, row.last_error, row.settled_n ?? 0], ["FAILED", "FAILED", "PROVIDER_ALL_LOOKUPS_EMPTY", 0]);
  assert.equal(row.settled_roi ?? null, null);
  // FAILED is retried immediately on the next scheduled run (no revisit throttle) and heals the same row
  const r2 = await runSettlementCycle(db, async (id) => mkt(id, { outcomePrices: "not-json", clobTokenIds: "{" }) as any, { nowMs: NOW + 3600_000 });
  const healed = reports.get(`2026-10-10|${REPORT_VERSION}`)!;
  assert.equal(r2.ok, true); assert.equal(healed.status, "INCOMPLETE"); assert.equal(healed.open_n, 1); assert.equal(healed.win_n + healed.loss_n, 0); assert.equal(healed.settled_roi, null);
});

test("a settled outcome never regresses to OPEN from a later partial provider read", async () => {
  const { db, reports } = fakeDb([dec(), dec({ physical_event_id: "ev2", condition_id: "0xc2" })]);
  await runSettlementCycle(db, fetchOf({ "0xc1": mkt("0xc1"), "0xc2": mkt("0xc2", { closed: false }) }), { nowMs: NOW });
  const k = `2026-10-10|${REPORT_VERSION}`;
  assert.equal(reports.get(k)!.settled_n, 1);
  const r = await runSettlementCycle(db, fetchOf({ "0xc2": mkt("0xc2", { closed: false }) }), { nowMs: NOW + MIN_REVISIT_MS });
  const row = reports.get(k)!;
  assert.equal(r.ok, false); assert.equal(r.days.find((d) => d.day === "2026-10-10")!.outcome, "REGRESSION_REFUSED");
  assert.equal(row.settled_n, 1); assert.equal(row.win_n, 1); assert.equal(row.last_attempt_status, "REGRESSION_REFUSED"); assert.match(row.last_error, /SETTLED_REGRESSION_REFUSED:prev=1,new=0/);
});

test("UTC day boundaries: the in-progress day is checked first; decisions are bucketed by admission_observed_at half-open day", async () => {
  assert.deepEqual(selectTargetDays({ nowMs: Date.parse("2026-10-11T00:00:00.000Z"), existing: [], reconcileDays: 1 }), ["2026-10-11", "2026-10-10"]);
  assert.deepEqual(selectTargetDays({ nowMs: Date.parse("2026-10-10T23:59:59.999Z"), existing: [], reconcileDays: 1 }), ["2026-10-10", "2026-10-09"]);
  const edge = [dec({ admission_observed_at: "2026-10-10T23:59:59.999Z" }), dec({ physical_event_id: "ev2", admission_observed_at: "2026-10-11T00:00:00.000Z" }), dec({ physical_event_id: "ev3", admission_observed_at: "2026-10-09T23:59:59.999Z" })];
  const { db, reports } = fakeDb(edge);
  await runSettlementCycle(db, fetchOf({ "0xc1": mkt("0xc1") }), { nowMs: NOW });
  assert.equal(reports.get(`2026-10-10|${REPORT_VERSION}`)!.bet_n, 1);
  assert.equal(reports.get(`2026-10-09|${REPORT_VERSION}`)!.bet_n, 1);
  // the in-progress day is reported, but its decision (no scheduled start on record) is PENDING, never settled
  const today = reports.get(`2026-10-11|${REPORT_VERSION}`)!;
  assert.deepEqual([today.bet_n, today.settled_n, today.open_n, today.status], [1, 0, 1, "INCOMPLETE"]);
});

test("selectTargetDays: yesterday first, open reports revisited oldest-attempt first, resolved skipped, bounded", () => {
  const ex = (d: string, status: any, at: string | null): ExistingReport => ({ utc_day: d, status, settled_n: 0, attempts_n: 1, generated_at: at, first_generated_at: at, last_attempt_at: at });
  const old = "2026-10-11T01:00:00.000Z";
  const days = selectTargetDays({ nowMs: NOW, existing: [ex("2026-10-10", "PARTIALLY_SETTLED", old), ex("2026-10-09", "FULLY_RESOLVED", old), ex("2026-10-08", "PARTIALLY_SETTLED", "2026-10-10T01:00:00.000Z"), ex("2026-10-07", "FAILED", "2026-10-11T07:00:00.000Z"), ex("2026-09-01", "INCOMPLETE", null)] });
  assert.deepEqual(days, ["2026-10-11", "2026-10-10", "2026-10-08", "2026-10-07"]); // today + cap 3; 10-09 resolved; 09-01 beyond lookback
  assert.deepEqual(selectTargetDays({ nowMs: NOW, existing: [ex("2026-10-10", "INCOMPLETE", "2026-10-11T07:30:00.000Z")], maxDays: 3 }).includes("2026-10-10"), false); // recently attempted
  assert.deepEqual(selectTargetDays({ nowMs: NOW, existing: [], maxDays: 10 }), ["2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08"]);
  // same-day cadence: the in-progress day is due again after the hourly cycle, not within a double fire; FULLY_RESOLVED mid-day is not final
  const t = (status: any, at: string) => ({ ...ex("2026-10-11", status, at), generated_at: at });
  assert.equal(selectTargetDays({ nowMs: NOW, existing: [t("PARTIALLY_SETTLED", "2026-10-11T07:00:00.000Z")] }).includes("2026-10-11"), true);
  assert.equal(selectTargetDays({ nowMs: NOW, existing: [t("PARTIALLY_SETTLED", "2026-10-11T07:30:00.000Z")] }).includes("2026-10-11"), false);
  assert.equal(selectTargetDays({ nowMs: NOW, existing: [t("FULLY_RESOLVED", "2026-10-11T06:00:00.000Z")] }).includes("2026-10-11"), true);
  assert.equal(selectTargetDays({ nowMs: Date.parse("2026-10-12T08:00:00.000Z"), existing: [{ ...ex("2026-10-11", "FULLY_RESOLVED", "2026-10-11T06:00:00.000Z"), generated_at: "2026-10-11T06:00:00.000Z" }] }).includes("2026-10-11"), true); // generated before its day ended: re-settled once more
  assert.equal(selectTargetDays({ nowMs: Date.parse("2026-10-12T08:00:00.000Z"), existing: [{ ...ex("2026-10-11", "FULLY_RESOLVED", "2026-10-12T00:30:00.000Z"), generated_at: "2026-10-12T00:30:00.000Z" }] }).includes("2026-10-11"), false);
  assert.equal(classifyReportStatus({ waiting_n: 1, bet_n: 1, settled_n: 1, open_n: 0 }), "INCOMPLETE");
  assert.equal(classifyReportStatus({ waiting_n: 0, bet_n: 0, settled_n: 0, open_n: 0 }), "FULLY_RESOLVED");
});

test("LIVE-only, full-position SELL x2/x3/x5 is descriptive; post-game and bare best bid never count; no decision is ever mutated", async () => {
  const d = dec({ entry_vwap: 0.2, entry_quantity: 5, entry_notional_usd: 1 });
  const o = (id: string, at: string, over: Dec) => ({ id, physical_event_id: "ev1", condition_id: "0xc1", token_id: WIN, observed_at: at, event_live_status: "LIVE", orderbook_fetch_status: "SUCCESS",
    best_bid: 0.9, mid_price: 0.9, bid_depth_relevant_usd: 50, full_stake_shares: 5, full_stake_exit_vwap: 0.5, full_stake_exit_fully_filled: true, ...over });
  const obs = [
    o("o0", "2026-10-10T07:59:00.000Z", {}), // before entry
    o("o1", "2026-10-10T09:00:00.000Z", { event_live_status: "FINAL", best_bid: 0.99 }), // post-game
    o("o2", "2026-10-10T09:10:00.000Z", { bid_depth_relevant_usd: 0.1, full_stake_exit_fully_filled: false, full_stake_exit_vwap: null, best_bid: 0.99, mid_price: 0.99 }), // best bid, no depth
    o("o3", "2026-10-10T09:20:00.000Z", { full_stake_exit_vwap: 0.45, bid_depth_relevant_usd: 0.1 }), // full fill, 5*0.45=2.25 => x2 only
  ];
  const { db, reports, mutations } = fakeDb([d], obs);
  await runSettlementCycle(db, fetchOf({ "0xc1": mkt("0xc1") }), { nowMs: NOW });
  const row = reports.get(`2026-10-10|${REPORT_VERSION}`)!;
  assert.deepEqual([row.executable_x2_n, row.executable_x3_n, row.executable_x5_n], [1, 0, 0]);
  assert.equal(row.summary.executable_hits[0].multiple, "x2"); assert.equal(row.summary.executable_hits[0].first_hit_at, "2026-10-10T09:20:00.000Z");
  assert.equal(row.summary.executable_exits.caveat, "DESCRIPTIVE_DIAGNOSTIC_NOT_REALIZED_PROFIT");
  assert.ok(mutations.every((m) => m.endsWith(`:${REPORT_TABLE}`)), `only the report table is written: ${mutations}`);
});

test("per-run Gamma budget bounds provider requests", async () => {
  const ds = Array.from({ length: 10 }, (_, i) => dec({ physical_event_id: `e${i}`, condition_id: `0xc${i}` }));
  const { db } = fakeDb(ds);
  let calls = 0;
  const r = await runSettlementCycle(db, async (id) => { calls++; return mkt(id) as any; }, { nowMs: NOW, maxGammaRequests: 4 });
  assert.equal(calls, 4); assert.equal(r.budget_exhausted, true);
});

test("missing report table fails loudly with the exact schema action; nothing else is written", async () => {
  const { db, mutations } = fakeDb([dec()], [], { reportTable: false });
  await assert.rejects(runSettlementCycle(db, fetchOf({}), { nowMs: NOW }), /SETTLEMENT_REPORT_TABLE_MISSING:apply ops\/research-clone\/inplay-paper-settlement-reports-schema\.sql/);
  assert.deepEqual(mutations, []);
});

test("scheduled command: settlement runs last in BOTH branches, `;`-separated so it cannot suppress sync/decisions, exit code preserved", () => {
  const toml = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8");
  const start = toml.split("\n").find((l) => l.startsWith("startCommand"))!.trimEnd();
  assert.equal((start.match(/research-clone:inplay-paper-settlement-cycle/g) ?? []).length, 2);
  // BOX_B_HISTORICAL_CATCHUP_LIVE_V1: the Box B collector now runs after settlement; every exit code (D/S/C) is preserved.
  const tail = String.raw`npm run research-clone:inplay-paper-settlement-cycle; S=\$\?; npm run research-clone:market-outcome-collector; C=\$\?; \[ \\"\$D\\" = 0 \] && \[ \\"\$S\\" = 0 \] && \[ \\"\$C\\" = 0 \]`;
  assert.match(start, new RegExp(String.raw`research-clone:inplay-paper-decisions; D=\$\?; ${tail}; else`));
  assert.match(start, new RegExp(String.raw`research-clone:sync -- --telemetry-only; npm run research-clone:inplay-paper-decisions; D=\$\?; ${tail}; fi'"$`));
  assert.doesNotMatch(start, /(sync|decisions)\s*&&\s*npm run research-clone:inplay-paper-settlement/);
  assert.match(toml, /cronSchedule\s*=\s*"0 \* \* \* \*"/);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["research-clone:inplay-paper-settlement-cycle"], "tsx scripts/research-inplay-paper-settlement-cycle.ts");
});

test("schema: DBClone-only, additive/idempotent, PK on (utc_day, version), least privilege, no decision table touched; cycle is clone-only", () => {
  const sql = readFileSync("ops/research-clone/inplay-paper-settlement-reports-schema.sql", "utf8");
  assert.match(sql, /nppznoujvnyjargjkmnv/); assert.match(sql, /NEVER apply to production/);
  assert.match(sql, /primary key \(utc_day, report_version\)/); assert.match(sql, /create table if not exists/);
  assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on public\.research_inplay_paper_settlement_reports from anon, authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*delete/i); assert.doesNotMatch(sql, /drop table|alter table public\.research_inplay_paper_decisions|^\s*truncate\b/im);
  assert.match(sql, /REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE public\.research_inplay_paper_settlement_reports\s+FROM service_role;/); // reproduces the DBClone least-privilege state
  const src = ["lib/research/inplayPaperSettlementCycle.ts", "scripts/research-inplay-paper-settlement-cycle.ts"].map((f) => readFileSync(f, "utf8")).join("\n").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(src, /nppznoujvnyjargjkmnv/); assert.doesNotMatch(src, /nbnldzfsxffztsfrrxqy|ireland|placeOrder|SUPABASE_URL\b|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(src, /from\(DECISION_TABLE\)|research_inplay_paper_decisions"\)\.(insert|update|upsert|delete)/);
});

// ───────────────────────────── same-day outcomes (Box B authority, start + 6h) ─────────────────────────────
const T = (c: string) => c.toLowerCase();
const rev = (cond: string, o: Dec = {}) => ({ condition_id: T(cond), revision_no: 1, outcome_status: "FINAL", winner_token_id: WIN, market_token_ids: [WIN, LOSE], ...o });
const today = (o: Dec = {}) => dec({ admission_observed_at: "2026-10-11T01:00:00.000Z", event_start_iso: "2026-10-11T00:30:00.000Z", observed_at: "2026-10-11T01:00:00.000Z", ...o });
const SD = `2026-10-11|${REPORT_VERSION}`;
const noGamma = async () => { throw new Error("same-day settlement must not call the provider"); };

test("same-day: eligible FINAL -> WIN/LOSS, VOID -> VOID; PENDING/CONFLICT/missing/pre-6h stay PENDING; no provider call", async () => {
  const ds = [
    today({ physical_event_id: "e1", condition_id: "0xw", token_id: WIN, entry_vwap: 0.4 }), today({ physical_event_id: "e2", condition_id: "0xl", token_id: LOSE }),
    today({ physical_event_id: "e3", condition_id: "0xv", token_id: WIN }), today({ physical_event_id: "e4", condition_id: "0xp", token_id: WIN }),
    today({ physical_event_id: "e5", condition_id: "0xc", token_id: WIN }), today({ physical_event_id: "e6", condition_id: "0xn", token_id: WIN }),
    today({ physical_event_id: "e7", condition_id: "0xearly", token_id: WIN, event_start_iso: "2026-10-11T07:00:00.000Z" }), // start + 6h = 13:00 > 08:00
    today({ physical_event_id: "e8", condition_id: "0xfam", token_id: "tok-other" }), // FINAL but token not in the Box B market
  ];
  const boxB = [rev("0xw"), rev("0xl"), rev("0xv", { outcome_status: "VOID", winner_token_id: null }), rev("0xp", { outcome_status: "PENDING", winner_token_id: null }),
    rev("0xc", { outcome_status: "CONFLICT", winner_token_id: null }), rev("0xearly"), rev("0xfam")];
  const { db, reports, mutations } = fakeDb(ds, [], { boxB });
  const r = await runSettlementCycle(db, noGamma, { nowMs: NOW });
  assert.equal(r.ok, true); assert.equal(r.gamma_requests, 0);
  const row = reports.get(SD)!;
  assert.deepEqual([row.bet_n, row.win_n, row.loss_n, row.void_n, row.settled_n, row.open_n, row.status], [8, 1, 1, 1, 3, 5, "PARTIALLY_SETTLED"]);
  assert.equal(row.settled_gross_pnl_u, 0.5); // +1.5 -1 +0
  assert.equal(row.summary.outcome_authority, "BOX_B_ONLY_SAME_DAY_START_PLUS_6H"); assert.equal(row.summary.pending_n, 5);
  for (const k of ["BOX_B_PENDING", "BOX_B_CONFLICT", "BOX_B_NO_REVISION", "NOT_YET_ELIGIBLE_BEFORE_START_PLUS_6H", "BOX_B_TOKEN_NOT_IN_MARKET"]) assert.ok(Object.keys(row.summary.missing_outcome_reasons).some((x) => x.endsWith(`:${k}`)), k);
  assert.ok(mutations.every((m) => m.endsWith(`:${REPORT_TABLE}`)));
});

test("same-day: PENDING is retried on the next hourly run and settles when Box B turns FINAL; same row, never regresses", async () => {
  const boxB: Dec[] = [rev("0xw", { outcome_status: "PENDING", winner_token_id: null })];
  const { db, reports } = fakeDb([today({ condition_id: "0xw" })], [], { boxB });
  await runSettlementCycle(db, noGamma, { nowMs: NOW });
  assert.deepEqual([reports.get(SD)!.settled_n, reports.get(SD)!.open_n], [0, 1]);
  await runSettlementCycle(db, noGamma, { nowMs: NOW + 10 * 60_000 }); // double fire inside the revisit guard: untouched
  assert.equal(reports.get(SD)!.attempts_n, 1);
  boxB.push(rev("0xw", { revision_no: 2 }));
  await runSettlementCycle(db, noGamma, { nowMs: NOW + 3600_000 });
  const row = reports.get(SD)!;
  assert.deepEqual([row.settled_n, row.win_n, row.status, row.attempts_n], [1, 1, "FULLY_RESOLVED", 2]);
  // a decision admitted later the same day is still picked up even though the mid-day row was FULLY_RESOLVED
  const ds2 = [today({ condition_id: "0xw" })], f = fakeDb(ds2, [], { boxB });
  await runSettlementCycle(f.db, noGamma, { nowMs: NOW });
  assert.equal(f.reports.get(SD)!.status, "FULLY_RESOLVED");
  ds2.push(today({ physical_event_id: "ev9", condition_id: "0xnone", token_id: LOSE })); // not in Box B yet -> PENDING
  await runSettlementCycle(f.db, noGamma, { nowMs: NOW + 3600_000 });
  assert.deepEqual([f.reports.get(SD)!.bet_n, f.reports.get(SD)!.settled_n, f.reports.get(SD)!.open_n, f.reports.get(SD)!.status], [2, 1, 1, "PARTIALLY_SETTLED"]);
});

test("same-day: DELAYED_PAPER is never presented as prospective; LIVE_PROSPECTIVE is separated", async () => {
  const ds = [today({ condition_id: "0xw" }), today({ physical_event_id: "e2", condition_id: "0xl", token_id: LOSE })];
  const a = fakeDb(ds, [], { boxB: [rev("0xw"), rev("0xl")] });
  await runSettlementCycle(a.db, noGamma, { nowMs: NOW });
  const s1 = a.reports.get(SD)!.summary;
  assert.deepEqual(s1.prospective_claim, { live_prospective_settled_n: 0, delayed_paper_settled_n: 2, claim: "NO_PROSPECTIVE_PROFITABILITY_CLAIM_DELAYED_OR_UNPROVEN_ONLY" });
  assert.equal(a.reports.get(SD)!.missing_authority.snapshot_delayed_n, 2);
  const b = fakeDb([today({ condition_id: "0xw", provenance_class: "LIVE_PROSPECTIVE" })], [], { boxB: [rev("0xw")] });
  await runSettlementCycle(b.db, noGamma, { nowMs: NOW });
  assert.equal(b.reports.get(SD)!.summary.prospective_claim.live_prospective_settled_n, 1);
  assert.equal(b.reports.get(SD)!.summary.settlement_by_provenance.LIVE_PROSPECTIVE.settled_n, 1);
});

test("completed day: a terminal Box B revision overrides without a provider call; otherwise the existing provider path is unchanged", async () => {
  const ds = [dec({ physical_event_id: "e1", condition_id: "0xw" }), dec({ physical_event_id: "e2", condition_id: "0xg", token_id: LOSE })];
  const { db, reports } = fakeDb(ds, [], { boxB: [rev("0xw"), rev("0xg", { outcome_status: "PENDING", winner_token_id: null })] });
  const asked: string[] = [];
  await runSettlementCycle(db, async (id) => { asked.push(id); return mkt(id) as any; }, { nowMs: NOW });
  assert.deepEqual(asked.filter((x) => x === "0xw"), []); assert.ok(asked.includes("0xg"));
  const row = reports.get(`2026-10-10|${REPORT_VERSION}`)!;
  assert.deepEqual([row.win_n, row.loss_n, row.settled_n], [1, 1, 2]);
  assert.equal(row.summary.outcome_authority, "BOX_B_TERMINAL_THEN_PROVIDER_GAMMA");
});

test("Box B hardening: unusable terminal rows never settle same-day and fall back to the provider on completed days; read errors degrade completed days only", async () => {
  const bad = (o: Dec) => rev("0xw", o);
  for (const o of [{ winner_token_id: null }, { market_token_ids: null }, { market_token_ids: "x" }, { winner_token_id: "tok-elsewhere" }, { market_token_ids: [LOSE] }, { outcome_status: "VOID", winner_token_id: null, market_token_ids: [LOSE] }]) {
    const sd = fakeDb([today({ condition_id: "0xw" })], [], { boxB: [bad(o)] });
    await runSettlementCycle(sd.db, noGamma, { nowMs: NOW });
    assert.deepEqual([sd.reports.get(SD)!.settled_n, sd.reports.get(SD)!.open_n], [0, 1], JSON.stringify(o));
    const cd = fakeDb([dec({ condition_id: "0xw" })], [], { boxB: [bad(o)] });
    const asked: string[] = [];
    await runSettlementCycle(cd.db, async (id) => { asked.push(id); return mkt(id) as any; }, { nowMs: NOW });
    assert.ok(asked.includes("0xw"), `provider fallback for ${JSON.stringify(o)}`);
    assert.equal(cd.reports.get(`2026-10-10|${REPORT_VERSION}`)!.win_n, 1);
  }
  // Box B unreadable: completed day keeps the provider-only path; the in-progress day fails loudly (its only authority)
  const e = fakeDb([dec(), today({ physical_event_id: "ev2", condition_id: "0xw" })], [], { boxBError: true });
  const r = await runSettlementCycle(e.db, async (id) => mkt(id) as any, { nowMs: NOW });
  assert.equal(e.reports.get(`2026-10-10|${REPORT_VERSION}`)!.summary.outcome_authority, "PROVIDER_GAMMA_BY_CONDITION_ID_AND_EXACT_TOKEN");
  assert.equal(e.reports.get(`2026-10-10|${REPORT_VERSION}`)!.win_n, 1);
  assert.equal(r.ok, false); assert.equal(r.days.find((d) => d.day === "2026-10-11")!.outcome, "FAILED"); assert.match(r.days.find((d) => d.day === "2026-10-11")!.error!, /BOX_B_READ/);
});
