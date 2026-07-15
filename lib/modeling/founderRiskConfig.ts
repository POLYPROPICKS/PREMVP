export const DEFAULT_FOUNDER_RISK_CONFIG = {
  maxStakePctOfCycleActive: 0.03,
  allowedStakeFractions: [0.30, 0.50, 0.70, 1.00],
  maxOpenExposurePct: 0.80,
  maxOpenPositions: 30,
  maxAcceptedPerUtcDay: 100,
} as const;

export interface FounderRiskConfig {
  maxStakePctOfCycleActive: number;
  allowedStakeFractions: readonly [number, number, number, number];
  maxOpenExposurePct: number;
  maxOpenPositions: number;
  maxAcceptedPerUtcDay: number;
}
