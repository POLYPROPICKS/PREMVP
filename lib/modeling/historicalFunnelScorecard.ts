// Founder scorecard renderer for the historical funnel comparison (Phase
// 3E.6).
//
// Renders a deterministic, founder-readable HTML report from an
// already-computed comparison + reproducible manifest + classifier. It does
// NOT recompute any model predicate or ROI figure -- it only validates that
// the comparison and manifest reference the same corpus (matching input
// hash) and presents the numbers. No Champion/winner/promote label, no
// statistical-significance claim, no raw rows, no secrets. Pure: no
// fs/env/network access.

import type { ComparisonResult, VariantExecution } from "./historicalFunnelComparison";
import type { EvaluationRunManifest } from "./evaluationRunManifest";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

export interface ComparisonWithHash extends ComparisonResult {
  inputSha256: string;
  classifierSha256: string;
}

export interface ScorecardInputs {
  comparison: ComparisonWithHash;
  manifest: EvaluationRunManifest;
  classifier: ExecutableFunnelClassifier;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function renderExecutiveRow(e: VariantExecution): string {
  const m = e.metrics;
  const d = e.baselineDelta;
  const limitation = e.blocker ?? (e.limitationFlags[0] ?? "—");
  return `<tr>
    <td><strong>${esc(e.variantId)}</strong></td>
    <td>${esc(e.evaluationStatus)}</td>
    <td>${m ? num(m.inputRows) : "—"}</td>
    <td>${m ? num(m.outputRows) : "—"}</td>
    <td>${m ? num(m.retentionRate * 100) + "%" : "—"}</td>
    <td>${m ? num(m.wins) : "—"}</td>
    <td>${m ? num(m.losses) : "—"}</td>
    <td>${m ? (m.winRate === null ? "—" : num(m.winRate) + "%") : "—"}</td>
    <td>${m ? num(m.flatUnitPnl) : "—"}</td>
    <td>${m ? (m.flatUnitRoi === null ? "—" : num(m.flatUnitRoi) + "%") : "—"}</td>
    <td>${d ? num(d.roiPercentagePointDeltaVsBaseline) : "—"}</td>
    <td>${m ? num(m.equity.maximumDrawdownUnits) : "—"}</td>
    <td>${m ? num(m.signalsPerCoveredDay) : "—"}</td>
    <td>${m ? num(m.workingEventGroups) : "—"}</td>
    <td>${esc(limitation)}</td>
  </tr>`;
}

function renderFunnelAttrition(e: VariantExecution): string {
  if (!e.stepResults) return "";
  const rows = e.stepResults
    .map((s) => {
      const share = s.inputRows > 0 ? ((s.removedRows / s.inputRows) * 100).toFixed(1) + "%" : "0%";
      return `<tr><td>${s.step}</td><td>${esc(s.action)}</td><td>${num(s.inputRows)}</td><td>${num(s.passedRows)}</td><td>${num(s.removedRows)}</td><td>${share}</td></tr>`;
    })
    .join("\n");
  return `<h4>${esc(e.variantId)}</h4>
  <table><thead><tr><th>Step</th><th>Rule</th><th>Input</th><th>Passed</th><th>Removed</th><th>Share removed</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Renders the founder scorecard HTML. Validates that the comparison's input
 * hash equals the manifest's before presenting anything -- a mismatch means
 * the two artifacts describe different corpora and the report must not be
 * produced.
 */
export function renderHistoricalFunnelScorecard(inputs: ScorecardInputs): string {
  const { comparison, manifest, classifier } = inputs;

  if (comparison.inputSha256 !== manifest.inputSha256) {
    throw new Error("scorecard: comparison/manifest input hash mismatch -- artifacts describe different corpora");
  }
  if (classifier.schemaVersion !== manifest.classifierSchemaVersion) {
    throw new Error("scorecard: classifier schemaVersion mismatch vs manifest");
  }

  const executed = comparison.executions.filter((e) => e.evaluationStatus === "EXECUTED");
  const skipped = comparison.executions.filter((e) => e.evaluationStatus !== "EXECUTED");

  const executiveRows = comparison.executions.map(renderExecutiveRow).join("\n");
  const attrition = executed.map(renderFunnelAttrition).join("\n");
  const reviewRows = comparison.executions
    .map((e) => {
      const change = e.metrics && e.baselineDelta
        ? `Δ rows ${num(e.baselineDelta.outputRowsDeltaVsBaseline)}, Δ ROI pp ${num(e.baselineDelta.roiPercentagePointDeltaVsBaseline)}`
        : "—";
      const result = e.metrics ? `${num(e.metrics.outputRows)} rows, ROI ${e.metrics.flatUnitRoi === null ? "—" : num(e.metrics.flatUnitRoi) + "%"}` : esc(e.evaluationStatus);
      const volume = e.metrics ? num(e.metrics.outputRows) : "—";
      const risk = e.blocker ?? (e.limitationFlags[0] ?? "—");
      return `<tr><td>${esc(e.variantId)}</td><td>${esc(change)}</td><td>${esc(result)}</td><td>${volume}</td><td>${esc(risk)}</td><td>NOT_REVIEWED</td></tr>`;
    })
    .join("\n");

  const excludedRows = skipped
    .map((e) => `<tr><td>${esc(e.variantId)}</td><td>${esc(e.evaluationStatus)}</td><td>${esc(e.blocker ?? (e.limitationFlags[0] ?? "—"))}</td></tr>`)
    .join("\n");

  const style = `<style>
    body{font-family:system-ui,Arial,sans-serif;max-width:1300px;margin:1rem auto;padding:0 1rem;line-height:1.4;}
    table{border-collapse:collapse;width:100%;margin:0.5rem 0 1.5rem;font-size:0.82rem;}
    th,td{border:1px solid #ccc;padding:0.35rem;vertical-align:top;text-align:left;}
    th{background:#f2f2f2;}
    code{background:#f6f8fa;padding:0 0.2rem;}
    section{margin-bottom:2.4rem;}
    .warn{background:#fff3cd;border:1px solid #ffe08a;padding:0.6rem;border-radius:4px;}
    @media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e6e6e6;}th{background:#2a2a2a;}code{background:#2a2a2a;}.warn{background:#3a331a;border-color:#6a5a2a;}td,th{border-color:#444;}}
  </style>`;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Historical Funnel Scorecard — Founder</title>${style}</head>
<body>
<h1>Historical Funnel Scorecard — Founder Decision Packet</h1>

<section id="contract">
  <h2>1. Evaluation contract</h2>
  <table><tbody>
    <tr><th>Input artifact</th><td><code>${esc(manifest.inputArtifactPath)}</code></td></tr>
    <tr><th>Input SHA-256</th><td><code>${esc(comparison.inputSha256)}</code></td></tr>
    <tr><th>Input row count</th><td>${num(manifest.inputRowCount)}</td></tr>
    <tr><th>Date range</th><td>${esc(comparison.corpus.firstResolvedAt)} → ${esc(comparison.corpus.lastResolvedAt)} (${num(comparison.corpus.coveredCalendarDays)} календарных дней)</td></tr>
    <tr><th>Dedup policy</th><td>${esc(manifest.dedupPolicy)}</td></tr>
    <tr><th>Git commit</th><td><code>${esc(manifest.gitCommit)}</code></td></tr>
    <tr><th>Classifier SHA-256 / schema</th><td><code>${esc(comparison.classifierSha256)}</code> / v${esc(manifest.classifierSchemaVersion)}</td></tr>
    <tr><th>Run ID</th><td><code>${esc(manifest.runId)}</code></td></tr>
    <tr><th>Comparison rule</th><td>Все модели сравниваются на одном корпусе, плоская ставка 1 единица (flat 1-unit), один и тот же ROI-контракт.</td></tr>
    <tr><th>Event identity limitation</th><td>${esc(manifest.eventIdentityPolicy)}</td></tr>
  </tbody></table>
  <p class="warn">Это описательное сравнение на одном корпусе, а не проверка гипотез и не выбор лучшей модели. Более высокий ROI не является причинно-следственным доказательством.</p>
</section>

<section id="executive">
  <h2>2. Executive comparison table</h2>
  <table><thead><tr>
    <th>Algorithm</th><th>Evaluation status</th><th>Input rows</th><th>Output rows</th><th>Retained</th>
    <th>Wins</th><th>Losses</th><th>Win rate</th><th>PnL, units</th><th>ROI</th><th>ROI vs baseline (pp)</th>
    <th>Max drawdown</th><th>Signals/day</th><th>Working events</th><th>Main limitation</th>
  </tr></thead><tbody>${executiveRows}</tbody></table>
</section>

<section id="attrition">
  <h2>3. Funnel attrition</h2>
  ${attrition}
</section>

<section id="deltas">
  <h2>4. Baseline deltas</h2>
  <p>Числовые дельты считаются относительно <strong>${esc(comparison.baselineVariantId)}</strong>. Более высокий ROI не интерпретируется как причинно-следственное доказательство.</p>
</section>

<section id="formula-policy">
  <h2>5. Formula versus external policy</h2>
  <p>Score уже вычислен формулой <code>v2-lite-growth-safe</code> (в <code>generateLandingCardPair</code>). Компоненты smart money (вес 0.25), whale/public (0.15) и pre-event (0.20) — это входы САМОЙ формулы. Внешние фильтры (например, исключение NBA/NHL) и стражи ставки (например, уменьшение ставки вдвое при smart money ≥ 75) — это ОТДЕЛЬНЫЕ политики, а не часть арифметики score.</p>
</section>

<section id="stake">
  <h2>6. Historical versus normalized stake</h2>
  <table><thead><tr><th>Model</th><th>Historical stake policy</th><th>Normalized comparison stake</th></tr></thead><tbody>
  ${comparison.executions.map((e) => `<tr><td>${esc(e.variantId)}</td><td>${esc(e.historicalStakePolicy?.unit ?? "—")}</td><td>${esc(e.normalizedStakePolicy?.unit ?? "—")}</td></tr>`).join("\n")}
  </tbody></table>
  <p>Первичное сравнение ROI использует только плоскую ставку 1 единица (FLAT_1_UNIT). Историческая ставка ($10 / stake-halving / tiered) показана лишь как диагностика и не смешивается с нормализованным PnL.</p>
</section>

<section id="excluded">
  <h2>7. Excluded and blocked variants</h2>
  <table><thead><tr><th>Variant</th><th>Status</th><th>Explanation</th></tr></thead><tbody>${excludedRows}</tbody></table>
  <ul>
    <li><strong>Ambiguous aliases</strong> (ALT1/ALT2/ALT3 старые имена): под одним именем найдены две разные реализации — не исполняются напрямую.</li>
    <li><strong>Missing event_key</strong> (ALT1_PY_EVENT_KEY_VARIANT): поле event_key отсутствует в 27-колоночном каноническом экспорте.</li>
    <li><strong>Contract stubs</strong>: только заготовки SQL-контрактов без исполняемой логики.</li>
    <li><strong>Label-only</strong>: имя-метка в логе без отдельной исполняемой логики.</li>
  </ul>
</section>

<section id="review">
  <h2>8. Founder review packet</h2>
  <table><thead><tr><th>Candidate</th><th>What it changes from baseline</th><th>Current-corpus result</th><th>Volume retained</th><th>Principal risk/limitation</th><th>Founder disposition</th></tr></thead><tbody>${reviewRows}</tbody></table>
  <p>Disposition остаётся <code>NOT_REVIEWED</code> до решения основателя. Никакая модель не помечается автоматически как продакшн-выбор.</p>
</section>

</body></html>`;
}
