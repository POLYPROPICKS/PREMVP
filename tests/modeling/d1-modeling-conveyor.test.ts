import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BOOTSTRAP_START,
  aggregate,
  buildRollups,
  chronologicalMaxDrawdown,
  dailyRow,
  evaluateFreshness,
  missingDates,
  parseConveyorArgs,
  pnlFor,
  runConveyor,
  scoreContext,
  selectionDigest,
  type BetPnlRow,
  type ConveyorDeps,
  type DailyRow,
  type OpenBetRef,
  type RollupRow,
  type SelectedBetFact,
} from "../../scripts/modeling/d1-modeling-conveyor-core";
import { ACTIVE_D1_FOOTBALL_STRATEGIES, strategyKey } from "../../scripts/modeling/active-d1-football-strategies";
import { IMPLEMENTATIONS, STRATEGY_REGISTRY, type RunContext } from "../../scripts/modeling/football-strategy-registry";
import { LIVE_B_STRATEGY, isLiveMltsOdds175200, selectFootballLiveMltsOdds175200 } from "../../scripts/modeling/football-live-safe-rebaseline";

const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

function cand(o: { date: string; event: string; cond: string; p: number; at: string; market?: string; label?: string }) {
  return {
    physicalEventKey: o.event, decisionTimestamp: o.at, eventStart: `${o.date}T20:00:00.000Z`, entryPrice: o.p, sportFamily: "soccer",
    ref: o.cond, candidateRef: "tok", scoreLevel: null, score: EMPTY, selectedPrice: EMPTY, volumeUsd: null, rowLeadTimeHours: 5,
    marketTypeRaw: o.market ?? "moneyline", candidateIdentity: `${o.cond}::tok::${o.at}`, period: "SEP_13_24" as const, modelDate: o.date,
  };
}
function ctxOf(cands: Array<ReturnType<typeof cand>>, labels: Record<string, string> = {}): RunContext {
  return {
    structural: cands as unknown as RunContext["structural"],
    safeUniverse: cands.map(({ period: _p, ...c }) => c) as unknown as RunContext["safeUniverse"],
    settlement: new Map(cands.map((c) => [c.candidateIdentity, (labels[c.candidateIdentity] ?? "OPEN") as never])),
  };
}

// ── in-memory deps ─────────────────────────────────────────────────────────
function fakeDeps(init: { ready: string[]; daily: string[]; ctxByDate?: Record<string, RunContext>; dashboardDay?: string | null }) {
  const calls: string[] = [];
  const bets = new Map<string, SelectedBetFact>();
  const daily = new Map<string, DailyRow>(init.daily.map((d) => [d, { model_date: d } as DailyRow]));
  const rollups: RollupRow[] = [];
  let dashboardDay: string | null = init.dashboardDay ?? null;
  let jobRuns = 0;
  const deps: ConveyorDeps & { calls: string[]; bets: typeof bets; daily: typeof daily; rollups: typeof rollups; jobRuns: () => number } = {
    calls, bets, daily, rollups, jobRuns: () => jobRuns,
    now: () => new Date("2026-09-30T02:00:00Z"),
    log: () => {},
    listReadyDates: async () => init.ready,
    listDailyDates: async () => [...daily.keys()],
    classifyDay: async (d) => { calls.push(`classify:${d}`); return init.ctxByDate?.[d] ?? ctxOf([]); },
    readClaims: async (ids, before) => {
      calls.push(`claims:${before}`);
      const m = new Map<string, Set<string>>();
      for (const b of bets.values()) if (b.model_date < before && ids.includes(b.physical_event_id)) {
        const k = strategyKey(b.strategy_id, b.strategy_version);
        (m.get(k) ?? m.set(k, new Set()).get(k)!).add(b.physical_event_id);
      }
      return m;
    },
    loadFrozenContext: async () => { calls.push("frozen"); return ctxOf([]); },
    upsertBets: async (rows) => { for (const r of rows) bets.set(`${r.strategy_id}|${r.model_date}|${r.physical_event_id}`, r); },
    listOpenBets: async () => [...new Map([...bets.values()].filter((b) => b.settlement_label === "OPEN").map((b) => [b.candidate_identity, b as unknown as OpenBetRef])).values()],
    resolveTerminal: async () => null,
    applySettlement: async (ref, label, pnl) => { for (const b of bets.values()) if (b.candidate_identity === ref.candidate_identity) { b.settlement_label = label; b.pnl_u = pnl; } },
    readBetsForDates: async (dates) => {
      calls.push("readBetsForDates");
      const m = new Map<string, BetPnlRow[]>();
      for (const b of bets.values()) if (dates.includes(b.model_date)) (m.get(b.model_date) ?? m.set(b.model_date, []).get(b.model_date)!).push({ ...b, strategy_key: strategyKey(b.strategy_id, b.strategy_version) });
      return m;
    },
    upsertDaily: async (rows) => { for (const r of rows) daily.set(r.model_date, r); },
    readAllBets: async () => {
      calls.push("readAllBets");
      const m = new Map<string, BetPnlRow[]>();
      for (const b of bets.values()) { const k = strategyKey(b.strategy_id, b.strategy_version); (m.get(k) ?? m.set(k, []).get(k)!).push(b); }
      return m;
    },
    upsertRollups: async (rows) => { rollups.length = 0; rollups.push(...rows); },
    publishDashboard: async (asOf) => { calls.push("publishDashboard"); dashboardDay = asOf; },
    readFreshness: async () => ({
      latestModelReadyDay: [...init.ready].sort().at(-1) ?? null,
      latestStrategyDailyDay: [...daily.keys()].sort().at(-1) ?? null,
      latestRollupDay: rollups[0]?.as_of_date ?? (init.daily.length ? init.daily.sort().at(-1)! : null),
      latestDashboardDay: dashboardDay,
    }),
    recordJobRun: async () => { jobRuns++; },
  };
  return deps;
}

const D1 = "2026-09-25";
const D2 = "2026-09-26";

test("1. no missing day => no classification / no candidate-corpus reread", async () => {
  const deps = fakeDeps({ ready: [D1], daily: [D1], dashboardDay: D1 });
  const res = await runConveyor(deps, { bootstrapThrough: null });
  assert.equal(res.ok, true);
  assert.ok(!deps.calls.some((c) => c.startsWith("classify") || c === "frozen"));
  assert.deepEqual(res.scoredDates, []);
});

test("2. one missing day => only that date is classified and scored", async () => {
  const c = cand({ date: D2, event: "e1", cond: "c1", p: 0.52, at: `${D2}T10:00:00.000Z` });
  const deps = fakeDeps({ ready: [D1, D2], daily: [D1], ctxByDate: { [D2]: ctxOf([c]) } });
  const res = await runConveyor(deps, { bootstrapThrough: null });
  assert.deepEqual(deps.calls.filter((x) => x.startsWith("classify")), [`classify:${D2}`]);
  assert.deepEqual(res.scoredDates, [D2]);
  assert.ok([...deps.bets.values()].every((b) => b.model_date === D2));
  assert.equal(res.freshness.latestStrategyDailyDay, D2);
});

test("3. rerun of the same date is idempotent", async () => {
  const c = cand({ date: D2, event: "e1", cond: "c1", p: 0.52, at: `${D2}T10:00:00.000Z` });
  const ctx = ctxOf([c]);
  const a = scoreContext(ctx, new Map(), "t");
  const b = scoreContext(ctx, new Map(), "t");
  assert.deepEqual(a, b);
  const deps = fakeDeps({ ready: [D2], daily: [], ctxByDate: { [D2]: ctx } });
  deps.daily.set("2026-09-24", { model_date: "2026-09-24" } as DailyRow); // prior bootstrap marker
  (deps as unknown as { listReadyDates: () => Promise<string[]> }).listReadyDates = async () => ["2026-09-24", D2];
  await runConveyor(deps, { bootstrapThrough: null });
  const n1 = deps.bets.size;
  deps.daily.delete(D2); // simulate crash before the daily row was written
  await runConveyor(deps, { bootstrapThrough: null });
  assert.equal(deps.bets.size, n1);
});

test("4. at most one bet per physical event per strategy (within day and across days)", () => {
  const ctx = ctxOf([
    cand({ date: D1, event: "e1", cond: "c1", p: 0.52, at: `${D1}T10:00:00.000Z` }),
    cand({ date: D1, event: "e1", cond: "c2", p: 0.51, at: `${D1}T11:00:00.000Z` }),
    cand({ date: D1, event: "e2", cond: "c3", p: 0.52, at: `${D1}T12:00:00.000Z` }),
  ]);
  const facts = scoreContext(ctx, new Map(), "t");
  const seen = new Set<string>();
  for (const f of facts) { const k = `${f.strategy_id}|${f.physical_event_id}`; assert.ok(!seen.has(k), k); seen.add(k); }
  // Cross-day: e1 already claimed by every strategy => never selected again.
  const claimed = new Map(ACTIVE_D1_FOOTBALL_STRATEGIES.map((s) => [strategyKey(s.strategy_id, s.strategy_version), new Set(["e1"])]));
  assert.ok(scoreContext(ctx, claimed, "t").every((f) => f.physical_event_id !== "e1"));
});

test("5. OPEN is not a LOSS", () => {
  assert.equal(pnlFor("OPEN", 0.52), null);
  const a = aggregate([{ model_date: D1, decision_at: "a", candidate_identity: "x", settlement_label: "OPEN", pnl_u: null }]);
  assert.deepEqual([a.open_n, a.losses, a.settled_n, a.pnl_u], [1, 0, 0, 0]);
});

test("6. settlement update cannot change selected identity", async () => {
  const c = cand({ date: D2, event: "e1", cond: "c1", p: 0.52, at: `${D2}T10:00:00.000Z` });
  const deps = fakeDeps({ ready: [D1, D2], daily: [D1], ctxByDate: { [D2]: ctxOf([c]) } });
  await runConveyor(deps, { bootstrapThrough: null });
  const before = [...deps.bets.values()].map((b) => b.candidate_identity).sort();
  const digest = selectionDigest(before);
  deps.resolveTerminal = async () => "WIN";
  deps.calls.length = 0;
  await runConveyor(deps, { bootstrapThrough: null });
  const after = [...deps.bets.values()];
  assert.equal(selectionDigest(after.map((b) => b.candidate_identity)), digest);
  assert.ok(after.every((b) => b.settlement_label === "WIN" && b.pnl_u !== null));
  assert.ok(!deps.calls.some((x) => x.startsWith("classify")), "settlement change must not trigger rescoring");
  assert.equal(dailyRow(D2, { strategy_id: "s", strategy_version: "1" }, [{ model_date: D2, decision_at: "a", candidate_identity: "x", settlement_label: "WIN", pnl_u: 1 }], "t").selection_digest,
    dailyRow(D2, { strategy_id: "s", strategy_version: "1" }, [{ model_date: D2, decision_at: "a", candidate_identity: "x", settlement_label: "OPEN", pnl_u: null }], "t").selection_digest);
});

test("7. active strategies reuse the frozen implementations", () => {
  assert.equal(ACTIVE_D1_FOOTBALL_STRATEGIES.length, 11);
  const ids = ACTIVE_D1_FOOTBALL_STRATEGIES.map((s) => s.strategy_id);
  for (const id of ["FOOTBALL_ODDS_185_200_REPAIRED", "FOOTBALL_ODDS_192_200_REPAIRED_SAFE", "FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200", "FOOTBALL_SPREADS_ODDS_185_200_AUDIT_REQUIRED", "FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200", "FOOTBALL_ODDS_192_200_PRICE_BAND", "FOOTBALL_ODDS_185_200_PRICE_BAND", "FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER", "FOOTBALL_TOTAL_CORNERS_ODDS_225_250", "FOOTBALL_LIVE_MLTS_ODDS_175_200", "FOOTBALL_LIVE_MLTS_175_200_THEN_MLTS_185_200"]) assert.ok(ids.includes(id), id);
  for (const def of STRATEGY_REGISTRY) {
    const active = ACTIVE_D1_FOOTBALL_STRATEGIES.find((s) => s.strategy_id === def.strategy_id);
    if (active) assert.equal(active.select, IMPLEMENTATIONS[def.implementation_symbol]);
  }
  assert.equal(ACTIVE_D1_FOOTBALL_STRATEGIES.find((s) => s.strategy_id === "FOOTBALL_LIVE_MLTS_ODDS_175_200")!.select, selectFootballLiveMltsOdds175200);
});

test("8. FOOTBALL_LIVE_MLTS_ODDS_175_200 price_max is exactly 4/7", () => {
  assert.equal(LIVE_B_STRATEGY.price_max, 4 / 7);
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 4 / 7 }), true);
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 4 / 7 + 1e-9 }), false);
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 0.5 }), false);
});

test("9. rollup MaxDD uses the chronological selected-bet sequence", () => {
  const mk = (day: string, at: string, id: string, pnl: number): BetPnlRow => ({ model_date: day, decision_at: at, candidate_identity: id, settlement_label: pnl > 0 ? "WIN" : "LOSS", pnl_u: pnl, strategy_key: "S@1" });
  const rows = [mk("2026-09-29", "2026-09-29T10:00Z", "d", -1), mk("2026-09-25", "2026-09-25T10:00Z", "a", 1), mk("2026-09-27", "2026-09-27T10:00Z", "c", -1), mk("2026-09-26", "2026-09-26T10:00Z", "b", -1)];
  assert.equal(chronologicalMaxDrawdown(rows), -3); // +1,-1,-1,-1 => peak 1 -> trough -2 => dd -3
  const r = buildRollups("2026-09-29", [{ strategy_id: "S", strategy_version: "1" }], new Map([["S@1", rows]]), "t");
  const by = Object.fromEntries(r.map((x) => [x.window_kind, x]));
  assert.equal(by["LIFETIME"].max_dd_u, -3);
  assert.equal(by["7D"].max_dd_u, -3);
  assert.equal(by["1D"].selected_n, 1);
  assert.equal(by["1D"].max_dd_u, -1);
  assert.deepEqual(r.map((x) => x.window_kind), ["1D", "7D", "14D", "30D", "LIFETIME"]);
  assert.equal(by["LIFETIME"].period_start, BOOTSTRAP_START);
});

test("10. freshness gate fails if strategy_daily is behind MODEL_READY", async () => {
  assert.equal(evaluateFreshness({ latestModelReadyDay: D2, latestStrategyDailyDay: D1, latestRollupDay: D2, latestDashboardDay: D2 }).pass, false);
  assert.equal(evaluateFreshness({ latestModelReadyDay: D2, latestStrategyDailyDay: D2, latestRollupDay: D2, latestDashboardDay: D2 }).pass, true);
  const deps = fakeDeps({ ready: [D1, D2], daily: [D1], ctxByDate: { [D2]: ctxOf([]) } });
  deps.upsertDaily = async () => {}; // daily write silently lost => stale
  await assert.rejects(runConveyor(deps, { bootstrapThrough: null }), /CONVEYOR_FRESHNESS_GATE_FAILED:STRATEGY_DAILY_BEHIND_MODEL_READY/);
  assert.equal(deps.jobRuns(), 1);
});

test("11. normal nightly mode never invokes bootstrap", async () => {
  assert.deepEqual(parseConveyorArgs([]), { bootstrapThrough: null });
  assert.deepEqual(parseConveyorArgs(["--bootstrap-through=2026-09-29"]), { bootstrapThrough: "2026-09-29" });
  const deps = fakeDeps({ ready: [D1], daily: [] });
  await assert.rejects(runConveyor(deps, { bootstrapThrough: null }), /CONVEYOR_NORMAL_MODE_REQUIRES_PRIOR_BOOTSTRAP/);
  assert.ok(!deps.calls.includes("frozen"));
  const many = fakeDeps({ ready: Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`), daily: ["2026-08-04"] });
  await assert.rejects(runConveyor(many, { bootstrapThrough: null }), /CONVEYOR_MISSING_DAYS_EXCEED_BOUND/);
  assert.ok(!many.calls.includes("frozen"));
  assert.deepEqual(missingDates(["a", "b", "c"], ["b"]), ["a", "c"]);
  const railway = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.doesNotMatch(pkg.scripts["research-clone:modeling-conveyor"], /bootstrap/);
  assert.doesNotMatch(railway, /--bootstrap/);
});

test("12. Railway runs the conveyor only after direct model-ready succeeds, then runtime dashboard refresh", () => {
  const line = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8").split("\n").find((l) => l.startsWith("startCommand"))!;
  const cmd = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
  assert.equal(
    cmd,
    "npm run research-clone:sync && npm run research-clone:model-ready; npm run research-clone:model-ready-direct && npm run research-clone:modeling-conveyor && npm run research-clone:modeling-dashboard-refresh -- --runtime-only",
  );
  assert.ok(cmd.indexOf("model-ready-direct &&") < cmd.indexOf("modeling-conveyor"));
  assert.doesNotMatch(cmd, /model-ready;\s*npm run research-clone:modeling-conveyor/);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["research-clone:modeling-conveyor"], "tsx scripts/modeling/run-d1-modeling-conveyor.ts");
});

test("13. dashboard runtime is fed from rollups and needs no daily Git artifact write", async () => {
  const deps = fakeDeps({ ready: [D1], daily: [D1], dashboardDay: null });
  let published: RollupRow[] | null = null;
  const orig = deps.publishDashboard;
  deps.publishDashboard = async (asOf, r, f) => { published = r; await orig(asOf, r, f); };
  const res = await runConveyor(deps, { bootstrapThrough: null });
  assert.equal(published!.length, ACTIVE_D1_FOOTBALL_STRATEGIES.length * 5);
  assert.equal(res.freshness.latestDashboardDay, D1);
  for (const f of ["core", "db", "runner"].map((s) => s === "runner" ? "run-d1-modeling-conveyor" : `d1-modeling-conveyor-${s}`)) {
    const src = readFileSync(`scripts/modeling/${f}.ts`, "utf8");
    assert.doesNotMatch(src, /writeFileSync|mkdirSync|appendFileSync/, f);
  }
});

test("14. causal portfolio has a distinct version and never retro-replaces an earlier-day fallback", () => {
  const port = ACTIVE_D1_FOOTBALL_STRATEGIES.find((s) => s.strategy_id === "FOOTBALL_LIVE_MLTS_175_200_THEN_MLTS_185_200")!;
  assert.equal(port.strategy_version, "D1_CAUSAL_V1");
  assert.equal(port.dayCausal, true);
  // Same physical event on two days: the day-1 selection stays; the day-2 row must not replace it.
  const d1 = cand({ date: D1, event: "eX", cond: "c1", p: 0.52, at: `${D1}T10:00:00.000Z`, market: "moneyline" });
  const d2 = cand({ date: D2, event: "eX", cond: "c2", p: 0.55, at: `${D2}T10:00:00.000Z`, market: "moneyline" });
  const facts = scoreContext(ctxOf([d1, d2]), new Map(), "t", [port]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].model_date, D1);
});
