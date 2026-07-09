// DQA-R1: pure, DB-independent audit of result-field consistency across a
// dataset of signal rows. Checks signal_result labels (case-insensitive)
// against outcome inferred from winning_outcome/selected_outcome.

export type ResultFieldAuditRow = {
  signal_result?: unknown;
  winning_outcome?: unknown;
  selected_outcome?: unknown;
};

export type ResultFieldConsistencySummary = {
  totalRows: number;
  resolvedSignalResultCount: number;
  unresolvedSignalResultCount: number;
  inferredOutcomeCount: number;
  consistentResolvedCount: number;
  resultOutcomeConflictCount: number;
  legacyUppercaseResultCount: number;
  hasBlockingViolations: boolean;
};

type Label = "win" | "loss" | "unresolved";

const WIN_LABELS = new Set(["won", "win", "hit", "resolved_win", "success"]);
const LOSS_LABELS = new Set(["lost", "loss", "miss", "resolved_loss", "failed"]);

function classifyLabel(raw: unknown): Label {
  if (typeof raw !== "string") return "unresolved";
  const lower = raw.toLowerCase();
  if (WIN_LABELS.has(lower)) return "win";
  if (LOSS_LABELS.has(lower)) return "loss";
  return "unresolved";
}

function isLegacyUppercase(raw: unknown): boolean {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw === raw.toUpperCase() &&
    raw !== raw.toLowerCase()
  );
}

function inferOutcome(row: ResultFieldAuditRow): Label | null {
  const { winning_outcome, selected_outcome } = row;
  if (winning_outcome === null || winning_outcome === undefined) return null;
  if (selected_outcome === null || selected_outcome === undefined) return null;
  return winning_outcome === selected_outcome ? "win" : "loss";
}

export function auditResultFieldConsistency(
  rows: ResultFieldAuditRow[],
): ResultFieldConsistencySummary {
  let resolvedSignalResultCount = 0;
  let inferredOutcomeCount = 0;
  let consistentResolvedCount = 0;
  let resultOutcomeConflictCount = 0;
  let legacyUppercaseResultCount = 0;

  for (const row of rows) {
    const label = classifyLabel(row.signal_result);
    if (label !== "unresolved") resolvedSignalResultCount++;
    if (isLegacyUppercase(row.signal_result)) legacyUppercaseResultCount++;

    const inferred = inferOutcome(row);
    if (inferred !== null) inferredOutcomeCount++;

    if (label !== "unresolved" && inferred !== null) {
      if (label === inferred) {
        consistentResolvedCount++;
      } else {
        resultOutcomeConflictCount++;
      }
    }
  }

  return {
    totalRows: rows.length,
    resolvedSignalResultCount,
    unresolvedSignalResultCount: rows.length - resolvedSignalResultCount,
    inferredOutcomeCount,
    consistentResolvedCount,
    resultOutcomeConflictCount,
    legacyUppercaseResultCount,
    hasBlockingViolations: resultOutcomeConflictCount > 0,
  };
}
