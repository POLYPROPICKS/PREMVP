// SPORTS UNIVERSE SOURCE-COVERAGE FUNNEL — pure analyzer.
//
// Answers one question with numbers: between generated_signal_pairs and
// Reservation planning, WHERE do whole Polymarket sport categories disappear,
// and how much of that loss is caused by classifying the wrong text surface?
//
// Contract:
//   - NO I/O. No Supabase client, no fs, no network, no process.env, no Date.now().
//     `nowIso` is always supplied by the caller so every run is reproducible.
//   - The production classifier and sport normalizer are CALLED, never
//     reimplemented, so this report can never disagree with the pipeline it
//     audits. Both are injectable purely so tests can prove that seam.
//   - Identity conclusions use PERSISTED PROVIDER IDs and timestamps only.
//     Title text may locate candidate rows; it may never prove identity, and it
//     may never deduplicate two events.
//
// What is being measured (proved by the prior inspect-only trace):
// buildIdentityText() in lib/executor/buildFireModelCandidates.ts:352-391 selects
// the FIRST non-empty source from a preference list that begins
//   providerEventContext.eventTitle -> providerEventContext.marketQuestion -> ...
// so for any row carrying an event title, the fail-closed MARKET-class taxonomy
// runs against EVENT-title text, which by construction contains no market
// vocabulary. "Rangers vs Rays" -> unknown -> dropped, while its sibling
// "Spread: New York Mets (-2.5)" survives only because the market word is inside
// the title string itself.
//
// This module does NOT change that behavior. It quantifies it.

import {
  classifyMarketText,
  isAllowedFullMatchMarketClass,
  resolveMarketAnchorDecision,
  type EventScope,
  type MarketAnchorReasonCode,
  type MarketClass,
} from "./taxonomy";
import { normalizeSport } from "../liquidity/marketGates";
import type { NormalizedSport } from "../liquidity/types";

export const SOURCE_COVERAGE_REPORT_VERSION = "sports-source-coverage-v1" as const;

/**
 * One production-shaped row from public.generated_signal_pairs, reduced to the
 * fields this analysis can defend. Every field is nullable because the whole
 * point of the report is to measure which ones are actually persisted.
 */
export interface CoverageSourceRow {
  row_id: string;
  /** Persisted provider identity — the ONLY admissible identity proof. */
  provider_event_id: string | null;
  provider_event_slug: string | null;
  provider_market_id: string | null;
  /** The provider's own market question — the surface policy SHOULD read. */
  provider_market_question: string | null;
  /** The provider's event title — the surface policy CURRENTLY reads. */
  provider_event_title: string | null;
  event_start_iso: string | null;
  observed_at_iso: string | null;
  league_or_sport_hint: string | null;
  market_slug: string | null;
  event_slug: string | null;
}

export interface CoverageTarget {
  target_label: string;
  /** Lowercased tokens that must ALL appear in a row's text to be a candidate. */
  match_tokens: string[];
}

/** Pipeline stages, in the exact order the planner applies them. */
export const COVERAGE_STAGES = [
  "source_row_count",
  "fresh_row_count",
  "identity_complete_row_count",
  "inside_horizon_event_count",
  "current_surface_policy_eligible_count",
] as const;

export type CoverageStage = (typeof COVERAGE_STAGES)[number];

export type RejectionStage =
  | "fresh_rows"
  | "identity_complete"
  | "inside_horizon"
  | "market_policy_eligible";

export type IdentityVerdict = "PROVEN" | "NOT_PROVEN";

export interface CoverageRowAnalysis {
  row_id: string;
  normalized_sport: NormalizedSport;
  provider_event_id: string | null;
  provider_market_id: string | null;
  provider_event_key: string | null;
  event_title_text: string | null;
  market_question_text: string | null;
  event_start_iso: string | null;
  observed_at_iso: string | null;

  fresh: boolean;
  event_identity_complete: boolean;
  identity_verdict: IdentityVerdict;
  inside_horizon: boolean;

  /** Classification of the surface production reads today. */
  event_title_market_class: MarketClass;
  current_surface_policy_eligible: boolean;
  /** Classification of the surface production SHOULD read. */
  market_question_market_class: MarketClass;
  market_question_policy_eligible: boolean;
  market_question_rejection_code: MarketAnchorReasonCode | null;
  event_scope: EventScope;

  /** True only when the correct surface rescues a row the current one drops. */
  surface_recovery: boolean;

  current_first_rejection_stage: RejectionStage | null;
  current_first_rejection_code: string | null;
}

export interface CoverageBySport {
  normalized_sport: NormalizedSport;
  source_row_count: number;
  fresh_row_count: number;
  identity_complete_row_count: number;
  distinct_provider_event_count: number;
  inside_horizon_event_count: number;
  current_surface_policy_eligible_count: number;
  market_question_policy_eligible_count: number;
  surface_recoverable_row_count: number;
  fullmatch_candidate_count: number;
  partial_candidate_count: number;
  unknown_market_count: number;
  first_zero_stage: CoverageStage | null;
  top_rejection_codes: Array<{ code: string; count: number }>;
}

export interface OverallFunnel {
  source_row_count: number;
  fresh_row_count: number;
  identity_complete_row_count: number;
  distinct_provider_event_count: number;
  inside_horizon_event_count: number;
  current_surface_policy_eligible_count: number;
  market_question_policy_eligible_count: number;
  surface_recoverable_row_count: number;
  fullmatch_candidate_count: number;
  partial_candidate_count: number;
  unknown_market_count: number;
  first_zero_stage: CoverageStage | null;
  top_rejection_codes: Array<{ code: string; count: number }>;
}

export interface TargetEventRow {
  target_label: string;
  found_by_discovery: boolean;
  identity_verdict: IdentityVerdict;
  provider_event_ids: string[];
  provider_market_ids: string[];
  source_row_count: number;
  latest_observed_at: string | null;
  event_start_iso: string | null;
  normalized_sport: NormalizedSport | null;
  event_identity_complete: boolean;
  event_title_text: string | null;
  market_questions: string[];
  event_title_market_class: MarketClass | null;
  market_question_market_classes: MarketClass[];
  surface_recovery_possible: boolean;
  inside_horizon: boolean;
  current_first_rejection_stage: RejectionStage | null;
  current_first_rejection_code: string | null;
}

export interface SurfaceSelectionLoss {
  current_surface_policy_eligible_count: number;
  market_question_policy_eligible_count: number;
  surface_recoverable_row_count: number;
  /** eligible-on-question / eligible-on-title. null when the denominator is 0. */
  recovery_multiple: number | null;
  recoverable_by_sport: Array<{ normalized_sport: NormalizedSport; surface_recoverable_row_count: number }>;
}

export interface SourceCoverageReport {
  report_version: typeof SOURCE_COVERAGE_REPORT_VERSION;
  fixed_now: string;
  window: { freshness_hours: number; horizon_hours: number };
  rows: CoverageRowAnalysis[];
  overall_funnel: OverallFunnel;
  coverage_by_sport: CoverageBySport[];
  target_event_matrix: TargetEventRow[];
  largest_loss_stage: CoverageStage | null;
  surface_selection_loss: SurfaceSelectionLoss;
}

export interface AnalyzeSourceCoverageInput {
  rows: CoverageSourceRow[];
  nowIso: string;
  freshnessHours: number;
  horizonHours: number;
  targets?: CoverageTarget[];
  /** Injectable ONLY so tests can prove the production seam. Defaults are production. */
  classifyMarket?: (input: unknown) => MarketClass;
  normalizeSportFn?: (raw: unknown) => NormalizedSport;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Identity is PROVEN only by persisted provider fields: an event identifier plus
 * a parseable ISO start. This mirrors the requirements documented on
 * providerEventKeyOf() in buildFireModelCandidates.ts, which production does not
 * export; it is therefore recomputed here rather than imported, and is reported
 * as a report-local predicate. Title text is never admissible.
 */
function providerEventKeyOf(row: CoverageSourceRow): string | null {
  const identity = firstNonEmpty(row.provider_event_slug, row.provider_event_id);
  const start = row.event_start_iso;
  if (!identity || !/^[-a-z0-9_]+$/i.test(identity)) return null;
  if (!start || !/^\d{4}-\d{2}-\d{2}T/.test(start) || parseIso(start) === null) return null;
  return `polymarket:${identity.toLowerCase()}:${start.slice(0, 10)}`;
}

function topCodes(counts: Map<string, number>): Array<{ code: string; count: number }> {
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    // Deterministic: count desc, then code asc.
    .sort((a, b) => (b.count - a.count) || a.code.localeCompare(b.code))
    .slice(0, 5);
}

function analyzeRow(
  row: CoverageSourceRow,
  ctx: {
    nowMs: number;
    freshnessMs: number;
    horizonMs: number;
    classifyMarket: (input: unknown) => MarketClass;
    normalizeSportFn: (raw: unknown) => NormalizedSport;
  }
): CoverageRowAnalysis {
  const eventTitle = firstNonEmpty(row.provider_event_title);
  const marketQuestion = firstNonEmpty(row.provider_market_question);

  // Sport is normalized from the explicit provider hint first. Falling back to
  // free text would let a team name ("Miami Pickleball Club") decide a sport,
  // which is exactly the kind of inference this report exists to expose.
  const normalized_sport = ctx.normalizeSportFn(
    firstNonEmpty(row.league_or_sport_hint) ?? ""
  );

  // ── Stage 1: freshness ──────────────────────────────────────────────────
  const observedMs = parseIso(row.observed_at_iso);
  const fresh = observedMs !== null && observedMs >= ctx.nowMs - ctx.freshnessMs;

  // ── Stage 2: identity ───────────────────────────────────────────────────
  const provider_event_key = providerEventKeyOf(row);
  const event_identity_complete = provider_event_key !== null;
  const identity_verdict: IdentityVerdict = event_identity_complete ? "PROVEN" : "NOT_PROVEN";

  // ── Stage 3: horizon ────────────────────────────────────────────────────
  const startMs = parseIso(row.event_start_iso);
  const inside_horizon =
    startMs !== null && startMs >= ctx.nowMs && startMs <= ctx.nowMs + ctx.horizonMs;

  // ── Stage 4: market policy, measured on BOTH surfaces ───────────────────
  // Current surface: exactly what buildIdentityText selects in planningMode —
  // the event title wins whenever it is present.
  const currentSurfaceText = firstNonEmpty(
    eventTitle,
    marketQuestion,
    row.event_slug,
    row.market_slug
  );
  const event_title_market_class = ctx.classifyMarket(currentSurfaceText ?? "");
  const current_surface_policy_eligible = isAllowedFullMatchMarketClass(event_title_market_class);

  // Correct surface: the full production anchor decision, which also applies
  // event scope, so a per-map line can never be counted as "recoverable".
  const questionDecision = resolveMarketAnchorDecision({
    providerMarketQuestion: marketQuestion,
    eventTitle,
    marketSlug: row.market_slug,
    eventSlug: row.event_slug,
  });
  const market_question_market_class = questionDecision.market_class;
  const market_question_policy_eligible = questionDecision.allowed;

  const surface_recovery = !current_surface_policy_eligible && market_question_policy_eligible;

  // ── First rejection under CURRENT production behavior ───────────────────
  let current_first_rejection_stage: RejectionStage | null = null;
  let current_first_rejection_code: string | null = null;
  if (!fresh) {
    current_first_rejection_stage = "fresh_rows";
    current_first_rejection_code = "STALE_OUTSIDE_LOOKBACK";
  } else if (!event_identity_complete) {
    current_first_rejection_stage = "identity_complete";
    current_first_rejection_code = "PROVIDER_IDENTITY_INCOMPLETE";
  } else if (!inside_horizon) {
    current_first_rejection_stage = "inside_horizon";
    current_first_rejection_code = "OUTSIDE_PLANNING_HORIZON";
  } else if (!current_surface_policy_eligible) {
    current_first_rejection_stage = "market_policy_eligible";
    current_first_rejection_code =
      event_title_market_class === "unknown"
        ? "UNKNOWN_MARKET_CLASS"
        : event_title_market_class === "esports_non_policy"
          ? "ESPORTS_NON_POLICY"
          : "FORBIDDEN_MARKET_CLASS";
  }

  return {
    row_id: row.row_id,
    normalized_sport,
    provider_event_id: row.provider_event_id,
    provider_market_id: row.provider_market_id,
    provider_event_key,
    event_title_text: eventTitle,
    market_question_text: marketQuestion,
    event_start_iso: row.event_start_iso,
    observed_at_iso: row.observed_at_iso,
    fresh,
    event_identity_complete,
    identity_verdict,
    inside_horizon,
    event_title_market_class,
    current_surface_policy_eligible,
    market_question_market_class,
    market_question_policy_eligible,
    market_question_rejection_code: questionDecision.reason_code,
    event_scope: questionDecision.event_scope,
    surface_recovery,
    current_first_rejection_stage,
    current_first_rejection_code,
  };
}

function summarize(analyses: CoverageRowAnalysis[]): Omit<OverallFunnel, never> {
  const distinctEvents = new Set<string>();
  const rejectionCodes = new Map<string, number>();
  let fresh = 0;
  let identityComplete = 0;
  let insideHorizon = 0;
  let currentEligible = 0;
  let questionEligible = 0;
  let recoverable = 0;
  let fullmatch = 0;
  let partial = 0;
  let unknown = 0;

  for (const a of analyses) {
    if (a.fresh) fresh += 1;
    if (a.event_identity_complete) identityComplete += 1;
    // Only a PROVEN provider identity can collapse two rows into one event.
    if (a.provider_event_key) distinctEvents.add(a.provider_event_key);
    if (a.inside_horizon) insideHorizon += 1;
    if (a.current_surface_policy_eligible) currentEligible += 1;
    if (a.market_question_policy_eligible) questionEligible += 1;
    if (a.surface_recovery) recoverable += 1;
    if (a.market_question_policy_eligible) fullmatch += 1;
    if (a.market_question_rejection_code === "PARTIAL_EVENT_SCOPE") partial += 1;
    if (a.market_question_rejection_code === "UNKNOWN_MARKET_CLASS") unknown += 1;
    if (a.current_first_rejection_code) {
      rejectionCodes.set(
        a.current_first_rejection_code,
        (rejectionCodes.get(a.current_first_rejection_code) ?? 0) + 1
      );
    }
  }

  const counts = {
    source_row_count: analyses.length,
    fresh_row_count: fresh,
    identity_complete_row_count: identityComplete,
    distinct_provider_event_count: distinctEvents.size,
    inside_horizon_event_count: insideHorizon,
    current_surface_policy_eligible_count: currentEligible,
    market_question_policy_eligible_count: questionEligible,
    surface_recoverable_row_count: recoverable,
    fullmatch_candidate_count: fullmatch,
    partial_candidate_count: partial,
    unknown_market_count: unknown,
  };

  // first_zero_stage: the earliest stage whose survivor count hit zero while it
  // had non-zero input. A funnel that never had input has no zero stage.
  let first_zero_stage: CoverageStage | null = null;
  if (analyses.length > 0) {
    for (const stage of COVERAGE_STAGES) {
      if (counts[stage] === 0) {
        first_zero_stage = stage;
        break;
      }
    }
  }

  return { ...counts, first_zero_stage, top_rejection_codes: topCodes(rejectionCodes) };
}

export function analyzeSourceCoverage(input: AnalyzeSourceCoverageInput): SourceCoverageReport {
  const classifyMarket = input.classifyMarket ?? classifyMarketText;
  const normalizeSportFn = input.normalizeSportFn ?? normalizeSport;

  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`analyzeSourceCoverage: nowIso is not a valid ISO timestamp: ${input.nowIso}`);
  }
  if (!(input.freshnessHours > 0) || !(input.horizonHours > 0)) {
    throw new Error("analyzeSourceCoverage: freshnessHours and horizonHours must be positive");
  }

  const ctx = {
    nowMs,
    freshnessMs: input.freshnessHours * 3_600_000,
    horizonMs: input.horizonHours * 3_600_000,
    classifyMarket,
    normalizeSportFn,
  };

  const rows = input.rows.map((row) => analyzeRow(row, ctx));

  // ── Per-sport funnels, deterministically ordered by sport id ────────────
  const bySport = new Map<NormalizedSport, CoverageRowAnalysis[]>();
  for (const a of rows) {
    const bucket = bySport.get(a.normalized_sport);
    if (bucket) bucket.push(a);
    else bySport.set(a.normalized_sport, [a]);
  }
  const coverage_by_sport: CoverageBySport[] = [...bySport.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((sport) => ({
      normalized_sport: sport,
      ...summarize(bySport.get(sport) ?? []),
    }));

  const overall_funnel: OverallFunnel = summarize(rows);

  // ── Largest single-stage loss across the whole funnel ───────────────────
  let largest_loss_stage: CoverageStage | null = null;
  if (rows.length > 0) {
    let worstDrop = 0;
    let previous = overall_funnel.source_row_count;
    for (const stage of COVERAGE_STAGES) {
      if (stage === "source_row_count") continue;
      const current = overall_funnel[stage];
      const drop = previous - current;
      if (drop > worstDrop) {
        worstDrop = drop;
        largest_loss_stage = stage;
      }
      previous = current;
    }
  }

  const surface_selection_loss: SurfaceSelectionLoss = {
    current_surface_policy_eligible_count: overall_funnel.current_surface_policy_eligible_count,
    market_question_policy_eligible_count: overall_funnel.market_question_policy_eligible_count,
    surface_recoverable_row_count: overall_funnel.surface_recoverable_row_count,
    recovery_multiple:
      overall_funnel.current_surface_policy_eligible_count > 0
        ? overall_funnel.market_question_policy_eligible_count /
          overall_funnel.current_surface_policy_eligible_count
        : null,
    recoverable_by_sport: coverage_by_sport
      .filter((s) => s.surface_recoverable_row_count > 0)
      .map((s) => ({
        normalized_sport: s.normalized_sport,
        surface_recoverable_row_count: s.surface_recoverable_row_count,
      })),
  };

  const target_event_matrix = (input.targets ?? []).map((target) =>
    buildTargetRow(target, input.rows, rows)
  );

  return {
    report_version: SOURCE_COVERAGE_REPORT_VERSION,
    fixed_now: input.nowIso,
    window: { freshness_hours: input.freshnessHours, horizon_hours: input.horizonHours },
    rows,
    overall_funnel,
    coverage_by_sport,
    target_event_matrix,
    largest_loss_stage,
    surface_selection_loss,
  };
}

/**
 * Locate a target's rows by title tokens (DISCOVERY ONLY), then draw every
 * identity conclusion from persisted provider ids and timestamps. A target with
 * no matching row is reported as absent FROM SOURCE STORAGE — never as absent
 * from Polymarket, which this data cannot show.
 */
function buildTargetRow(
  target: CoverageTarget,
  sourceRows: CoverageSourceRow[],
  analyses: CoverageRowAnalysis[]
): TargetEventRow {
  const tokens = target.match_tokens.map((t) => t.toLowerCase()).filter(Boolean);

  const matchedIndexes: number[] = [];
  sourceRows.forEach((row, index) => {
    const haystack = [
      row.provider_event_title,
      row.provider_market_question,
      row.event_slug,
      row.market_slug,
    ]
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .toLowerCase();
    if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) {
      matchedIndexes.push(index);
    }
  });

  const matched = matchedIndexes.map((i) => analyses[i]);

  if (matched.length === 0) {
    return {
      target_label: target.target_label,
      found_by_discovery: false,
      identity_verdict: "NOT_PROVEN",
      provider_event_ids: [],
      provider_market_ids: [],
      source_row_count: 0,
      latest_observed_at: null,
      event_start_iso: null,
      normalized_sport: null,
      event_identity_complete: false,
      event_title_text: null,
      market_questions: [],
      event_title_market_class: null,
      market_question_market_classes: [],
      surface_recovery_possible: false,
      inside_horizon: false,
      current_first_rejection_stage: null,
      current_first_rejection_code: null,
    };
  }

  const uniqueSorted = (values: Array<string | null>): string[] =>
    [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))].sort();

  const observedTimes = matched
    .map((m) => m.observed_at_iso)
    .filter((v): v is string => typeof v === "string")
    .sort();

  // Representative row: the first identity-complete match, else the first match.
  const lead = matched.find((m) => m.event_identity_complete) ?? matched[0];

  return {
    target_label: target.target_label,
    found_by_discovery: true,
    identity_verdict: matched.some((m) => m.event_identity_complete) ? "PROVEN" : "NOT_PROVEN",
    provider_event_ids: uniqueSorted(matched.map((m) => m.provider_event_id)),
    provider_market_ids: uniqueSorted(matched.map((m) => m.provider_market_id)),
    source_row_count: matched.length,
    latest_observed_at: observedTimes.length > 0 ? observedTimes[observedTimes.length - 1] : null,
    event_start_iso: lead.event_start_iso,
    normalized_sport: lead.normalized_sport,
    event_identity_complete: lead.event_identity_complete,
    event_title_text: lead.event_title_text,
    market_questions: uniqueSorted(matched.map((m) => m.market_question_text)),
    event_title_market_class: lead.event_title_market_class,
    market_question_market_classes: [
      ...new Set(matched.map((m) => m.market_question_market_class)),
    ].sort() as MarketClass[],
    surface_recovery_possible: matched.some((m) => m.surface_recovery),
    inside_horizon: matched.some((m) => m.inside_horizon),
    current_first_rejection_stage: lead.current_first_rejection_stage,
    current_first_rejection_code: lead.current_first_rejection_code,
  };
}
