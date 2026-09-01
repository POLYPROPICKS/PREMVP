/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — frozen model registry.
 *
 * C0 / C1 / C4 / C5 are already-frozen models. This file is their
 * versioned, deterministic, LLM-free encoding. Thresholds are frozen —
 * this mission introduces no new hypothesis and changes no threshold.
 */
import type { EvaluatedEvent } from "./types";

export type FrozenModelId = "C0" | "C1" | "C4" | "C5";

/** Shared price band for every frozen model: 0.50 <= entry_price < 0.60. */
export const ENTRY_PRICE_BAND = { minInclusive: 0.5, maxExclusive: 0.6 } as const;

/** Lead-time threshold used by C4: lead_time_hours >= 24. */
export const C4_LEAD_TIME_HOURS_THRESHOLD = 24;

/** Sport family C1 restricts to. */
export const SOCCER_FAMILY = "soccer";

/** Sport family C5 excludes. */
export const TABLE_TENNIS_FAMILY = "table-tennis";

export interface FrozenModel {
  MODEL_ID: FrozenModelId;
  MODEL_VERSION: string;
  ROLE: string;
  NAME: string;
  timeSemantics: string;
  economicUnit: string;
  stakeSemantics: string;
  predicateDescription: string;
  /** Deterministic membership predicate over an evaluated event. */
  predicate: (event: EvaluatedEvent) => boolean;
}

/** Single version string for the whole frozen family in this freeze. */
export const MODEL_RESEARCH_ENGINE_VERSION = "freeze-v1";

function inPriceBand(entryPrice: number): boolean {
  return (
    entryPrice >= ENTRY_PRICE_BAND.minInclusive &&
    entryPrice < ENTRY_PRICE_BAND.maxExclusive
  );
}

const COMMON = {
  MODEL_VERSION: MODEL_RESEARCH_ENGINE_VERSION,
  timeSemantics: "lead_time_hours = eventStart - decisionTimestamp (hours)",
  economicUnit: "unit (u); WIN pnl_u = 1/entry_price - 1, LOSS pnl_u = -1",
  stakeSemantics: "flat 1u stake per selected physical event",
} as const;

export const FROZEN_MODELS: Record<FrozenModelId, FrozenModel> = {
  C0: {
    ...COMMON,
    MODEL_ID: "C0",
    NAME: "PRICE_ANCHOR",
    ROLE: "PRICE_ANCHOR",
    predicateDescription: "0.50 <= entry_price < 0.60",
    predicate: (e) => inPriceBand(e.entryPrice),
  },
  C1: {
    ...COMMON,
    MODEL_ID: "C1",
    NAME: "HIGH_ROI",
    ROLE: "HIGH_ROI",
    predicateDescription: "0.50 <= entry_price < 0.60 AND sport_family = soccer",
    predicate: (e) => inPriceBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY,
  },
  C4: {
    ...COMMON,
    MODEL_ID: "C4",
    NAME: "BALANCED",
    ROLE: "BALANCED / CURRENT OPERATING MODEL",
    predicateDescription:
      "0.50 <= entry_price < 0.60 AND (sport_family = soccer OR lead_time_hours >= 24)",
    predicate: (e) =>
      inPriceBand(e.entryPrice) &&
      (e.sportFamily === SOCCER_FAMILY ||
        e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD),
  },
  C5: {
    ...COMMON,
    MODEL_ID: "C5",
    NAME: "PNL_SCALE",
    ROLE: "PNL_SCALE",
    predicateDescription:
      "0.50 <= entry_price < 0.60 AND sport_family != table-tennis",
    predicate: (e) =>
      inPriceBand(e.entryPrice) && e.sportFamily !== TABLE_TENNIS_FAMILY,
  },
};

export const FROZEN_MODEL_IDS: FrozenModelId[] = ["C0", "C1", "C4", "C5"];

export function getFrozenModel(id: FrozenModelId): FrozenModel {
  const model = FROZEN_MODELS[id];
  if (!model) {
    throw new Error(`getFrozenModel: unknown model id ${id}`);
  }
  return model;
}
