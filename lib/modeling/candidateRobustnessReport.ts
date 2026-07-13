// Founder robustness report renderer (Phase 3E.7).
//
// Renders a deterministic, founder-readable HTML report from an
// already-computed candidate robustness audit result (Phase 3E.7 Commit A).
// Presents weekly stability, PRIMARY's rule-contribution ablation, segment
// breakdowns, result concentration, identity/duplication, and field
// coverage -- with an explicit smart-money limitation note and a bounded
// founder-disposition packet defaulting to NOT_REVIEWED. No Champion/Winner/
// "production ready"/statistical-significance claim. Pure: no fs/env/network
// access, does not recompute any audited figure.

import type {
  CandidateRobustnessAuditResult,
  CandidateAudit,
  WeeklyStability,
  SegmentBucket,
} from "./candidateRobustnessAudit";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

export interface RobustnessReportInputs {
  audit: CandidateRobustnessAuditResult;
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

function renderWeeklyTable(label: string, ws: WeeklyStability): string {
  const rows = ws.weeks
    .map(
      (w) =>
        `<tr><td>${esc(w.week)}</td><td>${num(w.signals)}</td><td>${num(w.wins)}</td><td>${num(w.losses)}</td><td>${num(w.pnl)}</td><td>${w.roiPct === null ? "—" : num(w.roiPct) + "%"}</td><td>${w.winRatePct === null ? "—" : num(w.winRatePct) + "%"}</td><td>${num(w.maxDrawdownUnits)}</td></tr>`,
    )
    .join("\n");
  return `<h4>${esc(label)}</h4>
  <table><thead><tr><th>Week</th><th>Signals</th><th>Wins</th><th>Losses</th><th>PnL</th><th>ROI</th><th>Win rate</th><th>Max drawdown</th></tr></thead><tbody>${rows}</tbody></table>
  <p>Positive weeks: ${num(ws.positiveWeekCount)}; negative weeks: ${num(ws.negativeWeekCount)}. Best week: ${ws.bestWeek ? esc(ws.bestWeek.week) + " (" + num(ws.bestWeek.pnl) + ")" : "—"}. Worst week: ${ws.worstWeek ? esc(ws.worstWeek.week) + " (" + num(ws.worstWeek.pnl) + ")" : "—"}. Best-week share of positive PnL: ${ws.bestWeekShareOfPositivePnl === null ? "—" : num(ws.bestWeekShareOfPositivePnl * 100) + "%"}. Best two weeks share: ${ws.bestTwoWeeksShareOfPositivePnl === null ? "—" : num(ws.bestTwoWeeksShareOfPositivePnl * 100) + "%"}. ${ws.bestWeekConcentrationFlag ? '<strong class="warn-inline">CONCENTRATION FLAG: best week &gt; 40% of positive PnL.</strong>' : ""}</p>`;
}

function renderSegmentTable(label: string, buckets: SegmentBucket[]): string {
  const rows = buckets
    .map(
      (b) =>
        `<tr><td>${esc(b.label)}</td><td>${num(b.signals)}</td><td>${b.sampleFlag === "LOW_SAMPLE" ? "—" : b.roiPct === null ? "—" : num(b.roiPct) + "%"}</td><td>${b.sampleFlag === "LOW_SAMPLE" ? "—" : num(b.pnl)}</td><td>${b.sampleFlag === "LOW_SAMPLE" ? "—" : b.winRatePct === null ? "—" : num(b.winRatePct) + "%"}</td><td>${esc(b.sampleFlag)}</td></tr>`,
    )
    .join("\n");
  return `<h4>${esc(label)}</h4><table><thead><tr><th>Segment</th><th>Signals</th><th>ROI</th><th>PnL</th><th>Win rate</th><th>Sample</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCandidate(c: CandidateAudit): string {
  let ruleContributionHtml = "";
  if (c.ruleContribution) {
    const rows = c.ruleContribution.stages
      .map(
        (s) =>
          `<tr><td>${s.stageIndex}</td><td><code>${esc(s.ruleLabel)}</code></td><td>${esc(s.plainLanguage)}</td><td>${num(s.inputRows)}</td><td>${num(s.outputRows)}</td><td>${num(s.removedRows)}</td><td>${s.pnl === null ? "—" : num(s.pnl)}</td><td>${s.roiPct === null ? "—" : num(s.roiPct) + "%"}</td><td>${s.deltaPnlFromPrevious === null ? "—" : num(s.deltaPnlFromPrevious)}</td><td>${s.deltaRoiFromPrevious === null ? "—" : num(s.deltaRoiFromPrevious) + " pp"}</td></tr>`,
      )
      .join("\n");
    ruleContributionHtml = `<h3>Rule contribution (cumulative ablation, exact historical order)</h3>
    <table><thead><tr><th>#</th><th>Rule</th><th>Plain language</th><th>Input rows</th><th>Output rows</th><th>Removed</th><th>PnL</th><th>ROI</th><th>Δ PnL</th><th>Δ ROI</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  return `<section>
  <h2>${esc(c.variantId)}</h2>
  <table><tbody>
    <tr><th>Input rows</th><td>${num(c.overallMetrics.inputRows)}</td></tr>
    <tr><th>Output rows</th><td>${num(c.overallMetrics.outputRows)}</td></tr>
    <tr><th>Wins / Losses</th><td>${num(c.overallMetrics.wins)} / ${num(c.overallMetrics.losses)}</td></tr>
    <tr><th>PnL (flat 1 unit)</th><td>${num(c.overallMetrics.flatUnitPnl)}</td></tr>
    <tr><th>ROI</th><td>${c.overallMetrics.flatUnitRoi === null ? "—" : num(c.overallMetrics.flatUnitRoi) + "%"}</td></tr>
    <tr><th>Win rate</th><td>${c.overallMetrics.winRatePct === null ? "—" : num(c.overallMetrics.winRatePct) + "%"}</td></tr>
  </tbody></table>

  ${renderWeeklyTable(`Weekly stability — ${c.variantId}`, c.weeklyStability)}
  ${ruleContributionHtml}

  <h3>Segment breakdown</h3>
  ${renderSegmentTable("League family", c.segments.leagueFamily)}
  ${renderSegmentTable("Score band", c.segments.scoreBand)}
  ${renderSegmentTable("Entry-price band", c.segments.priceBand)}
  ${renderSegmentTable("Coverage band", c.segments.coverageBand)}
  ${renderSegmentTable("Timing band", c.segments.timingBand)}

  <h3>Result concentration (sensitivity analysis only)</h3>
  <table><tbody>
    <tr><th>Top 1 win contribution</th><td>${num(c.concentration.top1WinContribution)}</td></tr>
    <tr><th>Top 5 win contribution</th><td>${num(c.concentration.top5WinContribution)}</td></tr>
    <tr><th>Top 10 win contribution</th><td>${num(c.concentration.top10WinContribution)}</td></tr>
    <tr><th>PnL after removing top 1</th><td>${num(c.concentration.pnlAfterRemovingTop1)}</td></tr>
    <tr><th>PnL after removing top 5</th><td>${num(c.concentration.pnlAfterRemovingTop5)}</td></tr>
    <tr><th>PnL after removing top 10</th><td>${num(c.concentration.pnlAfterRemovingTop10)}</td></tr>
    <tr><th>Worst 1 / 5 / 10 contribution</th><td>${num(c.concentration.worst1Contribution)} / ${num(c.concentration.worst5Contribution)} / ${num(c.concentration.worst10Contribution)}</td></tr>
  </tbody></table>

  <h3>Identity and duplication sanity</h3>
  <table><tbody>
    <tr><th>Unique condition/token pairs</th><td>${num(c.identity.uniqueConditionTokenPairs)}</td></tr>
    <tr><th>Unique markets</th><td>${num(c.identity.uniqueMarkets)}</td></tr>
    <tr><th>Working event groups</th><td>${num(c.identity.workingEventGroups)}</td></tr>
    <tr><th>Maximum signals per working event</th><td>${num(c.identity.maximumSignalsPerWorkingEvent)}</td></tr>
    <tr><th>Events with &gt;1 selected signal</th><td>${num(c.identity.eventsWithMoreThanOneSignal)}</td></tr>
  </tbody></table>

  <h3>Field coverage</h3>
  <table><tbody>
    <tr><th>score</th><td>${num(c.fieldCoverage.score)}%</td></tr>
    <tr><th>coverage</th><td>${num(c.fieldCoverage.coverage)}%</td></tr>
    <tr><th>timing</th><td>${num(c.fieldCoverage.timing)}%</td></tr>
    <tr><th>league</th><td>${num(c.fieldCoverage.league)}%</td></tr>
    <tr><th>entry price</th><td>${num(c.fieldCoverage.entryPrice)}%</td></tr>
    <tr><th>smart money</th><td>${num(c.fieldCoverage.smartMoney)}%</td></tr>
    <tr><th>result</th><td>${num(c.fieldCoverage.result)}%</td></tr>
    <tr><th>event identity</th><td>${num(c.fieldCoverage.eventIdentity)}%</td></tr>
  </tbody></table>
</section>`;
}

/**
 * Renders the founder robustness report HTML. Never recomputes an audited
 * figure -- purely presents the already-computed audit result.
 */
export function renderCandidateRobustnessReport(inputs: RobustnessReportInputs): string {
  const { audit } = inputs;

  const style = `<style>
    body{font-family:system-ui,Arial,sans-serif;max-width:1300px;margin:1rem auto;padding:0 1rem;line-height:1.4;}
    table{border-collapse:collapse;width:100%;margin:0.5rem 0 1.5rem;font-size:0.82rem;}
    th,td{border:1px solid #ccc;padding:0.35rem;vertical-align:top;text-align:left;}
    th{background:#f2f2f2;}
    code{background:#f6f8fa;padding:0 0.2rem;}
    section{margin-bottom:2.4rem;}
    .warn{background:#fff3cd;border:1px solid #ffe08a;padding:0.6rem;border-radius:4px;}
    .warn-inline{color:#8a6100;}
    @media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e6e6e6;}th{background:#2a2a2a;}code{background:#2a2a2a;}.warn{background:#3a331a;border-color:#6a5a2a;}td,th{border-color:#444;}}
  </style>`;

  const dispositionRows = audit.candidates
    .map((c) => `<tr><td>${esc(c.variantId)}</td><td>${c.overallMetrics.outputRows} rows, ROI ${c.overallMetrics.flatUnitRoi === null ? "—" : num(c.overallMetrics.flatUnitRoi) + "%"}</td><td>NOT_REVIEWED</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Candidate Robustness Report — Founder</title>${style}</head>
<body>
<h1>Candidate Robustness and Rule-Contribution Audit — Founder Report</h1>

<section id="contract">
  <h2>1. Corpus contract</h2>
  <table><tbody>
    <tr><th>Corpus SHA-256</th><td><code>${esc(audit.corpusSha256)}</code></td></tr>
    <tr><th>Corpus row count</th><td>${num(audit.corpusRowCount)}</td></tr>
  </tbody></table>
  <p class="warn">This is a descriptive robustness audit of two already-selected candidates on one fixed corpus -- not a hypothesis test and not a statistical-significance claim.</p>
</section>

<section id="executive">
  <h2>2. Executive summary</h2>
  <table><thead><tr><th>Candidate</th><th>Output rows</th><th>PnL</th><th>ROI</th><th>Win rate</th></tr></thead><tbody>
  ${audit.candidates
    .map(
      (c) =>
        `<tr><td>${esc(c.variantId)}</td><td>${num(c.overallMetrics.outputRows)}</td><td>${num(c.overallMetrics.flatUnitPnl)}</td><td>${c.overallMetrics.flatUnitRoi === null ? "—" : num(c.overallMetrics.flatUnitRoi) + "%"}</td><td>${c.overallMetrics.winRatePct === null ? "—" : num(c.overallMetrics.winRatePct) + "%"}</td></tr>`,
    )
    .join("\n")}
  </tbody></table>
</section>

<section id="weekly-baseline">
  <h2>3. Weekly stability — BASELINE_V1_CONTROL (reference)</h2>
  ${renderWeeklyTable("BASELINE_V1_CONTROL", audit.baselineWeeklyStability)}
</section>

${audit.candidates.map(renderCandidate).join("\n")}

<section id="smart-money-limitation">
  <h2>Explicit field-coverage limitation</h2>
  <p class="warn">${esc(audit.smartMoneyLimitationNote)}</p>
</section>

<section id="disposition">
  <h2>Founder review packet</h2>
  <table><thead><tr><th>Candidate</th><th>Current-corpus result</th><th>Founder disposition</th></tr></thead><tbody>${dispositionRows}</tbody></table>
  <p>Disposition остаётся <code>NOT_REVIEWED</code> до решения основателя.</p>
</section>

</body></html>`;
}
