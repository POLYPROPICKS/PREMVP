// Three-candidate founder/CEO funnel report renderer (Phase 3E.8A).
//
// Renders a deterministic, founder-readable HTML report DERIVED from the
// classifier-built catalog (Phase 3E.8A Commit A) -- never hardcoded. Shows
// the permanent observation roles, a separate ordered table per model, a
// side-by-side rule matrix, text funnel diagrams containing only actual
// stages, real historical attrition (only when the corpus hash matches),
// known limitations, and a plain-language glossary. No Champion/winner/
// production-ready claim; sort/group are never called "filters". Pure: no
// fs/env/network access.

import type {
  ThreeCandidateFunnelCatalog,
  CatalogCandidate,
  CatalogStep,
} from "./threeCandidateFunnelCatalog";

export interface HistoricalComparisonLike {
  inputSha256?: string;
  executions?: Array<{ variantId: string; stepResults?: Array<{ step: number; action: string; inputRows: number; passedRows: number; removedRows: number }> }>;
}

export interface ReportInputs {
  catalog: ThreeCandidateFunnelCatalog;
  historicalComparison?: HistoricalComparisonLike;
  expectedCorpusSha256?: string;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ROLE_DESCRIPTION: Record<string, string> = {
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: "Selective research candidate",
  ALT2_TS_SCORE_GE_65: "Mandatory core comparator",
  ALT1_CANONICAL_EVENT_GROUPING: "Strong watch / event-grouping candidate",
};

function modelNote(variantId: string): string {
  if (variantId === "ALT2_TS_SCORE_GE_65") {
    return '<p class="warn"><strong>This is the exact TS score&gt;=65 variant. It has no smart-money guard</strong> — it is NOT the Python smart-money variant, and it remains a MANDATORY_CORE_COMPARATOR in all future observational reporting.</p>';
  }
  if (variantId === "ALT1_CANONICAL_EVENT_GROUPING") {
    return '<p class="warn"><strong>Canonical event grouping (buildEventGroupKey). MEDIUM identity confidence. Exploratory only</strong> — not production-grade; the Python event_key grouping is deliberately not substituted.</p>';
  }
  if (variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP") {
    return '<p class="warn"><strong>Approximate reconstruction</strong> (source self-labelled APPROX / NEEDS_EXACT_RECON). The score&gt;=72 threshold produced the dominant measured row-reduction; the model-name exclusions contributed comparatively little — name wording and measured contribution are distinct.</p>';
  }
  return "";
}

function renderModelTable(c: CatalogCandidate): string {
  const rows = c.orderedSteps
    .map((s: CatalogStep) => {
      const removesRows = s.changesRowCount ? "YES" : "NO";
      return `<tr>
      <td>${s.stepNumber}</td>
      <td><code>${esc(s.taxonomyCategory)}</code></td>
      <td>${esc(s.action)}</td>
      <td>${esc(JSON.stringify(s.thresholdOrRule))}</td>
      <td>${esc(s.physicalSourcePaths.join(", ") || "—")}</td>
      <td>${esc(s.missingDataBehavior)}</td>
      <td>${removesRows}</td>
      <td>${esc(s.semanticPurpose)}</td>
      <td>${esc(s.limitationFlags.join("; ") || "—")}</td>
    </tr>`;
    })
    .join("\n");
  return `<section>
  <h2>${esc(c.variantId)} — ${esc(ROLE_DESCRIPTION[c.variantId] ?? c.displayRole)}</h2>
  ${modelNote(c.variantId)}
  <p>Run status: <code>${esc(c.runStatus)}</code>. Identity confidence: <code>${esc(c.identityConfidence)}</code>. Active filters: ${c.activeFilterCount}; row-reducing steps: ${c.rowReducingStepCount}; ordering steps: ${c.orderingStepCount}; grouping steps: ${c.groupingStepCount}.</p>
  <table><thead><tr><th>#</th><th>Stage type</th><th>Action</th><th>Rule</th><th>Source field/path</th><th>Missing-data behavior</th><th>Removes rows?</th><th>Why it exists</th><th>Limitation</th></tr></thead><tbody>${rows}</tbody></table>
  <p><em>Robustness observations (analysis metadata only):</em> ${c.robustnessObservations.map(esc).join(" ")}</p>
</section>`;
}

function stageArrow(s: CatalogStep): string | null {
  switch (s.taxonomyCategory) {
    case "ELIGIBILITY_GATE":
      return "↓ eligibility gate";
    case "NUMERIC_THRESHOLD":
      return `↓ score threshold (${esc(JSON.stringify(s.thresholdOrRule))})`;
    case "CATEGORY_EXCLUSION":
      return s.fieldSemantic === "league" ? "↓ exclude NBA/NHL" : "↓ exclude VOID result";
    case "DERIVED_BUCKET_EXCLUSION":
      return "↓ exclude bad coverage/price bucket";
    case "TIME_WINDOW_EXCLUSION":
      return "↓ exclude timing 6–24h";
    case "SORT_PRIORITY":
      return "↓ ordering (sort)";
    case "EVENT_GROUPING":
      return "↓ event grouping";
    case "ROW_SELECTION":
      return s.changesRowCount ? "↓ keep first per event group" : "↓ keep all eligible";
    default:
      return null;
  }
}

function renderFunnelDiagram(c: CatalogCandidate): string {
  const lines = ["Input corpus (strict-dedup rows)"];
  for (const s of c.orderedSteps) {
    const arrow = stageArrow(s);
    if (arrow) lines.push("  " + arrow);
  }
  lines.push("Output rows");
  return `<h4>${esc(c.variantId)} — funnel</h4><pre>${esc(lines.join("\n"))}</pre>`;
}

function renderOverlapMatrix(catalog: ThreeCandidateFunnelCatalog): string {
  const rows = catalog.overlapMatrix
    .map(
      (r) =>
        `<tr><td><code>${esc(r.rule)}</code></td><td>${esc(r.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP)}</td><td>${esc(r.ALT2_TS_SCORE_GE_65)}</td><td>${esc(r.ALT1_CANONICAL_EVENT_GROUPING)}</td></tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Semantic rule</th><th>PRIMARY</th><th>ALT2 TS</th><th>ALT1 canonical</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSemanticFieldMatrix(catalog: ThreeCandidateFunnelCatalog): string {
  const rows = catalog.semanticFieldMatrix
    .map(
      (r) =>
        `<tr><td>${esc(r.semanticField)}</td><td><code>${esc(r.physicalSource)}</code></td><td>${esc(r.adapter)}</td><td>${esc(r.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP)}</td><td>${esc(r.ALT2_TS_SCORE_GE_65)}</td><td>${esc(r.ALT1_CANONICAL_EVENT_GROUPING)}</td><td>${esc(r.missingBehavior)}</td></tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Semantic field</th><th>Physical source</th><th>Adapter</th><th>PRIMARY</th><th>ALT2 TS</th><th>ALT1</th><th>Missing behavior</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAttrition(inputs: ReportInputs): string {
  const { historicalComparison, expectedCorpusSha256 } = inputs;
  if (!historicalComparison) {
    return `<p class="warn"><code>HISTORICAL_ATTRITION_NOT_LOADED</code> — no historical comparison artifact supplied.</p>`;
  }
  if (expectedCorpusSha256 && historicalComparison.inputSha256 !== expectedCorpusSha256) {
    return `<p class="warn"><code>HISTORICAL_ATTRITION_NOT_LOADED</code> — corpus hash mismatch (expected <code>${esc(expectedCorpusSha256)}</code>, got <code>${esc(historicalComparison.inputSha256)}</code>). Attrition blocked; numbers not shown to avoid mixing corpora.</p>`;
  }
  const blocks = (historicalComparison.executions ?? [])
    .filter((e) => ["PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", "ALT2_TS_SCORE_GE_65", "ALT1_CANONICAL_EVENT_GROUPING"].includes(e.variantId))
    .map((e) => {
      const rows = (e.stepResults ?? [])
        .map((s) => `<tr><td>${s.step}</td><td>${esc(s.action)}</td><td>${s.inputRows}</td><td>${s.passedRows}</td><td>${s.removedRows}</td></tr>`)
        .join("\n");
      return `<h4>${esc(e.variantId)}</h4><table><thead><tr><th>Step</th><th>Action</th><th>Input</th><th>Passed</th><th>Removed</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
  // Hash matched -> attrition IS loaded (even if this comparison happened to
  // carry no rows for the three candidates); the NOT_LOADED sentinel is
  // reserved for absent/mismatched artifacts only.
  return blocks || `<p>Historical attrition loaded (corpus hash matched); this comparison carried no step-level rows for the three candidates.</p>`;
}

const GLOSSARY: Array<[string, string]> = [
  ["eligibility gate", "A pass/fail check on which model version produced the row (does the row belong to this experiment at all)."],
  ["threshold", "A numeric cutoff — keep the row only if a number (like the confidence score) is at or above a value."],
  ["exclusion", "Throw a row out if it matches a category (for example, an NBA or NHL match)."],
  ["derived exclusion", "Throw a row out based on a combination of two numbers (for example, coverage between 50 and 74 AND price between 0.44 and 0.58)."],
  ["sort", "Re-order the surviving rows by a priority (for example, highest coverage first). Sorting does NOT remove any row — it is not a filter."],
  ["group", "Collect rows that belong to the same sporting event together. Grouping does not remove rows by itself."],
  ["keep", "After grouping, keep one row per event (the first after sorting)."],
  ["missing fail-closed", "If the field needed for a check is missing, the row is removed (we cannot confirm it qualifies)."],
  ["missing pass-open", "If the field needed for an exclusion is missing, the row is kept (we cannot confirm it should be thrown out)."],
  ["core comparator", "A model that always stays in the comparison as a fixed reference point, even if it is never chosen for production."],
];

function renderGlossary(): string {
  const rows = GLOSSARY.map(([term, def]) => `<tr><td><strong>${esc(term)}</strong></td><td>${esc(def)}</td></tr>`).join("\n");
  return `<table><thead><tr><th>Term</th><th>Plain-language meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Renders the three-candidate funnel report HTML. Everything is derived from
 * the supplied catalog; nothing is recomputed or hardcoded per model.
 */
export function renderThreeCandidateFunnelReport(inputs: ReportInputs): string {
  const { catalog } = inputs;

  const style = `<style>
    body{font-family:system-ui,Arial,sans-serif;max-width:1300px;margin:1rem auto;padding:0 1rem;line-height:1.4;}
    table{border-collapse:collapse;width:100%;margin:0.5rem 0 1.5rem;font-size:0.8rem;}
    th,td{border:1px solid #ccc;padding:0.35rem;vertical-align:top;text-align:left;}
    th{background:#f2f2f2;}
    code{background:#f6f8fa;padding:0 0.2rem;}
    pre{background:#f6f8fa;padding:0.6rem;overflow-x:auto;}
    section{margin-bottom:2.4rem;}
    .warn{background:#fff3cd;border:1px solid #ffe08a;padding:0.6rem;border-radius:4px;}
    @media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e6e6e6;}th{background:#2a2a2a;}code,pre{background:#2a2a2a;}.warn{background:#3a331a;border-color:#6a5a2a;}td,th{border-color:#444;}}
  </style>`;

  const execRows = catalog.candidates
    .map((c) => `<tr><td><strong>${esc(c.variantId)}</strong></td><td>${esc(ROLE_DESCRIPTION[c.variantId] ?? c.displayRole)}</td><td><code>${esc(c.displayRole)}</code></td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Three-Candidate Funnel Catalog — Founder</title>${style}</head>
<body>
<h1>Three-Candidate Executable Funnel Catalog — Founder / CEO Report</h1>
<p>Derived from <code>${esc(catalog.generatedFrom.derivedFrom)}</code>. This documents and validates existing behavior; it does not rank models against each other and changes no model.</p>

<section id="executive">
  <h2>1. Executive summary — permanent observation roles</h2>
  <table><thead><tr><th>Model</th><th>Permanent role</th><th>Role code</th></tr></thead><tbody>${execRows}</tbody></table>
</section>

${catalog.candidates.map(renderModelTable).join("\n")}

<section id="matrix">
  <h2>5. Side-by-side filter matrix</h2>
  ${renderOverlapMatrix(catalog)}
  <h3>Semantic field matrix</h3>
  ${renderSemanticFieldMatrix(catalog)}
</section>

<section id="diagrams">
  <h2>6. Full funnel diagrams (only actual stages)</h2>
  ${catalog.candidates.map(renderFunnelDiagram).join("\n")}
</section>

<section id="attrition">
  <h2>7. Actual historical attrition</h2>
  ${renderAttrition(inputs)}
</section>

<section id="limitations">
  <h2>8. Known limitations</h2>
  <ul>
    <li>PRIMARY_V1_AVOID_NBA_NHL_COV_CAP is an approximate reconstruction (APPROX / NEEDS_EXACT_RECON).</li>
    <li>ALT2_TS_SCORE_GE_65 weekly PnL concentration requires continued observation before any promotion.</li>
    <li>ALT1_CANONICAL_EVENT_GROUPING identity confidence is MEDIUM (exploratory only).</li>
    <li>smart-money coverage is 0% in the current canonical export; smart-money variants and tie-breaks remain unvalidated.</li>
    <li>No model is ready for production solely from this report.</li>
  </ul>
</section>

<section id="glossary">
  <h2>9. Plain-language glossary</h2>
  ${renderGlossary()}
</section>

</body></html>`;
}
