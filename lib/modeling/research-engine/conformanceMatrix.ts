/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — small fixed synthetic conformance matrix.
 *
 * This is a SMALL FIXED synthetic unit-test fixture, explicitly allowed by
 * the mission. It is NOT a historical corpus and NOT a growing modeling
 * dataset. It exists only to exercise the frozen predicates and the
 * structural membership relations.
 */
import type { EvaluatedEvent } from "./types";

/**
 * Canonical sport-family values that are historically relevant to the
 * accepted frozen contract. Used to check C4 => C5 across representative
 * sport values under the documented historical membership assumption.
 */
export const HISTORICALLY_RELEVANT_CANONICAL_SPORTS = [
  "soccer",
  "basketball",
  "tennis",
  "table-tennis",
  "baseball",
  "ice-hockey",
  "american-football",
] as const;

/**
 * Documented historical membership assumption: table-tennis rows never
 * carried lead_time_hours >= 24 in the accepted historical data, so a
 * table-tennis row could never be C4-selected. The conformance matrix
 * respects this assumption; CANONICAL_MODELING_DATASET_V1 re-proves it.
 */
export const HISTORICAL_MEMBERSHIP_ASSUMPTIONS = {
  "table-tennis": { maxLeadTimeHoursObserved: "< 24" },
} as const;

interface MatrixSpec {
  label: string;
  sportFamily: string;
  entryPrice: number;
  leadTimeHours: number;
  outcome: "WIN" | "LOSS";
}

function fromLeadTime(spec: MatrixSpec): EvaluatedEvent {
  // Fixed anchor; decisionTimestamp derived so eventStart - decision == leadTime.
  const eventStartMs = Date.parse("2026-06-01T18:00:00.000Z");
  const decisionMs = eventStartMs - spec.leadTimeHours * 3_600_000;
  return {
    physicalEventKey: `matrix:${spec.label}`,
    decisionTimestamp: new Date(decisionMs).toISOString(),
    eventStart: "2026-06-01T18:00:00.000Z",
    entryPrice: spec.entryPrice,
    sportFamily: spec.sportFamily,
    outcome: spec.outcome,
    leadTimeHours: spec.leadTimeHours,
    ref: spec.label,
  };
}

/**
 * Representative conformance matrix. Respects
 * HISTORICAL_MEMBERSHIP_ASSUMPTIONS (no table-tennis row with lead >= 24h).
 */
const CONFORMANCE_MATRIX_SPECS: MatrixSpec[] = [
  { label: "soccer-band-lead-0", sportFamily: "soccer", entryPrice: 0.5, leadTimeHours: 0, outcome: "WIN" },
  { label: "soccer-band-lead-2", sportFamily: "soccer", entryPrice: 0.55, leadTimeHours: 2, outcome: "LOSS" },
  { label: "soccer-band-lead-48", sportFamily: "soccer", entryPrice: 0.59, leadTimeHours: 48, outcome: "WIN" },
  { label: "soccer-below-band", sportFamily: "soccer", entryPrice: 0.49, leadTimeHours: 30, outcome: "WIN" },
  { label: "soccer-at-060", sportFamily: "soccer", entryPrice: 0.6, leadTimeHours: 30, outcome: "LOSS" },
  { label: "basketball-band-lead-2", sportFamily: "basketball", entryPrice: 0.52, leadTimeHours: 2, outcome: "WIN" },
  { label: "basketball-band-lead-24", sportFamily: "basketball", entryPrice: 0.52, leadTimeHours: 24, outcome: "LOSS" },
  { label: "basketball-band-lead-72", sportFamily: "basketball", entryPrice: 0.58, leadTimeHours: 72, outcome: "WIN" },
  { label: "tennis-band-lead-25", sportFamily: "tennis", entryPrice: 0.5, leadTimeHours: 25, outcome: "LOSS" },
  { label: "tennis-band-lead-1", sportFamily: "tennis", entryPrice: 0.5, leadTimeHours: 1, outcome: "WIN" },
  { label: "baseball-band-lead-36", sportFamily: "baseball", entryPrice: 0.53, leadTimeHours: 36, outcome: "WIN" },
  { label: "ice-hockey-band-lead-26", sportFamily: "ice-hockey", entryPrice: 0.57, leadTimeHours: 26, outcome: "LOSS" },
  { label: "american-football-band-lead-30", sportFamily: "american-football", entryPrice: 0.5, leadTimeHours: 30, outcome: "WIN" },
  { label: "table-tennis-band-lead-2", sportFamily: "table-tennis", entryPrice: 0.55, leadTimeHours: 2, outcome: "WIN" },
  { label: "table-tennis-band-lead-12", sportFamily: "table-tennis", entryPrice: 0.5, leadTimeHours: 12, outcome: "LOSS" },
  { label: "table-tennis-below-band-lead-2", sportFamily: "table-tennis", entryPrice: 0.4, leadTimeHours: 2, outcome: "WIN" },
];

export const CONFORMANCE_MATRIX: EvaluatedEvent[] =
  CONFORMANCE_MATRIX_SPECS.map(fromLeadTime);
