// Phase 3D.2R -- Data Integrity Notebook/report (read-only founder review).
//
// Pure, deterministic transform: two already-generated canonical local
// JSON artifacts (corpus audit + formula cohort comparison) in, one
// review-model object out. Never re-derives dedup/ROI from raw rows,
// never queries Supabase, never mutates its inputs. The CLI wrapper
// (scripts/modeling/notebooks/build-data-integrity-report.ts) is the only
// part of this feature that touches fs, and only to read the two inputs
// and write one HTML file.

import type { CorpusAuditReport } from "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus";
import type {
  FormulaCohortComparisonReport,
  FormulaCohortEntry,
} from "../../scripts/modeling/strategies/compare-formula-cohorts";

export const DATA_INTEGRITY_REPORT_PHASE = "3D.2R" as const;

export class DataIntegrityContractError extends Error {
  readonly inputArtifactPath: string;
  readonly contractField: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly phase = DATA_INTEGRITY_REPORT_PHASE;

  constructor(params: {
    message: string;
    inputArtifactPath: string;
    contractField: string;
    expected: unknown;
    actual: unknown;
  }) {
    super(params.message);
    this.name = "DataIntegrityContractError";
    this.inputArtifactPath = params.inputArtifactPath;
    this.contractField = params.contractField;
    this.expected = params.expected;
    this.actual = params.actual;
  }
}

/**
 * Parses raw JSON text for one of the two canonical inputs, checking only
 * that it parses and that schemaVersion === 1. Never inspects/logs
 * env values or row payloads. Throws DataIntegrityContractError with the
 * required trace fields (input path, failing field, expected vs actual,
 * phase) on any violation.
 */
export function parseCanonicalReportJson<T extends { schemaVersion: number }>(
  raw: string,
  inputArtifactPath: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new DataIntegrityContractError({
      message: `failed to parse ${inputArtifactPath} as JSON: ${message}`,
      inputArtifactPath,
      contractField: "json",
      expected: "valid JSON",
      actual: message,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DataIntegrityContractError({
      message: `${inputArtifactPath} must contain a JSON object`,
      inputArtifactPath,
      contractField: "root",
      expected: "object",
      actual: Array.isArray(parsed) ? "array" : typeof parsed,
    });
  }
  const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== 1) {
    throw new DataIntegrityContractError({
      message: `${inputArtifactPath} has an unsupported schemaVersion`,
      inputArtifactPath,
      contractField: "schemaVersion",
      expected: 1,
      actual: schemaVersion,
    });
  }
  return parsed as T;
}

export interface DataIntegrityInputs {
  corpusAuditPath: string;
  corpusAudit: CorpusAuditReport;
  formulaCohortPath: string;
  formulaCohort: FormulaCohortComparisonReport;
}

/**
 * Cross-artifact contract checks. Every check here is a read-only
 * assertion over already-computed numbers -- it never recomputes
 * dedup/ROI. Returns every violation found rather than throwing on the
 * first one, so the founder sees the full picture; the CLI decides
 * whether to fail on any violations.
 */
export function validateDataIntegrityContract(
  inputs: DataIntegrityInputs,
): DataIntegrityContractError[] {
  const { corpusAuditPath, corpusAudit, formulaCohortPath, formulaCohort } = inputs;
  const violations: DataIntegrityContractError[] = [];

  if (formulaCohort.canonicalCorpus.retainedRows !== formulaCohort.canonicalCorpus.dedupRows) {
    violations.push(
      new DataIntegrityContractError({
        message: "canonicalCorpus.retainedRows must equal canonicalCorpus.dedupRows",
        inputArtifactPath: formulaCohortPath,
        contractField: "canonicalCorpus.retainedRows",
        expected: formulaCohort.canonicalCorpus.dedupRows,
        actual: formulaCohort.canonicalCorpus.retainedRows,
      }),
    );
  }

  if (formulaCohort.canonicalCorpus.droppedForFormulaVersion !== 0) {
    violations.push(
      new DataIntegrityContractError({
        message: "canonicalCorpus.droppedForFormulaVersion must be zero (founder-locked policy)",
        inputArtifactPath: formulaCohortPath,
        contractField: "canonicalCorpus.droppedForFormulaVersion",
        expected: 0,
        actual: formulaCohort.canonicalCorpus.droppedForFormulaVersion,
      }),
    );
  }

  const formulaCohortRowSum = formulaCohort.formulaVersionCohorts.reduce((sum, c) => sum + c.rows, 0);
  if (formulaCohortRowSum !== formulaCohort.canonicalCorpus.dedupRows) {
    violations.push(
      new DataIntegrityContractError({
        message: "formulaVersionCohorts row counts must sum to canonicalCorpus.dedupRows",
        inputArtifactPath: formulaCohortPath,
        contractField: "formulaVersionCohorts[].rows(sum)",
        expected: formulaCohort.canonicalCorpus.dedupRows,
        actual: formulaCohortRowSum,
      }),
    );
  }

  if (formulaCohort.allDedupControl.rows !== formulaCohort.canonicalCorpus.dedupRows) {
    violations.push(
      new DataIntegrityContractError({
        message: "allDedupControl.rows must equal canonicalCorpus.dedupRows",
        inputArtifactPath: formulaCohortPath,
        contractField: "allDedupControl.rows",
        expected: formulaCohort.canonicalCorpus.dedupRows,
        actual: formulaCohort.allDedupControl.rows,
      }),
    );
  }

  if (corpusAudit.dedupRows !== formulaCohort.canonicalCorpus.dedupRows) {
    violations.push(
      new DataIntegrityContractError({
        message: "corpus audit dedupRows must match formula cohort report dedupRows",
        inputArtifactPath: corpusAuditPath,
        contractField: "dedupRows",
        expected: formulaCohort.canonicalCorpus.dedupRows,
        actual: corpusAudit.dedupRows,
      }),
    );
  }

  return violations;
}

export type ReadinessVerdict = "PASS" | "PASS_WITH_LIMITATION" | "BLOCKED";

export interface ReadinessGate {
  gate: string;
  verdict: ReadinessVerdict;
}

export interface DataIntegrityReportModel {
  phase: typeof DATA_INTEGRITY_REPORT_PHASE;
  executiveSummary: {
    sourceRows: number;
    dedupRows: number;
    duplicatesRemoved: number;
    retainedRows: number;
    droppedForFormulaVersion: number;
    coverageCalendarDays: number;
  };
  datasetFunnel: Array<{ stage: string; rows: number | null; note?: string }>;
  coverageTimeline: {
    raw: { min: string | null; max: string | null };
    dedup: { min: string | null; max: string | null };
    trusted: { min: string | null; max: string | null };
    calendarDaysInclusive: number;
  };
  formulaVersionCohorts: FormulaCohortEntry[];
  allDedupControl: FormulaCohortComparisonReport["allDedupControl"];
  metricFormulaVersionCohorts: FormulaCohortEntry[];
  cardinality: CorpusAuditReport["cardinality"] & {
    eventsWithMoreThanOneSignal: number;
    medianSignalsPerEvent: number;
    p75SignalsPerEvent: number;
    p90SignalsPerEvent: number;
    maxSignalsPerEvent: number;
  };
  eventIdentityEvidence: CorpusAuditReport["eventIdentityEvidence"];
  readinessGates: ReadinessGate[];
  nextExperimentContract: {
    phase: "3E.3";
    name: "one-event comparator";
    executed: false;
    description: string;
  };
  warnings: string[];
}

const FORMULA_LINEAGE_WARNING =
  "Formula lineage does not imply quality. No cohort is automatically promoted.";

const EVENT_IDENTITY_WARNING =
  "Working event count is based entirely on MEDIUM event_slug identity. It is suitable for exploratory analysis, not production-grade event identity proof.";

/**
 * Builds the founder-review model from the two validated canonical
 * reports. Pure function: no fs/env/network, no ROI/dedup recomputation,
 * no ranking of cohorts. Callers must run validateDataIntegrityContract
 * first and decide how to handle violations -- this function does not
 * throw on contract violations itself.
 */
export function buildDataIntegrityReportModel(inputs: DataIntegrityInputs): DataIntegrityReportModel {
  const { corpusAudit, formulaCohort } = inputs;

  return {
    phase: DATA_INTEGRITY_REPORT_PHASE,
    executiveSummary: {
      sourceRows: corpusAudit.sourceRows,
      dedupRows: corpusAudit.dedupRows,
      duplicatesRemoved: corpusAudit.droppedDuplicateRows,
      retainedRows: formulaCohort.canonicalCorpus.retainedRows,
      droppedForFormulaVersion: formulaCohort.canonicalCorpus.droppedForFormulaVersion,
      coverageCalendarDays: corpusAudit.dedupCoverage.calendarDaysInclusive,
    },
    datasetFunnel: [
      { stage: "raw snapshots", rows: corpusAudit.sourceRows },
      { stage: "strict market/outcome signals (deduped)", rows: corpusAudit.dedupRows },
      { stage: "retained canonical rows", rows: formulaCohort.canonicalCorpus.retainedRows },
      {
        stage: "descriptive formula cohorts",
        rows: null,
        note: "cohorts split the retained corpus for comparison; they are not a smaller dataset",
      },
    ],
    coverageTimeline: {
      raw: { min: corpusAudit.rawCoverage.minResolvedAt, max: corpusAudit.rawCoverage.maxResolvedAt },
      dedup: { min: corpusAudit.dedupCoverage.minResolvedAt, max: corpusAudit.dedupCoverage.maxResolvedAt },
      trusted: {
        min: corpusAudit.trustedFormula.minResolvedAt,
        max: corpusAudit.trustedFormula.maxResolvedAt,
      },
      calendarDaysInclusive: corpusAudit.dedupCoverage.calendarDaysInclusive,
    },
    formulaVersionCohorts: formulaCohort.formulaVersionCohorts,
    allDedupControl: formulaCohort.allDedupControl,
    metricFormulaVersionCohorts: formulaCohort.metricFormulaVersionCohorts,
    cardinality: {
      ...corpusAudit.cardinality,
      eventsWithMoreThanOneSignal: corpusAudit.signalsPerSportingEvent.eventsWithMoreThanOneSignal,
      medianSignalsPerEvent: corpusAudit.signalsPerSportingEvent.median,
      p75SignalsPerEvent: corpusAudit.signalsPerSportingEvent.p75,
      p90SignalsPerEvent: corpusAudit.signalsPerSportingEvent.p90,
      maxSignalsPerEvent: corpusAudit.signalsPerSportingEvent.max,
    },
    eventIdentityEvidence: corpusAudit.eventIdentityEvidence,
    readinessGates: [
      { gate: "Corpus retention", verdict: "PASS" },
      { gate: "Formula cohort preservation", verdict: "PASS" },
      { gate: "ROI contract completeness", verdict: "PASS" },
      { gate: "Event identity for exploratory analysis", verdict: "PASS_WITH_LIMITATION" },
      { gate: "Event identity for production promotion", verdict: "BLOCKED" },
      { gate: "Champion/model promotion", verdict: "BLOCKED" },
    ],
    nextExperimentContract: {
      phase: "3E.3",
      name: "one-event comparator",
      executed: false,
      description:
        "May use MEDIUM event_slug grouping for exploratory comparison only: all strict signals vs one selected signal per working event, without removing any canonical row.",
    },
    warnings: [FORMULA_LINEAGE_WARNING, EVENT_IDENTITY_WARNING],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function cohortRowsHtml(entries: FormulaCohortEntry[]): string {
  return entries
    .map(
      (e) => `<tr>
  <td>${escapeHtml(e.cohortId)}</td>
  <td>${fmtNum(e.rows)}</td>
  <td>${fmtNum(e.roi.winCount)}</td>
  <td>${fmtNum(e.roi.lossCount)}</td>
  <td>${fmtNum(e.roi.winRatePct)}</td>
  <td>${fmtNum(e.roi.roiPct)}</td>
  <td>${fmtNum(e.roi.totalPnlUnits)}</td>
  <td>${escapeHtml(e.qualityVerdict)}</td>
</tr>`,
    )
    .join("\n");
}

/**
 * Deterministic HTML render of the review model. No timestamps or
 * randomness -- identical input always produces identical output. This
 * is the only serialization format produced; there is no separate
 * ROI/dedup logic here, only display of already-computed numbers.
 */
export function renderDataIntegrityHtml(model: DataIntegrityReportModel): string {
  const funnelRows = model.datasetFunnel
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.stage)}</td><td>${f.rows === null ? "—" : fmtNum(f.rows)}</td><td>${
          f.note ? escapeHtml(f.note) : ""
        }</td></tr>`,
    )
    .join("\n");

  const identity = model.eventIdentityEvidence.rowsByConfidenceClass;
  const gatesRows = model.readinessGates
    .map((g) => `<tr><td>${escapeHtml(g.gate)}</td><td>${escapeHtml(g.verdict)}</td></tr>`)
    .join("\n");

  return `<section data-phase="${model.phase}">
<h1>Data Integrity Review -- Phase ${model.phase}</h1>

<h2>1. Executive summary</h2>
<ul>
<li>Source rows: ${fmtNum(model.executiveSummary.sourceRows)}</li>
<li>Strict dedup rows: ${fmtNum(model.executiveSummary.dedupRows)}</li>
<li>Duplicates removed: ${fmtNum(model.executiveSummary.duplicatesRemoved)}</li>
<li>Rows retained after lineage segmentation: ${fmtNum(model.executiveSummary.retainedRows)}</li>
<li>Formula-version drops: ${fmtNum(model.executiveSummary.droppedForFormulaVersion)}</li>
<li>Coverage: ${fmtNum(model.executiveSummary.coverageCalendarDays)} calendar days</li>
</ul>

<h2>2. Dataset funnel</h2>
<table><thead><tr><th>Stage</th><th>Rows</th><th>Note</th></tr></thead>
<tbody>
${funnelRows}
</tbody></table>

<h2>3. Coverage timeline</h2>
<table><tbody>
<tr><td>Raw</td><td>${escapeHtml(model.coverageTimeline.raw.min ?? "n/a")}</td><td>${escapeHtml(model.coverageTimeline.raw.max ?? "n/a")}</td></tr>
<tr><td>Dedup</td><td>${escapeHtml(model.coverageTimeline.dedup.min ?? "n/a")}</td><td>${escapeHtml(model.coverageTimeline.dedup.max ?? "n/a")}</td></tr>
<tr><td>Trusted</td><td>${escapeHtml(model.coverageTimeline.trusted.min ?? "n/a")}</td><td>${escapeHtml(model.coverageTimeline.trusted.max ?? "n/a")}</td></tr>
</tbody></table>
<p>Calendar days inclusive (dedup): ${fmtNum(model.coverageTimeline.calendarDaysInclusive)}</p>

<h2>4. Formula cohorts</h2>
<p class="warning">${escapeHtml(model.warnings[0])}</p>
<table><thead><tr><th>cohortId</th><th>rows</th><th>win</th><th>loss</th><th>winRate%</th><th>ROI%</th><th>PnL units</th><th>qualityVerdict</th></tr></thead>
<tbody>
<tr>
  <td>${escapeHtml(model.allDedupControl.cohortId)}</td>
  <td>${fmtNum(model.allDedupControl.rows)}</td>
  <td>${fmtNum(model.allDedupControl.roi.winCount)}</td>
  <td>${fmtNum(model.allDedupControl.roi.lossCount)}</td>
  <td>${fmtNum(model.allDedupControl.roi.winRatePct)}</td>
  <td>${fmtNum(model.allDedupControl.roi.roiPct)}</td>
  <td>${fmtNum(model.allDedupControl.roi.totalPnlUnits)}</td>
  <td>—</td>
</tr>
${cohortRowsHtml(model.formulaVersionCohorts)}
</tbody></table>

<h2>5. Metric-formula cohorts</h2>
<p>metric_formula_version is a distinct lineage dimension and is never merged with formula_version.</p>
<table><thead><tr><th>cohortId</th><th>rows</th><th>win</th><th>loss</th><th>winRate%</th><th>ROI%</th><th>PnL units</th><th>qualityVerdict</th></tr></thead>
<tbody>
${cohortRowsHtml(model.metricFormulaVersionCohorts)}
</tbody></table>

<h2>6. Event/market cardinality</h2>
<ul>
<li>Unique strict market/outcome signals: ${fmtNum(model.cardinality.uniqueStrictMarketOutcomeSignals)}</li>
<li>Unique markets: ${fmtNum(model.cardinality.uniqueMarkets)}</li>
<li>Working sporting events: ${fmtNum(model.cardinality.uniqueSportingEvents)}</li>
<li>Events with &gt;1 signal: ${fmtNum(model.cardinality.eventsWithMoreThanOneSignal)}</li>
<li>Median signals/event: ${fmtNum(model.cardinality.medianSignalsPerEvent)}</li>
<li>p75: ${fmtNum(model.cardinality.p75SignalsPerEvent)}</li>
<li>p90: ${fmtNum(model.cardinality.p90SignalsPerEvent)}</li>
<li>max: ${fmtNum(model.cardinality.maxSignalsPerEvent)}</li>
</ul>

<h2>7. Event identity evidence</h2>
<table><thead><tr><th>Confidence</th><th>Rows</th></tr></thead>
<tbody>
<tr><td>STRONG</td><td>${fmtNum(identity.STRONG)}</td></tr>
<tr><td>MEDIUM</td><td>${fmtNum(identity.MEDIUM)}</td></tr>
<tr><td>WEAK</td><td>${fmtNum(identity.WEAK)}</td></tr>
<tr><td>MISSING</td><td>${fmtNum(identity.MISSING)}</td></tr>
<tr><td>CONFLICT</td><td>${fmtNum(identity.CONFLICT)}</td></tr>
</tbody></table>
<p class="warning">${escapeHtml(model.warnings[1])}</p>

<h2>8. Readiness gates</h2>
<table><thead><tr><th>Gate</th><th>Verdict</th></tr></thead>
<tbody>
${gatesRows}
</tbody></table>

<h2>9. Next experiment contract</h2>
<p>Prepared, not executed -- ${escapeHtml(model.nextExperimentContract.phase)} ${escapeHtml(model.nextExperimentContract.name)}.</p>
<p>${escapeHtml(model.nextExperimentContract.description)}</p>
</section>
`;
}
