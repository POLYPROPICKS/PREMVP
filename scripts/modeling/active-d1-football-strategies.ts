/**
 * ACTIVE_D1_FOOTBALL_STRATEGIES — Git-owned manifest of the football strategies
 * the nightly D-1 modeling conveyor scores. Composition only: every predicate is
 * the frozen implementation imported from football-strategy-registry.ts /
 * football-live-safe-rebaseline.ts. The frozen registry evidence is not mutated.
 */
import {
  IMPLEMENTATIONS,
  STRATEGY_REGISTRY,
  selectFootballMoneylineTotalsSpreadsOdds185200,
  type RunContext,
} from "./football-strategy-registry";
import {
  LIVE_B_ID,
  LIVE_B_STRATEGY,
  LIVE_SAFE_PORTFOLIO_ID,
  selectFootballLiveMltsOdds175200,
} from "./football-live-safe-rebaseline";
import { composePriority } from "./football-core-portfolio-composition";
import type { SelectedCandidate } from "./daily-portfolio-frontier";

export interface ActiveStrategy {
  strategy_id: string;
  strategy_version: string;
  /** Frozen selector applied to ONE day's context (already stripped of previously claimed physical events). */
  select: (ctx: RunContext) => SelectedCandidate[];
  /**
   * Forward-causal composition: the selector is applied one model_date at a time
   * (ascending), so an earlier-day selection is never replaced by a later-day one.
   * Standalone chronological first-claim selectors do not need this.
   */
  dayCausal?: boolean;
}

/** Semantic version of the forward-causal D-1 portfolio (distinct from the historical full-corpus composition). */
export const D1_CAUSAL_PORTFOLIO_VERSION = "D1_CAUSAL_V1";

export const ACTIVE_REGISTRY_STRATEGY_IDS = [
  "FOOTBALL_ODDS_185_200_REPAIRED",
  "FOOTBALL_ODDS_192_200_REPAIRED_SAFE",
  "FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200",
  "FOOTBALL_SPREADS_ODDS_185_200_AUDIT_REQUIRED",
  "FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200",
  "FOOTBALL_ODDS_192_200_PRICE_BAND",
  "FOOTBALL_ODDS_185_200_PRICE_BAND",
  "FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER",
  "FOOTBALL_TOTAL_CORNERS_ODDS_225_250",
] as const;

function registryStrategy(id: string): ActiveStrategy {
  const def = STRATEGY_REGISTRY.find((s) => s.strategy_id === id);
  if (!def) throw new Error(`ACTIVE_STRATEGY_NOT_IN_REGISTRY:${id}`);
  const impl = IMPLEMENTATIONS[def.implementation_symbol];
  if (!impl) throw new Error(`ACTIVE_STRATEGY_IMPLEMENTATION_MISSING:${def.implementation_symbol}`);
  return { strategy_id: def.strategy_id, strategy_version: def.semantic_version, select: impl };
}

/**
 * LIVE_B first, MLTS_185_200 fills events LIVE_B has not claimed. Applied per
 * day (see `dayCausal`) on a context already stripped of previously claimed
 * events: FORWARD-CAUSAL, so an earlier-day fallback bet is never retro-replaced.
 * This intentionally can differ from the historical full-corpus composition.
 */
export const selectLiveSafePortfolioDay = (ctx: RunContext): SelectedCandidate[] =>
  composePriority(selectFootballLiveMltsOdds175200(ctx), selectFootballMoneylineTotalsSpreadsOdds185200(ctx)).portfolio;

export const ACTIVE_D1_FOOTBALL_STRATEGIES: ActiveStrategy[] = [
  ...ACTIVE_REGISTRY_STRATEGY_IDS.map(registryStrategy),
  { strategy_id: LIVE_B_ID, strategy_version: LIVE_B_STRATEGY.semantic_version, select: selectFootballLiveMltsOdds175200 },
  { strategy_id: LIVE_SAFE_PORTFOLIO_ID, strategy_version: D1_CAUSAL_PORTFOLIO_VERSION, select: selectLiveSafePortfolioDay, dayCausal: true },
];

export const strategyKey = (id: string, version: string): string => `${id}@${version}`;
