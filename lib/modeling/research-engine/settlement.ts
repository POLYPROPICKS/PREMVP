/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — settlement.
 *
 * Flat stake = 1u for every selected bet.
 *
 *   WIN:  pnl_u = 1 / entry_price - 1
 *   LOSS: pnl_u = -1
 */
import type { Outcome } from "./types";

/** Flat stake, in units, applied to every selected bet. */
export const FLAT_STAKE_U = 1;

/**
 * Settlement of a single flat-1u bet.
 *
 * @param outcome    Realized outcome.
 * @param entryPrice Entry price in probability units (0 < p < 1).
 * @returns          Profit/loss in units.
 */
export function settleBetU(outcome: Outcome, entryPrice: number): number {
  if (!(entryPrice > 0 && entryPrice < 1)) {
    throw new RangeError(
      `settleBetU: entryPrice must be in (0, 1), received ${entryPrice}`,
    );
  }
  if (outcome === "WIN") {
    return 1 / entryPrice - 1;
  }
  return -1;
}
