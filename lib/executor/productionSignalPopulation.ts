/**
 * Canonical production signal-population selector for the PREMVP Contract A
 * Planning / Reservation money boundary.
 *
 * Contract A Planning / Reservation consume scored candidates from exactly ONE
 * explicitly selected production population. Research / challenger populations
 * (`shadow-firemodel1_1_research_v0`, `shadow-strategic-sports-v1`, ...) are
 * still persisted to `generated_signal_pairs` / `current_signal_pair_serving`
 * and analysed, but they do NOT compete for money-path Planning / Reservation
 * slots unless explicitly promoted here in a future product decision.
 *
 * This module is the single source of truth: every money-path admission list
 * imports it instead of re-declaring a `metric_formula_version` set inline, so
 * the selected production population is defined in exactly one place.
 */

/** The one selected production `metric_formula_version` for the money path. */
export const PRODUCTION_SIGNAL_POPULATION_VERSION = "v2-lite-growth-safe" as const;

/**
 * The `metric_formula_version` values admitted to SCORED Contract A Planning /
 * Reservation money slots — exactly the selected production population, nothing
 * else. The score-null `shadow-strategic-sports-v1` planning-shadow fallback is
 * read by a separate, disjoint query (filtered on that exact version) and is
 * not represented here because it is not scored and not money-authoritative.
 */
export const PRODUCTION_SCORED_PLANNING_VERSIONS: readonly string[] = [
  PRODUCTION_SIGNAL_POPULATION_VERSION,
];
