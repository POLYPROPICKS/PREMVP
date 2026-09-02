/**
 * AUGUST_ENRICHED_RESEARCH_DATASET_V1 — pure deterministic enrichment.
 *
 * No filesystem, no network, no LLM. Given the parsed base population and the
 * parsed persisted enrichment sources, produce the enriched rows and the
 * coverage report. Missing joins => NULL + ENRICHMENT_UNRESOLVED; features the
 * frozen audit proved absent => NULL + NOT_RECOVERABLE. Nothing is imputed.
 */
import {
  AUGUST_BASE_POPULATION,
  FEATURE_REGISTRY,
  SCORE_SLOTS,
  VOLUME_SEMANTICS,
  type FeatureSpec,
} from "./contract";
import type {
  AugustBaseRow,
  ReplayInputRow,
  TaxonomyRow,
  EnrichedRow,
  EnrichedFeature,
  CoverageReport,
  CoverageCount,
} from "./types";

const MS_PER_HOUR = 3_600_000;

export function leadTimeHours(decisionIso: string, startIso: string): number {
  const d = Date.parse(decisionIso);
  const s = Date.parse(startIso);
  if (Number.isNaN(d) || Number.isNaN(s)) return NaN;
  return Math.round(((s - d) / MS_PER_HOUR) * 1000) / 1000;
}

/** A feature value is only allowed if it was known at/before decision time. */
function pointInTimeSafe(observedAtIso: string | null, decisionIso: string): boolean {
  if (observedAtIso === null) return true; // derived-from-decision-row sources
  const o = Date.parse(observedAtIso);
  const dec = Date.parse(decisionIso);
  if (Number.isNaN(o) || Number.isNaN(dec)) return false;
  return o <= dec;
}

function resolvedMarketType(v: string | null | undefined): string | null {
  if (!v) return null;
  if (v === "MONEYLINE" || v === "SPREAD" || v === "TOTAL") return v;
  return null; // UNRESOLVED / UNKNOWN_OTHER => not a resolved market family
}

export interface EnrichInputs {
  base: AugustBaseRow[];
  replayById: Map<string, ReplayInputRow>;
  taxonomyById: Map<string, TaxonomyRow>;
}

export function enrichRow(row: AugustBaseRow, inputs: EnrichInputs): EnrichedRow {
  const decision = row.created_at;
  const replay = inputs.replayById.get(row.id)?.replay_inputs ?? null;
  const tax = inputs.taxonomyById.get(row.id)?.taxonomy ?? null;

  const enrichment: Record<string, EnrichedFeature> = {};

  for (const spec of FEATURE_REGISTRY) {
    enrichment[spec.key] = computeFeature(spec, { decision, replay, tax });
  }

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const notRecoverable: string[] = [];
  for (const [k, f] of Object.entries(enrichment)) {
    if (f.status === "RESOLVED") resolved.push(k);
    else if (f.status === "NOT_RECOVERABLE") notRecoverable.push(k);
    else unresolved.push(k);
  }

  return {
    base: {
      id: row.id,
      provider_event_id: row.provider_event_id,
      condition_id: row.condition_id,
      selected_token_id: row.selected_token_id,
      decision_timestamp: decision,
      event_start: row.event_start,
      t90_cutoff: row.t90_cutoff,
      event_slug: row.event_slug,
      split_lane: row._lane,
      lead_time_hours: leadTimeHours(decision, row.event_start),
      settlement: {
        status: row.label.status,
        gamma_event_id: row.label.gamma_event_id ?? null,
        gamma_winning_token_id: row.label.gamma_winning_token_id ?? null,
        point_in_time_safe: false,
      },
    },
    enrichment,
    enrichment_status: { resolved, unresolved, not_recoverable: notRecoverable },
  };
}

function computeFeature(
  spec: FeatureSpec,
  ctx: {
    decision: string;
    replay: ReplayInputRow["replay_inputs"] | null;
    tax: TaxonomyRow["taxonomy"] | null;
  },
): EnrichedFeature {
  const base: EnrichedFeature = {
    value: null,
    source: spec.source,
    semantic: spec.semantic,
    observed_at: null,
    status: spec.baselineStatus,
    ...(spec.reason ? { reason: spec.reason } : {}),
  };

  if (spec.baselineStatus === "NOT_RECOVERABLE") return base;

  let raw: string | number | null = null;
  switch (spec.key) {
    case "entry_price":
      raw = ctx.replay?.entry_price_num ?? null;
      break;
    case "formula_version":
      raw = AUGUST_BASE_POPULATION.scoreProducerPopulation;
      break;
    case "market_family":
      raw = resolvedMarketType(ctx.tax?.market_type);
      break;
    case "sport_family":
      raw = ctx.tax?.sport_family ?? null;
      break;
    case "league_or_competition":
      raw = ctx.tax?.league_or_competition ?? null;
      break;
    default:
      raw = null;
  }

  if (raw === null || raw === "") {
    return { ...base, status: "ENRICHMENT_UNRESOLVED" };
  }

  const observedAt = spec.observedAtField === "created_at" ? ctx.decision : null;
  if (!pointInTimeSafe(observedAt, ctx.decision)) {
    return {
      ...base,
      status: "ENRICHMENT_UNRESOLVED",
      reason: "join value failed point-in-time gate (observed_at > decision_timestamp)",
    };
  }

  return { ...base, value: raw, observed_at: observedAt, status: "RESOLVED" };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1_000_000) / 10_000;
}

function count(
  present: number,
  denom: number,
  sourceStage: string,
): CoverageCount {
  return {
    unit: "physical_provider_event",
    source_stage: sourceStage,
    input_denominator: denom,
    output_denominator: denom,
    present_n: present,
    present_pct: pct(present, denom),
  };
}

export function buildCoverageReport(rows: EnrichedRow[]): CoverageReport {
  const n = rows.length;
  const decisions = rows.map((r) => r.base.decision_timestamp).sort();
  const starts = rows.map((r) => r.base.event_start).sort();

  const isResolved = (r: EnrichedRow, k: string) =>
    r.enrichment[k]?.status === "RESOLVED";

  const signal_score: Record<string, CoverageCount> = {};
  for (const slot of SCORE_SLOTS) {
    signal_score[slot] = count(
      rows.filter((r) => isResolved(r, slot)).length,
      n,
      "replay-input sidecar exact id join",
    );
  }

  const volume: Record<string, CoverageCount> = {};
  for (const sem of VOLUME_SEMANTICS) {
    volume[sem] = count(
      rows.filter((r) => isResolved(r, sem)).length,
      n,
      "no frozen August source carries this volume semantic",
    );
  }

  const mfDist: Record<string, number> = {};
  const sfDist: Record<string, number> = {};
  let mfPresent = 0;
  let sfPresent = 0;
  let scoreVersionDist: Record<string, number> = {};
  let anyRich = 0;
  let anyRichExclBaseDerived = 0;
  let scoreAndSettlement = 0;
  let scoreAndVolume = 0;

  for (const r of rows) {
    const mf = r.enrichment.market_family;
    if (mf?.status === "RESOLVED" && typeof mf.value === "string") {
      mfPresent++;
      mfDist[mf.value] = (mfDist[mf.value] ?? 0) + 1;
    }
    const sf = r.enrichment.sport_family;
    if (sf?.status === "RESOLVED" && typeof sf.value === "string") {
      sfPresent++;
      sfDist[sf.value] = (sfDist[sf.value] ?? 0) + 1;
    }
    const fv = r.enrichment.formula_version;
    if (fv?.status === "RESOLVED" && typeof fv.value === "string") {
      scoreVersionDist[fv.value] = (scoreVersionDist[fv.value] ?? 0) + 1;
    }

    const hasScore = SCORE_SLOTS.some((s) => isResolved(r, s));
    const hasVolume = VOLUME_SEMANTICS.some((s) => isResolved(r, s));
    const hasEntryPrice = isResolved(r, "entry_price");
    const hasMarketFamily = mf?.status === "RESOLVED";
    const hasSportFamily = sf?.status === "RESOLVED";

    if (hasScore || hasVolume || hasEntryPrice || hasMarketFamily || hasSportFamily) anyRich++;
    if (hasScore || hasVolume || hasMarketFamily) anyRichExclBaseDerived++;
    if (hasScore && r.base.settlement.status) scoreAndSettlement++;
    if (hasScore && hasVolume) scoreAndVolume++;
  }

  return {
    mission: "AUGUST_ENRICHED_RESEARCH_DATASET_V1",
    base_row_n: n,
    enriched_row_n: n,
    date_range: {
      decision_timestamp: [decisions[0] ?? "", decisions[n - 1] ?? ""],
      event_start: [starts[0] ?? "", starts[n - 1] ?? ""],
    },
    score_population: AUGUST_BASE_POPULATION.scoreProducerPopulation,
    score_version_distribution: scoreVersionDist,
    signal_score,
    volume,
    market_family: {
      ...count(mfPresent, n, "taxonomy-v2 sidecar exact id join, resolved market_type only"),
      distribution: mfDist,
    },
    sport_family: {
      ...count(sfPresent, n, "taxonomy-v2 sidecar exact id join"),
      distribution: sfDist,
    },
    smart_money: count(0, n, "no frozen August source carries smart-money / whale-vs-public"),
    price_movement: count(0, n, "no frozen August source carries price deltas / prior observations"),
    entry_price: count(
      rows.filter((r) => isResolved(r, "entry_price")).length,
      n,
      "replay-input sidecar exact id join",
    ),
    rows_with_any_rich_attribute_n: anyRich,
    rows_with_any_rich_attribute_excl_base_derived_n: anyRichExclBaseDerived,
    rows_with_score_and_settlement_n: scoreAndSettlement,
    rows_with_score_and_volume_n: scoreAndVolume,
    not_recoverable_features: FEATURE_REGISTRY.filter(
      (f) => f.baselineStatus === "NOT_RECOVERABLE",
    ).map((f) => ({ key: f.key, reason: f.reason ?? "" })),
  };
}

export function enrichAll(inputs: EnrichInputs): {
  rows: EnrichedRow[];
  coverage: CoverageReport;
} {
  const rows = inputs.base
    .map((r) => enrichRow(r, inputs))
    .sort((a, b) => {
      if (a.base.event_start !== b.base.event_start)
        return a.base.event_start < b.base.event_start ? -1 : 1;
      return a.base.provider_event_id < b.base.provider_event_id ? -1 : 1;
    });
  return { rows, coverage: buildCoverageReport(rows) };
}
