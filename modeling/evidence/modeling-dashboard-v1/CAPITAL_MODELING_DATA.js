// Generated projection; source economics remain in DAILY_BATCH_CAPITAL_APPROX_V1.
window.POLYPROPICKS_CAPITAL_MODELING_DATA = {
  "meta": {
    "sourceMission": "DAILY_BATCH_CAPITAL_APPROX_V1",
    "sourceWindow": [
      "2026-08-04",
      "2026-09-20"
    ],
    "startingCapitalUsd": 100,
    "cap": 30,
    "dailyAggregateApproximation": true,
    "exactBetLevelReplay": false,
    "authorityTotalsExact": true
  },
  "scenarioNames": [
    "EARLY_DD",
    "MID_DD",
    "LATE_DD"
  ],
  "models": [
    {
      "model": "P50_52_SAFE",
      "authority": {
        "selected": 1015,
        "settled": 937,
        "open": 78,
        "pnl_u": 150.31,
        "max_dd_u": -23.98
      },
      "scenarios": {
        "EARLY_DD": {
          "fixed": {
            "ending_total_usd": 398.98730672,
            "free_active_usd": 356.98730672,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 47.96,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 2006.86138006,
            "free_active_usd": 673.03677492,
            "open_principal_usd": 1145.98153614,
            "vault_usd": 187.843069,
            "max_drawdown_usd": 71.94,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 1607.87407334
        },
        "MID_DD": {
          "fixed": {
            "ending_total_usd": 398.98908918,
            "free_active_usd": 356.98908918,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 47.96,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 2016.90108242,
            "free_active_usd": 676.56573066,
            "open_principal_usd": 1151.99029764,
            "vault_usd": 188.34505412,
            "max_drawdown_usd": 454.19277562,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 1617.91199324
        },
        "LATE_DD": {
          "fixed": {
            "ending_total_usd": 434.8771427,
            "free_active_usd": 392.8771427,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 13.70285708,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 5412.05368968,
            "free_active_usd": 1846.0808649,
            "open_principal_usd": 3143.32687788,
            "vault_usd": 422.6459469,
            "max_drawdown_usd": 1290.86524836,
            "executed_n": 1015,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 4977.17654698
        }
      },
      "summary": {
        "fixed_end_usd": {
          "min": 398.98730672,
          "max": 434.8771427
        },
        "protected_end_usd": {
          "min": 2006.86138006,
          "max": 5412.05368968
        },
        "protected_upside_usd": {
          "min": 1607.87407334,
          "max": 4977.17654698
        },
        "vault_usd": {
          "min": 187.843069,
          "max": 422.6459469
        },
        "max_drawdown_usd": {
          "min": 13.70285708,
          "max": 1290.86524836
        },
        "capital_skips": 0
      }
    },
    {
      "model": "PORTFOLIO_BROAD_SAFE",
      "authority": {
        "selected": 1087,
        "settled": 1008,
        "open": 79,
        "pnl_u": 140.18,
        "max_dd_u": -24.19
      },
      "scenarios": {
        "EARLY_DD": {
          "fixed": {
            "ending_total_usd": 378.5850771,
            "free_active_usd": 334.5850771,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 48.38,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 1533.35938964,
            "free_active_usd": 465.52508296,
            "open_principal_usd": 903.6663372,
            "vault_usd": 164.16796948,
            "max_drawdown_usd": 72.57,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 1154.77431254
        },
        "MID_DD": {
          "fixed": {
            "ending_total_usd": 378.5850771,
            "free_active_usd": 334.5850771,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 48.38,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 1533.95516788,
            "free_active_usd": 465.71751932,
            "open_principal_usd": 904.03989016,
            "vault_usd": 164.1977584,
            "max_drawdown_usd": 400.37324836,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 1155.37009078
        },
        "LATE_DD": {
          "fixed": {
            "ending_total_usd": 408.94818166,
            "free_active_usd": 364.94818166,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 19.79181808,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 3726.03191744,
            "free_active_usd": 1149.49101284,
            "open_principal_usd": 2231.3649072,
            "vault_usd": 345.1759974,
            "max_drawdown_usd": 1427.48803074,
            "executed_n": 1087,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 3317.08373578
        }
      },
      "summary": {
        "fixed_end_usd": {
          "min": 378.5850771,
          "max": 408.94818166
        },
        "protected_end_usd": {
          "min": 1533.35938964,
          "max": 3726.03191744
        },
        "protected_upside_usd": {
          "min": 1154.77431254,
          "max": 3317.08373578
        },
        "vault_usd": {
          "min": 164.16796948,
          "max": 345.1759974
        },
        "max_drawdown_usd": {
          "min": 19.79181808,
          "max": 1427.48803074
        },
        "capital_skips": 0
      }
    },
    {
      "model": "QUALITY_FILL_A_SAFE",
      "authority": {
        "selected": 1046,
        "settled": 966,
        "open": 80,
        "pnl_u": 182.95,
        "max_dd_u": -21.76
      },
      "scenarios": {
        "EARLY_DD": {
          "fixed": {
            "ending_total_usd": 464.49561346,
            "free_active_usd": 422.49561346,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 43.52,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 5377.16347416,
            "free_active_usd": 1857.69796104,
            "open_principal_usd": 3163.10733942,
            "vault_usd": 356.3581737,
            "max_drawdown_usd": 65.28,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 4912.6678607
        },
        "MID_DD": {
          "fixed": {
            "ending_total_usd": 464.49561346,
            "free_active_usd": 422.49561346,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 43.52,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 5373.62984604,
            "free_active_usd": 1856.45589072,
            "open_principal_usd": 3160.99246302,
            "vault_usd": 356.1814923,
            "max_drawdown_usd": 634.77845374,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 4909.13423258
        },
        "LATE_DD": {
          "fixed": {
            "ending_total_usd": 501.13047606,
            "free_active_usd": 459.13047606,
            "open_principal_usd": 42,
            "vault_usd": 0,
            "max_drawdown_usd": 8.28952378,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 13074.58541148,
            "free_active_usd": 4531.1705795,
            "open_principal_usd": 7715.23639194,
            "vault_usd": 828.17844004,
            "max_drawdown_usd": 1738.98338932,
            "executed_n": 1046,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 12573.45493542
        }
      },
      "summary": {
        "fixed_end_usd": {
          "min": 464.49561346,
          "max": 501.13047606
        },
        "protected_end_usd": {
          "min": 5373.62984604,
          "max": 13074.58541148
        },
        "protected_upside_usd": {
          "min": 4909.13423258,
          "max": 12573.45493542
        },
        "vault_usd": {
          "min": 356.1814923,
          "max": 828.17844004
        },
        "max_drawdown_usd": {
          "min": 8.28952378,
          "max": 1738.98338932
        },
        "capital_skips": 0
      }
    },
    {
      "model": "QUALITY_FILL_D_SAFE",
      "authority": {
        "selected": 1076,
        "settled": 989,
        "open": 87,
        "pnl_u": 237.25,
        "max_dd_u": -21.81
      },
      "scenarios": {
        "EARLY_DD": {
          "fixed": {
            "ending_total_usd": 573.98802358,
            "free_active_usd": 529.98802358,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 43.62,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 21245.1281072,
            "free_active_usd": 6832.42637852,
            "open_principal_usd": 13262.94532332,
            "vault_usd": 1149.75640536,
            "max_drawdown_usd": 65.43,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 20671.14008362
        },
        "MID_DD": {
          "fixed": {
            "ending_total_usd": 573.98855338,
            "free_active_usd": 529.98855338,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 43.62,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 21021.52958136,
            "free_active_usd": 6760.20405498,
            "open_principal_usd": 13122.74904732,
            "vault_usd": 1138.57647906,
            "max_drawdown_usd": 1374.07610372,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 20447.54102798
        },
        "LATE_DD": {
          "fixed": {
            "ending_total_usd": 616.1372728,
            "free_active_usd": 572.1372728,
            "open_principal_usd": 44,
            "vault_usd": 0,
            "max_drawdown_usd": 1.98272728,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 57050.22591546,
            "free_active_usd": 18369.31965208,
            "open_principal_usd": 35658.09108928,
            "vault_usd": 3022.8151741,
            "max_drawdown_usd": 1656.07756668,
            "executed_n": 1076,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 56434.08864266
        }
      },
      "summary": {
        "fixed_end_usd": {
          "min": 573.98802358,
          "max": 616.1372728
        },
        "protected_end_usd": {
          "min": 21021.52958136,
          "max": 57050.22591546
        },
        "protected_upside_usd": {
          "min": 20447.54102798,
          "max": 56434.08864266
        },
        "vault_usd": {
          "min": 1138.57647906,
          "max": 3022.8151741
        },
        "max_drawdown_usd": {
          "min": 1.98272728,
          "max": 1656.07756668
        },
        "capital_skips": 0
      }
    },
    {
      "model": "TENNIS_P50_52_SAFE",
      "authority": {
        "selected": 271,
        "settled": 242,
        "open": 29,
        "pnl_u": 218,
        "max_dd_u": -2
      },
      "scenarios": {
        "EARLY_DD": {
          "fixed": {
            "ending_total_usd": 534.50847464,
            "free_active_usd": 524.50847464,
            "open_principal_usd": 10,
            "vault_usd": 0,
            "max_drawdown_usd": 4,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 20356.94971044,
            "free_active_usd": 16363.86189122,
            "open_principal_usd": 2887.7403337,
            "vault_usd": 1105.34748552,
            "max_drawdown_usd": 6,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 19822.4412358
        },
        "MID_DD": {
          "fixed": {
            "ending_total_usd": 534.50847464,
            "free_active_usd": 524.50847464,
            "open_principal_usd": 10,
            "vault_usd": 0,
            "max_drawdown_usd": 4,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 20072.73059768,
            "free_active_usd": 16134.3549576,
            "open_principal_usd": 2847.2391102,
            "vault_usd": 1091.13652988,
            "max_drawdown_usd": 80.51710312,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 19538.22212304
        },
        "LATE_DD": {
          "fixed": {
            "ending_total_usd": 539.1999998,
            "free_active_usd": 529.1999998,
            "open_principal_usd": 10,
            "vault_usd": 0,
            "max_drawdown_usd": 0.79999994,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected": {
            "ending_total_usd": 21574.22144446,
            "free_active_usd": 17336.28071136,
            "open_principal_usd": 3059.343655,
            "vault_usd": 1178.5970781,
            "max_drawdown_usd": 247.7201177,
            "executed_n": 271,
            "capital_skip_n": 0
          },
          "protected_minus_fixed_total_usd": 21035.02144466
        }
      },
      "summary": {
        "fixed_end_usd": {
          "min": 534.50847464,
          "max": 539.1999998
        },
        "protected_end_usd": {
          "min": 20072.73059768,
          "max": 21574.22144446
        },
        "protected_upside_usd": {
          "min": 19538.22212304,
          "max": 21035.02144466
        },
        "vault_usd": {
          "min": 1091.13652988,
          "max": 1178.5970781
        },
        "max_drawdown_usd": {
          "min": 0.79999994,
          "max": 247.7201177
        },
        "capital_skips": 0
      }
    }
  ]
};
