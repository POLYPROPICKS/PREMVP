export const WILSON_ONE_SIDED_90_Z = 1.2815515655446004;
export type StakeTier = 0 | 0.3 | 0.5 | 0.7 | 1;

export interface CalibrationObservation { resolvedAtMs: number; win: boolean; score: number; price: number; coverage: number; marketFamily: string | null }
export interface CalibrationDecision { decisionAtMs: number; score: number; price: number; coverage: number; marketFamily: string | null }
export interface CalibrationResult { wins: number; sampleSize: number; bucketLevel: "EXACT" | "SCORE_PRICE" | "SCORE" | "GLOBAL"; qMean: number; qLower: number; conservativeKellyFraction: number; cappedFraction: number; stakeTier: StakeTier; robustExpectedRoi: number }

export function wilsonLowerBound90(wins: number, n: number): number {
  if (n <= 0) return 0;
  const p = wins / n, z = WILSON_ONE_SIDED_90_Z, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n));
}
export function quantizeConservativeFraction(value: number): StakeTier {
  if (value < 0.009) return 0;
  if (value < 0.015) return 0.3;
  if (value < 0.021) return 0.5;
  if (value < 0.03) return 0.7;
  return 1;
}
const band = (v: number, width: number) => Math.floor(v / width);
export function calibratePastOnlyProbability(decision: CalibrationDecision, observations: readonly CalibrationObservation[], minimumExactBucket = 30): CalibrationResult {
  const past = observations.filter((x) => x.resolvedAtMs < decision.decisionAtMs).sort((a,b)=>a.resolvedAtMs-b.resolvedAtMs||a.score-b.score||a.price-b.price);
  const levels: Array<[CalibrationResult["bucketLevel"], (x: CalibrationObservation) => boolean]> = [
    ["EXACT", x => band(x.score, 5) === band(decision.score, 5) && band(x.price, .1) === band(decision.price, .1) && band(x.coverage, 25) === band(decision.coverage, 25) && x.marketFamily === decision.marketFamily],
    ["SCORE_PRICE", x => band(x.score, 5) === band(decision.score, 5) && band(x.price, .1) === band(decision.price, .1)],
    ["SCORE", x => band(x.score, 5) === band(decision.score, 5)], ["GLOBAL", () => true],
  ];
  let selected: CalibrationObservation[] = [], bucketLevel: CalibrationResult["bucketLevel"] = "GLOBAL";
  for (const [level, predicate] of levels) { const rows = past.filter(predicate); if (rows.length >= minimumExactBucket || level === "GLOBAL") { selected = rows; bucketLevel = level; break; } }
  const wins = selected.filter(x=>x.win).length, qMean = selected.length ? wins / selected.length : 0, qLower = wilsonLowerBound90(wins, selected.length);
  const conservativeKellyFraction = decision.price < 1 ? Math.max(0, (qLower - decision.price) / (1 - decision.price)) : 0;
  const cappedFraction = Math.min(0.03, conservativeKellyFraction);
  return { wins, sampleSize: selected.length, bucketLevel, qMean, qLower, conservativeKellyFraction, cappedFraction, stakeTier: quantizeConservativeFraction(cappedFraction), robustExpectedRoi: decision.price > 0 ? (qLower - decision.price) / decision.price : 0 };
}
