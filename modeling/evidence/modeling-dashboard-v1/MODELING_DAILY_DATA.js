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
 *   modeling/evidence/unified-core-scoreboard-v1/CANONICAL_DECISION_AUTHORITY_2026-08-04_2026-09-20.md
 *     (uncapped founder table, gate economics, market-type economics; PORTFOLIO_BROAD's
 *     LIVE reference status, and the diagnostic/reference-only models that were never
 *     run through the daily-cap engine: C0_ONLY_NOT_C1, SCORE63_64, C1, C4_CURRENT,
 *     TENNIS_LEAD18_24, LEGACY_C4_HISTORICAL, QUALITY_FILL_B, QUALITY_FILL_D-ref)
 *   modeling/evidence/unified-core-scoreboard-v1/BROAD_ANATOMY_anatomy_2026-08-04_2026-09-20.md
 *     (score-bucket / score x price / score x sport / price x sport economics)
 * `null` marks a cell that has no accepted aggregate figure in those artifacts
 * (never fabricated / never recomputed from raw rows to fill a gap). Models that
 * were only ever evaluated UNCAPPED (no daily-cap-engine run in accepted evidence)
 * carry an `uncapped` block instead of `caps`/`marginal`/`fill` -- never backfilled
 * with a fabricated capped number.
 */
window.POLYPROPICKS_MODELING_DATA = {
  "ARTIFACT": "MODELING_DAILY_DATA_V1",
  "GENERATED_AT": "2026-09-25T14:03:57.456Z",
  "meta": {
    "frozenPeriodStart": "2026-08-04",
    "frozenPeriodEnd": "2026-09-20",
    "closedDays": 48,
    "modelReadyRows": 68949,
    "processedPhysicalEvents": 7985,
    "preferredModel": "QUALITY_FILL_A",
    "fillReferenceModel": "QUALITY_FILL_D",
    "livePolicyModel": "PORTFOLIO_BROAD",
    "latestDashboardDate": "2026-09-24",
    "provenance": {
      "source": "PREMVP-DB-CLONE / research_model_ready_days / research_model_ready_rows",
      "liveSource": "Production runtime (read-only): night_event_reservations / event_execution_queue / executor_order_events; settlement from bet_execution_ledger or an existing executor live net view when authoritative evidence is populated there",
      "economics": "Flat 1u backtest research projection only -- not realized live cash P&L",
      "productionWrites": 0,
      "volumeSource": "PR #367 evidence, read-only provenance -- NOT_ACTIONABLE_CURRENT_COVERAGE",
      "sep21FreezeCommitPr": "#368",
      "refreshCommand": "npm run research-clone:modeling-dashboard-refresh",
      "liveRefreshCommand": "npm run research-live:modeling-dashboard-refresh",
      "combinedRefreshCommand": "npm run modeling-dashboard:refresh"
    }
  },
  "models": {
    "QUALITY_FILL_A": {
      "status": "PREFERRED_RESEARCH_PORTFOLIO",
      "label": "QUALITY_FILL_A",
      "mainRules": "1. Tennis P50_52  2. Soccer P50_54  3. remaining P50_52 (all sports)",
      "sportMixNote": "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence within this bounded freeze; not recomputed (RAW_ROW_BUDGET=0).",
      "fill": {
        "fill30": 0.5,
        "fill40": 0.375,
        "fill50": 0.3125
      },
      "augSep": {
        "aug": {
          "n": 627,
          "pnl_u": 68.21,
          "roi_pct": 10.88
        },
        "sep": {
          "n": 755,
          "pnl_u": 334.05,
          "roi_pct": 44.24
        }
      },
      "caps": {
        "15": null,
        "20": null,
        "30": {
          "selected_n": 1026,
          "pnl_u": 297.8,
          "roi_pct": 29.03,
          "maxdd_u": -30.6,
          "proj30d_u": 186.13
        },
        "40": {
          "selected_n": 1222,
          "pnl_u": 358.92,
          "roi_pct": 29.37,
          "maxdd_u": -33.62,
          "proj30d_u": 224.33
        },
        "50": {
          "selected_n": 1382,
          "pnl_u": 402.25,
          "roi_pct": 29.11,
          "maxdd_u": -28.62,
          "proj30d_u": 251.41
        }
      },
      "marginal": {
        "1_15": null,
        "16_20": null,
        "21_30": {
          "incr_n": 272,
          "incr_pnl_u": 80.22,
          "incr_roi_pct": 29.49
        },
        "31_40": {
          "incr_n": 196,
          "incr_pnl_u": 61.12,
          "incr_roi_pct": 31.18
        },
        "41_50": {
          "incr_n": 160,
          "incr_pnl_u": 43.33,
          "incr_roi_pct": 27.08
        }
      }
    },
    "QUALITY_FILL_D": {
      "status": "FILL_REFERENCE",
      "label": "QUALITY_FILL_D",
      "mainRules": "QUALITY_FILL_A + Soccer P54_60 as LAST fallback tier",
      "sportMixNote": "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence within this bounded freeze; not recomputed (RAW_ROW_BUDGET=0).",
      "fill": {
        "fill30": 0.5833,
        "fill40": 0.3958,
        "fill50": 0.3333
      },
      "augSep": {
        "aug": {
          "n": 637,
          "pnl_u": 72.33,
          "roi_pct": 11.36
        },
        "sep": {
          "n": 828,
          "pnl_u": 326.42,
          "roi_pct": 39.42
        }
      },
      "caps": {
        "15": null,
        "20": null,
        "30": {
          "selected_n": 1076,
          "pnl_u": 293.89,
          "roi_pct": 27.31,
          "maxdd_u": -30.6,
          "proj30d_u": 183.68
        },
        "40": {
          "selected_n": 1296,
          "pnl_u": 355.69,
          "roi_pct": 27.45,
          "maxdd_u": -33.62,
          "proj30d_u": 222.31
        },
        "50": {
          "selected_n": 1465,
          "pnl_u": 398.76,
          "roi_pct": 27.22,
          "maxdd_u": -32.28,
          "proj30d_u": 249.22
        }
      },
      "marginal": {
        "1_15": null,
        "16_20": null,
        "21_30": {
          "incr_n": 310,
          "incr_pnl_u": 79.4,
          "incr_roi_pct": 25.61
        },
        "31_40": {
          "incr_n": 220,
          "incr_pnl_u": 61.8,
          "incr_roi_pct": 28.09
        },
        "41_50": {
          "incr_n": 169,
          "incr_pnl_u": 43.07,
          "incr_roi_pct": 25.49
        }
      }
    },
    "QUALITY_FILL_B": {
      "status": "REFERENCE_QUALITY_FILL_VARIANT",
      "label": "QUALITY_FILL_B",
      "mainRules": "Tennis P50_52 -> Soccer P50_54 -> non-Esports remaining P50_52 -> Esports P50_52 (last)",
      "sportMixNote": "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence; not recomputed (RAW_ROW_BUDGET=0).",
      "fill": {
        "fill30": 0.5,
        "fill40": 0.375,
        "fill50": 0.3125
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": null,
        "20": null,
        "30": {
          "selected_n": 1026,
          "pnl_u": 307.9,
          "roi_pct": 30.01,
          "maxdd_u": -24.35,
          "proj30d_u": 192.44
        },
        "40": {
          "selected_n": 1222,
          "pnl_u": 368.96,
          "roi_pct": 30.19,
          "maxdd_u": -27.6,
          "proj30d_u": 230.6
        },
        "50": {
          "selected_n": 1382,
          "pnl_u": 400.25,
          "roi_pct": 28.96,
          "maxdd_u": -30.62,
          "proj30d_u": 250.16
        }
      },
      "marginal": {
        "1_15": null,
        "16_20": null,
        "21_30": {
          "incr_n": 272,
          "incr_pnl_u": 88.16,
          "incr_roi_pct": 32.41
        },
        "31_40": {
          "incr_n": 196,
          "incr_pnl_u": 61.06,
          "incr_roi_pct": 31.15
        },
        "41_50": {
          "incr_n": 160,
          "incr_pnl_u": 31.29,
          "incr_roi_pct": 19.56
        }
      }
    },
    "QUALITY_FILL_C": {
      "status": "REFERENCE_QUALITY_FILL_VARIANT",
      "label": "QUALITY_FILL_C",
      "mainRules": "Tennis P50_52 -> Soccer P50_54 -> non-Esports remaining P50_52 -> Esports P50_52 -> Soccer P54_60 (last)",
      "sportMixNote": "Tier composition only (see mainRules) -- per-event sport-mix aggregate not in accepted evidence; not recomputed (RAW_ROW_BUDGET=0).",
      "fill": {
        "fill30": 0.5833,
        "fill40": 0.3958,
        "fill50": 0.3333
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": null,
        "20": null,
        "30": {
          "selected_n": 1076,
          "pnl_u": 303.99,
          "roi_pct": 28.25,
          "maxdd_u": -25.01,
          "proj30d_u": 189.99
        },
        "40": {
          "selected_n": 1296,
          "pnl_u": 365.73,
          "roi_pct": 28.22,
          "maxdd_u": -27.6,
          "proj30d_u": 228.58
        },
        "50": {
          "selected_n": 1465,
          "pnl_u": 396.76,
          "roi_pct": 27.08,
          "maxdd_u": -32.28,
          "proj30d_u": 247.97
        }
      },
      "marginal": {
        "1_15": null,
        "16_20": null,
        "21_30": {
          "incr_n": 310,
          "incr_pnl_u": 87.35,
          "incr_roi_pct": 28.18
        },
        "31_40": {
          "incr_n": 220,
          "incr_pnl_u": 61.74,
          "incr_roi_pct": 28.06
        },
        "41_50": {
          "incr_n": 169,
          "incr_pnl_u": 31.03,
          "incr_roi_pct": 18.36
        }
      }
    },
    "P50_52": {
      "status": "STRONG_SIMPLE_BASELINE",
      "label": "P50_52",
      "mainRules": "0.50 <= entry_price < 0.52, all sports",
      "sportMixNote": "tennis 45.8%, soccer 22.2% of selected bets (uncapped, CANONICAL_DECISION_AUTHORITY founder table).",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 2983,
        "bet_pct": 37.4,
        "roi_pct": 19.06,
        "pnl_u": 568.57,
        "maxdd_u": -31.04
      },
      "fill": {
        "fill30": 0.4792,
        "fill40": 0.3542,
        "fill50": 0.2917
      },
      "augSep": {
        "aug": {
          "n": 621,
          "pnl_u": 72.69,
          "roi_pct": 11.7
        },
        "sep": {
          "n": 722,
          "pnl_u": 306.62,
          "roi_pct": 42.47
        }
      },
      "caps": {
        "15": {
          "selected_n": 567,
          "pnl_u": 134.18,
          "roi_pct": 23.67,
          "maxdd_u": -19.41,
          "proj30d_u": 83.86
        },
        "20": {
          "selected_n": 731,
          "pnl_u": 189.49,
          "roi_pct": 25.92,
          "maxdd_u": -20.59,
          "proj30d_u": 118.43
        },
        "30": {
          "selected_n": 996,
          "pnl_u": 267.35,
          "roi_pct": 26.84,
          "maxdd_u": -31.02,
          "proj30d_u": 167.09
        },
        "40": {
          "selected_n": 1192,
          "pnl_u": 332.64,
          "roi_pct": 27.91,
          "maxdd_u": -35.1,
          "proj30d_u": 207.9
        },
        "50": {
          "selected_n": 1343,
          "pnl_u": 379.3,
          "roi_pct": 28.24,
          "maxdd_u": -29.04,
          "proj30d_u": 237.06
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 567,
          "incr_pnl_u": 134.18,
          "incr_roi_pct": 23.66
        },
        "16_20": {
          "incr_n": 164,
          "incr_pnl_u": 55.31,
          "incr_roi_pct": 33.73
        },
        "21_30": {
          "incr_n": 265,
          "incr_pnl_u": 77.86,
          "incr_roi_pct": 29.38
        },
        "31_40": {
          "incr_n": 196,
          "incr_pnl_u": 65.29,
          "incr_roi_pct": 33.31
        },
        "41_50": {
          "incr_n": 151,
          "incr_pnl_u": 46.66,
          "incr_roi_pct": 30.9
        }
      }
    },
    "PORTFOLIO_BROAD": {
      "status": "CURRENT_LIVE_POLICY_REFERENCE",
      "isLivePolicy": true,
      "label": "PORTFOLIO_BROAD",
      "mainRules": "tier1 Tennis/Score63-64 P50_52 -> tier2 P50_52 all sports -> tier3 P52_54 all sports",
      "sportMixNote": "tennis 42.7%, soccer 24.8% of selected bets (uncapped, CANONICAL_DECISION_AUTHORITY founder table).",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 3229,
        "bet_pct": 40.4,
        "roi_pct": 18.74,
        "pnl_u": 605.23,
        "maxdd_u": -37.32
      },
      "fill": {
        "fill30": 0.5625,
        "fill40": 0.375,
        "fill50": 0.3333
      },
      "augSep": {
        "aug": {
          "n": 688,
          "pnl_u": 66.18,
          "roi_pct": 9.62
        },
        "sep": {
          "n": 766,
          "pnl_u": 308.7,
          "roi_pct": 40.3
        }
      },
      "caps": {
        "15": {
          "selected_n": 593,
          "pnl_u": 150.72,
          "roi_pct": 25.42,
          "maxdd_u": -14.91,
          "proj30d_u": 94.2
        },
        "20": {
          "selected_n": 769,
          "pnl_u": 195.47,
          "roi_pct": 25.42,
          "maxdd_u": -20.51,
          "proj30d_u": 122.17
        },
        "30": {
          "selected_n": 1068,
          "pnl_u": 271.93,
          "roi_pct": 25.46,
          "maxdd_u": -36.79,
          "proj30d_u": 169.96
        },
        "40": {
          "selected_n": 1285,
          "pnl_u": 325.27,
          "roi_pct": 25.31,
          "maxdd_u": -38.47,
          "proj30d_u": 203.3
        },
        "50": {
          "selected_n": 1454,
          "pnl_u": 374.88,
          "roi_pct": 25.78,
          "maxdd_u": -31.87,
          "proj30d_u": 234.3
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 593,
          "incr_pnl_u": 150.72,
          "incr_roi_pct": 25.42
        },
        "16_20": {
          "incr_n": 176,
          "incr_pnl_u": 44.75,
          "incr_roi_pct": 25.43
        },
        "21_30": {
          "incr_n": 299,
          "incr_pnl_u": 76.46,
          "incr_roi_pct": 25.57
        },
        "31_40": {
          "incr_n": 217,
          "incr_pnl_u": 53.34,
          "incr_roi_pct": 24.58
        },
        "41_50": {
          "incr_n": 169,
          "incr_pnl_u": 49.61,
          "incr_roi_pct": 29.36
        }
      }
    },
    "P50_54": {
      "status": "STRONG_RESEARCH_BASELINE",
      "label": "P50_54",
      "mainRules": "0.50 <= entry_price < 0.54, all sports",
      "sportMixNote": "tennis 42.7%, soccer 24.7% of selected bets (uncapped, CANONICAL_DECISION_AUTHORITY founder table).",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 3229,
        "bet_pct": 40.4,
        "roi_pct": 18.9,
        "pnl_u": 610.13,
        "maxdd_u": -38.31
      },
      "fill": {
        "fill30": 0.5625,
        "fill40": null,
        "fill50": 0.3125
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": {
          "selected_n": 594,
          "pnl_u": 124.18,
          "roi_pct": 20.91,
          "maxdd_u": -24.22,
          "proj30d_u": 77.61
        },
        "20": {
          "selected_n": 770,
          "pnl_u": 190.4,
          "roi_pct": 24.73,
          "maxdd_u": -22.24,
          "proj30d_u": 119
        },
        "30": {
          "selected_n": 1065,
          "pnl_u": 257.52,
          "roi_pct": 24.18,
          "maxdd_u": -34.85,
          "proj30d_u": 160.95
        },
        "40": {
          "selected_n": 1281,
          "pnl_u": 321.79,
          "roi_pct": 25.12,
          "maxdd_u": -42.19,
          "proj30d_u": 201.12
        },
        "50": {
          "selected_n": 1448,
          "pnl_u": 359.45,
          "roi_pct": 24.82,
          "maxdd_u": -36.96,
          "proj30d_u": 224.66
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 594,
          "incr_pnl_u": 124.18,
          "incr_roi_pct": 20.91
        },
        "16_20": {
          "incr_n": 176,
          "incr_pnl_u": 66.22,
          "incr_roi_pct": 37.63
        },
        "21_30": {
          "incr_n": 295,
          "incr_pnl_u": 67.12,
          "incr_roi_pct": 22.75
        },
        "31_40": {
          "incr_n": 216,
          "incr_pnl_u": 64.27,
          "incr_roi_pct": 29.75
        },
        "41_50": {
          "incr_n": 167,
          "incr_pnl_u": 37.66,
          "incr_roi_pct": 22.55
        }
      }
    },
    "C5": {
      "status": "TRACKED_REFERENCE_PRICE_ANCHOR_BAND",
      "label": "C5",
      "mainRules": "Frozen C5 price-anchor definition (lib/modeling/research-engine/models.ts)",
      "sportMixNote": "tennis 38.6%, soccer 28.7% of selected bets (uncapped, CANONICAL_DECISION_AUTHORITY founder table).",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 3653,
        "bet_pct": 45.8,
        "roi_pct": 16.55,
        "pnl_u": 604.52,
        "maxdd_u": -38.96
      },
      "fill": {
        "fill30": 0.6667,
        "fill40": null,
        "fill50": 0.375
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": {
          "selected_n": 628,
          "pnl_u": 141.82,
          "roi_pct": 22.58,
          "maxdd_u": -17.06,
          "proj30d_u": 88.64
        },
        "20": {
          "selected_n": 809,
          "pnl_u": 193.69,
          "roi_pct": 23.94,
          "maxdd_u": -21.83,
          "proj30d_u": 121.06
        },
        "30": {
          "selected_n": 1142,
          "pnl_u": 263.7,
          "roi_pct": 23.09,
          "maxdd_u": -22.64,
          "proj30d_u": 164.81
        },
        "40": {
          "selected_n": 1427,
          "pnl_u": 305.57,
          "roi_pct": 21.41,
          "maxdd_u": -33.85,
          "proj30d_u": 190.98
        },
        "50": {
          "selected_n": 1618,
          "pnl_u": 334.56,
          "roi_pct": 20.68,
          "maxdd_u": -39.86,
          "proj30d_u": 209.1
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 628,
          "incr_pnl_u": 141.82,
          "incr_roi_pct": 22.58
        },
        "16_20": {
          "incr_n": 181,
          "incr_pnl_u": 51.87,
          "incr_roi_pct": 28.66
        },
        "21_30": {
          "incr_n": 333,
          "incr_pnl_u": 70.01,
          "incr_roi_pct": 21.02
        },
        "31_40": {
          "incr_n": 285,
          "incr_pnl_u": 41.87,
          "incr_roi_pct": 14.69
        },
        "41_50": {
          "incr_n": 191,
          "incr_pnl_u": 28.99,
          "incr_roi_pct": 15.18
        }
      }
    },
    "C0": {
      "status": "TRACKED_REFERENCE_PRICE_ANCHOR_BAND",
      "label": "C0",
      "mainRules": "0.50 <= entry_price < 0.60, all sports",
      "sportMixNote": "tennis 38%, soccer 28.3% of selected bets (uncapped, CANONICAL_DECISION_AUTHORITY founder table).",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 3713,
        "bet_pct": 46.5,
        "roi_pct": 16.23,
        "pnl_u": 602.52,
        "maxdd_u": -42.96
      },
      "fill": {
        "fill30": 0.6875,
        "fill40": null,
        "fill50": 0.375
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": {
          "selected_n": 628,
          "pnl_u": 141.82,
          "roi_pct": 22.58,
          "maxdd_u": -17.06,
          "proj30d_u": 88.64
        },
        "20": {
          "selected_n": 809,
          "pnl_u": 193.69,
          "roi_pct": 23.94,
          "maxdd_u": -21.83,
          "proj30d_u": 121.06
        },
        "30": {
          "selected_n": 1149,
          "pnl_u": 260.7,
          "roi_pct": 22.69,
          "maxdd_u": -23.64,
          "proj30d_u": 162.94
        },
        "40": {
          "selected_n": 1451,
          "pnl_u": 299.86,
          "roi_pct": 20.67,
          "maxdd_u": -36.85,
          "proj30d_u": 187.41
        },
        "50": {
          "selected_n": 1648,
          "pnl_u": 326.75,
          "roi_pct": 19.83,
          "maxdd_u": -46.86,
          "proj30d_u": 204.22
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 628,
          "incr_pnl_u": 141.82,
          "incr_roi_pct": 22.58
        },
        "16_20": {
          "incr_n": 181,
          "incr_pnl_u": 51.87,
          "incr_roi_pct": 28.66
        },
        "21_30": {
          "incr_n": 340,
          "incr_pnl_u": 67.01,
          "incr_roi_pct": 19.71
        },
        "31_40": {
          "incr_n": 302,
          "incr_pnl_u": 39.16,
          "incr_roi_pct": 12.97
        },
        "41_50": {
          "incr_n": 197,
          "incr_pnl_u": 26.89,
          "incr_roi_pct": 13.65
        }
      }
    },
    "TENNIS_P50_52": {
      "status": "STRONG_HIGH_QUALITY_SATELLITE_SPARSE_SUPPLY",
      "label": "TENNIS_P50_52",
      "mainRules": "0.50 <= entry_price < 0.52, sportFamily = tennis",
      "sportMixNote": "100% tennis by construction -- see mainRules.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 1365,
        "bet_pct": 17.1,
        "roi_pct": 35.07,
        "pnl_u": 478.77,
        "maxdd_u": -16
      },
      "fill": {
        "fill30": 0.2083,
        "fill40": null,
        "fill50": 0.1458
      },
      "augSep": {
        "aug": null,
        "sep": null
      },
      "caps": {
        "15": {
          "selected_n": 230,
          "pnl_u": 171.98,
          "roi_pct": 74.77,
          "maxdd_u": -4,
          "proj30d_u": 107.49
        },
        "20": {
          "selected_n": 295,
          "pnl_u": 218.96,
          "roi_pct": 74.22,
          "maxdd_u": -5,
          "proj30d_u": 136.85
        },
        "30": {
          "selected_n": 405,
          "pnl_u": 290.96,
          "roi_pct": 71.84,
          "maxdd_u": -6.02,
          "proj30d_u": 181.85
        },
        "40": {
          "selected_n": 499,
          "pnl_u": 336.96,
          "roi_pct": 67.53,
          "maxdd_u": -10.02,
          "proj30d_u": 210.6
        },
        "50": {
          "selected_n": 586,
          "pnl_u": 365.96,
          "roi_pct": 62.45,
          "maxdd_u": -10.02,
          "proj30d_u": 228.73
        }
      },
      "marginal": {
        "1_15": {
          "incr_n": 230,
          "incr_pnl_u": 171.98,
          "incr_roi_pct": 74.77
        },
        "16_20": {
          "incr_n": 65,
          "incr_pnl_u": 46.98,
          "incr_roi_pct": 72.28
        },
        "21_30": {
          "incr_n": 110,
          "incr_pnl_u": 72,
          "incr_roi_pct": 65.45
        },
        "31_40": {
          "incr_n": 94,
          "incr_pnl_u": 46,
          "incr_roi_pct": 48.94
        },
        "41_50": {
          "incr_n": 87,
          "incr_pnl_u": 29,
          "incr_roi_pct": 33.33
        }
      }
    }
  },
  "uncappedModels": {
    "C0_ONLY_NOT_C1": {
      "status": "REFERENCE_DIAGNOSTIC",
      "label": "C0_ONLY_NOT_C1",
      "mainRules": "C0 (0.50<=price<0.60) AND sport != soccer",
      "sportMixNote": "tennis 53%, esports 14.2% of selected bets.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 2664,
        "bet_pct": 33.4,
        "roi_pct": 17,
        "pnl_u": 452.82,
        "maxdd_u": -44.27
      }
    },
    "SCORE63_64": {
      "status": "REFERENCE_DIAGNOSTIC",
      "label": "SCORE63_64 overlay",
      "mainRules": "0.50<=price<0.60 AND score in [63,65)",
      "sportMixNote": "tennis 55.3%, soccer 26.1% of selected bets.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 2230,
        "bet_pct": 27.9,
        "roi_pct": 18.38,
        "pnl_u": 409.78,
        "maxdd_u": -24.33
      }
    },
    "C1": {
      "status": "REFERENCE_DIAGNOSTIC",
      "label": "C1",
      "mainRules": "0.50<=price<0.60 AND soccer",
      "sportMixNote": "soccer 100% by construction.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 1053,
        "bet_pct": 13.2,
        "roi_pct": 14.39,
        "pnl_u": 151.55,
        "maxdd_u": -27.65
      }
    },
    "C4_CURRENT": {
      "status": "REFERENCE_DIAGNOSTIC",
      "label": "C4 (current)",
      "mainRules": "0.50<=price<0.60 AND (soccer OR lead_time_hours >= 24)",
      "sportMixNote": "soccer 83.6%, esports 9.9% of selected bets.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 1255,
        "bet_pct": 15.7,
        "roi_pct": 9.63,
        "pnl_u": 120.81,
        "maxdd_u": -32.88
      }
    },
    "TENNIS_LEAD18_24": {
      "status": "SMALL_SAMPLE_DIAGNOSTIC",
      "label": "TENNIS_LEAD18-24 diagnostic",
      "mainRules": "diagnostic only, not a decision leader (tennis, lead_time_hours in [18,24))",
      "sportMixNote": "tennis 100% by construction.",
      "uncapped": {
        "processed_n": 7985,
        "bet_n": 245,
        "bet_pct": 3.1,
        "roi_pct": 58.03,
        "pnl_u": 142.17,
        "maxdd_u": -5.23
      }
    },
    "LEGACY_C4_HISTORICAL": {
      "status": "REFERENCE_ISOLATED_NOT_IN_AUG_SEP_DENOMINATOR",
      "label": "LEGACY_C4_HISTORICAL",
      "mainRules": "frozen golden-contract reference (Jun-Aug, separate dataset)",
      "sportMixNote": "not published in the Aug04-Sep20 accepted evidence.",
      "uncapped": {
        "processed_n": null,
        "bet_n": 4142,
        "bet_pct": null,
        "roi_pct": 11.85,
        "pnl_u": 490.71,
        "maxdd_u": -15.84,
        "wins": 2398,
        "losses": 1744,
        "datasetLabel": "Jun-Aug (isolated, NOT in Aug04-Sep20 denominator)"
      }
    }
  },
  "signalScore": {
    "dataAvailable": true,
    "note": "Score bucket / score x price / score x sport economics from accepted frozen Git evidence (BROAD_ANATOMY_anatomy_2026-08-04_2026-09-20.md, price band 0.50<=price<0.60). Score is useful ranking context, NON-MONOTONIC, not a universal hard gate. No new score calculation was run.",
    "buckets": [
      "50-59",
      "60-62",
      "63-64",
      "65-67",
      ">=68"
    ],
    "byBucket": [
      {
        "bucket": "50-59",
        "n": 66,
        "wins": 38,
        "losses": 28,
        "pnl_u": -1.85,
        "roi_pct": -2.8024,
        "maxdd_u": -7.96
      },
      {
        "bucket": "60-62",
        "n": 486,
        "wins": 303,
        "losses": 183,
        "pnl_u": 72.37,
        "roi_pct": 14.89,
        "maxdd_u": -9.43
      },
      {
        "bucket": "63-64",
        "n": 2230,
        "wins": 1329,
        "losses": 901,
        "pnl_u": 409.78,
        "roi_pct": 18.3759,
        "maxdd_u": -24.33
      },
      {
        "bucket": "65-67",
        "n": 348,
        "wins": 236,
        "losses": 112,
        "pnl_u": 106.21,
        "roi_pct": 30.521,
        "maxdd_u": -20.26
      },
      {
        "bucket": ">=68",
        "n": 216,
        "wins": 117,
        "losses": 99,
        "pnl_u": 4.71,
        "roi_pct": 2.1789,
        "maxdd_u": -11.3
      }
    ],
    "scoreByPrice": [
      {
        "score": "60-62",
        "price": ".52-.54",
        "n": 208,
        "pnl_u": 67.98,
        "roi_pct": 32.6824
      },
      {
        "score": "60-62",
        "price": ".54-.56",
        "n": 134,
        "pnl_u": 1.01,
        "roi_pct": 0.7558
      },
      {
        "score": "60-62",
        "price": ".56-.58",
        "n": 133,
        "pnl_u": 6.4,
        "roi_pct": 4.8113
      },
      {
        "score": "60-62",
        "price": ".58-.60",
        "n": 116,
        "pnl_u": 5.36,
        "roi_pct": 4.6217
      },
      {
        "score": "63-64",
        "price": ".50-.52",
        "n": 2131,
        "pnl_u": 407.58,
        "roi_pct": 19.1263
      },
      {
        "score": "65-67",
        "price": ".50-.52",
        "n": 212,
        "pnl_u": 97.19,
        "roi_pct": 45.8436
      }
    ],
    "scoreBySport": [
      {
        "score": "60-62",
        "sport": "soccer",
        "n": 239,
        "pnl_u": 55.94,
        "roi_pct": 23.406
      },
      {
        "score": "63-64",
        "sport": "tennis",
        "n": 1233,
        "pnl_u": 364.47,
        "roi_pct": 29.5592
      },
      {
        "score": "63-64",
        "sport": "soccer",
        "n": 583,
        "pnl_u": 60.78,
        "roi_pct": 10.4259
      },
      {
        "score": "63-64",
        "sport": "esports",
        "n": 110,
        "pnl_u": 7.71,
        "roi_pct": 7.0048
      },
      {
        "score": "65-67",
        "sport": "soccer",
        "n": 207,
        "pnl_u": 57.92,
        "roi_pct": 27.9816
      },
      {
        "score": "68+",
        "sport": "soccer",
        "n": 144,
        "pnl_u": 12.53,
        "roi_pct": 8.6988
      }
    ],
    "smallSampleExcluded": {
      "scoreByPrice": 19,
      "scoreBySport": 19,
      "priceBySport": 18
    }
  },
  "sports": {
    "note": "Price x sport economics from accepted frozen Git evidence (BROAD_ANATOMY_anatomy_2026-08-04_2026-09-20.md, price band 0.50<=price<0.60). MAIN cells only (N>=100); no new sport search was run.",
    "priceBySport": [
      {
        "price": ".50-.52",
        "sport": "tennis",
        "n": 1365,
        "wins": 922,
        "losses": 443,
        "pnl_u": 478.77,
        "roi_pct": 35.0744,
        "maxdd_u": -16,
        "highlight": true
      },
      {
        "price": ".50-.52",
        "sport": "soccer",
        "n": 665,
        "wins": 386,
        "losses": 279,
        "pnl_u": 100.11,
        "roi_pct": 15.0549,
        "maxdd_u": -18.76,
        "highlight": true
      },
      {
        "price": ".50-.52",
        "sport": "esports",
        "n": 288,
        "wins": 141,
        "losses": 147,
        "pnl_u": -7.15,
        "roi_pct": -2.484,
        "maxdd_u": -26.76,
        "highlight": true
      },
      {
        "price": ".52-.54",
        "sport": "soccer",
        "n": 208,
        "wins": 143,
        "losses": 65,
        "pnl_u": 63.64,
        "roi_pct": 30.5968,
        "maxdd_u": -4.77,
        "highlight": true
      },
      {
        "price": ".54-.56",
        "sport": "soccer",
        "n": 150,
        "wins": 90,
        "losses": 60,
        "pnl_u": 14.54,
        "roi_pct": 9.6952,
        "maxdd_u": -5.06
      },
      {
        "price": ".56-.58",
        "sport": "soccer",
        "n": 157,
        "wins": 92,
        "losses": 65,
        "pnl_u": 5.08,
        "roi_pct": 3.2375,
        "maxdd_u": -10.56
      },
      {
        "price": ".58-.60",
        "sport": "soccer",
        "n": 127,
        "wins": 80,
        "losses": 47,
        "pnl_u": 8.92,
        "roi_pct": 7.024,
        "maxdd_u": -8.27
      }
    ]
  },
  "marketTypes": {
    "attributionCoverageN": 2193,
    "attributionCoverageDenominator": 7985,
    "note": "marketTypeRaw is read directly off canonical_row (direct materializer row construction). ATTRIBUTION_LIMITED: 2,193 / 7,985 processed physical events carry a resolvable marketTypeRaw -- this section does NOT explain the full processed population.",
    "rows": [
      {
        "marketType": "moneyline",
        "status": "RESEARCH",
        "n": 1341,
        "pnl_u": -18.97,
        "roi_pct": -1.41,
        "maxdd_u": -41.05,
        "aug": {
          "n": 747,
          "pnl_u": -22.93
        },
        "sep": {
          "n": 594,
          "pnl_u": 3.96
        }
      },
      {
        "marketType": "totals",
        "status": "RESEARCH",
        "n": 565,
        "pnl_u": -6.72,
        "roi_pct": -1.19,
        "maxdd_u": -47.11,
        "aug": {
          "n": 185,
          "pnl_u": 19.57
        },
        "sep": {
          "n": 380,
          "pnl_u": -26.3
        }
      },
      {
        "marketType": "spreads",
        "status": "RESEARCH",
        "n": 368,
        "pnl_u": -59.66,
        "roi_pct": -16.21,
        "maxdd_u": -74.9,
        "aug": {
          "n": 34,
          "pnl_u": -3.5
        },
        "sep": {
          "n": 334,
          "pnl_u": -56.16
        }
      },
      {
        "marketType": "child_moneyline",
        "status": "RESEARCH",
        "n": 302,
        "pnl_u": -26.18,
        "roi_pct": -8.67,
        "maxdd_u": -26.25,
        "aug": {
          "n": 294,
          "pnl_u": -20.31
        },
        "sep": {
          "n": 8,
          "pnl_u": -5.87
        }
      },
      {
        "marketType": "tennis_completed_match",
        "status": "RESEARCH",
        "n": 202,
        "pnl_u": 42.08,
        "roi_pct": 20.83,
        "maxdd_u": -7,
        "aug": {
          "n": 121,
          "pnl_u": 7.04
        },
        "sep": {
          "n": 81,
          "pnl_u": 35.04
        }
      },
      {
        "marketType": "total_corners",
        "status": "RESEARCH",
        "n": 120,
        "pnl_u": 11.99,
        "roi_pct": 9.99,
        "maxdd_u": -10.18,
        "aug": {
          "n": 13,
          "pnl_u": -1.63
        },
        "sep": {
          "n": 107,
          "pnl_u": 13.62
        }
      }
    ],
    "smallSampleExcluded": [
      {
        "marketType": "soccer_exact_score",
        "n": 32,
        "pnl_u": 44.64
      },
      {
        "marketType": "soccer_first_to_score",
        "n": 26,
        "pnl_u": 13.35
      }
    ]
  },
  "dataQuality": [
    {
      "item": "marketTypeRaw coverage",
      "value": "2,193 / 7,985",
      "status": "ATTRIBUTION_LIMITED"
    },
    {
      "item": "volume",
      "value": "~14% overall observed; August much thinner than September",
      "status": "NOT_ACTIONABLE_CURRENT_COVERAGE"
    },
    {
      "item": "BAD_BUCKET legacy hard-reject",
      "value": "removed events 100% in September (0 in August) in both C0/Broad cuts -- flagged August join-completeness caveat, not resolved",
      "status": "NO_GO_AS_HARD_REJECT"
    },
    {
      "item": "dynamic score trajectory",
      "value": null,
      "status": "DATA_NOT_AVAILABLE"
    },
    {
      "item": "Exact Score",
      "value": "N=32, +44.64u (diagnostic)",
      "status": "SMALL_SAMPLE"
    },
    {
      "item": "First-to-score",
      "value": "N=26, +13.35u (diagnostic)",
      "status": "SMALL_SAMPLE"
    },
    {
      "item": "live settled P&L",
      "value": null,
      "status": "PENDING_WHEN_NO_AUTHORITATIVE_SETTLEMENT_EXISTS"
    }
  ],
  "liveVsResearch": {
    "liveModel": "PORTFOLIO_BROAD",
    "researchModel": "QUALITY_FILL_A",
    "cap": 50,
    "delta": {
      "pnl_u": 27.37,
      "roi_pct_points": 3.33,
      "maxdd_u_better": 3.25,
      "proj30d_u": 17.11,
      "fill30_pct_points": -6.25,
      "fill50_pct_points": -2.08
    },
    "interpretation": "Broad currently trades somewhat higher fill availability for lower frozen research P&L/ROI. QUALITY_FILL_A is NOT promoted to production by this dashboard."
  },
  "gapAnatomy": {
    "label": "SHADOW RESEARCH DIFFERENCE",
    "note": "Structural rule differences only -- not a production action or recommendation.",
    "liveBroadRules": [
      "tier1: Tennis OR Score63-64 @ P50_52",
      "tier2: P50_52 (all sports)",
      "tier3: P52_54 (all sports)"
    ],
    "qualityFillARules": [
      "tier1: Tennis P50_52",
      "tier2: Soccer P50_54",
      "tier3: remaining P50_52 (all sports)"
    ],
    "differences": [
      "QUALITY_FILL_A removes score63-64 as a universal priority mechanism.",
      "QUALITY_FILL_A gives selective widening to Soccer through .54, instead of Broad's blanket P52_54 tier across all sports.",
      "QUALITY_FILL_A does not blanket-prioritize all P52_54 events.",
      "Broad produces somewhat more fill (Fill30 56.25% vs 50.00%, Fill50 33.33% vs 31.25%), but lower frozen cap50 P&L (+374.88u vs +402.25u)."
    ]
  },
  "closedHypotheses": [
    {
      "rule": "hard score >= 65",
      "status": "NO_GO"
    },
    {
      "rule": "sub-0.50 entry price",
      "status": "NO_GO"
    },
    {
      "rule": "legacy BAD_BUCKET hard reject",
      "status": "NO_GO"
    },
    {
      "rule": "C4 non-Soccer lead >= 24",
      "status": "NO_GO"
    },
    {
      "rule": "volume",
      "status": "NOT_ACTIONABLE_CURRENT_COVERAGE"
    },
    {
      "rule": "dynamic score trajectory",
      "status": "DATA_NOT_AVAILABLE"
    },
    {
      "rule": "Exact Score",
      "status": "SMALL_SAMPLE"
    },
    {
      "rule": "First-to-score",
      "status": "SMALL_SAMPLE"
    }
  ],
  "daily": [
    {
      "date": "2026-09-21",
      "model": "QUALITY_FILL_A",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-21",
      "model": "QUALITY_FILL_D",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-21",
      "model": "P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 25.94
      },
      "cap40": {
        "n": 40,
        "pnl_u": 31.94
      },
      "cap50": {
        "n": 50,
        "pnl_u": 39.94
      }
    },
    {
      "date": "2026-09-21",
      "model": "PORTFOLIO_BROAD",
      "cap30": {
        "n": 30,
        "pnl_u": 28
      },
      "cap40": {
        "n": 40,
        "pnl_u": 34
      },
      "cap50": {
        "n": 50,
        "pnl_u": 42
      }
    },
    {
      "date": "2026-09-21",
      "model": "P50_54",
      "cap30": {
        "n": 30,
        "pnl_u": 23.72
      },
      "cap40": {
        "n": 40,
        "pnl_u": 31.72
      },
      "cap50": {
        "n": 50,
        "pnl_u": 37.72
      }
    },
    {
      "date": "2026-09-21",
      "model": "C5",
      "cap30": {
        "n": 30,
        "pnl_u": 20.21
      },
      "cap40": {
        "n": 40,
        "pnl_u": 28.21
      },
      "cap50": {
        "n": 50,
        "pnl_u": 36.21
      }
    },
    {
      "date": "2026-09-21",
      "model": "C0",
      "cap30": {
        "n": 30,
        "pnl_u": 20.21
      },
      "cap40": {
        "n": 40,
        "pnl_u": 28.21
      },
      "cap50": {
        "n": 50,
        "pnl_u": 36.21
      }
    },
    {
      "date": "2026-09-21",
      "model": "TENNIS_P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-22",
      "model": "QUALITY_FILL_A",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 48
      }
    },
    {
      "date": "2026-09-22",
      "model": "QUALITY_FILL_D",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 48
      }
    },
    {
      "date": "2026-09-22",
      "model": "P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 48
      }
    },
    {
      "date": "2026-09-22",
      "model": "PORTFOLIO_BROAD",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 48
      }
    },
    {
      "date": "2026-09-22",
      "model": "P50_54",
      "cap30": {
        "n": 30,
        "pnl_u": 28
      },
      "cap40": {
        "n": 40,
        "pnl_u": 36
      },
      "cap50": {
        "n": 50,
        "pnl_u": 45.89
      }
    },
    {
      "date": "2026-09-22",
      "model": "C5",
      "cap30": {
        "n": 30,
        "pnl_u": 26
      },
      "cap40": {
        "n": 40,
        "pnl_u": 34
      },
      "cap50": {
        "n": 50,
        "pnl_u": 43.89
      }
    },
    {
      "date": "2026-09-22",
      "model": "C0",
      "cap30": {
        "n": 30,
        "pnl_u": 26
      },
      "cap40": {
        "n": 40,
        "pnl_u": 34
      },
      "cap50": {
        "n": 50,
        "pnl_u": 43.89
      }
    },
    {
      "date": "2026-09-22",
      "model": "TENNIS_P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 48
      }
    },
    {
      "date": "2026-09-23",
      "model": "QUALITY_FILL_A",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-23",
      "model": "QUALITY_FILL_D",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-23",
      "model": "P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 25.88
      },
      "cap40": {
        "n": 40,
        "pnl_u": 35.88
      },
      "cap50": {
        "n": 50,
        "pnl_u": 41.88
      }
    },
    {
      "date": "2026-09-23",
      "model": "PORTFOLIO_BROAD",
      "cap30": {
        "n": 30,
        "pnl_u": 25.96
      },
      "cap40": {
        "n": 40,
        "pnl_u": 35.96
      },
      "cap50": {
        "n": 50,
        "pnl_u": 39.96
      }
    },
    {
      "date": "2026-09-23",
      "model": "P50_54",
      "cap30": {
        "n": 30,
        "pnl_u": 25.89
      },
      "cap40": {
        "n": 40,
        "pnl_u": 33.79
      },
      "cap50": {
        "n": 50,
        "pnl_u": 39.68
      }
    },
    {
      "date": "2026-09-23",
      "model": "C5",
      "cap30": {
        "n": 30,
        "pnl_u": 21.89
      },
      "cap40": {
        "n": 40,
        "pnl_u": 29.79
      },
      "cap50": {
        "n": 50,
        "pnl_u": 37.46
      }
    },
    {
      "date": "2026-09-23",
      "model": "C0",
      "cap30": {
        "n": 30,
        "pnl_u": 21.89
      },
      "cap40": {
        "n": 40,
        "pnl_u": 29.79
      },
      "cap50": {
        "n": 50,
        "pnl_u": 37.46
      }
    },
    {
      "date": "2026-09-23",
      "model": "TENNIS_P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 38
      },
      "cap50": {
        "n": 50,
        "pnl_u": 46
      }
    },
    {
      "date": "2026-09-24",
      "model": "QUALITY_FILL_A",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 40
      },
      "cap50": {
        "n": 50,
        "pnl_u": 50
      }
    },
    {
      "date": "2026-09-24",
      "model": "QUALITY_FILL_D",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 40
      },
      "cap50": {
        "n": 50,
        "pnl_u": 50
      }
    },
    {
      "date": "2026-09-24",
      "model": "P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 27.89
      },
      "cap40": {
        "n": 40,
        "pnl_u": 37.89
      },
      "cap50": {
        "n": 50,
        "pnl_u": 47.89
      }
    },
    {
      "date": "2026-09-24",
      "model": "PORTFOLIO_BROAD",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 40
      },
      "cap50": {
        "n": 50,
        "pnl_u": 50
      }
    },
    {
      "date": "2026-09-24",
      "model": "P50_54",
      "cap30": {
        "n": 30,
        "pnl_u": 28
      },
      "cap40": {
        "n": 40,
        "pnl_u": 37.9
      },
      "cap50": {
        "n": 50,
        "pnl_u": 47.9
      }
    },
    {
      "date": "2026-09-24",
      "model": "C5",
      "cap30": {
        "n": 30,
        "pnl_u": 29.82
      },
      "cap40": {
        "n": 40,
        "pnl_u": 39.72
      },
      "cap50": {
        "n": 50,
        "pnl_u": 49.72
      }
    },
    {
      "date": "2026-09-24",
      "model": "C0",
      "cap30": {
        "n": 30,
        "pnl_u": 29.82
      },
      "cap40": {
        "n": 40,
        "pnl_u": 39.72
      },
      "cap50": {
        "n": 50,
        "pnl_u": 49.72
      }
    },
    {
      "date": "2026-09-24",
      "model": "TENNIS_P50_52",
      "cap30": {
        "n": 30,
        "pnl_u": 30
      },
      "cap40": {
        "n": 40,
        "pnl_u": 40
      },
      "cap50": {
        "n": 50,
        "pnl_u": 50
      }
    }
  ]
};
