/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — deterministic research engine.
 *
 * Runs one or all frozen models (C0/C1/C4/C5) against a compatible
 * normalized input and emits machine-readable results. No LLM dependency.
 *
 * Economic invariant: one physical economic event -> maximum one selected
 * economic bet. Duplicate candidate rows for the same `physicalEventKey`
 * collapse to the chronologically first row that satisfies the predicate.
 */
import {
  FROZEN_MODELS,
  FROZEN_MODEL_IDS,
  MODEL_RESEARCH_ENGINE_VERSION,
  getFrozenModel,
  type FrozenModelId,
} from "./models";
import { aggregateMetrics, sortChronologically } from "./metrics";
import { settleBetU } from "./settlement";
import type {
  EvaluatedEvent,
  ModelResult,
  ResearchEngineInputEvent,
  SelectedBet,
} from "./types";

const MS_PER_HOUR = 3_600_000;

function parseIso(label: string, value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`research-engine: ${label} is not a valid ISO date: ${value}`);
  }
  return ms;
}

/** Attach the derived `leadTimeHours` time semantic to a raw input row. */
export function evaluateEvent(input: ResearchEngineInputEvent): EvaluatedEvent {
  if (!input.physicalEventKey) {
    throw new TypeError("research-engine: physicalEventKey is required on every input row");
  }
  const startMs = parseIso("eventStart", input.eventStart);
  const decisionMs = parseIso("decisionTimestamp", input.decisionTimestamp);
  return {
    ...input,
    leadTimeHours: (startMs - decisionMs) / MS_PER_HOUR,
  };
}

function toSelectedBet(event: EvaluatedEvent): SelectedBet {
  return {
    physicalEventKey: event.physicalEventKey,
    decisionTimestamp: event.decisionTimestamp,
    eventStart: event.eventStart,
    leadTimeHours: event.leadTimeHours,
    entryPrice: event.entryPrice,
    sportFamily: event.sportFamily,
    outcome: event.outcome,
    pnlU: settleBetU(event.outcome, event.entryPrice),
    ...(event.ref === undefined ? {} : { ref: event.ref }),
  };
}

/** Run a single frozen model against normalized input. */
export function runModel(
  modelId: FrozenModelId,
  input: ResearchEngineInputEvent[],
): ModelResult {
  const model = getFrozenModel(modelId);
  const ordered = sortChronologically(input.map(evaluateEvent));

  const selectedBets: SelectedBet[] = [];
  const claimedKeys = new Set<string>();
  for (const event of ordered) {
    if (claimedKeys.has(event.physicalEventKey)) {
      continue; // one physical event -> maximum one selected bet
    }
    if (!model.predicate(event)) {
      continue;
    }
    claimedKeys.add(event.physicalEventKey);
    selectedBets.push(toSelectedBet(event));
  }

  const metrics = aggregateMetrics(selectedBets);
  return {
    MODEL_ID: model.MODEL_ID,
    MODEL_VERSION: model.MODEL_VERSION,
    ROLE: model.ROLE,
    INPUT_EVENT_N: input.length,
    SELECTED_PHYSICAL_EVENT_N: metrics.SELECTED_PHYSICAL_EVENT_N,
    WINS: metrics.WINS,
    LOSSES: metrics.LOSSES,
    PNL_U: metrics.PNL_U,
    ROI_PCT: metrics.ROI_PCT,
    MAX_DRAWDOWN_U: metrics.MAX_DRAWDOWN_U,
    raw: metrics.raw,
    selectedMembership: selectedBets.map((b) => b.physicalEventKey),
    selectedBets,
  };
}

export interface EngineRunResult {
  engineVersion: string;
  models: Record<string, ModelResult>;
}

/** Run one model id, or all four when `modelId` is omitted or `"all"`. */
export function runResearchEngine(
  input: ResearchEngineInputEvent[],
  modelId: FrozenModelId | "all" = "all",
): EngineRunResult {
  const ids: FrozenModelId[] =
    modelId === "all" ? [...FROZEN_MODEL_IDS] : [modelId];
  const models: Record<string, ModelResult> = {};
  for (const id of ids) {
    models[id] = runModel(id, input);
  }
  return { engineVersion: MODEL_RESEARCH_ENGINE_VERSION, models };
}

export { FROZEN_MODELS, FROZEN_MODEL_IDS, MODEL_RESEARCH_ENGINE_VERSION };
export type { FrozenModelId };
