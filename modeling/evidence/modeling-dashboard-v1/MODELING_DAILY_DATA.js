/**
 * MODELING_DAILY_DATA_V1 — tracked aggregate data file for MODELING_DASHBOARD.html.
 *
 * FROZEN Sep21 seed (2026-08-04 -> 2026-09-20, 48 closed days, 68,949 model-ready
 * rows, 7,985 processed physical events) plus whatever `daily` history the
 * incremental refresh command (npm run research-clone:modeling-dashboard-refresh)
 * has appended since. Aggregate metrics only -- no raw event rows.
 *
 * Source authority: PREMVP-DB-CLONE / research_model_ready_days / research_model_ready_rows.
 * Engine authority: scripts/modeling/daily-portfolio-frontier.ts
 *   (runStandalone / runPortfolio / applyDailyCap / computeCapacity / metricsFor).
 * Numbers below are read verbatim from the already-accepted evidence artifacts:
 *   modeling/evidence/daily-cap-pnl-optimization-v1/DAILY_CAP_PNL_OPTIMIZATION_2026-08-04_2026-09-20.md
 *   modeling/evidence/daily-cap-pnl-optimization-v1/QUALITY_FILL_PORTFOLIO_TEST_2026-08-04_2026-09-20.md
 *   modeling/evidence/daily-cap-pnl-optimization-v1/QUALITY_FILL_D_RESULT_2026-08-04_2026-09-20.md
 * `null` marks a cell that has no accepted aggregate figure in those artifacts
 * (never fabricated / never recomputed from raw rows to fill a gap).
 */
window.POLYPROPICKS_MODELING_DATA = {
  ARTIFACT: "MODELING_DAILY_DATA_V1",
  GENERATED_AT: "2026-09-21T00:00:00Z",

  meta: {
    frozenPeriodStart: "2026-08-04",
    frozenPeriodEnd: "2026-09-20",
    closedDays: 48,
    modelReadyRows: 68949,
    processedPhysicalEvents: 7985,
    preferredModel: "QUALITY_FILL_A",
    fillReferenceModel: "QUALITY_FILL_D",
    latestDashboardDate: "2026-09-20",
    provenance: {
      source: "PREMVP-DB-CLONE / research_model_ready_days / research_model_ready_rows",
      economics: "Flat 1u backtest research projection only -- not realized live cash P&L",
      productionWrites: 0,
      volumeSource: "PR #367 evidence, read-only provenance -- NOT_ACTIONABLE_CURRENT_COVERAGE",
      sep21FreezeCommitPr: "#368",
      refreshCommand: "npm run research-clone:modeling-dashboard-refresh",
    },
  },

  // One row per FROZEN model x CAP, drawn verbatim from the accepted evidence tables above.
  models: {
    QUALITY_FILL_A: {
      status: "PREFERRED_RESEARCH_PORTFOLIO",
      label: "QUALITY_FILL_A",
      mainRules: "1. Tennis P50_52  2. Soccer P50_54  3. remaining P50_52 (all sports)",
      sportMixNote: "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence within this bounded freeze; not recomputed (RAW_ROW_BUDGET=0).",
      fill: { fill30: 0.5, fill40: 0.375, fill50: 0.3125 },
      augSep: {
        aug: { n: 627, pnl_u: 68.21, roi_pct: 10.88 },
        sep: { n: 755, pnl_u: 334.05, roi_pct: 44.24 },
      },
      caps: {
        15: null,
        20: null,
        30: { selected_n: 1026, pnl_u: 297.8, roi_pct: 29.03, maxdd_u: -30.6, proj30d_u: 186.13 },
        40: { selected_n: 1222, pnl_u: 358.92, roi_pct: 29.37, maxdd_u: -33.62, proj30d_u: 224.33 },
        50: { selected_n: 1382, pnl_u: 402.25, roi_pct: 29.11, maxdd_u: -28.62, proj30d_u: 251.41 },
      },
      marginal: {
        "1_15": null,
        "16_20": null,
        "21_30": { incr_n: 272, incr_pnl_u: 80.22, incr_roi_pct: 29.49 },
        "31_40": { incr_n: 196, incr_pnl_u: 61.12, incr_roi_pct: 31.18 },
        "41_50": { incr_n: 160, incr_pnl_u: 43.33, incr_roi_pct: 27.08 },
      },
    },
    QUALITY_FILL_D: {
      status: "FILL_REFERENCE",
      label: "QUALITY_FILL_D",
      mainRules: "QUALITY_FILL_A + Soccer P54_60 as LAST fallback tier",
      sportMixNote: "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence within this bounded freeze; not recomputed (RAW_ROW_BUDGET=0).",
      fill: { fill30: 0.5833, fill40: 0.3958, fill50: 0.3333 },
      augSep: {
        aug: { n: 637, pnl_u: 72.33, roi_pct: 11.36 },
        sep: { n: 828, pnl_u: 326.42, roi_pct: 39.42 },
      },
      caps: {
        15: null,
        20: null,
        30: { selected_n: 1076, pnl_u: 293.89, roi_pct: 27.31, maxdd_u: -30.6, proj30d_u: 183.68 },
        40: { selected_n: 1296, pnl_u: 355.69, roi_pct: 27.45, maxdd_u: -33.62, proj30d_u: 222.31 },
        50: { selected_n: 1465, pnl_u: 398.76, roi_pct: 27.22, maxdd_u: -32.28, proj30d_u: 249.22 },
      },
      marginal: {
        "1_15": null,
        "16_20": null,
        "21_30": { incr_n: 310, incr_pnl_u: 79.4, incr_roi_pct: 25.61 },
        "31_40": { incr_n: 220, incr_pnl_u: 61.8, incr_roi_pct: 28.09 },
        "41_50": { incr_n: 169, incr_pnl_u: 43.07, incr_roi_pct: 25.49 },
      },
    },
    P50_52: {
      status: "STRONG_SIMPLE_BASELINE",
      label: "P50_52",
      mainRules: "0.50 <= entry_price < 0.52, all sports",
      sportMixNote: "Single-band price rule (all sports) -- see mainRules.",
      fill: { fill30: 0.4792, fill40: 0.3542, fill50: 0.2917 },
      augSep: {
        aug: { n: 621, pnl_u: 72.69, roi_pct: 11.7 },
        sep: { n: 722, pnl_u: 306.62, roi_pct: 42.47 },
      },
      caps: {
        15: { selected_n: 567, pnl_u: 134.18, roi_pct: 23.67, maxdd_u: -19.41, proj30d_u: 83.86 },
        20: { selected_n: 731, pnl_u: 189.49, roi_pct: 25.92, maxdd_u: -20.59, proj30d_u: 118.43 },
        30: { selected_n: 996, pnl_u: 267.35, roi_pct: 26.84, maxdd_u: -31.02, proj30d_u: 167.09 },
        40: { selected_n: 1192, pnl_u: 332.64, roi_pct: 27.91, maxdd_u: -35.1, proj30d_u: 207.9 },
        50: { selected_n: 1343, pnl_u: 379.3, roi_pct: 28.24, maxdd_u: -29.04, proj30d_u: 237.06 },
      },
      marginal: {
        "1_15": { incr_n: 567, incr_pnl_u: 134.18, incr_roi_pct: 23.66 },
        "16_20": { incr_n: 164, incr_pnl_u: 55.31, incr_roi_pct: 33.73 },
        "21_30": { incr_n: 265, incr_pnl_u: 77.86, incr_roi_pct: 29.38 },
        "31_40": { incr_n: 196, incr_pnl_u: 65.29, incr_roi_pct: 33.31 },
        "41_50": { incr_n: 151, incr_pnl_u: 46.66, incr_roi_pct: 30.9 },
      },
    },
    PORTFOLIO_BROAD: {
      status: "PRODUCTION_REFERENCE_MODEL_NOT_RESEARCH_PNL_LEADER",
      label: "PORTFOLIO_BROAD",
      mainRules: "tier1 Tennis/Score63-64 P50_52 -> tier2 P50_52 all sports -> tier3 P52_54 all sports",
      sportMixNote: "Tiered, multi-sport composite -- see mainRules.",
      fill: { fill30: 0.5625, fill40: 0.375, fill50: 0.3333 },
      augSep: {
        aug: { n: 688, pnl_u: 66.18, roi_pct: 9.62 },
        sep: { n: 766, pnl_u: 308.7, roi_pct: 40.3 },
      },
      caps: {
        15: { selected_n: 593, pnl_u: 150.72, roi_pct: 25.42, maxdd_u: -14.91, proj30d_u: 94.2 },
        20: { selected_n: 769, pnl_u: 195.47, roi_pct: 25.42, maxdd_u: -20.51, proj30d_u: 122.17 },
        30: { selected_n: 1068, pnl_u: 271.93, roi_pct: 25.46, maxdd_u: -36.79, proj30d_u: 169.96 },
        40: { selected_n: 1285, pnl_u: 325.27, roi_pct: 25.31, maxdd_u: -38.47, proj30d_u: 203.3 },
        50: { selected_n: 1454, pnl_u: 374.88, roi_pct: 25.78, maxdd_u: -31.87, proj30d_u: 234.3 },
      },
      marginal: {
        "1_15": { incr_n: 593, incr_pnl_u: 150.72, incr_roi_pct: 25.42 },
        "16_20": { incr_n: 176, incr_pnl_u: 44.75, incr_roi_pct: 25.43 },
        "21_30": { incr_n: 299, incr_pnl_u: 76.46, incr_roi_pct: 25.57 },
        "31_40": { incr_n: 217, incr_pnl_u: 53.34, incr_roi_pct: 24.58 },
        "41_50": { incr_n: 169, incr_pnl_u: 49.61, incr_roi_pct: 29.36 },
      },
    },
    P50_54: {
      status: "STRONG_RESEARCH_BASELINE",
      label: "P50_54",
      mainRules: "0.50 <= entry_price < 0.54, all sports",
      sportMixNote: "Single-band price rule (all sports) -- see mainRules.",
      fill: { fill30: 0.5625, fill40: null, fill50: 0.3125 },
      augSep: { aug: null, sep: null },
      caps: {
        15: { selected_n: 594, pnl_u: 124.18, roi_pct: 20.91, maxdd_u: -24.22, proj30d_u: 77.61 },
        20: { selected_n: 770, pnl_u: 190.4, roi_pct: 24.73, maxdd_u: -22.24, proj30d_u: 119.0 },
        30: { selected_n: 1065, pnl_u: 257.52, roi_pct: 24.18, maxdd_u: -34.85, proj30d_u: 160.95 },
        40: { selected_n: 1281, pnl_u: 321.79, roi_pct: 25.12, maxdd_u: -42.19, proj30d_u: 201.12 },
        50: { selected_n: 1448, pnl_u: 359.45, roi_pct: 24.82, maxdd_u: -36.96, proj30d_u: 224.66 },
      },
      marginal: {
        "1_15": { incr_n: 594, incr_pnl_u: 124.18, incr_roi_pct: 20.91 },
        "16_20": { incr_n: 176, incr_pnl_u: 66.22, incr_roi_pct: 37.63 },
        "21_30": { incr_n: 295, incr_pnl_u: 67.12, incr_roi_pct: 22.75 },
        "31_40": { incr_n: 216, incr_pnl_u: 64.27, incr_roi_pct: 29.75 },
        "41_50": { incr_n: 167, incr_pnl_u: 37.66, incr_roi_pct: 22.55 },
      },
    },
    C5: {
      status: "TRACKED_REFERENCE_PRICE_ANCHOR_BAND",
      label: "C5",
      mainRules: "Frozen C5 price-anchor definition (lib/modeling/research-engine/models.ts)",
      sportMixNote: "Price-anchor band, all sports -- see mainRules.",
      fill: { fill30: 0.6667, fill40: null, fill50: 0.375 },
      augSep: { aug: null, sep: null },
      caps: {
        15: { selected_n: 628, pnl_u: 141.82, roi_pct: 22.58, maxdd_u: -17.06, proj30d_u: 88.64 },
        20: { selected_n: 809, pnl_u: 193.69, roi_pct: 23.94, maxdd_u: -21.83, proj30d_u: 121.06 },
        30: { selected_n: 1142, pnl_u: 263.7, roi_pct: 23.09, maxdd_u: -22.64, proj30d_u: 164.81 },
        40: { selected_n: 1427, pnl_u: 305.57, roi_pct: 21.41, maxdd_u: -33.85, proj30d_u: 190.98 },
        50: { selected_n: 1618, pnl_u: 334.56, roi_pct: 20.68, maxdd_u: -39.86, proj30d_u: 209.1 },
      },
      marginal: {
        "1_15": { incr_n: 628, incr_pnl_u: 141.82, incr_roi_pct: 22.58 },
        "16_20": { incr_n: 181, incr_pnl_u: 51.87, incr_roi_pct: 28.66 },
        "21_30": { incr_n: 333, incr_pnl_u: 70.01, incr_roi_pct: 21.02 },
        "31_40": { incr_n: 285, incr_pnl_u: 41.87, incr_roi_pct: 14.69 },
        "41_50": { incr_n: 191, incr_pnl_u: 28.99, incr_roi_pct: 15.18 },
      },
    },
    C0: {
      status: "TRACKED_REFERENCE_PRICE_ANCHOR_BAND",
      label: "C0",
      mainRules: "0.50 <= entry_price < 0.60, all sports",
      sportMixNote: "Price-anchor band, all sports -- see mainRules.",
      fill: { fill30: 0.6875, fill40: null, fill50: 0.375 },
      augSep: { aug: null, sep: null },
      caps: {
        15: { selected_n: 628, pnl_u: 141.82, roi_pct: 22.58, maxdd_u: -17.06, proj30d_u: 88.64 },
        20: { selected_n: 809, pnl_u: 193.69, roi_pct: 23.94, maxdd_u: -21.83, proj30d_u: 121.06 },
        30: { selected_n: 1149, pnl_u: 260.7, roi_pct: 22.69, maxdd_u: -23.64, proj30d_u: 162.94 },
        40: { selected_n: 1451, pnl_u: 299.86, roi_pct: 20.67, maxdd_u: -36.85, proj30d_u: 187.41 },
        50: { selected_n: 1648, pnl_u: 326.75, roi_pct: 19.83, maxdd_u: -46.86, proj30d_u: 204.22 },
      },
      marginal: {
        "1_15": { incr_n: 628, incr_pnl_u: 141.82, incr_roi_pct: 22.58 },
        "16_20": { incr_n: 181, incr_pnl_u: 51.87, incr_roi_pct: 28.66 },
        "21_30": { incr_n: 340, incr_pnl_u: 67.01, incr_roi_pct: 19.71 },
        "31_40": { incr_n: 302, incr_pnl_u: 39.16, incr_roi_pct: 12.97 },
        "41_50": { incr_n: 197, incr_pnl_u: 26.89, incr_roi_pct: 13.65 },
      },
    },
    TENNIS_P50_52: {
      status: "STRONG_HIGH_QUALITY_SATELLITE_SPARSE_SUPPLY",
      label: "TENNIS_P50_52",
      mainRules: "0.50 <= entry_price < 0.52, sportFamily = tennis",
      sportMixNote: "100% tennis by construction -- see mainRules.",
      fill: { fill30: 0.2083, fill40: null, fill50: 0.1458 },
      augSep: { aug: null, sep: null },
      caps: {
        15: { selected_n: 230, pnl_u: 171.98, roi_pct: 74.77, maxdd_u: -4.0, proj30d_u: 107.49 },
        20: { selected_n: 295, pnl_u: 218.96, roi_pct: 74.22, maxdd_u: -5.0, proj30d_u: 136.85 },
        30: { selected_n: 405, pnl_u: 290.96, roi_pct: 71.84, maxdd_u: -6.02, proj30d_u: 181.85 },
        40: { selected_n: 499, pnl_u: 336.96, roi_pct: 67.53, maxdd_u: -10.02, proj30d_u: 210.6 },
        50: { selected_n: 586, pnl_u: 365.96, roi_pct: 62.45, maxdd_u: -10.02, proj30d_u: 228.73 },
      },
      marginal: {
        "1_15": { incr_n: 230, incr_pnl_u: 171.98, incr_roi_pct: 74.77 },
        "16_20": { incr_n: 65, incr_pnl_u: 46.98, incr_roi_pct: 72.28 },
        "21_30": { incr_n: 110, incr_pnl_u: 72.0, incr_roi_pct: 65.45 },
        "31_40": { incr_n: 94, incr_pnl_u: 46.0, incr_roi_pct: 48.94 },
        "41_50": { incr_n: 87, incr_pnl_u: 29.0, incr_roi_pct: 33.33 },
      },
    },
  },

  // PLOT 4 (signal score): accepted evidence is status-only (closed hypotheses),
  // no accepted score-bucket P&L / score x price heatmap aggregate exists in the
  // Sep21 evidence set read for this freeze. Never recomputed from raw rows
  // (RAW_ROW_BUDGET=0, NO NEW CALCULATION SEARCH). Buckets kept as labels only.
  signalScore: {
    dataAvailable: false,
    note: "DATA_NOT_AVAILABLE_IN_ACCEPTED_AGGREGATE_EVIDENCE -- signal score is useful ranking context (NON-MONOTONIC, not a universal hard gate); hard score >= 65 is a NO_GO gate. No accepted score-bucket P&L or score x price heatmap artifact exists to render without a new calculation, which this mission may not run.",
    buckets: ["50-59", "60-62", "63-64", "65-67", ">=68"],
  },

  closedHypotheses: [
    { rule: "hard score >= 65", status: "NO_GO" },
    { rule: "sub-0.50 entry price", status: "NO_GO" },
    { rule: "legacy BAD_BUCKET hard reject", status: "NO_GO" },
    { rule: "C4 non-Soccer lead >= 24", status: "NO_GO" },
    { rule: "volume", status: "NOT_ACTIONABLE_CURRENT_COVERAGE" },
    { rule: "dynamic score trajectory", status: "DATA_NOT_AVAILABLE" },
    { rule: "Exact Score", status: "SMALL_SAMPLE" },
    { rule: "First-to-score", status: "SMALL_SAMPLE" },
  ],

  // PLOT 6 -- grows via the incremental refresh command. Empty at Sep21 freeze:
  // the frozen Aug04-Sep20 evidence above is a period aggregate, not a per-day
  // series, so no per-day point is fabricated to seed it (RAW_ROW_BUDGET=0).
  // `npm run research-clone:modeling-dashboard-refresh` appends one entry per
  // newly closed MODEL_READY day, per tracked model, per cap (30/40/50).
  // Each entry: { date, model, cap30: {n, pnl_u}, cap40: {n, pnl_u}, cap50: {n, pnl_u} }
  daily: [],
};
