/**
 * BUILD_OFFLINE_PLOTLY_MODEL_COMPARISON_DASHBOARD_V1 — thin presentation model.
 *
 * This module is a VIEW over already-calculated offline-replay analytical truth.
 * It is NOT a model engine. It MUST NOT:
 *   - select model bets;
 *   - calculate settlement / PnL / ROI / MaxDD / win-rate / concentration;
 *   - deduplicate physical events;
 *   - reconstruct Contract A;
 *   - invent missing segment economics.
 *
 * It MAY only: select fields, reshape JSON for presentation, sort display rows,
 * and format labels. Every number it emits is copied verbatim from a source
 * artifact produced by scripts/modeling/offline-replay.ts (runReplay()) and its
 * committed companion scripts.
 *
 * Source artifacts (all under modeling/evidence/offline-replay-plane-v1/):
 *   SEPTEMBER_TABLES.json          — primary: overall[] + grouped{} (by sport)
 *   CONTRACT_A_ATTRIBUTION_V1.json — Contract A selected-bet band breakdowns + ranked damage
 *   CONTRACT_A_CANDIDATES_V1.json  — Contract A correction-candidate comparison
 *   MANIFEST.json                  — window / field completeness / sha inventory
 */
import {
  MODEL_RUNTIME_CONTRACT,
  DASHBOARD_DEFAULT_MODELS,
  type ModelRuntimeContract,
} from "./policyRegistry";

/* ------------------------------------------------------------------ *
 * Normalised row shape used across every chart (verbatim passthrough) *
 * ------------------------------------------------------------------ */

export interface DashboardMetricRow {
  /** model identifier, exactly as it appears in its source artifact */
  model: string;
  /** which source artifact this row's numbers were copied from */
  source: "SEPTEMBER_TABLES.json" | "CONTRACT_A_CANDIDATES_V1.json";
  BETS: number;
  TERMINAL: number;
  UNRESOLVED: number;
  WINS: number;
  LOSSES: number;
  /** GROSS_BEFORE_FEES; null economics stay null, never 0 */
  PNL_U: number | null;
  ROI_PCT: number | null;
  MAX_DD_U: number | null;
  WIN_RATE_PCT: number | null;
  /** only present for the primary SEPTEMBER_TABLES rows */
  CONCENTRATION: number | null;
  REJECT_REASONS: Record<string, number> | null;
  /** current operator-surface status (from MODEL_RUNTIME_CONTRACT) */
  STATUS: string;
  /** whether the PRIMARY operator comparison renders this lane by default */
  DASHBOARD_DEFAULT_VISIBLE: boolean;
}

export interface DashboardSportRow {
  model: string;
  sport: string;
  BETS: number;
  TERMINAL: number;
  UNRESOLVED: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number | null;
  ROI_PCT: number | null;
  MAX_DD_U: number | null;
  WIN_RATE_PCT: number | null;
}

export interface DashboardBandRow {
  dimension: string; // by_entry_price | by_lead_time | ...
  bucket: string;
  BETS: number;
  TERMINAL: number;
  UNRESOLVED: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number | null;
  ROI_PCT: number | null;
  MAX_DD_U: number | null;
  WIN_RATE_PCT: number | null;
}

export interface DashboardRankedRow {
  RANK: number;
  CONTRACT_A_SEMANTIC: string;
  CURRENT_RULE: string;
  EVIDENCE: string;
  CURRENT_A_PNL: number | null;
  ABLATION_PNL: number | null;
  DELTA_PNL: number | null;
  CURRENT_A_ROI: number | null;
  ABLATION_ROI: number | null;
  DELTA_ROI_PP: number | null;
  VERDICT: string;
}

export interface DashboardMeta {
  mission: string;
  window: { from: string; to: string; as_of: string };
  economics_basis: string;
  determinism_hash: string;
  wall_clock_ms: number | null;
  days_loaded: string[];
  days_missing: string[];
  label_sources: Record<string, string>;
  counts: {
    IDENTITY_N: number;
    DISTINCT_PHYSICAL_EVENT_N: number;
    TERMINAL_LABELED_IDENTITY_N: number;
    UNRESOLVED_IDENTITY_N: number;
  };
  field_completeness: Record<string, number> | null;
}

export interface UnavailableDimension {
  dimension: string;
  reason: string;
}

export interface DashboardModel {
  meta: DashboardMeta;
  /** MODEL OVERVIEW / MODEL COMPARISON — every model, verbatim (default + research) */
  overallModels: DashboardMetricRow[];
  /** the 4 lanes the PRIMARY operator comparison renders by default */
  dashboardDefaultModels: string[];
  /** default-visible subset of overallModels, in canonical order */
  defaultModels: DashboardMetricRow[];
  /** the remaining models — research / hidden, not shown in the default plots */
  researchModels: DashboardMetricRow[];
  /** full per-model deterministic runtime contract (single authority) */
  runtimeContract: ModelRuntimeContract[];
  /** SPORT COMPARISON — model x sport, from SEPTEMBER_TABLES.grouped */
  sportRows: DashboardSportRow[];
  sports: string[];
  primaryModels: string[];
  candidateModels: string[];
  /** CONTRACT A DIAGNOSTICS */
  contractAAttribution: {
    baselineReproduced: unknown;
    bands: DashboardBandRow[];
    bandDimensions: string[];
    ranked: DashboardRankedRow[];
  };
  /** CONTRACT A CORRECTION COMPARISON */
  contractACandidates: {
    mission: string;
    decision: string | null;
    comparison: Array<Record<string, unknown>>;
    sportTable: Record<string, Record<string, Record<string, unknown>>>;
    marketTable: Record<string, Record<string, Record<string, unknown>>>;
  };
  unavailableDimensions: UnavailableDimension[];
}

/* ------------------------------------------------------------------ *
 * helpers — pure selection / reshaping, ZERO arithmetic on economics  *
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function asObj(v: unknown, ctx: string): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`dashboardModel: expected object for ${ctx}`);
  }
  return v as Json;
}

function asArr(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`dashboardModel: expected array for ${ctx}`);
  return v;
}

/** copy a number field verbatim; missing -> undefined, explicit null -> null */
function num(o: Json, key: string): number | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (v === undefined) return null;
  throw new Error(`dashboardModel: field "${key}" is not numeric/null (${typeof v})`);
}

function reqNum(o: Json, key: string, ctx: string): number {
  const v = o[key];
  if (typeof v !== "number") throw new Error(`dashboardModel: ${ctx} missing required numeric "${key}"`);
  return v;
}

function statusOf(model: string): { STATUS: string; DASHBOARD_DEFAULT_VISIBLE: boolean } {
  const c = MODEL_RUNTIME_CONTRACT[model];
  return c
    ? { STATUS: c.STATUS, DASHBOARD_DEFAULT_VISIBLE: c.DASHBOARD_DEFAULT_VISIBLE }
    : { STATUS: "UNREGISTERED", DASHBOARD_DEFAULT_VISIBLE: false };
}

/** SEPTEMBER_TABLES StandardResult -> normalised row (rename only, no math) */
function fromStandardResult(r: Json): DashboardMetricRow {
  return {
    model: String(r.MODEL),
    source: "SEPTEMBER_TABLES.json",
    ...statusOf(String(r.MODEL)),
    BETS: reqNum(r, "SIMULATED_BET_N", "overall row"),
    TERMINAL: reqNum(r, "TERMINAL_BET_N", "overall row"),
    UNRESOLVED: reqNum(r, "UNRESOLVED_BET_N", "overall row"),
    WINS: reqNum(r, "WINS", "overall row"),
    LOSSES: reqNum(r, "LOSSES", "overall row"),
    PNL_U: num(r, "GROSS_PNL_U"),
    ROI_PCT: num(r, "GROSS_ROI_PCT"),
    MAX_DD_U: num(r, "MAX_DD_U"),
    WIN_RATE_PCT: num(r, "WIN_RATE_PCT"),
    CONCENTRATION: num(r, "CONCENTRATION"),
    REJECT_REASONS:
      r.REJECT_REASONS && typeof r.REJECT_REASONS === "object"
        ? (r.REJECT_REASONS as Record<string, number>)
        : null,
  };
}

/** CONTRACT_A_CANDIDATES comparison_table row -> normalised row (rename only) */
function fromCandidateRow(r: Json): DashboardMetricRow {
  return {
    model: String(r.MODEL),
    source: "CONTRACT_A_CANDIDATES_V1.json",
    ...statusOf(String(r.MODEL)),
    BETS: reqNum(r, "BETS", "candidate row"),
    TERMINAL: reqNum(r, "TERMINAL", "candidate row"),
    UNRESOLVED: reqNum(r, "UNRESOLVED", "candidate row"),
    WINS: reqNum(r, "WINS", "candidate row"),
    LOSSES: reqNum(r, "LOSSES", "candidate row"),
    PNL_U: num(r, "PNL_U"),
    ROI_PCT: num(r, "ROI_PCT"),
    MAX_DD_U: num(r, "MAX_DD_U"),
    WIN_RATE_PCT: num(r, "WIN_RATE_PCT"),
    CONCENTRATION: null,
    REJECT_REASONS: null,
  };
}

function fromGroupedRow(model: string, r: Json): DashboardSportRow {
  return {
    model,
    sport: String(r.GROUP_KEY),
    BETS: reqNum(r, "SIMULATED_BET_N", "grouped row"),
    TERMINAL: reqNum(r, "TERMINAL_BET_N", "grouped row"),
    UNRESOLVED: reqNum(r, "UNRESOLVED_BET_N", "grouped row"),
    WINS: reqNum(r, "WINS", "grouped row"),
    LOSSES: reqNum(r, "LOSSES", "grouped row"),
    PNL_U: num(r, "GROSS_PNL_U"),
    ROI_PCT: num(r, "GROSS_ROI_PCT"),
    MAX_DD_U: num(r, "MAX_DD_U"),
    WIN_RATE_PCT: num(r, "WIN_RATE_PCT"),
  };
}

function fromBandRow(dimension: string, bucket: string, r: Json): DashboardBandRow {
  return {
    dimension,
    bucket,
    BETS: reqNum(r, "BETS", `${dimension} band`),
    TERMINAL: reqNum(r, "TERMINAL", `${dimension} band`),
    UNRESOLVED: reqNum(r, "UNRESOLVED", `${dimension} band`),
    WINS: reqNum(r, "WINS", `${dimension} band`),
    LOSSES: reqNum(r, "LOSSES", `${dimension} band`),
    PNL_U: num(r, "PNL_U"),
    ROI_PCT: num(r, "ROI_PCT"),
    MAX_DD_U: num(r, "MAX_DD_U"),
    WIN_RATE_PCT: num(r, "WIN_RATE_PCT"),
  };
}

/* ------------------------------------------------------------------ *
 * main builder                                                        *
 * ------------------------------------------------------------------ */

export interface DashboardSources {
  septemberTables: unknown;
  contractAAttribution: unknown;
  contractACandidates: unknown;
  manifest: unknown;
}

export function buildDashboardModel(sources: DashboardSources): DashboardModel {
  const sep = asObj(sources.septemberTables, "SEPTEMBER_TABLES.json");
  const attr = asObj(sources.contractAAttribution, "CONTRACT_A_ATTRIBUTION_V1.json");
  const cand = asObj(sources.contractACandidates, "CONTRACT_A_CANDIDATES_V1.json");
  const manifest = asObj(sources.manifest, "MANIFEST.json");

  const viewMeta = asObj(sep.view_meta, "SEPTEMBER_TABLES.view_meta");
  const counts = asObj(viewMeta.counts, "view_meta.counts");
  const window = asObj(manifest.window ?? sep.params ?? viewMeta, "window");

  const meta: DashboardMeta = {
    mission: String(sep.mission ?? "BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1"),
    window: {
      from: String(window.from ?? viewMeta.from),
      to: String(window.to ?? viewMeta.to),
      as_of: String(window.as_of ?? viewMeta.as_of),
    },
    economics_basis: String(sep.economics_basis ?? "GROSS_BEFORE_FEES"),
    determinism_hash: String(sep.determinism_hash ?? ""),
    wall_clock_ms: typeof sep.wall_clock_ms === "number" ? sep.wall_clock_ms : null,
    days_loaded: (asArr(viewMeta.days_loaded ?? [], "days_loaded") as string[]).map(String),
    days_missing: (asArr(viewMeta.days_missing ?? [], "days_missing") as string[]).map(String),
    label_sources: (viewMeta.label_sources as Record<string, string>) ?? {},
    counts: {
      IDENTITY_N: reqNum(counts, "IDENTITY_N", "counts"),
      DISTINCT_PHYSICAL_EVENT_N: reqNum(counts, "DISTINCT_PHYSICAL_EVENT_N", "counts"),
      TERMINAL_LABELED_IDENTITY_N: reqNum(counts, "TERMINAL_LABELED_IDENTITY_N", "counts"),
      UNRESOLVED_IDENTITY_N: reqNum(counts, "UNRESOLVED_IDENTITY_N", "counts"),
    },
    field_completeness:
      (viewMeta.field_completeness as Record<string, number>) ??
      (manifest.field_completeness as Record<string, number>) ??
      null,
  };

  /* --- MODEL OVERVIEW: primary rows (SEPTEMBER_TABLES) + candidate-only rows --- */
  const overallSep = asArr(sep.overall, "SEPTEMBER_TABLES.overall").map((r) =>
    fromStandardResult(asObj(r, "overall row")),
  );
  const primaryModels = overallSep.map((r) => r.model);

  const candComparison = asArr(cand.comparison_table, "CONTRACT_A_CANDIDATES_V1.comparison_table").map(
    (r) => asObj(r, "candidate row"),
  );
  const candRows = candComparison.map(fromCandidateRow);
  // keep candidate rows whose model is NOT already carried by the primary artifact,
  // and NOT the C0_REFERENCE echo (C0 already carries that lane — do not render it
  // as a separate operator model). Its raw numbers remain in contractACandidates.comparison.
  const candidateOnly = candRows.filter(
    (r) => !primaryModels.includes(r.model) && r.model !== "C0_REFERENCE",
  );
  const candidateModels = candidateOnly.map((r) => r.model);

  const overallModels = [...overallSep, ...candidateOnly];
  const defaultModels = DASHBOARD_DEFAULT_MODELS.map((id) =>
    overallModels.find((r) => r.model === id),
  ).filter((r): r is DashboardMetricRow => Boolean(r));
  const researchModels = overallModels.filter((r) => !r.DASHBOARD_DEFAULT_VISIBLE);
  const runtimeContract = Object.values(MODEL_RUNTIME_CONTRACT);

  /* --- SPORT COMPARISON --- */
  const grouped = asObj(sep.grouped, "SEPTEMBER_TABLES.grouped");
  const sportRows: DashboardSportRow[] = [];
  for (const [model, rows] of Object.entries(grouped)) {
    for (const r of asArr(rows, `grouped.${model}`)) {
      sportRows.push(fromGroupedRow(model, asObj(r, "grouped row")));
    }
  }
  const sports = [...new Set(sportRows.map((r) => r.sport))].sort();

  /* --- CONTRACT A DIAGNOSTICS --- */
  const a1 = asObj(
    attr.analysis_1_selected_bet_economics,
    "CONTRACT_A_ATTRIBUTION_V1.analysis_1_selected_bet_economics",
  );
  const bands: DashboardBandRow[] = [];
  const bandDimensions: string[] = [];
  for (const [dim, bucketsRaw] of Object.entries(a1)) {
    const buckets = asObj(bucketsRaw, `analysis_1.${dim}`);
    bandDimensions.push(dim);
    for (const [bucket, rowRaw] of Object.entries(buckets)) {
      bands.push(fromBandRow(dim, bucket, asObj(rowRaw, `analysis_1.${dim}.${bucket}`)));
    }
  }

  const rankedRaw = Array.isArray(attr.ranked_founder_table) ? attr.ranked_founder_table : [];
  const ranked: DashboardRankedRow[] = rankedRaw.map((r) => {
    const o = asObj(r, "ranked_founder_table row");
    return {
      RANK: reqNum(o, "RANK", "ranked row"),
      CONTRACT_A_SEMANTIC: String(o.CONTRACT_A_SEMANTIC ?? ""),
      CURRENT_RULE: String(o.CURRENT_RULE ?? ""),
      EVIDENCE: String(o.EVIDENCE ?? ""),
      CURRENT_A_PNL: num(o, "CURRENT_A_PNL"),
      ABLATION_PNL: num(o, "ABLATION_PNL"),
      DELTA_PNL: num(o, "DELTA_PNL"),
      CURRENT_A_ROI: num(o, "CURRENT_A_ROI"),
      ABLATION_ROI: num(o, "ABLATION_ROI"),
      DELTA_ROI_PP: num(o, "DELTA_ROI_PP"),
      VERDICT: String(o.VERDICT ?? ""),
    };
  });

  /* --- CONTRACT A CORRECTION COMPARISON --- */
  const contractACandidates = {
    mission: String(cand.mission ?? ""),
    decision: cand.decision != null ? String(cand.decision) : null,
    comparison: candComparison as Array<Record<string, unknown>>,
    sportTable: (cand.sport_table as Record<string, Record<string, Record<string, unknown>>>) ?? {},
    marketTable: (cand.market_table as Record<string, Record<string, Record<string, unknown>>>) ?? {},
  };

  /* --- explicit UNAVAILABLE dimensions (never synthesized) --- */
  const unavailableDimensions: UnavailableDimension[] = [
    {
      dimension: "Cumulative PnL / equity curve (all models)",
      reason:
        "No persisted chronological per-bet or per-day series exists in SEPTEMBER_TABLES.json; " +
        "runReplay() emits aggregates only. Expanding the replay engine is out of scope.",
    },
    {
      dimension: "Score / entry-price / lead-time / volume bands for C0–C5",
      reason:
        "SEPTEMBER_TABLES.json groups by sport only. Band economics are persisted for " +
        "CONTRACT_A_FILTER_SIM_CURRENT only (CONTRACT_A_ATTRIBUTION_V1.json).",
    },
    {
      dimension: "Volume / liquidity segmentation (any model)",
      reason: "No source artifact groups or reports economics by volume_usd / liquidity_usd.",
    },
    {
      dimension: "CONTRACT_A_ACTUAL — historical production-selection lane",
      reason:
        "Does not exist. The current Contract A lane is CONTRACT_A_FILTER_SIM_CURRENT, a filter " +
        "simulation that by design does not reproduce the scheduler / slot allocation / historical picks.",
    },
    {
      dimension: "Market-family grouping for C0–C5",
      reason:
        "Not persisted in SEPTEMBER_TABLES.json (group_by=sport). Available only as a fresh " +
        "runReplay(--group-by market_family) run, which this mission does not perform.",
    },
  ];

  return {
    meta,
    overallModels,
    dashboardDefaultModels: DASHBOARD_DEFAULT_MODELS,
    defaultModels,
    researchModels,
    runtimeContract,
    sportRows,
    sports,
    primaryModels,
    candidateModels,
    contractAAttribution: {
      baselineReproduced: attr.baseline_reproduced ?? null,
      bands,
      bandDimensions,
      ranked,
    },
    contractACandidates,
    unavailableDimensions,
  };
}
