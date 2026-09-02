/**
 * AUGUST_ENRICHED_RESEARCH_DATASET_V1 — shared types.
 */
import type { EnrichmentStatus } from "./contract";

/** One row of the existing accepted August research base (as persisted). */
export interface AugustBaseRow {
  id: string;
  provider_event_id: string;
  condition_id: string;
  selected_token_id: string;
  created_at: string;
  event_start: string;
  t90_cutoff: string;
  event_slug: string;
  label: {
    status: "WIN" | "LOSS";
    gamma_event_id?: string;
    gamma_market_condition_id?: string;
    gamma_selected_token_id?: string;
    gamma_market_closed?: boolean;
    gamma_terminal_outcome_prices?: unknown;
    gamma_winning_token_id?: string;
  };
  /** research split lane, injected by the loader. */
  _lane: "train" | "validation" | "untouched_test";
}

export interface ReplayInputRow {
  source_row_id: string;
  provider_event_id?: string;
  replay_inputs?: {
    entry_price_num?: number | null;
    signal_confidence_num?: number | null;
    score?: number | null;
    pre_event_score_num?: number | null;
    selected_outcome?: string | null;
    market_slug?: string | null;
  } | null;
}

export interface TaxonomyRow {
  source_row_id: string;
  taxonomy?: {
    sport_family?: string | null;
    league_or_competition?: string | null;
    sport_code?: string | null;
    market_type?: string | null;
  } | null;
}

/** A single enriched feature cell — VALUE / SOURCE / SEMANTIC / OBSERVED_AT. */
export interface EnrichedFeature {
  value: string | number | null;
  source: string | null;
  semantic: string;
  observed_at: string | null;
  status: EnrichmentStatus;
  reason?: string;
}

export interface EnrichedRow {
  base: {
    id: string;
    provider_event_id: string;
    condition_id: string;
    selected_token_id: string;
    decision_timestamp: string;
    event_start: string;
    t90_cutoff: string;
    event_slug: string;
    split_lane: AugustBaseRow["_lane"];
    lead_time_hours: number;
    settlement: {
      status: "WIN" | "LOSS";
      gamma_event_id: string | null;
      gamma_winning_token_id: string | null;
      /** settlement is NOT point-in-time and is never exposed as a feature. */
      point_in_time_safe: false;
    };
  };
  enrichment: Record<string, EnrichedFeature>;
  enrichment_status: {
    resolved: string[];
    unresolved: string[];
    not_recoverable: string[];
  };
}

export interface CoverageCount {
  unit: "physical_provider_event";
  source_stage: string;
  input_denominator: number;
  output_denominator: number;
  present_n: number;
  present_pct: number;
}

export interface CoverageReport {
  mission: "AUGUST_ENRICHED_RESEARCH_DATASET_V1";
  base_row_n: number;
  enriched_row_n: number;
  date_range: {
    decision_timestamp: [string, string];
    event_start: [string, string];
  };
  score_population: string;
  score_version_distribution: Record<string, number>;
  signal_score: Record<string, CoverageCount>;
  volume: Record<string, CoverageCount>;
  market_family: CoverageCount & { distribution: Record<string, number> };
  sport_family: CoverageCount & { distribution: Record<string, number> };
  smart_money: CoverageCount;
  price_movement: CoverageCount;
  entry_price: CoverageCount;
  rows_with_any_rich_attribute_n: number;
  rows_with_any_rich_attribute_excl_base_derived_n: number;
  rows_with_score_and_settlement_n: number;
  rows_with_score_and_volume_n: number;
  not_recoverable_features: { key: string; reason: string }[];
}
