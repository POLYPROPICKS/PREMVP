/**
 * PRE-MODEL eligibility: use the canonical aggregate volume for the event,
 * never an individual child market's volume.
 */
export const MINIMUM_MODEL_EVENT_VOLUME_USD = 1000;

export function hasEligibleEventVolume(volume: unknown): volume is number {
  return typeof volume === "number" && Number.isFinite(volume) && volume >= MINIMUM_MODEL_EVENT_VOLUME_USD;
}
