// Sport/market performance report renderer (Phase 3E.8C).
//
// Renders a deterministic, founder-readable HTML report from an
// already-computed sport/market performance slice (Commit A). Never
// recomputes any figure. No Champion/production-ready claim; sport and
// market-type tables are clearly separated; event concentration is
// included; no raw rows.

import type {
  SportMarketPerformanceSlice,
  ModelSlice,
  SegmentBucket,
  LeaderEntry,
  CrossModelRow,
} from "./sportMarketPerformanceSlice";

export interface ReportInputs {
  slice: SportMarketPerformanceSlice;
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

function renderBreakdownTable(title: string, buckets: SegmentBucket[]): string {
  const rows = buckets
    .map(
      (b) =>
        `<tr><td>${esc(b.label)}</td><td>${num(b.metrics.signals)}</td><td>${num(b.metrics.uniqueEventGroups)}</td><td>${num(b.metrics.maxSignalsPerEvent)}</td><td>${b.metrics.winRatePct === null ? "—" : num(b.metrics.winRatePct) + "%"}</td><td>${num(b.metrics.pnlUnits)}</td><td>${b.metrics.roiPct === null ? "—" : num(b.metrics.roiPct) + "%"}</td><td>${num(b.metrics.maxDrawdownUnits)}</td><td>${esc(b.sampleStatus)}</td><td>${esc(b.classificationConfidence)}</td></tr>`,
    )
    .join("\n");
  return `<h4>${esc(title)}</h4>
  <table><thead><tr><th>Sport/Market</th><th>Signals</th><th>Events</th><th>Max/event</th><th>Win rate</th><th>PnL</th><th>ROI</th><th>Max DD</th><th>Sample status</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLeaderTable(title: string, entries: LeaderEntry[]): string {
  const rows = entries
    .map((e) => `<tr><td>${esc(e.label)}</td><td>${num(e.signals)}</td><td>${e.roiPct === null ? "—" : num(e.roiPct) + "%"}</td><td>${num(e.pnlUnits)}</td></tr>`)
    .join("\n");
  return `<h5>${esc(title)}</h5><table><thead><tr><th>Label</th><th>Signals</th><th>ROI</th><th>PnL</th></tr></thead><tbody>${rows || "<tr><td colspan=4>—</td></tr>"}</tbody></table>`;
}

function renderModelSection(m: ModelSlice): string {
  return `<section>
  <h2>${esc(m.variantId)}</h2>
  <p>Output rows: ${num(m.outputRows)}. Overall PnL: ${num(m.overallPnlUnits)}. Overall ROI: ${m.overallRoiPct === null ? "—" : num(m.overallRoiPct) + "%"}.</p>

  <h3>Sport breakdown</h3>
  ${renderBreakdownTable(`${m.variantId} — sport breakdown`, m.sportBreakdown)}

  <h3>Market-type breakdown</h3>
  ${renderBreakdownTable(`${m.variantId} — market-type breakdown`, m.marketTypeBreakdown)}

  <h3>Leaders</h3>
  ${renderLeaderTable("Top 3 sports by ROI (sample ≥30)", m.leaders.topSportsByRoi)}
  ${renderLeaderTable("Top 3 sports by PnL", m.leaders.topSportsByPnl)}
  ${renderLeaderTable("Top 3 market types by ROI (sample ≥30)", m.leaders.topMarketsByRoi)}
  ${renderLeaderTable("Top 3 market types by PnL", m.leaders.topMarketsByPnl)}
  ${renderLeaderTable("Worst 3 sports by PnL", m.leaders.worstSportsByPnl)}
  ${renderLeaderTable("Worst 3 market types by PnL", m.leaders.worstMarketsByPnl)}

  <h3>Event concentration</h3>
  <table><tbody>
    <tr><th>Total signals</th><td>${num(m.eventConcentration.totalSignals)}</td></tr>
    <tr><th>Unique event groups</th><td>${num(m.eventConcentration.uniqueEventGroups)}</td></tr>
    <tr><th>Average signals per event</th><td>${num(m.eventConcentration.averageSignalsPerEvent)}</td></tr>
    <tr><th>Events with &gt;1 signal</th><td>${num(m.eventConcentration.eventsWithMultipleSignals)}</td></tr>
    <tr><th>Share of signals from multi-signal events</th><td>${num(m.eventConcentration.shareOfSignalsFromMultiSignalEvents)}%</td></tr>
    <tr><th>Max signals on one event</th><td>${num(m.eventConcentration.maxSignalsPerEvent)}</td></tr>
  </tbody></table>
  <h4>Top 10 most concentrated event groups</h4>
  <table><thead><tr><th>Event group (hashed)</th><th>Signals</th><th>PnL</th><th>ROI</th></tr></thead><tbody>
  ${m.eventConcentration.topConcentratedGroups.map((g) => `<tr><td><code>${esc(g.eventGroupKeyHash)}</code></td><td>${num(g.signals)}</td><td>${num(g.pnlUnits)}</td><td>${g.roiPct === null ? "—" : num(g.roiPct) + "%"}</td></tr>`).join("\n")}
  </tbody></table>
</section>`;
}

function renderCrossModelMatrix(title: string, rows: CrossModelRow[]): string {
  const cell = (c: CrossModelRow[keyof CrossModelRow]) => {
    if (c === null || typeof c !== "object") return "—";
    return `${num(c.signals)} / ${num(c.pnlUnits)} / ${c.roiPct === null ? "—" : num(c.roiPct) + "%"}`;
  };
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td>${cell(r.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP)}</td><td>${cell(r.ALT2_TS_SCORE_GE_65)}</td><td>${cell(r.ALT1_CANONICAL_EVENT_GROUPING)}</td></tr>`,
    )
    .join("\n");
  return `<h3>${esc(title)}</h3>
  <p>Cells show: signals / PnL / ROI.</p>
  <table><thead><tr><th>Label</th><th>PRIMARY</th><th>ALT2 TS</th><th>ALT1</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Renders the sport/market performance report HTML. Never recomputes any
 * figure -- purely presents the already-computed slice.
 */
export function renderSportMarketPerformanceReport(inputs: ReportInputs): string {
  const { slice } = inputs;

  const style = `<style>
    body{font-family:system-ui,Arial,sans-serif;max-width:1300px;margin:1rem auto;padding:0 1rem;line-height:1.4;}
    table{border-collapse:collapse;width:100%;margin:0.5rem 0 1.5rem;font-size:0.8rem;}
    th,td{border:1px solid #ccc;padding:0.35rem;vertical-align:top;text-align:left;}
    th{background:#f2f2f2;}
    code{background:#f6f8fa;padding:0 0.2rem;}
    section{margin-bottom:2.4rem;}
    .warn{background:#fff3cd;border:1px solid #ffe08a;padding:0.6rem;border-radius:4px;}
    @media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e6e6e6;}th{background:#2a2a2a;}code{background:#2a2a2a;}.warn{background:#3a331a;border-color:#6a5a2a;}td,th{border-color:#444;}}
  </style>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sport &amp; Market Performance — Founder</title>${style}</head>
<body>
<h1>Sport and Market-Type Performance Slice</h1>
<p class="warn">Descriptive breakdown on one fixed corpus (${slice.corpusRowCount} rows). Not a statistical-significance claim, and not a decision about which model to run in production.</p>

<section>
  <h2>Classification coverage</h2>
  <table><thead><tr><th>Dimension</th><th>HIGH</th><th>MEDIUM</th><th>LOW</th><th>UNKNOWN</th></tr></thead><tbody>
    <tr><td>Sport</td><td>${num(slice.classificationCoverage.sport.HIGH)}%</td><td>${num(slice.classificationCoverage.sport.MEDIUM)}%</td><td>${num(slice.classificationCoverage.sport.LOW)}%</td><td>${num(slice.classificationCoverage.sport.UNKNOWN)}%</td></tr>
    <tr><td>Market type</td><td>${num(slice.classificationCoverage.marketType.HIGH)}%</td><td>${num(slice.classificationCoverage.marketType.MEDIUM)}%</td><td>${num(slice.classificationCoverage.marketType.LOW)}%</td><td>${num(slice.classificationCoverage.marketType.UNKNOWN)}%</td></tr>
  </tbody></table>
</section>

${slice.models.map(renderModelSection).join("\n")}

<section>
  <h2>Cross-model comparison</h2>
  ${renderCrossModelMatrix("Sport", slice.crossModelSportMatrix)}
  ${renderCrossModelMatrix("Market type", slice.crossModelMarketMatrix)}
</section>

</body></html>`;
}
