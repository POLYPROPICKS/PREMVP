export interface ScientificDashboardEvidence {
  title: string;
  frozenDatasetSha256: string;
  capitalFrontier: unknown;
  finalMatrix: unknown;
  winner: Record<string, unknown>;
  winnerCurve: Array<{ atIso: string; total: number; active: number; vault: number; fallFromTotalPeak: number }>;
  bootstrap: unknown;
}

export interface ScientificFounderReportEvidence {
  datasetSha256: string;
  sensitivityVerdict: string;
  primaryCapitalPolicy: string;
  sensitivityCapitalPolicy: string;
  primarySpa: { consistent: number; upper: number };
  sensitivitySpa: { consistent: number; upper: number };
  pnlMax: Record<string, unknown>;
  riskMin: Record<string, unknown>;
  winner: Record<string, unknown>;
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
const section = (title: string, value: unknown) => `<section><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function lineChart(points: ScientificDashboardEvidence["winnerCurve"]): string {
  if (!points.length) return "<p>No curve points.</p>";
  const values = points.flatMap((point) => [point.total, point.active, point.vault]);
  const minimum = Math.min(...values), maximum = Math.max(...values), span = Math.max(1, maximum - minimum);
  const polyline = (key: "total" | "active" | "vault") => points.map((point, index) => {
    const x = points.length === 1 ? 0 : index / (points.length - 1) * 1000;
    const y = 280 - (point[key] - minimum) / span * 260;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return `<svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-label="Total Active Vault curves"><polyline class="total" points="${polyline("total")}"/><polyline class="active" points="${polyline("active")}"/><polyline class="vault" points="${polyline("vault")}"/></svg><p class="legend"><span class="totalKey">Total</span><span class="activeKey">Active</span><span class="vaultKey">Vault</span></p>`;
}

function fallChart(points: ScientificDashboardEvidence["winnerCurve"]): string {
  const maximum = Math.max(1, ...points.map((point) => point.fallFromTotalPeak));
  const bars = points.map((point, index) => { const width = 1000 / Math.max(1, points.length); const height = point.fallFromTotalPeak / maximum * 260; return `<rect x="${(index * width).toFixed(2)}" y="${(280 - height).toFixed(2)}" width="${Math.max(1, width - 1).toFixed(2)}" height="${height.toFixed(2)}"/>`; }).join("");
  return `<svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-label="Fall from previous Total peak">${bars}</svg>`;
}

function blockPnlChart(winner: Record<string, unknown>): string {
  const confirmation = record(winner.confirmation), blockPnl = record(confirmation.blockPnl), rows = Object.entries(blockPnl).filter((entry): entry is [string, number] => typeof entry[1] === "number").sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return "<p>No confirmation block PnL.</p>";
  const scale = Math.max(1, ...rows.map(([, value]) => Math.abs(value)));
  return `<div class="blockPnl">${rows.map(([key, value]) => `<div><code>${escapeHtml(key)}</code><span class="${value >= 0 ? "positive" : "negative"}" style="width:${(Math.abs(value) / scale * 70).toFixed(2)}%">${escapeHtml(value.toFixed(2))}</span></div>`).join("")}</div>`;
}

function matrixTable(finalMatrix: unknown): string {
  if (!Array.isArray(finalMatrix)) return "<p>No matrix rows.</p>";
  const rows = finalMatrix.map(record);
  return `<table><thead><tr><th>Model</th><th>Stake</th><th>Scenario</th><th>Policy</th><th>Capacity</th><th>Executed</th><th>PnL</th><th>ROI</th><th>Max fall</th><th>CVaR95</th><th>Freeze eligible</th></tr></thead><tbody>${rows.map((row) => { const confirmation = record(row.confirmation), risk = record(confirmation.risk), capacity = record(row.capacity), policy = record(row.capitalPolicy); return `<tr><td>${escapeHtml(row.model)}</td><td>${escapeHtml(row.stakePolicy)}</td><td>${escapeHtml(row.operationScenario)}</td><td>${escapeHtml(policy.id)}</td><td>${escapeHtml(`${capacity.maxOpenPositions}/${capacity.maxOpenExposurePct}`)}</td><td>${escapeHtml(confirmation.executedMatches)}</td><td>${escapeHtml(confirmation.netPnl)}</td><td>${escapeHtml(confirmation.roi)}</td><td>${escapeHtml(confirmation.maximumFallFromTotalPeak)}</td><td>${escapeHtml(risk.cvar95MaximumFall)}</td><td>${escapeHtml(row.eligibleForFinalSelection)}</td></tr>`; }).join("")}</tbody></table>`;
}

export function renderScientificArchitectureDashboard(evidence: ScientificDashboardEvidence): string {
  const bootstrap = record(evidence.bootstrap);
  const quantiles = { p10EndingCapital: number(bootstrap.p10EndingCapital), medianEndingCapital: number(bootstrap.medianEndingCapital), p90EndingCapital: number(bootstrap.p90EndingCapital), cvar95MaximumFall: number(bootstrap.cvar95MaximumFall), probabilityBelowInitial: number(bootstrap.probabilityBelowInitial) };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(evidence.title)}</title><style>body{font-family:system-ui;margin:24px;color:#17202a;background:#fafafa}main{max-width:1400px;margin:auto}section{margin:28px 0;background:#fff;padding:18px;border:1px solid #dfe6e9;border-radius:10px}pre{background:#f4f6f7;padding:12px;overflow:auto;max-height:420px}svg{width:100%;height:300px;border:1px solid #ccd1d1;background:#fff}.total{fill:none;stroke:#1565c0;stroke-width:3}.active{fill:none;stroke:#2e7d32;stroke-width:2}.vault{fill:none;stroke:#8e24aa;stroke-width:2}rect{fill:#ef6c00}.legend span{margin-right:18px}.totalKey{color:#1565c0}.activeKey{color:#2e7d32}.vaultKey{color:#8e24aa}.blockPnl div{display:flex;gap:12px;margin:5px}.blockPnl code{width:100px}.blockPnl span{display:block;padding:3px 8px;color:#fff}.positive{background:#2e7d32}.negative{background:#c62828}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ddd;padding:6px;text-align:right}th:first-child,td:first-child{text-align:left}</style></head><body><main><h1>${escapeHtml(evidence.title)}</h1><p>Historical pseudo-out-of-sample evidence. Not forward validation and not live approval.</p><p>Dataset: <code>${escapeHtml(evidence.frozenDatasetSha256)}</code></p><section><h2>Total / Active / Vault capital curves</h2>${lineChart(evidence.winnerCurve)}</section><section><h2>Fall from previous Total peak</h2>${fallChart(evidence.winnerCurve)}</section><section><h2>Confirmation-block PnL</h2>${blockPnlChart(evidence.winner)}</section><section><h2>Bootstrap distribution summary and CVaR</h2><pre>${escapeHtml(JSON.stringify(quantiles, null, 2))}</pre></section><section><h2>Final model × fixed/dynamic × 24×7/night-only matrix</h2>${matrixTable(evidence.finalMatrix)}</section>${section("Capital-policy Pareto frontier and SPA corroboration", evidence.capitalFrontier)}${section("Scientific final winner", evidence.winner)}<script type="application/json" id="machine-evidence">${safeJson(evidence)}</script></main></body></html>`;
}

function winnerLines(label: string, value: Record<string, unknown>): string[] {
  const confirmation = record(value.confirmation), risk = record(confirmation.risk), capacity = record(value.capacity), policy = record(value.capitalPolicy);
  return [
    `- ${label}: model \`${String(value.model)}\`, policy \`${String(policy.id)}\`, stake \`${String(value.stakePolicy)}\`, scenario \`${String(value.operationScenario)}\`.`,
    `- Capacity: ${String(capacity.maxOpenPositions)} positions, ${String(capacity.maxOpenExposurePct)} exposure, ${String(capacity.maxAcceptedPerOperatingDay)} accepted per Minsk operating day.`,
    `- Confirmation: ${String(confirmation.executedMatches)} executions, PnL $${String(confirmation.netPnl)}, ROI ${String(confirmation.roi)}%, ending Total $${String(confirmation.endingTotal)}.`,
    `- Minimum Total $${String(confirmation.minimumTotal)}, maximum fall $${String(confirmation.maximumFallFromTotalPeak)}, CVaR95 maximum fall $${String(risk.cvar95MaximumFall)}, probability below initial ${String(risk.probabilityBelowInitial)}.`,
  ];
}

export function renderScientificFounderReport(evidence: ScientificFounderReportEvidence): string {
  return `# Финальный исторический scientific freeze — отчёт основателю

Проверены 25 coarse capital policies: No Vault, Static Capital Floor, High-Watermark Drawdown Floor и one-way ratcheted CPPI. Refinement выполнялся только вокруг максимум трёх development Pareto candidates; общий предел — 35. Это дискретные проектные адаптации, а не заявления о точном воспроизведении академических торговых стратегий.

Development — первые 70% Minsk operating-day blocks; confirmation — последние 30%. Внутри development использованы expanding one-block-ahead результаты только после 12 prior blocks. Confirmation не использовался для refinement, выбора capacity или SPA inputs. Это historical pseudo-out-of-sample evidence, не forward validation.

PRIMARY выбрал \`${evidence.primaryCapitalPolicy}\`; Hansen SPA consistent=${evidence.primarySpa.consistent}, conservative upper=${evidence.primarySpa.upper}. SENSITIVITY выбрал \`${evidence.sensitivityCapitalPolicy}\`; consistent=${evidence.sensitivitySpa.consistent}, upper=${evidence.sensitivitySpa.upper}. Verdict: \`${evidence.sensitivityVerdict}\`.

${winnerLines("PNL_MAX", evidence.pnlMax).join("\n")}

${winnerLines("RISK_MIN", evidence.riskMin).join("\n")}

${winnerLines("SCIENTIFIC_FINAL_WINNER", evidence.winner).join("\n")}

На банке $10,000 FIXED_100 всегда ставит ровно $100. DYNAMIC_ACTIVE_3PCT фиксирует 3% разрешённого Active reference на границе Minsk operating cycle и не уменьшает максимум из-за уже открытых позиций. Vault односторонний: переводы возможны только из free Active после settlement; автоматического возврата из Vault нет. Для одинакового timestamp сначала закрывается весь settlement batch, затем применяется capital policy, затем обрабатывается entry batch.

Цена защиты измеряется разницей PnL и skipped positions относительно No Vault и альтернативных capacity cells; полные значения находятся в machine-readable frontier и matrix. Отдельные 24×7 и NIGHT_ONLY результаты нельзя взаимозаменять: NIGHT_ONLY — окно 18:00–09:00 Europe/Minsk.

Ограничения: frozen historical dataset не является forward sample; SPA/upper подтверждают только процедуру multiple-testing на development blocks; результаты чувствительны к исторической последовательности, settlement labels и доступной выборке; комиссии и live slippage не добавлялись; Ireland parity и live readiness не проверялись.

Dataset SHA-256: \`${evidence.datasetSha256}\`.
`;
}
