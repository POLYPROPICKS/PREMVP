/**
 * AUTOMATED_D1_MODELING_CONVEYOR_V1 — pure, DB-free core: day scoring with
 * cross-day physical-event claims, daily aggregates, windowed rollups over
 * compact selected bets (chronological MaxDD), and the freshness gate.
 */
import { createHash } from "node:crypto";

import { marketBucketOf } from "./football-structural-authority";
import { settledPnlU, roiPct, type RunContext } from "./football-strategy-registry";
import type { SelectedCandidate } from "./daily-portfolio-frontier";
import { ACTIVE_D1_FOOTBALL_STRATEGIES, strategyKey, type ActiveStrategy } from "./active-d1-football-strategies";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

export const CONVEYOR_SOURCE = "automated-d1-modeling-conveyor-v1";
export const WINDOW_KINDS = ["1D", "7D", "14D", "30D", "LIFETIME"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];
export const BOOTSTRAP_START = "2026-08-04";
/** A normal (non-bootstrap) run refuses to score more than this many missing days. */
export const MAX_NORMAL_MISSING_DAYS = 14;

export interface SelectedBetFact {
  model_date: string;
  strategy_id: string;
  strategy_version: string;
  physical_event_id: string;
  candidate_identity: string;
  condition_id: string;
  selected_token_id: string;
  decision_at: string;
  entry_price_num: number;
  market_family: string;
  settlement_label: CorpusLabel;
  pnl_u: number | null;
  computed_at: string;
}

/** Compact projection used by daily/rollup math. */
export interface BetPnlRow {
  model_date: string;
  decision_at: string;
  candidate_identity: string;
  settlement_label: string;
  pnl_u: number | null;
  /** strategyKey(id, version); set by the reader when rows of several strategies are mixed. */
  strategy_key?: string;
}

const round = (v: number, dp = 6): number => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export const pnlFor = (label: string, entryPrice: number): number | null =>
  label === "WIN" || label === "LOSS" ? settledPnlU(label, entryPrice) : null;

/** Drop candidates whose physical event this strategy already owns (earlier days). */
export function stripClaimed(ctx: RunContext, claimed: ReadonlySet<string>): RunContext {
  if (claimed.size === 0) return ctx;
  return {
    ...ctx,
    structural: ctx.structural.filter((c) => !claimed.has(c.physicalEventKey)),
    safeUniverse: ctx.safeUniverse.filter((c) => !claimed.has(c.physicalEventKey)),
  };
}

/** Apply a day-causal selector one model_date at a time, accumulating its own claims. */
export function selectDayCausal(s: ActiveStrategy, ctx: RunContext, initialClaimed: ReadonlySet<string>): SelectedCandidate[] {
  const dates = [...new Set([...ctx.structural, ...ctx.safeUniverse].map((c) => c.modelDate))].sort();
  const claimed = new Set(initialClaimed);
  const out: SelectedCandidate[] = [];
  for (const d of dates) {
    const dayCtx: RunContext = {
      ...ctx,
      structural: ctx.structural.filter((c) => c.modelDate === d),
      safeUniverse: ctx.safeUniverse.filter((c) => c.modelDate === d),
    };
    for (const sel of s.select(stripClaimed(dayCtx, claimed))) {
      claimed.add(sel.physicalEventKey);
      out.push(sel);
    }
  }
  return out;
}

/**
 * Score a context (one day incrementally, or the frozen corpus once at bootstrap). Selection uses the frozen selectors; the
 * previously claimed physical events are removed BEFORE selection (identical to
 * the chronological claim the frozen full-corpus runner would have made).
 */
export function scoreContext(
  ctx: RunContext,
  claimedByStrategy: ReadonlyMap<string, ReadonlySet<string>>,
  computedAt: string,
  strategies: ActiveStrategy[] = ACTIVE_D1_FOOTBALL_STRATEGIES,
): SelectedBetFact[] {
  const structuralByIdentity = new Map(ctx.structural.map((c) => [c.candidateIdentity, c] as const));
  const safeByIdentity = new Map(ctx.safeUniverse.map((c) => [c.candidateIdentity, c] as const));
  const out: SelectedBetFact[] = [];
  for (const s of strategies) {
    const key = strategyKey(s.strategy_id, s.strategy_version);
    const claimed = claimedByStrategy.get(key) ?? new Set<string>();
    const selected = s.dayCausal ? selectDayCausal(s, ctx, claimed) : s.select(stripClaimed(ctx, claimed));
    const seen = new Set<string>();
    for (const sel of selected) {
      if (claimed.has(sel.physicalEventKey)) throw new Error(`CONVEYOR_CLAIMED_EVENT_RESELECTED:${key}:${sel.physicalEventKey}`);
      if (seen.has(sel.physicalEventKey)) throw new Error(`CONVEYOR_DUPLICATE_PHYSICAL_EVENT:${key}:${sel.physicalEventKey}`);
      seen.add(sel.physicalEventKey);
      const label = ctx.settlement.get(sel.candidateIdentity);
      if (label === undefined) throw new Error(`CONVEYOR_SETTLEMENT_JOIN_MISS:${sel.candidateIdentity}`);
      const cand = structuralByIdentity.get(sel.candidateIdentity) ?? safeByIdentity.get(sel.candidateIdentity);
      if (!cand) throw new Error(`CONVEYOR_SELECTED_IDENTITY_NOT_IN_CONTEXT:${sel.candidateIdentity}`);
      const marketType = (cand.marketTypeRaw as string | null | undefined) ?? null;
      out.push({
        model_date: cand.modelDate,
        strategy_id: s.strategy_id,
        strategy_version: s.strategy_version,
        physical_event_id: sel.physicalEventKey,
        candidate_identity: sel.candidateIdentity,
        condition_id: String(sel.ref ?? ""),
        selected_token_id: String(sel.candidateRef ?? ""),
        decision_at: sel.decisionTimestamp,
        entry_price_num: sel.entryPrice,
        market_family: marketBucketOf(marketType),
        settlement_label: label,
        pnl_u: pnlFor(label, sel.entryPrice),
        computed_at: computedAt,
      });
    }
  }
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function chronologicalMaxDrawdown(rows: BetPnlRow[]): number {
  const settled = rows
    .filter((r) => r.pnl_u !== null && (r.settlement_label === "WIN" || r.settlement_label === "LOSS"))
    .sort((a, b) => a.decision_at.localeCompare(b.decision_at) || a.candidate_identity.localeCompare(b.candidate_identity));
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of settled) {
    cum += r.pnl_u as number;
    if (cum > peak) peak = cum;
    if (cum - peak < maxDd) maxDd = cum - peak;
  }
  return round(maxDd);
}

export interface Aggregate {
  selected_n: number;
  settled_n: number;
  open_n: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_dd_u: number;
}

export function aggregate(rows: BetPnlRow[]): Aggregate {
  const wins = rows.filter((r) => r.settlement_label === "WIN").length;
  const losses = rows.filter((r) => r.settlement_label === "LOSS").length;
  const pnl = rows.reduce((a, r) => a + (r.pnl_u ?? 0), 0);
  const settled = wins + losses;
  return {
    selected_n: rows.length,
    settled_n: settled,
    open_n: rows.filter((r) => r.settlement_label === "OPEN").length,
    wins,
    losses,
    pnl_u: round(pnl),
    roi_pct: round(roiPct(pnl, settled), 4),
    max_dd_u: chronologicalMaxDrawdown(rows),
  };
}

export interface DailyRow extends Omit<Aggregate, "max_dd_u"> {
  model_date: string;
  strategy_id: string;
  strategy_version: string;
  daily_max_dd_u: number;
  selection_digest: string;
  computed_at: string;
}

/** Digest over selected identities ONLY — settlement changes never alter it. */
export const selectionDigest = (identities: string[]): string =>
  createHash("sha256").update([...identities].sort().join("\n")).digest("hex");

export function dailyRow(
  modelDate: string,
  strategy: { strategy_id: string; strategy_version: string },
  bets: Array<BetPnlRow>,
  computedAt: string,
): DailyRow {
  const { max_dd_u, ...a } = aggregate(bets);
  return {
    model_date: modelDate,
    strategy_id: strategy.strategy_id,
    strategy_version: strategy.strategy_version,
    ...a,
    daily_max_dd_u: max_dd_u,
    selection_digest: selectionDigest(bets.map((b) => b.candidate_identity)),
    computed_at: computedAt,
  };
}

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function windowStart(kind: WindowKind, asOf: string, lifetimeStart: string): string {
  switch (kind) {
    case "1D": return asOf;
    case "7D": return addDays(asOf, -6);
    case "14D": return addDays(asOf, -13);
    case "30D": return addDays(asOf, -29);
    case "LIFETIME": return lifetimeStart;
  }
}

export interface RollupRow extends Aggregate {
  as_of_date: string;
  window_kind: WindowKind;
  strategy_id: string;
  strategy_version: string;
  period_start: string;
  period_end: string;
  computed_at: string;
}

/** Rollups computed ONLY from compact selected-bet rows (never candidate/source rows). */
export function buildRollups(
  asOf: string,
  strategies: Array<{ strategy_id: string; strategy_version: string }>,
  betsByStrategy: ReadonlyMap<string, BetPnlRow[]>,
  computedAt: string,
  lifetimeStart: string = BOOTSTRAP_START,
): RollupRow[] {
  const out: RollupRow[] = [];
  for (const s of strategies) {
    const all = (betsByStrategy.get(strategyKey(s.strategy_id, s.strategy_version)) ?? []).filter((b) => b.model_date <= asOf);
    for (const kind of WINDOW_KINDS) {
      const start = windowStart(kind, asOf, lifetimeStart);
      const inWindow = all.filter((b) => b.model_date >= start && b.model_date <= asOf);
      out.push({
        as_of_date: asOf,
        window_kind: kind,
        strategy_id: s.strategy_id,
        strategy_version: s.strategy_version,
        period_start: start,
        period_end: asOf,
        ...aggregate(inWindow),
        computed_at: computedAt,
      });
    }
  }
  return out;
}

// ── Freshness gate ──────────────────────────────────────────────────────────

export interface FreshnessInput {
  latestModelReadyDay: string | null;
  latestStrategyDailyDay: string | null;
  latestRollupDay: string | null;
  latestDashboardDay: string | null;
}

export function evaluateFreshness(f: FreshnessInput): { pass: boolean; stale: string[] } {
  const stale: string[] = [];
  if (!f.latestModelReadyDay) return { pass: false, stale: ["MODEL_READY_ABSENT"] };
  if (f.latestStrategyDailyDay !== f.latestModelReadyDay) stale.push("STRATEGY_DAILY_BEHIND_MODEL_READY");
  if (f.latestRollupDay !== f.latestModelReadyDay) stale.push("ROLLUPS_BEHIND_MODEL_READY");
  if (f.latestDashboardDay !== f.latestModelReadyDay) stale.push("DASHBOARD_BEHIND_MODEL_READY");
  return { pass: stale.length === 0, stale };
}

// ── Mode / planning ─────────────────────────────────────────────────────────

export interface ConveyorOptions {
  bootstrapThrough: string | null;
}

export function parseConveyorArgs(argv: string[]): ConveyorOptions {
  const eq = argv.find((a) => a.startsWith("--bootstrap-through="));
  const i = argv.indexOf("--bootstrap-through");
  const raw = eq ? eq.split("=")[1] : i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined) return { bootstrapThrough: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("CONVEYOR_BOOTSTRAP_DATE_INVALID");
  return { bootstrapThrough: raw };
}

/** MODEL_READY dates that have no strategy_daily row yet, ascending. */
export function missingDates(readyDates: string[], dailyDates: string[]): string[] {
  const have = new Set(dailyDates);
  return [...new Set(readyDates)].filter((d) => !have.has(d)).sort();
}

// ── Orchestration (all IO injected; tests use in-memory fakes) ──────────────

/** Last day of the frozen denominator-v2 prefix reused (never rebuilt) at bootstrap. */
export const FROZEN_PREFIX_END = "2026-09-24";

export interface OpenBetRef {
  candidate_identity: string;
  condition_id: string;
  selected_token_id: string;
  entry_price_num: number;
  model_date: string;
}

export interface ConveyorDeps {
  now(): Date;
  listReadyDates(): Promise<string[]>;
  listDailyDates(): Promise<string[]>;
  /** Narrow, date-bounded classification of exactly ONE model date. */
  classifyDay(date: string): Promise<RunContext>;
  /** Strategy claims (physical events) made strictly before `beforeDate`, for the given events only. */
  readClaims(eventIds: string[], beforeDate: string): Promise<Map<string, Set<string>>>;
  /** ONE-TIME: frozen Aug04..Sep24 selected universe scored once (no lineage rebuild). */
  loadFrozenContext(): Promise<RunContext>;
  upsertBets(rows: SelectedBetFact[]): Promise<void>;
  listOpenBets(): Promise<OpenBetRef[]>;
  /** Authoritative terminal settlement for an OPEN identity; null = still open. */
  resolveTerminal(ref: OpenBetRef): Promise<"WIN" | "LOSS" | null>;
  applySettlement(ref: OpenBetRef, label: "WIN" | "LOSS", pnlU: number, computedAt: string): Promise<void>;
  readBetsForDates(dates: string[]): Promise<Map<string, BetPnlRow[]>>;
  upsertDaily(rows: DailyRow[]): Promise<void>;
  readAllBets(asOf: string): Promise<Map<string, BetPnlRow[]>>;
  upsertRollups(rows: RollupRow[]): Promise<void>;
  publishDashboard(asOf: string, rollups: RollupRow[], freshness: { status: string }): Promise<void>;
  readFreshness(): Promise<FreshnessInput>;
  recordJobRun(status: "success" | "failed", diagnostics: Record<string, unknown>, durationMs: number): Promise<void>;
  log(stage: Record<string, unknown>): void;
}

export interface ConveyorResult {
  ok: boolean;
  mode: "NORMAL" | "BOOTSTRAP";
  asOf: string | null;
  scoredDates: string[];
  stageMs: Record<string, number>;
  freshness: FreshnessInput & { stale: string[] };
  counts: Record<string, number>;
}

function candidateEventIds(ctx: RunContext): string[] {
  return [...new Set([...ctx.structural, ...ctx.safeUniverse].map((c) => c.physicalEventKey))].sort();
}

export async function runConveyor(
  deps: ConveyorDeps,
  opts: ConveyorOptions,
  strategies: ActiveStrategy[] = ACTIVE_D1_FOOTBALL_STRATEGIES,
): Promise<ConveyorResult> {
  const startedAt = Date.now();
  const stageMs: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { return await fn(); } finally {
      stageMs[name] = (stageMs[name] ?? 0) + Date.now() - t0;
      deps.log({ STAGE: name, MS: stageMs[name] });
    }
  };
  const mode = opts.bootstrapThrough ? "BOOTSTRAP" : "NORMAL";
  const computedAt = deps.now().toISOString();
  const touched = new Set<string>();
  const scoredDates: string[] = [];
  let asOf: string | null = null;

  try {
    const { ready, missing } = await timed("missing-date-resolve", async () => {
      const ready = (await deps.listReadyDates()).filter((d) => d >= BOOTSTRAP_START).sort();
      const daily = await deps.listDailyDates();
      if (opts.bootstrapThrough) {
        const through = opts.bootstrapThrough;
        if (through < FROZEN_PREFIX_END) throw new Error("CONVEYOR_BOOTSTRAP_BEFORE_FROZEN_PREFIX");
        const suffix = ready.filter((d) => d > FROZEN_PREFIX_END && d <= through);
        return { ready: ready.filter((d) => d <= through), missing: suffix };
      }
      if (daily.length === 0) throw new Error("CONVEYOR_NORMAL_MODE_REQUIRES_PRIOR_BOOTSTRAP");
      const missing = missingDates(ready, daily);
      if (missing.length > MAX_NORMAL_MISSING_DAYS) throw new Error(`CONVEYOR_MISSING_DAYS_EXCEED_BOUND:${missing.length}`);
      return { ready, missing };
    });
    asOf = ready.at(-1) ?? null;
    counts.missing_dates = missing.length;

    // ── Bootstrap prefix: frozen selected universe scored ONCE, no lineage rebuild.
    if (opts.bootstrapThrough) {
      await timed("strategy-scoring", async () => {
        const ctx = await deps.loadFrozenContext();
        const facts = scoreContext(ctx, new Map(), computedAt, strategies);
        await deps.upsertBets(facts);
        counts.frozen_prefix_bets = facts.length;
        for (const f of facts) touched.add(f.model_date);
      });
    }

    // ── Incremental suffix: only missing days, ascending (claims are causal).
    for (const date of missing) {
      const ctx = await timed("daily-classification", () => deps.classifyDay(date));
      await timed("strategy-scoring", async () => {
        const claims = await deps.readClaims(candidateEventIds(ctx), date);
        const facts = scoreContext(ctx, claims, computedAt, strategies);
        await deps.upsertBets(facts);
        counts.new_bets = (counts.new_bets ?? 0) + facts.length;
      });
      touched.add(date);
      scoredDates.push(date);
    }

    // ── Settlement reconciliation: selection immutable, settlement only.
    await timed("settlement-reconcile", async () => {
      const open = await deps.listOpenBets();
      counts.open_checked = open.length;
      let settled = 0;
      for (const ref of open) {
        const terminal = await deps.resolveTerminal(ref);
        if (terminal === null) continue;
        await deps.applySettlement(ref, terminal, settledPnlU(terminal, ref.entry_price_num), computedAt);
        touched.add(ref.model_date);
        settled++;
      }
      counts.newly_settled = settled;
    });

    // ── Daily aggregates for every touched date (zero rows kept so freshness is provable).
    await timed("daily-aggregates", async () => {
      const dates = [...new Set([...touched, ...missing])].sort();
      const byDate = await deps.readBetsForDates(dates);
      const rows: DailyRow[] = [];
      for (const d of dates) {
        const bets = byDate.get(d) ?? [];
        for (const s of strategies) {
          const mine = bets.filter((b) => b.strategy_key === strategyKey(s.strategy_id, s.strategy_version));
          rows.push(dailyRow(d, s, mine, computedAt));
        }
      }
      if (mode === "BOOTSTRAP") {
        const have = new Set(rows.map((r) => r.model_date));
        for (const d of ready) if (!have.has(d)) for (const s of strategies) rows.push(dailyRow(d, s, [], computedAt));
      }
      await deps.upsertDaily(rows);
      counts.daily_rows = rows.length;
    });

    // ── Rollups from compact selected bets only.
    let rollups: RollupRow[] = [];
    await timed("rollups", async () => {
      if (!asOf) return;
      const bets = await deps.readAllBets(asOf);
      rollups = buildRollups(asOf, strategies, bets, computedAt);
      await deps.upsertRollups(rollups);
      counts.rollup_rows = rollups.length;
    });

    // ── Dashboard runtime + freshness gate.
    const result = await timed("dashboard-freshness", async () => {
      const pre = await deps.readFreshness();
      const intended = { ...pre, latestDashboardDay: asOf };
      await deps.publishDashboard(asOf as string, rollups, { status: evaluateFreshness(intended).pass ? "FRESH" : "STALE" });
      const f = await deps.readFreshness();
      return { ...f, ...evaluateFreshness(f) };
    });

    const res: ConveyorResult = { ok: result.pass, mode, asOf, scoredDates, stageMs, freshness: result, counts };
    await deps.recordJobRun(result.pass ? "success" : "failed", { mode, asOf, scoredDates, stageMs, counts, freshness: result }, Date.now() - startedAt);
    if (!result.pass) throw Object.assign(new Error(`CONVEYOR_FRESHNESS_GATE_FAILED:${result.stale.join(",")}`), { result: res });
    return res;
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("CONVEYOR_FRESHNESS_GATE_FAILED"))) {
      try { await deps.recordJobRun("failed", { mode, error: e instanceof Error ? e.message : String(e), stageMs, counts }, Date.now() - startedAt); } catch { /* never mask the real error */ }
    }
    throw e;
  }
}
