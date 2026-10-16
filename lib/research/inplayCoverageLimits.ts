// UTC-day research budgets. Stage 300 requires a separate reviewed migration after natural stage-200 proof.
export const INPLAY_COVERAGE_STAGES = Object.freeze({
  100: Object.freeze({ events: 100, rows: 20_000, logicalMb: 20 }),
  200: Object.freeze({ events: 200, rows: 40_000, logicalMb: 40 }),
  300: Object.freeze({ events: 300, rows: 60_000, logicalMb: 60 }),
});
export const ACTIVE_INPLAY_COVERAGE_STAGE = 200;
export const INPLAY_COVERAGE_LIMITS = INPLAY_COVERAGE_STAGES[ACTIVE_INPLAY_COVERAGE_STAGE];
// 3,200 rows/hour = 76,800/day, above the largest authorized budget; other telemetry stays unchanged.
export const INPLAY_SYNC_MAX_PAGES = 16;
