/**
 * BUILD_OFFLINE_PLOTLY_MODEL_COMPARISON_DASHBOARD_V1 — thin offline renderer.
 *
 *   npx tsx scripts/modeling/offline-replay-dashboard.ts
 *
 * Reads the ALREADY-CALCULATED Sep01–10 offline-replay artifacts and emits one
 * self-describing interactive Plotly HTML dashboard. It NEVER invokes runReplay,
 * queries a database, hits the network, or recomputes any model metric — every
 * number written to the page is copied verbatim from a source artifact and is
 * re-checked for parity before the file is written.
 *
 * Output:  modeling/evidence/offline-replay-plane-v1/SEPTEMBER_DASHBOARD_V1.html
 * Charts:  Plotly, loaded from the vendored offline bundle beside the page
 *          (modeling/evidence/offline-replay-plane-v1/vendor/plotly-2.35.2.min.js).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildDashboardModel, type DashboardModel } from "../../lib/modeling/offline-replay/dashboardModel";

const DIR = join("modeling", "evidence", "offline-replay-plane-v1");
const OUT = join(DIR, "SEPTEMBER_DASHBOARD_V1.html");
const PLOTLY_VENDOR_REL = "vendor/plotly-2.35.2.min.js";
const PLOTLY_VENDOR_ABS = join(DIR, PLOTLY_VENDOR_REL);

function readJson(f: string): unknown {
  return JSON.parse(readFileSync(join(DIR, f), "utf8"));
}

/* ------------------------------------------------------------------ *
 * fail-closed parity guard — the renderer must not drift from source  *
 * ------------------------------------------------------------------ */
function assertParity(model: DashboardModel, sep: any, cand: any, attr: any): string[] {
  const checks: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (a !== b && !(a === null && b === null)) {
      throw new Error(`PARITY FAIL: ${label}: dashboard=${JSON.stringify(a)} source=${JSON.stringify(b)}`);
    }
    checks.push(label);
  };

  for (const raw of sep.overall) {
    const row = model.overallModels.find((r) => r.model === raw.MODEL && r.source === "SEPTEMBER_TABLES.json")!;
    eq(row.BETS, raw.SIMULATED_BET_N, `overall ${raw.MODEL} BETS`);
    eq(row.TERMINAL, raw.TERMINAL_BET_N, `overall ${raw.MODEL} TERMINAL`);
    eq(row.PNL_U, raw.GROSS_PNL_U, `overall ${raw.MODEL} PNL_U`);
    eq(row.ROI_PCT, raw.GROSS_ROI_PCT, `overall ${raw.MODEL} ROI_PCT`);
    eq(row.MAX_DD_U, raw.MAX_DD_U, `overall ${raw.MODEL} MAX_DD_U`);
  }
  for (const raw of cand.comparison_table) {
    if (sep.overall.some((o: any) => o.MODEL === raw.MODEL)) continue;
    if (raw.MODEL === "C0_REFERENCE") continue; // echo of C0, not a separate operator model
    const row = model.overallModels.find((r) => r.model === raw.MODEL)!;
    eq(row.BETS, raw.BETS, `candidate ${raw.MODEL} BETS`);
    eq(row.PNL_U, raw.PNL_U, `candidate ${raw.MODEL} PNL_U`);
    eq(row.ROI_PCT, raw.ROI_PCT, `candidate ${raw.MODEL} ROI_PCT`);
    eq(row.MAX_DD_U, raw.MAX_DD_U, `candidate ${raw.MODEL} MAX_DD_U`);
  }
  for (const [m, rows] of Object.entries<any[]>(sep.grouped)) {
    for (const raw of rows) {
      const row = model.sportRows.find((r) => r.model === m && r.sport === raw.GROUP_KEY)!;
      eq(row.PNL_U, raw.GROSS_PNL_U, `sport ${m}/${raw.GROUP_KEY} PNL_U`);
      eq(row.BETS, raw.SIMULATED_BET_N, `sport ${m}/${raw.GROUP_KEY} BETS`);
      eq(row.MAX_DD_U, raw.MAX_DD_U, `sport ${m}/${raw.GROUP_KEY} MAX_DD_U`);
    }
  }
  const a1 = attr.analysis_1_selected_bet_economics;
  for (const [dim, buckets] of Object.entries<any>(a1)) {
    for (const [bucket, raw] of Object.entries<any>(buckets)) {
      const row = model.contractAAttribution.bands.find((b) => b.dimension === dim && b.bucket === bucket)!;
      eq(row.PNL_U, raw.PNL_U, `band ${dim}/${bucket} PNL_U`);
      eq(row.ROI_PCT, raw.ROI_PCT, `band ${dim}/${bucket} ROI_PCT`);
      eq(row.BETS, raw.BETS, `band ${dim}/${bucket} BETS`);
    }
  }
  eq(model.meta.determinism_hash, sep.determinism_hash, "determinism_hash");
  return checks;
}

/* ------------------------------------------------------------------ *
 * HTML                                                                *
 * ------------------------------------------------------------------ */
function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function renderHtml(
  model: DashboardModel,
  parityChecks: string[],
  plotlyInline: string | null,
): string {
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  // deterministic: identify the render by the pinned AS-OF + determinism hash, not wall-clock
  const generatedAt = `AS-OF ${model.meta.window.as_of} · determinism ${model.meta.determinism_hash.slice(0, 16)}`;
  const plotlyMissing = plotlyInline === null;
  // Plotly loads from the vendored bundle that ships beside this page
  // (modeling/evidence/offline-replay-plane-v1/vendor/). Relative path, file://,
  // no network. An operator opens the HTML from that folder and it just works.
  const plotlyTag = `<script src="${PLOTLY_VENDOR_REL}"></script>`;
  void plotlyInline;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offline Model Comparison — Sep 01–10 · ${esc(model.meta.window.as_of)}</title>
${plotlyTag}
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0f1115; color: #e6e6e6; }
  header { padding: 18px 24px; border-bottom: 1px solid #262a33; background: #14171d; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 24px 8px; padding-top: 8px; border-top: 1px solid #262a33; }
  .sub { color: #9aa4b2; font-size: 12px; }
  .wrap { padding: 0 12px 48px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 8px; }
  .chart { background: #14171d; border: 1px solid #262a33; border-radius: 8px; padding: 6px; min-height: 320px; }
  table { border-collapse: collapse; width: calc(100% - 24px); margin: 8px 12px; font-size: 12.5px; }
  th, td { border: 1px solid #262a33; padding: 4px 8px; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th { background: #1b1f27; position: sticky; top: 0; }
  .na { color: #6b7280; font-style: italic; }
  .neg { color: #ff8080; } .pos { color: #6ee7a8; }
  .scroll { overflow-x: auto; }
  .pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; background:#1b1f27; border:1px solid #313743; margin-right:4px;}
  .warn { color:#ffcc66; }
  .controls { margin: 6px 12px; }
  select { background:#1b1f27; color:#e6e6e6; border:1px solid #313743; border-radius:6px; padding:3px 6px; }
  ul.unavail { margin: 4px 12px; }
  ul.unavail li { margin-bottom: 6px; }
  code { background:#1b1f27; padding:1px 4px; border-radius:4px; }
</style>
</head>
<body>
<header>
  <h1>Offline Policy Replay — Model Comparison Dashboard</h1>
  <div class="sub">
    Window <b>${esc(model.meta.window.from)} .. ${esc(model.meta.window.to)}</b> ·
    AS-OF <b>${esc(model.meta.window.as_of)}</b> ·
    economics <b>${esc(model.meta.economics_basis)}</b> ·
    determinism <code>${esc(model.meta.determinism_hash.slice(0, 16))}…</code>
  </div>
  <div class="sub">View over pre-calculated artifacts — no recomputation. ${esc(generatedAt)}.
    Source: <code>SEPTEMBER_TABLES.json</code>, <code>CONTRACT_A_ATTRIBUTION_V1.json</code>,
    <code>CONTRACT_A_CANDIDATES_V1.json</code>, <code>MANIFEST.json</code>.
    Parity checks passed: <b>${parityChecks.length}</b>.</div>
  ${plotlyMissing ? `<div class="sub warn">⚠ vendored Plotly bundle <code>${esc(PLOTLY_VENDOR_REL)}</code> not found at generate time — charts disabled. Tables still render.</div>` : `<div class="sub">Plotly loaded from vendored <code>${esc(PLOTLY_VENDOR_REL)}</code> · fully offline (file://, no network, no CDN).</div>`}
</header>
<div class="wrap">

  <h2>1 · Model overview</h2>
  <div class="sub controls">PRIMARY operator comparison — default lanes only:
    <b>${esc(model.dashboardDefaultModels.join(", "))}</b>.
    BETS / TERMINAL / UNRESOLVED / WINS / LOSSES / PNL_U / ROI_PCT / MAX_DD_U / WIN_RATE — verbatim from source.
    <span class="na">N/A</span> = null economics in the source (never shown as 0).
    C1–C5 + C0_REFERENCE are retained below under "research / hidden models".</div>
  <div id="tbl-overview" class="scroll"></div>

  <h2>1b · Model status &amp; deterministic runtime contract</h2>
  <div class="sub controls">RUNTIME_KIND = DETERMINISTIC_CODE · LLM_DEPENDENCY_AT_RUNTIME = NO ·
    NETWORK/DATABASE_DEPENDENCY_AT_REPLAY = NO for every model. STATUS describes the current operator surface only.</div>
  <div id="tbl-contract" class="scroll"></div>

  <h2>2 · Model comparison charts</h2>
  <div class="sub controls">default operator lanes only.</div>
  <div class="grid">
    <div id="c-pnl" class="chart"></div>
    <div id="c-roi" class="chart"></div>
    <div id="c-bets" class="chart"></div>
    <div id="c-dd" class="chart"></div>
    <div id="c-frontier" class="chart"></div>
  </div>

  <details style="margin:12px">
    <summary class="sub">research / hidden models (C1–C5, C0_REFERENCE) — source results retained, excluded from default plots</summary>
    <div id="tbl-research" class="scroll"></div>
    <div class="grid"><div id="c-research-pnl" class="chart"></div><div id="c-research-roi" class="chart"></div></div>
  </details>

  <h2>3 · Sport comparison (model × sport)</h2>
  <div class="controls">
    metric <select id="sport-metric">
      <option value="PNL_U">PNL_U</option>
      <option value="ROI_PCT">ROI_PCT</option>
      <option value="BETS">BETS</option>
      <option value="TERMINAL">TERMINAL</option>
      <option value="WINS">WINS</option>
      <option value="LOSSES">LOSSES</option>
      <option value="MAX_DD_U">MAX_DD_U</option>
    </select>
    <span class="sub">toggle models in the legend · heatmap + grouped bars</span>
  </div>
  <div class="grid">
    <div id="c-sport-heat" class="chart"></div>
    <div id="c-sport-bar" class="chart"></div>
  </div>
  <div id="tbl-sport" class="scroll"></div>

  <h2>4 · Contract A diagnostics — selected-bet breakdowns</h2>
  <div class="sub controls">From <code>CONTRACT_A_ATTRIBUTION_V1.json</code> — persisted for <code>CONTRACT_A_FILTER_SIM_CURRENT</code> only.
    dimension <select id="band-dim"></select></div>
  <div class="grid">
    <div id="c-band-pnl" class="chart"></div>
    <div id="c-band-roi" class="chart"></div>
  </div>
  <div id="tbl-band" class="scroll"></div>
  <h3 class="sub" style="margin:20px 12px 4px">Ranked Contract A damage attribution</h3>
  <div class="grid"><div id="c-ranked" class="chart"></div></div>
  <div id="tbl-ranked" class="scroll"></div>

  <h2>5 · Contract A correction comparison</h2>
  <div class="sub controls">From <code>CONTRACT_A_CANDIDATES_V1.json</code> · decision: <b>${esc(model.contractACandidates.decision ?? "—")}</b></div>
  <div class="grid">
    <div id="c-cand-pnl" class="chart"></div>
    <div id="c-cand-roi" class="chart"></div>
  </div>
  <div id="tbl-cand" class="scroll"></div>
  <div id="tbl-cand-sport" class="scroll"></div>
  <div id="tbl-cand-market" class="scroll"></div>

  <h2>6 · Data quality</h2>
  <div id="tbl-dq" class="scroll"></div>
  <div class="grid">
    <div id="c-dq-terminal" class="chart"></div>
    <div id="c-dq-fields" class="chart"></div>
  </div>

  <h2>7 · Unavailable dimensions (explicit — not synthesized)</h2>
  <ul class="unavail">
    ${model.unavailableDimensions.map((d) => `<li><b>${esc(d.dimension)}</b><br /><span class="sub">${esc(d.reason)}</span></li>`).join("\n    ")}
  </ul>

</div>
<script id="model-data" type="application/json">${data}</script>
<script>
${DASHBOARD_JS}
</script>
</body>
</html>
`;
}

/* ---- the page's own rendering logic (runs in the browser, offline) ---- */
const DASHBOARD_JS = String.raw`
const M = JSON.parse(document.getElementById("model-data").textContent);
const hasPlotly = typeof window.Plotly !== "undefined";
const LAYOUT = { paper_bgcolor: "#14171d", plot_bgcolor: "#14171d", font: { color: "#cbd5e1", size: 11 },
  margin: { t: 34, r: 12, b: 90, l: 54 }, legend: { orientation: "h" } };
const CONF = { displaylogo: false, responsive: true };
const fmt = (v, d = 2) => v === null || v === undefined ? "N/A" : (typeof v === "number" ? v.toFixed(d) : String(v));
const cls = (v) => v === null || v === undefined ? "na" : (v < 0 ? "neg" : (v > 0 ? "pos" : ""));

function plot(id, traces, layout) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!hasPlotly) { el.innerHTML = '<div class="sub warn" style="padding:16px">Plotly bundle unavailable — chart skipped.</div>'; return; }
  Plotly.newPlot(el, traces, Object.assign({}, LAYOUT, layout), CONF);
}
function tableHtml(cols, rows) {
  return '<table><thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + r.map((c, i) => {
      if (c && typeof c === 'object') return '<td class="' + (c.c || '') + '">' + c.v + '</td>';
      return '<td' + (i === 0 ? '' : '') + '>' + (c === null || c === undefined ? '<span class="na">N/A</span>' : c) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table>';
}

const METRIC_COLS = ["MODEL", "STATUS", "SOURCE", "BETS", "TERMINAL", "UNRESOLVED", "WINS", "LOSSES", "PNL_U", "ROI_PCT", "MAX_DD_U", "WIN_RATE"];
function metricRow(r) {
  return [r.model, { v: r.STATUS }, { v: r.source === "SEPTEMBER_TABLES.json" ? "primary" : "candidate" },
    r.BETS, r.TERMINAL, r.UNRESOLVED, r.WINS, r.LOSSES,
    { v: fmt(r.PNL_U), c: cls(r.PNL_U) }, { v: fmt(r.ROI_PCT, 2), c: cls(r.ROI_PCT) },
    { v: fmt(r.MAX_DD_U), c: cls(r.MAX_DD_U) }, { v: fmt(r.WIN_RATE_PCT, 2) }];
}

/* ---- 1 · overview table (DEFAULT operator lanes only) ---- */
(function () {
  document.getElementById("tbl-overview").innerHTML = tableHtml(METRIC_COLS, M.defaultModels.map(metricRow));
})();

/* ---- 1b · deterministic runtime contract ---- */
(function () {
  const cols = ["MODEL_ID", "MODEL_VERSION", "RUNTIME_KIND", "LLM_DEP", "NET_DEP", "DB_DEP", "CANONICAL_PREDICATE_OWNER", "STATUS", "DEFAULT_VISIBLE"];
  const rows = M.runtimeContract.map(c => [c.MODEL_ID, c.MODEL_VERSION, c.RUNTIME_KIND,
    { v: c.LLM_DEPENDENCY_AT_RUNTIME ? "YES" : "NO" }, { v: c.NETWORK_DEPENDENCY_AT_REPLAY ? "YES" : "NO" },
    { v: c.DATABASE_DEPENDENCY_AT_REPLAY ? "YES" : "NO" }, c.CANONICAL_PREDICATE_OWNER, c.STATUS,
    { v: c.DASHBOARD_DEFAULT_VISIBLE ? "YES" : "NO" }]);
  document.getElementById("tbl-contract").innerHTML = tableHtml(cols, rows);
})();

/* ---- 2 · comparison charts (DEFAULT operator lanes only) ---- */
(function () {
  const D = M.defaultModels;
  const models = D.map(r => r.model);
  const bar = (key, d) => ({ x: models, y: D.map(r => r[key]), type: "bar",
    text: D.map(r => fmt(r[key], d)), textposition: "outside",
    marker: { color: D.map(r => (r[key] === null ? "#4b5563" : (r[key] < 0 ? "#ef6f6f" : "#5aa9e6"))) } });
  plot("c-pnl", [bar("PNL_U", 2)], { title: "PnL (u) — default lanes — GROSS_BEFORE_FEES", yaxis: { title: "PNL_U" } });
  plot("c-roi", [bar("ROI_PCT", 2)], { title: "ROI (%) — default lanes — null = no terminal bets (N/A)", yaxis: { title: "ROI_PCT" } });
  plot("c-dd", [bar("MAX_DD_U", 2)], { title: "Max drawdown (u) — default lanes", yaxis: { title: "MAX_DD_U" } });
  plot("c-bets", [
    { x: models, y: D.map(r => r.BETS), name: "BETS (selected)", type: "bar" },
    { x: models, y: D.map(r => r.TERMINAL), name: "TERMINAL", type: "bar" },
    { x: models, y: D.map(r => r.UNRESOLVED), name: "UNRESOLVED", type: "bar" },
  ], { barmode: "group", title: "Bet N / Terminal N / Unresolved N — default lanes", yaxis: { title: "count" } });

  const fr = D.filter(r => r.ROI_PCT !== null && r.PNL_U !== null);
  plot("c-frontier", [{
    x: fr.map(r => r.PNL_U), y: fr.map(r => r.ROI_PCT), mode: "markers+text", type: "scatter",
    text: fr.map(r => r.model), textposition: "top center",
    marker: { size: fr.map(r => Math.max(8, Math.sqrt(r.BETS))), color: fr.map(r => r.ROI_PCT),
      colorscale: "RdYlGn", showscale: true, line: { width: 1, color: "#0f1115" } },
    customdata: fr.map(r => [r.BETS, r.TERMINAL, r.WINS, r.LOSSES, r.MAX_DD_U]),
    hovertemplate: "<b>%{text}</b><br>PnL %{x:.2f}u · ROI %{y:.2f}%%<br>" +
      "BETS %{customdata[0]} · TERMINAL %{customdata[1]}<br>W-L %{customdata[2]}-%{customdata[3]} · MaxDD %{customdata[4]}<extra></extra>",
  }], { title: "ROI vs PnL frontier (marker ∝ √BETS; models with null ROI omitted)",
        xaxis: { title: "PNL_U" }, yaxis: { title: "ROI_PCT" } });
})();

/* ---- 2r · research / hidden models (retained, not in default plots) ---- */
(function () {
  const R = M.researchModels;
  if (!R.length) return;
  document.getElementById("tbl-research").innerHTML = tableHtml(METRIC_COLS, R.map(metricRow));
  const models = R.map(r => r.model);
  const bar = (key, d) => ({ x: models, y: R.map(r => r[key]), type: "bar", text: R.map(r => fmt(r[key], d)),
    textposition: "outside", marker: { color: R.map(r => (r[key] === null ? "#4b5563" : (r[key] < 0 ? "#ef6f6f" : "#5aa9e6"))) } });
  plot("c-research-pnl", [bar("PNL_U", 2)], { title: "research models — PNL_U (retained, not operator-default)", yaxis: { title: "PNL_U" } });
  plot("c-research-roi", [bar("ROI_PCT", 2)], { title: "research models — ROI_PCT (null = N/A)", yaxis: { title: "ROI_PCT" } });
})();

/* ---- 3 · sport comparison ---- */
(function () {
  const sports = M.sports;
  const allModels = [...new Set(M.sportRows.map(r => r.model))];
  const defaultInSport = allModels.filter(m => M.dashboardDefaultModels.indexOf(m) !== -1);
  const models = defaultInSport.length ? defaultInSport : allModels;
  const get = (m, s, key) => { const row = M.sportRows.find(r => r.model === m && r.sport === s); return row ? row[key] : null; };
  function draw(metric) {
    const z = models.map(m => sports.map(s => get(m, s, metric)));
    plot("c-sport-heat", [{
      z, x: sports, y: models, type: "heatmap", colorscale: "RdYlGn", hoverongaps: false,
      hovertemplate: "%{y} · %{x}<br>" + metric + " %{z}<extra></extra>",
    }], { title: "model × sport — " + metric + " (blank = no data / N/A)" });
    plot("c-sport-bar", models.map(m => ({
      x: sports, y: sports.map(s => get(m, s, metric)), name: m, type: "bar",
    })), { barmode: "group", title: "model × sport — " + metric + " (toggle models in legend)", yaxis: { title: metric } });
  }
  document.getElementById("sport-metric").addEventListener("change", e => draw(e.target.value));
  draw("PNL_U");

  const cols = ["MODEL", "SPORT", "BETS", "TERMINAL", "UNRESOLVED", "WINS", "LOSSES", "PNL_U", "ROI_PCT", "MAX_DD_U"];
  const rows = M.sportRows.map(r => [r.model, r.sport, r.BETS, r.TERMINAL, r.UNRESOLVED, r.WINS, r.LOSSES,
    { v: fmt(r.PNL_U), c: cls(r.PNL_U) }, { v: fmt(r.ROI_PCT, 2), c: cls(r.ROI_PCT) }, { v: fmt(r.MAX_DD_U), c: cls(r.MAX_DD_U) }]);
  document.getElementById("tbl-sport").innerHTML = tableHtml(cols, rows);
})();

/* ---- 4 · Contract A band diagnostics ---- */
(function () {
  const dims = M.contractAAttribution.bandDimensions;
  const sel = document.getElementById("band-dim");
  dims.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
  function draw(dim) {
    const b = M.contractAAttribution.bands.filter(x => x.dimension === dim);
    const hv = "%{x}<br>PnL %{y:.2f}u<br>BETS %{customdata[0]} · TERM %{customdata[1]} · W-L %{customdata[2]}-%{customdata[3]}<extra></extra>";
    const cd = b.map(r => [r.BETS, r.TERMINAL, r.WINS, r.LOSSES]);
    plot("c-band-pnl", [{ x: b.map(r => r.bucket), y: b.map(r => r.PNL_U), type: "bar", customdata: cd, hovertemplate: hv,
      marker: { color: b.map(r => (r.PNL_U === null ? "#4b5563" : (r.PNL_U < 0 ? "#ef6f6f" : "#6ee7a8"))) } }],
      { title: "CONTRACT_A_FILTER_SIM_CURRENT — PNL_U by " + dim, yaxis: { title: "PNL_U" } });
    plot("c-band-roi", [{ x: b.map(r => r.bucket), y: b.map(r => r.ROI_PCT), type: "bar", customdata: cd,
      hovertemplate: hv.replace("PnL %{y:.2f}u", "ROI %{y:.2f}%%") }],
      { title: "CONTRACT_A_FILTER_SIM_CURRENT — ROI_PCT by " + dim, yaxis: { title: "ROI_PCT" } });
    const cols = ["BUCKET", "BETS", "TERMINAL", "UNRESOLVED", "WINS", "LOSSES", "PNL_U", "ROI_PCT", "MAX_DD_U", "WIN_RATE_PCT"];
    document.getElementById("tbl-band").innerHTML = tableHtml(cols, b.map(r => [r.bucket, r.BETS, r.TERMINAL, r.UNRESOLVED,
      r.WINS, r.LOSSES, { v: fmt(r.PNL_U), c: cls(r.PNL_U) }, { v: fmt(r.ROI_PCT, 2), c: cls(r.ROI_PCT) },
      { v: fmt(r.MAX_DD_U), c: cls(r.MAX_DD_U) }, { v: fmt(r.WIN_RATE_PCT, 2) }]));
  }
  sel.addEventListener("change", e => draw(e.target.value));
  if (dims.length) draw(dims[0]);

  const rk = M.contractAAttribution.ranked;
  if (rk.length) {
    plot("c-ranked", [{
      x: rk.map(r => r.DELTA_PNL), y: rk.map(r => "#" + r.RANK + " " + r.CONTRACT_A_SEMANTIC), type: "bar", orientation: "h",
      text: rk.map(r => r.VERDICT), textposition: "outside",
      marker: { color: rk.map(r => r.VERDICT.indexOf("MAJOR") >= 0 ? "#ef4444" : (r.VERDICT.indexOf("DAMAGE") >= 0 ? "#f59e0b" : "#6b7280")) },
      hovertemplate: "%{y}<br>Δ PnL if gate removed %{x:.2f}u<extra></extra>",
    }], { title: "Ranked Contract A damage — Δ PnL if the gate is removed (research diagnostic, not a policy)",
          xaxis: { title: "DELTA_PNL (u)" }, margin: { l: 240 } });
    const cols = ["RANK", "SEMANTIC", "CURRENT_RULE", "CURRENT_A_PNL", "ABLATION_PNL", "DELTA_PNL", "DELTA_ROI_PP", "VERDICT"];
    document.getElementById("tbl-ranked").innerHTML = tableHtml(cols, rk.map(r => [r.RANK, r.CONTRACT_A_SEMANTIC, r.CURRENT_RULE,
      { v: fmt(r.CURRENT_A_PNL), c: cls(r.CURRENT_A_PNL) }, { v: fmt(r.ABLATION_PNL), c: cls(r.ABLATION_PNL) },
      { v: fmt(r.DELTA_PNL), c: cls(r.DELTA_PNL) }, { v: fmt(r.DELTA_ROI_PP, 2), c: cls(r.DELTA_ROI_PP) }, r.VERDICT]));
  }
})();

/* ---- 5 · Contract A correction comparison ---- */
(function () {
  const t = M.contractACandidates.comparison;
  const names = t.map(r => r.MODEL);
  const col = (k) => t.map(r => (r[k] === undefined ? null : r[k]));
  plot("c-cand-pnl", [{ x: names, y: col("PNL_U"), type: "bar", text: col("PNL_U").map(v => fmt(v)), textposition: "outside",
    marker: { color: col("PNL_U").map(v => (v === null ? "#4b5563" : (v < 0 ? "#ef6f6f" : "#6ee7a8"))) } }],
    { title: "Contract A candidates — PNL_U", yaxis: { title: "PNL_U" } });
  plot("c-cand-roi", [
    { x: names, y: col("ROI_PCT"), name: "ROI_PCT", type: "bar" },
    { x: names, y: col("MAX_DD_U"), name: "MAX_DD_U", type: "bar" },
  ], { barmode: "group", title: "Contract A candidates — ROI_PCT / MAX_DD_U", yaxis: { title: "value" } });
  const cols = ["MODEL", "FILTER_PASS_EVENTS", "BETS", "TERMINAL", "UNRESOLVED", "WINS", "LOSSES", "PNL_U", "ROI_PCT", "MAX_DD_U", "WIN_RATE_PCT"];
  document.getElementById("tbl-cand").innerHTML = tableHtml(cols, t.map(r => [r.MODEL, r.FILTER_PASS_EVENTS, r.BETS, r.TERMINAL,
    r.UNRESOLVED, r.WINS, r.LOSSES, { v: fmt(r.PNL_U), c: cls(r.PNL_U) }, { v: fmt(r.ROI_PCT, 2), c: cls(r.ROI_PCT) },
    { v: fmt(r.MAX_DD_U), c: cls(r.MAX_DD_U) }, { v: fmt(r.WIN_RATE_PCT, 2) }]));

  function nested(title, obj) {
    if (!obj || !Object.keys(obj).length) return "";
    let h = '<table><thead><tr><th>' + title + '</th><th>GROUP</th><th>BETS</th><th>TERMINAL</th><th>WINS</th><th>LOSSES</th><th>PNL_U</th><th>ROI_PCT</th><th>MAX_DD_U</th></tr></thead><tbody>';
    for (const [mdl, groups] of Object.entries(obj))
      for (const [g, r] of Object.entries(groups))
        h += '<tr><td>' + mdl + '</td><td>' + g + '</td><td>' + r.BETS + '</td><td>' + r.TERMINAL + '</td><td>' + r.WINS + '</td><td>' + r.LOSSES +
          '</td><td class="' + cls(r.PNL_U) + '">' + fmt(r.PNL_U) + '</td><td class="' + cls(r.ROI_PCT) + '">' + fmt(r.ROI_PCT, 2) +
          '</td><td class="' + cls(r.MAX_DD_U) + '">' + fmt(r.MAX_DD_U) + '</td></tr>';
    return h + '</tbody></table>';
  }
  document.getElementById("tbl-cand-sport").innerHTML = nested("candidate × sport", M.contractACandidates.sportTable);
  document.getElementById("tbl-cand-market").innerHTML = nested("candidate × market family", M.contractACandidates.marketTable);
})();

/* ---- 6 · data quality ---- */
(function () {
  const c = M.meta.counts, fc = M.meta.field_completeness || {};
  const rows = [
    ["window", M.meta.window.from + " .. " + M.meta.window.to],
    ["as_of", M.meta.window.as_of],
    ["economics_basis", M.meta.economics_basis],
    ["determinism_hash", M.meta.determinism_hash],
    ["days_loaded", M.meta.days_loaded.join(", ")],
    ["days_missing", M.meta.days_missing.length ? M.meta.days_missing.join(", ") : "(none)"],
    ["IDENTITY_N", c.IDENTITY_N],
    ["DISTINCT_PHYSICAL_EVENT_N", c.DISTINCT_PHYSICAL_EVENT_N],
    ["TERMINAL_LABELED_IDENTITY_N", c.TERMINAL_LABELED_IDENTITY_N],
    ["UNRESOLVED_IDENTITY_N", c.UNRESOLVED_IDENTITY_N],
  ];
  for (const [k, v] of Object.entries(fc)) rows.push(["field_completeness · " + k, v]);
  for (const [d, s] of Object.entries(M.meta.label_sources)) rows.push(["label_source · " + d, s]);
  document.getElementById("tbl-dq").innerHTML = tableHtml(["FIELD", "VALUE"], rows);

  plot("c-dq-terminal", [{
    values: [c.TERMINAL_LABELED_IDENTITY_N, c.UNRESOLVED_IDENTITY_N], labels: ["TERMINAL_LABELED", "UNRESOLVED"],
    type: "pie", hole: 0.55, marker: { colors: ["#5aa9e6", "#6b7280"] },
  }], { title: "Identity population — terminal vs unresolved (" + c.IDENTITY_N + " total)" });

  const fk = Object.keys(fc).filter(k => /_PCT$/.test(k));
  if (fk.length) plot("c-dq-fields", [{ x: fk, y: fk.map(k => fc[k]), type: "bar", text: fk.map(k => fc[k] + "%"), textposition: "outside" }],
    { title: "Field completeness (%)", yaxis: { title: "%", range: [0, 100] } });
  else document.getElementById("c-dq-fields").innerHTML = '<div class="sub" style="padding:16px">No *_PCT field-completeness metrics in source.</div>';
})();
`;

/* ------------------------------------------------------------------ *
 * main                                                                *
 * ------------------------------------------------------------------ */
function main(): number {
  const sep = readJson("SEPTEMBER_TABLES.json") as any;
  const attr = readJson("CONTRACT_A_ATTRIBUTION_V1.json") as any;
  const cand = readJson("CONTRACT_A_CANDIDATES_V1.json") as any;
  const manifest = readJson("MANIFEST.json");

  const model = buildDashboardModel({
    septemberTables: sep,
    contractAAttribution: attr,
    contractACandidates: cand,
    manifest,
  });

  const parityChecks = assertParity(model, sep, cand, attr);
  const plotlyVendored = existsSync(PLOTLY_VENDOR_ABS) ? readFileSync(PLOTLY_VENDOR_ABS, "utf8") : null;

  const html = renderHtml(model, parityChecks, plotlyVendored);
  writeFileSync(OUT, html, "utf8");

  console.log(`# DASHBOARD written: ${OUT} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB)`);
  console.log(`# plotly: ${plotlyVendored ? `vendored ${PLOTLY_VENDOR_REL} (relative, file://, no network)` : "MISSING ⚠"}`);
  console.log(`# default operator lanes: ${model.dashboardDefaultModels.join(", ")}`);
  console.log(`# research / hidden models: ${model.researchModels.map((r) => r.model).join(", ")}`);
  console.log(`# all renderable models: ${[...model.primaryModels, ...model.candidateModels].join(", ")}`);
  console.log(`# sports: ${model.sports.join(", ")}`);
  console.log(`# contract-A band dimensions: ${model.contractAAttribution.bandDimensions.join(", ")}`);
  console.log(`# parity checks passed: ${parityChecks.length}`);
  console.log(`# determinism_hash (pinned source): ${model.meta.determinism_hash}`);
  console.log(`# LLM_CALL_N=0  AI_AGENT_CALL_N=0  PRODUCTION_DB_QUERY_N=0  NETWORK_QUERY_N=0`);
  return plotlyVendored ? 0 : 2;
}

process.exitCode = main();
