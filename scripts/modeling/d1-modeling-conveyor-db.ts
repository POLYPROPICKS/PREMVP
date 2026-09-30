/**
 * AUTOMATED_D1_MODELING_CONVEYOR_V1 — research-clone IO adapter. Writes ONLY the
 * three research_strategy_* tables, the CURRENT runtime snapshot row and one
 * job_runs record, all on the research clone. Every read is date- or
 * identity-bounded; every request aborts at 60s.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";

import {
  buildOverlayRecord,
  buildProviderCodeSportMap,
  buildMarketTypeResolverIndex,
  explicitSportFamily,
  norm,
  obj,
  reconcileSport,
  resolveMarketType,
  type GspMarketTypeEntry,
  type OverlayRecord,
  type SourceRow,
} from "./build-football-denominator-reconciliation";
import {
  readEvidencePageMarketTypes,
  readGspMarketTypeIndex,
  readPartitionedSourceDateFromDb,
  readSnapshotMarketTypes,
} from "./build-football-denominator-reconciliation-v2";
import { loadFrozenFootballDenominatorV2, loadFrozenOverlayV2 } from "./load-frozen-football-denominator-v2";
import { buildStructuralCandidates } from "./football-structural-authority";
import {
  buildCommonSettlement,
  buildRunContext,
  buildSafeUniverseV2,
  type RunContext,
} from "./football-strategy-registry";
import { fetchTennisIdentityLookup } from "./tennis-safe-comparable-leaderboard";
import { mapWithConcurrency, projectRef, resolveGammaTerminal } from "./live-d1-research-corpus";
import {
  CONVEYOR_SOURCE,
  type BetPnlRow,
  type ConveyorDeps,
  type DailyRow,
  type FreshnessInput,
  type OpenBetRef,
  type RollupRow,
  type SelectedBetFact,
} from "./d1-modeling-conveyor-core";
import { strategyKey } from "./active-d1-football-strategies";

export const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
export const DB_READ_TIMEOUT_MS = 60_000;
const PAGE = 1000;
const WRITE_PAGE = 500;
const ID_CHUNK = 150;
const GAMMA_TIMEOUT_MS = 30_000;
const FORMULA_VERSION = "d1-modeling-conveyor-v1";

export function connectConveyorClone(): SupabaseClient {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_AUTHORIZATION_UNAVAILABLE");
  if (projectRef(url) !== EXPECTED_CLONE_REF || (process.env.SUPABASE_URL && projectRef(process.env.SUPABASE_URL) === projectRef(url))) {
    throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Fail fast: no single request may hang past the bound.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_READ_TIMEOUT_MS) }) },
  });
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

function must<T>(res: { data: T | null; error: { code?: string; message: string } | null }, ctx: string): T {
  if (res.error) throw new Error(`${ctx}:${res.error.code ?? res.error.message}`);
  return res.data as T;
}

/** Keyset pages over the compact selected-bet table (never the candidate corpus). */
async function readBetPages(
  db: SupabaseClient,
  build: (q: any) => any,
  select: string,
): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  let cursor: { model_date: string; physical_event_id: string; strategy_id: string; strategy_version: string } | null = null;
  for (;;) {
    let q = build(db.from("research_strategy_selected_bets").select(select))
      .order("model_date").order("strategy_id").order("strategy_version").order("physical_event_id").limit(PAGE);
    if (cursor) {
      const c = cursor;
      q = q.or(
        `model_date.gt.${c.model_date},` +
        `and(model_date.eq.${c.model_date},strategy_id.gt.${c.strategy_id}),` +
        `and(model_date.eq.${c.model_date},strategy_id.eq.${c.strategy_id},strategy_version.gt.${c.strategy_version}),` +
        `and(model_date.eq.${c.model_date},strategy_id.eq.${c.strategy_id},strategy_version.eq.${c.strategy_version},physical_event_id.gt.${c.physical_event_id})`,
      );
    }
    const rows = must(await q, "CONVEYOR_BET_READ") as Array<Record<string, any>>;
    out.push(...rows);
    if (rows.length < PAGE) return out;
    const last = rows[rows.length - 1];
    cursor = { model_date: last.model_date, physical_event_id: last.physical_event_id, strategy_id: last.strategy_id, strategy_version: last.strategy_version };
  }
}

const BET_PNL_SELECT = "model_date,strategy_id,strategy_version,physical_event_id,decision_at,candidate_identity,settlement_label,pnl_u";
const toPnlRow = (r: Record<string, any>): BetPnlRow => ({
  model_date: r.model_date,
  decision_at: r.decision_at,
  candidate_identity: r.candidate_identity,
  settlement_label: r.settlement_label,
  pnl_u: r.pnl_u,
  strategy_key: strategyKey(r.strategy_id, r.strategy_version),
});

/** Sport-recovery seed: explicit (sport, provider code) pairs from the frozen overlay — no DB scan. */
let frozenCodeSeed: SourceRow[] | null = null;
function frozenProviderCodeSeed(): SourceRow[] {
  if (frozenCodeSeed) return frozenCodeSeed;
  const { overlay } = loadFrozenOverlayV2();
  frozenCodeSeed = overlay
    .filter((o: OverlayRecord) => o.sport_reconciliation_basis === "SPORT_EXPLICIT" && o.provider_sport_code !== null)
    .map((o: OverlayRecord) => ({
      model_date: o.model_date, population_id: o.population_id, condition_id: o.condition_id,
      selected_token_id: o.selected_token_id, decision_at: o.decision_at, provider_event_id: o.provider_event_id,
      sport_family: o.source_sport_family, settlement_label: null, entry_price_num: null,
      canonical_row: { providerSportCode: o.provider_sport_code },
    }));
  return frozenCodeSeed;
}

export async function classifyOneDay(db: SupabaseClient, date: string, seed: SourceRow[] = frozenProviderCodeSeed()): Promise<RunContext> {
  const rows = await readPartitionedSourceDateFromDb(db, date);
  const codeMap = buildProviderCodeSportMap([...seed, ...rows]);

  // Market-type lineage ONLY for soccer rows lacking a direct canonical type.
  const fallbackRows = rows.filter((r) => {
    if (explicitSportFamily(r).conflict) return false;
    return reconcileSport(r, codeMap).reconciled === "soccer" && norm(obj(r.canonical_row).marketTypeRaw) === null;
  });
  const empty = new Map<string, GspMarketTypeEntry[]>();
  let gspIndex = empty;
  let resolver = buildMarketTypeResolverIndex(rows, [], [], empty);
  if (fallbackRows.length > 0) {
    const keys = new Set(fallbackRows.map((r) => `${r.condition_id}::${r.selected_token_id}`));
    const snapshots = await readSnapshotMarketTypes(db, keys);
    const snapResolver = buildMarketTypeResolverIndex(rows, snapshots, [], empty);
    const gspKeys = new Set(fallbackRows.filter((r) => resolveMarketType(r, empty, snapResolver).basis === "MARKET_TYPE_UNRESOLVED").map((r) => `${r.condition_id}::${r.selected_token_id}`));
    gspIndex = gspKeys.size ? await readGspMarketTypeIndex(db, gspKeys) : empty;
    const gspResolver = buildMarketTypeResolverIndex(rows, snapshots, [], gspIndex);
    const evKeys = new Set(fallbackRows.filter((r) => resolveMarketType(r, gspIndex, gspResolver).basis === "MARKET_TYPE_UNRESOLVED").map((r) => `${r.condition_id}::${r.selected_token_id}`));
    const evidence = evKeys.size ? await readEvidencePageMarketTypes(db, evKeys) : [];
    resolver = buildMarketTypeResolverIndex(rows, snapshots, evidence, gspIndex);
  }
  const overlay = rows.map((r) => buildOverlayRecord(r, codeMap, gspIndex, resolver));
  const { candidates } = buildStructuralCandidates(rows, overlay);
  const preliminary = buildSafeUniverseV2(rows, overlay, () => null);
  const lookup = preliminary.tennisConditionIds.length ? await fetchTennisIdentityLookup(db, preliminary.tennisConditionIds) : () => null;
  const safeUniverse = buildSafeUniverseV2(rows, overlay, lookup).safeUniverse;
  return { structural: candidates, safeUniverse, settlement: buildCommonSettlement(rows) };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<"TIMEOUT">((r) => { t = setTimeout(() => r("TIMEOUT"), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t!); }
}

export function createDbDeps(db: SupabaseClient): ConveyorDeps {
  const upsertChunked = async (table: string, rows: object[], onConflict: string) => {
    for (const c of chunks(rows, WRITE_PAGE)) {
      const { error } = await db.from(table).upsert(c, { onConflict });
      if (error) throw new Error(`CONVEYOR_WRITE_${table}:${error.code ?? error.message}`);
    }
  };
  return {
    now: () => new Date(),
    log: (s) => console.error(JSON.stringify(s)),

    async listReadyDates() {
      const data = must(await db.from("research_model_ready_days").select("model_date").eq("status", "MODEL_READY").order("model_date").limit(PAGE), "CONVEYOR_READY_DAYS");
      return (data as Array<{ model_date: string }>).map((r) => r.model_date);
    },
    async listDailyDates() {
      const data = must(await db.from("research_strategy_daily").select("model_date").order("model_date", { ascending: false }).limit(PAGE), "CONVEYOR_DAILY_DAYS");
      return [...new Set((data as Array<{ model_date: string }>).map((r) => r.model_date))];
    },
    classifyDay: (date) => classifyOneDay(db, date),

    async readClaims(eventIds, beforeDate) {
      const claims = new Map<string, Set<string>>();
      for (const c of chunks(eventIds, ID_CHUNK)) {
        const data = must(
          await db.from("research_strategy_selected_bets").select("strategy_id,strategy_version,physical_event_id").in("physical_event_id", c).lt("model_date", beforeDate).limit(PAGE * 10),
          "CONVEYOR_CLAIMS",
        ) as Array<{ strategy_id: string; strategy_version: string; physical_event_id: string }>;
        for (const r of data) {
          const k = strategyKey(r.strategy_id, r.strategy_version);
          if (!claims.has(k)) claims.set(k, new Set());
          claims.get(k)!.add(r.physical_event_id);
        }
      }
      return claims;
    },

    async loadFrozenContext() {
      const frozen = await loadFrozenFootballDenominatorV2(db);
      const preliminary = buildSafeUniverseV2(frozen.sourceRows, frozen.overlay, () => null);
      const lookup = await fetchTennisIdentityLookup(db, preliminary.tennisConditionIds);
      return buildRunContext(frozen.sourceRows, frozen.overlay, lookup);
    },

    upsertBets: (rows: SelectedBetFact[]) =>
      upsertChunked("research_strategy_selected_bets", rows, "strategy_id,strategy_version,model_date,physical_event_id"),

    async listOpenBets() {
      const rows = await readBetPages(db, (q) => q.eq("settlement_label", "OPEN"), "model_date,strategy_id,strategy_version,physical_event_id,candidate_identity,condition_id,selected_token_id,entry_price_num");
      const uniq = new Map<string, OpenBetRef>();
      for (const r of rows) uniq.set(r.candidate_identity, r as OpenBetRef);
      return [...uniq.values()];
    },
    async resolveTerminal(ref) {
      const r = await withTimeout(resolveGammaTerminal(ref.condition_id, ref.selected_token_id, ref.entry_price_num), GAMMA_TIMEOUT_MS);
      if (r === "TIMEOUT") return null; // fail closed: stays OPEN, retried next night
      return r.terminal === "WIN" || r.terminal === "LOSS" ? r.terminal : null;
    },
    async applySettlement(ref, label, pnlU, computedAt) {
      // Settlement fields only; identity/selection columns are never written here.
      const { error } = await db.from("research_strategy_selected_bets")
        .update({ settlement_label: label, pnl_u: pnlU, computed_at: computedAt })
        .eq("candidate_identity", ref.candidate_identity)
        .eq("settlement_label", "OPEN");
      if (error) throw new Error(`CONVEYOR_SETTLEMENT_WRITE:${error.code ?? error.message}`);
    },

    async readBetsForDates(dates) {
      const out = new Map<string, BetPnlRow[]>();
      for (const c of chunks(dates, 7)) {
        const rows = await readBetPages(db, (q) => q.in("model_date", c), BET_PNL_SELECT);
        for (const r of rows) {
          if (!out.has(r.model_date)) out.set(r.model_date, []);
          out.get(r.model_date)!.push(toPnlRow(r));
        }
      }
      return out;
    },
    upsertDaily: (rows: DailyRow[]) => upsertChunked("research_strategy_daily", rows, "model_date,strategy_id,strategy_version"),

    async readAllBets(asOf) {
      const rows = await readBetPages(db, (q) => q.lte("model_date", asOf), BET_PNL_SELECT);
      const out = new Map<string, BetPnlRow[]>();
      for (const r of rows) {
        const p = toPnlRow(r);
        if (!out.has(p.strategy_key!)) out.set(p.strategy_key!, []);
        out.get(p.strategy_key!)!.push(p);
      }
      return out;
    },
    upsertRollups: (rows: RollupRow[]) => upsertChunked("research_strategy_rollups", rows, "as_of_date,window_kind,strategy_id,strategy_version"),

    async publishDashboard(asOf, rollups, freshness) {
      const cur = must(await db.from("prospective_selection_shadow_runtime").select("snapshot_payload").eq("row_key", "CURRENT").eq("row_kind", "SNAPSHOT").limit(1).maybeSingle(), "CONVEYOR_RUNTIME_READ") as { snapshot_payload?: Record<string, unknown> } | null;
      const windows: Record<string, unknown[]> = {};
      for (const r of rollups) {
        (windows[r.window_kind] ??= []).push({
          strategy_id: r.strategy_id, strategy_version: r.strategy_version, period_start: r.period_start, period_end: r.period_end,
          selected_n: r.selected_n, settled_n: r.settled_n, open_n: r.open_n, wins: r.wins, losses: r.losses,
          pnl_u: r.pnl_u, roi_pct: r.roi_pct, max_dd_u: r.max_dd_u,
        });
      }
      const refreshedAt = new Date().toISOString();
      const payload = { ...(cur?.snapshot_payload ?? {}), strategyRollups: { source: CONVEYOR_SOURCE, asOfDate: asOf, refreshedAt, freshness, windows } };
      const { error } = await db.from("prospective_selection_shadow_runtime").upsert(
        { row_key: "CURRENT", row_kind: "SNAPSHOT", snapshot_payload: payload, updated_at: refreshedAt },
        { onConflict: "row_key" },
      );
      if (error) throw new Error(`CONVEYOR_RUNTIME_WRITE:${error.code ?? error.message}`);
    },

    async readFreshness(): Promise<FreshnessInput> {
      const latest = async (table: string, col: string, extra?: (q: any) => any) => {
        const q = db.from(table).select(col);
        const data = must(await (extra ? extra(q) : q).order(col, { ascending: false }).limit(1), `CONVEYOR_FRESH_${table}`) as unknown as Array<Record<string, string>>;
        return data[0]?.[col] ?? null;
      };
      const snap = must(await db.from("prospective_selection_shadow_runtime").select("snapshot_payload").eq("row_key", "CURRENT").eq("row_kind", "SNAPSHOT").limit(1).maybeSingle(), "CONVEYOR_FRESH_RUNTIME") as { snapshot_payload?: { strategyRollups?: { asOfDate?: string } } } | null;
      return {
        latestModelReadyDay: await latest("research_model_ready_days", "model_date", (q) => q.eq("status", "MODEL_READY")),
        latestStrategyDailyDay: await latest("research_strategy_daily", "model_date"),
        latestRollupDay: await latest("research_strategy_rollups", "as_of_date"),
        latestDashboardDay: snap?.snapshot_payload?.strategyRollups?.asOfDate ?? null,
      };
    },

    async recordJobRun(status, diagnostics, durationMs) {
      const now = new Date().toISOString();
      const { error } = await db.from("job_runs").insert({
        source: CONVEYOR_SOURCE, formula_version: FORMULA_VERSION, started_at: new Date(Date.now() - durationMs).toISOString(), finished_at: now,
        status, generated_count: 0, rejected_count: 0, duration_ms: durationMs, diagnostics,
      });
      if (error) throw new Error(`CONVEYOR_JOB_RUN_WRITE:${error.code ?? error.message}`);
    },
  };
}

export { mapWithConcurrency };
