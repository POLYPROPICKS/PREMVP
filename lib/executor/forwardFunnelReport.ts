import type { ContractADecisionResult, ContractAPlanningDecision } from "./contractADecisions";

type Row = Record<string, unknown>;
type Decision = ContractADecisionResult<ContractAPlanningDecision>;

export interface ForwardFunnelSummary {
  signal_pair_rows: number;
  rows_missing_canonical_event_start: number;
  unique_events: number;
  sports: Record<string, number>;
  score_ready: number;
  contract_a_input: number;
  pre_contract_a_eligible: number;
  contract_a_decision_results: number;
  contract_a_accepted: number;
  contract_a_rejected: number;
  top_first_rejection_reasons: Record<string, number>;
  planning_selected: number;
  would_reserve: number;
}

export function eventStartOf(row: Row): string | null {
  const diagnostics = row.diagnostics;
  const raw = diagnostics && typeof diagnostics === "object"
    ? (diagnostics as Row).gameStartIso
    : null;
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function structuredEventIdOf(row: Row, eventStartIso: string): string | null {
  const diagnostics = row.diagnostics;
  const context = diagnostics && typeof diagnostics === "object"
    ? (diagnostics as Row).providerEventContext
    : null;
  const eventId = context && typeof context === "object" ? (context as Row).eventId : null;
  return typeof eventId === "string" && eventId.trim() ? `provider:${eventId.trim().toLowerCase()}:${eventStartIso}` : null;
}

function sportOf(row: Row): string {
  const diagnostics = row.diagnostics;
  const context = diagnostics && typeof diagnostics === "object"
    ? (diagnostics as Row).providerEventContext
    : null;
  const sport = context && typeof context === "object" ? (context as Row).sportFamily : null;
  return typeof sport === "string" && sport.trim() ? sport.trim() : "UNKNOWN";
}

function scoreReady(row: Row): boolean {
  return typeof row.signal_confidence_num === "number" && row.signal_confidence_num >= 50 &&
    typeof row.entry_price_num === "number" && row.selected_token_id != null && row.condition_id != null;
}

export function rowsForEventWindow(rows: readonly Row[], startMs: number, endMs: number): {
  datedRows: Row[];
  missingCanonicalEventStart: number;
} {
  const datedRows: Row[] = [];
  let missingCanonicalEventStart = 0;
  for (const row of rows) {
    const start = eventStartOf(row);
    if (start === null) {
      missingCanonicalEventStart += 1;
      continue;
    }
    const ms = Date.parse(start);
    if (ms >= startMs && ms < endMs) datedRows.push(row);
  }
  return { datedRows, missingCanonicalEventStart };
}

export function summarizeForwardFunnel(input: {
  rows: readonly Row[];
  decisions: readonly Decision[];
  contractAFunctionInput: number;
  preContractEligible: number;
  reservationPhysicalEventIds: readonly string[];
  planningSelected: number;
  startMs: number;
  endMs: number;
}): ForwardFunnelSummary {
  const { datedRows, missingCanonicalEventStart } = rowsForEventWindow(input.rows, input.startMs, input.endMs);
  const sports: Record<string, number> = {};
  const eventIds = new Set<string>();
  for (const row of datedRows) {
    const eventStart = eventStartOf(row)!;
    const sport = sportOf(row);
    sports[sport] = (sports[sport] ?? 0) + 1;
    const eventId = structuredEventIdOf(row, eventStart);
    if (eventId !== null) eventIds.add(eventId);
  }
  const rejected = input.decisions.filter((decision) => !decision.accepted);
  const top_first_rejection_reasons: Record<string, number> = {};
  for (const decision of rejected) {
    const reason = decision.rejection.reason_code;
    top_first_rejection_reasons[reason] = (top_first_rejection_reasons[reason] ?? 0) + 1;
  }
  const contract_a_accepted = input.decisions.length - rejected.length;
  if (input.decisions.length !== contract_a_accepted + rejected.length) throw new Error("CONTRACT_A_CONSERVATION_FAILED");
  return {
    signal_pair_rows: datedRows.length,
    rows_missing_canonical_event_start: missingCanonicalEventStart,
    unique_events: eventIds.size,
    sports,
    score_ready: datedRows.filter(scoreReady).length,
    // `produceContractAPlanningDecisions` receives source rows, then reuses
    // the candidate builder. Keep both boundaries explicit: eligible results
    // conserve with accepted/rejected; raw function input does not.
    contract_a_input: input.contractAFunctionInput,
    pre_contract_a_eligible: input.preContractEligible,
    contract_a_decision_results: input.decisions.length,
    contract_a_accepted,
    contract_a_rejected: rejected.length,
    top_first_rejection_reasons: Object.fromEntries(Object.entries(top_first_rejection_reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    planning_selected: input.planningSelected,
    would_reserve: new Set(input.reservationPhysicalEventIds).size,
  };
}

export function compareReservationSets(at: readonly string[], compare: readonly string[]) {
  const early = new Set(at);
  const late = new Set(compare);
  return {
    same: [...early].filter((id) => late.has(id)).sort(),
    added_by_compare: [...late].filter((id) => !early.has(id)).sort(),
    lost_by_compare: [...early].filter((id) => !late.has(id)).sort(),
  };
}
