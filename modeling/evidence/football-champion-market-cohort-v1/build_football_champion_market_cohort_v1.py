#!/usr/bin/env python3
"""FOOTBALL_CHAMPION_AND_MARKET_COHORT_CLOSURE_V3 - scratch assembler.

Assembles the six evidence artifacts ONLY from committed canonical aggregates:
  - football-structural-authority-v2 (JSON)
  - p5052-p5054-c1-restored-lineage-audit-v2 (JSON)
  - football-denominator-reconciliation-v2 frozen overlay (Git artifact; used for a
    market-type presence census only - it carries no prices and no settlement)

No database access, no network, no raw DB rows, no settlement/economics engine.
Every metric that is not present in a committed aggregate is written as
NOT_COMPARABLE_FROM_CANONICAL_AGGREGATES and is never reconstructed.

Usage: build_football_champion_market_cohort_v1.py <REF_WORKTREE_DIR> <OUT_DIR>
"""
import gzip
import hashlib
import json
import math
import os
import subprocess
import sys
from collections import defaultdict

REF = sys.argv[1]
OUT = sys.argv[2]
NC = "NOT_COMPARABLE_FROM_CANONICAL_AGGREGATES"

STRUCT_PATH = "modeling/evidence/football-structural-authority-v2/FOOTBALL_STRUCTURAL_AUTHORITY_2026-08-04_2026-09-24.json"
AUDIT_PATH = "modeling/evidence/p5052-p5054-c1-restored-lineage-audit-v2/AUDIT_REPORT.json"
OVERLAY_PATH = "modeling/evidence/football-denominator-reconciliation-v2/FOOTBALL_DENOMINATOR_OVERLAY_2026-08-04_2026-09-24.jsonl.gz"
V3_PATHS = [
    "modeling/evidence/candidate-v3-freeze-v1/CANDIDATE_V3_CONTRACT.json",
    "modeling/evidence/candidate-v3-bounded-repair-v1/AMENDED_CANDIDATE_V3_CONTRACT.json",
    "modeling/evidence/step4c-contract-a-final-replay-v1/FINDINGS.md",
]
FROZEN_OVERLAY_SHA256 = "944d45b4a5c8dcffbbc12a54fbe4926a1bba269fad1fefc592ca7db2e4ce1665"


def sha256_file(rel):
    h = hashlib.sha256()
    with open(os.path.join(REF, rel), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def last_commit(rel):
    return subprocess.check_output(["git", "-C", REF, "log", "-1", "--format=%H", "--", rel], text=True).strip()


def load(rel):
    with open(os.path.join(REF, rel), "r", encoding="utf-8") as f:
        return json.load(f)


struct = load(STRUCT_PATH)
audit = load(AUDIT_PATH)
assert sha256_file(OVERLAY_PATH) == FROZEN_OVERLAY_SHA256, "FROZEN_OVERLAY_SHA_MISMATCH"

REF_HEAD = subprocess.check_output(["git", "-C", REF, "rev-parse", "HEAD"], text=True).strip()
INPUTS = {}
for rel in [STRUCT_PATH, AUDIT_PATH, OVERLAY_PATH] + V3_PATHS:
    INPUTS[rel] = {"SHA256": sha256_file(rel), "LAST_COMMIT": last_commit(rel)}

# ---------------------------------------------------------------- periods
PERIODS = ["AUG", "SEP_EARLY", "SEP_LATE", "COMBINED"]
PERIOD_RANGE = {
    "AUG": "2026-08-04..2026-08-31",
    "SEP_EARLY": "2026-09-01..2026-09-12",
    "SEP_LATE": "2026-09-13..2026-09-24",
    "COMBINED": "2026-08-04..2026-09-24",
}
CAL_DAYS = {"AUG": 28, "SEP_EARLY": 12, "SEP_LATE": 12, "COMBINED": 52}
STRUCT_KEY = {"AUG": "AUG", "SEP_EARLY": "SEP_1_12", "SEP_LATE": "SEP_13_24", "COMBINED": "COMBINED"}
AUDIT_KEY = {"AUG": "AUG", "SEP_EARLY": "SEP_1_12", "COMBINED": "COMBINED_FULL_AUG04_SEP24"}
AUDIT_SUB = {"SEP_13_20": 8, "SEP_21_24": 4}  # calendar days of the audit's own split of SEP_LATE

BUCKETS = [
    ("LT_1_35", "<1.35"), ("1_35_1_50", "1.35-1.50"), ("1_50_1_75", "1.50-1.75"),
    ("1_75_2_00", "1.75-2.00"), ("2_00_2_25", "2.00-2.25"), ("2_25_2_50", "2.25-2.50"),
    ("2_50_3_00", "2.50-3.00"), ("3_00_4_00", "3.00-4.00"), ("4_00_5_00", "4.00-5.00"),
    ("GE_5_00", "5.00+"),
]
CANON_FAMILIES = ["moneyline", "totals", "spreads", "total_corners", "other_structured", "soccer_exact_score"]


def evidence_status(n_settled):
    if n_settled is None:
        return NC
    if n_settled >= 100:
        return "MAIN_EVIDENCE"
    if n_settled >= 50:
        return "PROMISING_SMALL_SAMPLE"
    return "SMALL_SAMPLE"


def per_day(n_selected, days):
    return round(n_selected / days, 4)


def from_struct_cell(c, period):
    """Standardise a structural-authority CellMetrics record."""
    return {
        "N_SELECTED": c["N_SELECTED"], "N_SETTLED": c["N_SETTLED"], "N_OPEN": c["N_OPEN"],
        "W": c["WINS"], "L": c["LOSSES"], "HIT_RATE_PCT": c["HIT_RATE_PCT"],
        "PNL_U": c["REFERENCE_PNL_U"], "ROI_PCT": c["REFERENCE_ROI_SETTLED_PCT"], "MAXDD_U": c["MAX_DD_U"],
        "MEAN_ENTRY_PRICE": NC, "MEDIAN_ENTRY_PRICE": NC,
        "MEAN_DECIMAL_ODDS": c["MEAN_DISPLAY_ODDS"], "MEDIAN_DECIMAL_ODDS": c["MEDIAN_DISPLAY_ODDS"],
        "ACTIVE_DAY_N": NC, "MEAN_BETS_PER_ACTIVE_DAY": NC, "MEDIAN_BETS_PER_ACTIVE_DAY": NC,
        "P25_P75_BETS_PER_ACTIVE_DAY": NC,
        "SELECTED_PER_CALENDAR_DAY": per_day(c["N_SELECTED"], CAL_DAYS[period]),
        "EVIDENCE_STATUS": evidence_status(c["N_SETTLED"]),
    }


def from_audit_cell(c, days):
    return {
        "N_SELECTED": c["SELECTED_N"], "N_SETTLED": c["SETTLED_N"], "N_OPEN": c["OPEN_N"],
        "W": c["WINS"], "L": c["LOSSES"], "HIT_RATE_PCT": c["HIT_RATE_PCT"],
        "PNL_U": c["REFERENCE_PNL_U"], "ROI_PCT": c["REFERENCE_ROI_PCT"], "MAXDD_U": c["MAX_DD_U"],
        "MEAN_ENTRY_PRICE": c["AVG_ENTRY_PRICE"], "MEDIAN_ENTRY_PRICE": NC,
        "MEAN_DECIMAL_ODDS": c["AVG_DECIMAL_ODDS"], "MEDIAN_DECIMAL_ODDS": NC,
        "ACTIVE_DAY_N": NC, "MEAN_BETS_PER_ACTIVE_DAY": NC, "MEDIAN_BETS_PER_ACTIVE_DAY": NC,
        "P25_P75_BETS_PER_ACTIVE_DAY": NC,
        "SELECTED_PER_CALENDAR_DAY": per_day(c["SELECTED_N"], days),
        "EVIDENCE_STATUS": evidence_status(c["SETTLED_N"]),
    }


def nc_cell(reason):
    return {"STATUS": NC, "REASON": reason}


# ---------------------------------------------------------------- PART A policies
POLICIES = {}

POLICIES["CURRENT_LIVE_FOOTBALL_REFERENCE"] = {
    "DEFINITION": "football (canonical soccer, frozen denominator v2), entry_price in [0.50,0.54), market type in {moneyline, totals, spreads}, one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)",
    "SOURCE": "p5052-p5054-c1-restored-lineage-audit-v2 / AUDIT_REPORT.json LIVE_POLICY_REPLAY.TOTAL",
    "SCOPE_NOTE": "Audit publishes this replay for the full Aug04-Sep24 history only. No per-period split is published, so AUG / SEP_EARLY / SEP_LATE are not producible without a row-level replay. The multi-sport tiered PORTFOLIO_BROAD row of unified-core-scoreboard-v1 is NOT this football-only reference and is not substituted.",
    "PERIODS": {
        "AUG": nc_cell("no per-period LIVE_POLICY_REPLAY in canonical aggregates"),
        "SEP_EARLY": nc_cell("no per-period LIVE_POLICY_REPLAY in canonical aggregates"),
        "SEP_LATE": nc_cell("no per-period LIVE_POLICY_REPLAY in canonical aggregates"),
        "COMBINED": from_audit_cell(audit["LIVE_POLICY_REPLAY"]["TOTAL"], 52),
    },
}
assert audit["LIVE_POLICY_REPLAY"]["CALENDAR_DAYS"] == 52
assert abs(POLICIES["CURRENT_LIVE_FOOTBALL_REFERENCE"]["PERIODS"]["COMBINED"]["SELECTED_PER_CALENDAR_DAY"]
           - audit["LIVE_POLICY_REPLAY"]["TOTAL"]["SELECTED_EVENTS_PER_CALENDAR_DAY"]) < 1e-4

POLICIES["CANDIDATE_V3_CONTROL"] = {
    "DEFINITION": "CANDIDATE_V3_CONTRACT_A_NO_MOMENTUM (amended): soccer only; market type in allowed_fullmatch_{moneyline,spread,total} via lib/contur3/taxonomy.ts; Signal Score >= 65; entry price >= 0.30; 0 < minutes-to-start <= 1440; T-90 snapshot; esports excluded; one winner per physical event (highest score, earliest created_at, smallest identity).",
    "SOURCE": "candidate-v3-freeze-v1/CANDIDATE_V3_CONTRACT.json + candidate-v3-bounded-repair-v1/AMENDED_CANDIDATE_V3_CONTRACT.json",
    "STATUS": "CONTROL_NOT_HISTORICALLY_COMPARABLE",
    "REASON": "The contract is scored on T-90 snapshot lineage via produceFrozenModelV2ShadowDecisions. The only committed historical replay (step4c-contract-a-final-replay-v1) is a bounded selector-identity check on 17 of 152 S2 events and by its own statement carries no settlement or PnL. The only committed Score>=65 economics (unified-core-scoreboard-v1, 485 events, +112.35u) are multi-sport, Aug04-Sep20 and price-derived-score based; they are not football-only and are not substituted.",
    "PERIODS": {p: nc_cell("no historical apples-to-apples replay under the bounded-read contract") for p in PERIODS},
}

audit_models = audit["MODELS"]
for name, label in [("P50_52", "entry_price in [0.50,0.52)"), ("P50_54", "entry_price in [0.50,0.54)")]:
    m = audit_models[name]
    periods = {
        "AUG": from_audit_cell(m["AUG"], 28),
        "SEP_EARLY": from_audit_cell(m["SEP_1_12"], 12),
        "SEP_LATE": nc_cell("audit publishes SEP_13_20 and SEP_21_24 separately; each period is selected independently, so the two cannot be merged exactly (events, MaxDD and dedupe are not additive) - sub-periods preserved in SEP_LATE_SUBPERIODS"),
        "COMBINED": from_audit_cell(m["COMBINED_FULL_AUG04_SEP24"], 52),
    }
    POLICIES[name] = {
        "DEFINITION": f"football (canonical soccer, frozen denominator v2), ordinary HOLD (resolved non-exact-score market types), {label}, one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)",
        "SOURCE": f"p5052-p5054-c1-restored-lineage-audit-v2 / AUDIT_REPORT.json MODELS.{name}",
        "PERIODS": periods,
        "SEP_LATE_SUBPERIODS": {
            "SEP_13_20": from_audit_cell(m["SEP_13_20"], 8),
            "SEP_21_24": from_audit_cell(m["SEP_21_24"], 4),
        },
    }

odds_grid = struct["ODDS_GRID"]
POLICIES["ORDINARY_FOOTBALL_ODDS_1_75_2_00"] = {
    "DEFINITION": "football (canonical soccer, frozen denominator v2), ordinary HOLD (resolved non-exact-score market types), DISPLAY_ODDS = 1/entry_price in [1.75,2.00) (entry_price in (0.50,0.5714]), one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)",
    "SOURCE": "football-structural-authority-v2 / ODDS_GRID.<period>.1_75_2_00",
    "PERIODS": {p: from_struct_cell(odds_grid[STRUCT_KEY[p]]["1_75_2_00"], p) for p in PERIODS},
}

# ---------------------------------------------------------------- Pareto (COMBINED, comparable metrics only)
def pareto_vector(pol):
    c = pol["PERIODS"]["COMBINED"]
    if "STATUS" in c:
        return None
    # maximise PnL, ROI, supply; MaxDD is stored negative -> larger (closer to 0) is better
    return (c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"], c["SELECTED_PER_CALENDAR_DAY"])


vecs = {k: pareto_vector(v) for k, v in POLICIES.items()}
comparable = {k: v for k, v in vecs.items() if v is not None}


def dominates(a, b):
    return all(x >= y for x, y in zip(a, b)) and any(x > y for x, y in zip(a, b))


dominated_by = {k: [j for j, vj in comparable.items() if j != k and dominates(vj, vk)] for k, vk in comparable.items()}
PARETO_SET = sorted([k for k, d in dominated_by.items() if not d])

# implied-vs-observed hit-rate diagnostic (only where mean entry price is published exactly)
def z_hit(c):
    if "STATUS" in c or c["MEAN_ENTRY_PRICE"] in (None, NC) or (c["W"] + c["L"]) == 0:
        return None
    n = c["W"] + c["L"]
    p = c["MEAN_ENTRY_PRICE"]
    obs = c["W"] / n
    return round((obs - p) / math.sqrt(p * (1 - p) / n), 2)


# ---------------------------------------------------------------- Part B families
mgrid = struct["MARKET_STRUCTURE_GRID"]
FAMILIES = {}
for fam in CANON_FAMILIES + ["UNRESOLVED_MARKET_TYPE"]:
    FAMILIES[fam] = {p: from_struct_cell(mgrid[STRUCT_KEY[p]][fam], p) for p in PERIODS}

# ---- census from the frozen overlay (presence only, no prices, no settlement)
def period_of(d):
    return "AUG" if d <= "2026-08-31" else ("SEP_EARLY" if d <= "2026-09-12" else "SEP_LATE")


rows_ct = defaultdict(int)
ev_sets = defaultdict(set)
overlay_rows = 0
soccer_rows = 0
with gzip.open(os.path.join(REF, OVERLAY_PATH), "rt", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        overlay_rows += 1
        if r["reconciled_sport_family"] != "soccer":
            continue
        soccer_rows += 1
        mt = r["reconciled_market_type"] or "UNRESOLVED"
        for p in (period_of(r["model_date"]), "COMBINED"):
            rows_ct[(mt, p)] += 1
            ev_sets[(mt, p)].add(r["provider_event_id"])
assert overlay_rows == 75743

NAMED = {"moneyline", "totals", "spreads", "total_corners", "soccer_exact_score", "UNRESOLVED"}
census_types = sorted({k[0] for k in rows_ct}, key=lambda m: (-len(ev_sets[(m, "COMBINED")]), m))
CENSUS = {}
for mt in census_types:
    CENSUS[mt] = {
        "IN_STRUCTURAL_BUCKET": mt if mt in NAMED - {"UNRESOLVED"} else ("UNRESOLVED_MARKET_TYPE" if mt == "UNRESOLVED" else "other_structured"),
        "EVENTS_PRESENT": {p: len(ev_sets[(mt, p)]) for p in PERIODS},
        "OVERLAY_ROWS": {p: rows_ct[(mt, p)] for p in PERIODS},
        "ECONOMICS": NC,
    }
# validation: census distinct events reproduces the structural N_SELECTED for the six named buckets
CENSUS_CHECK = {}
for fam, mt in [("moneyline", "moneyline"), ("totals", "totals"), ("spreads", "spreads"),
                ("total_corners", "total_corners"), ("soccer_exact_score", "soccer_exact_score"),
                ("UNRESOLVED_MARKET_TYPE", "UNRESOLVED")]:
    CENSUS_CHECK[fam] = {p: {"CENSUS_EVENTS": len(ev_sets[(mt, p)]), "STRUCTURAL_N_SELECTED": FAMILIES[fam][p]["N_SELECTED"],
                             "MATCH": len(ev_sets[(mt, p)]) == FAMILIES[fam][p]["N_SELECTED"]} for p in PERIODS}
other_union = {p: set().union(*[ev_sets[(mt, p)] for mt in census_types if mt not in NAMED]) for p in PERIODS}
CENSUS_CHECK["other_structured"] = {p: {"CENSUS_EVENTS": len(other_union[p]), "STRUCTURAL_N_SELECTED": FAMILIES["other_structured"][p]["N_SELECTED"],
                                        "MATCH": len(other_union[p]) == FAMILIES["other_structured"][p]["N_SELECTED"]} for p in PERIODS}
CENSUS_ALL_MATCH = all(v["MATCH"] for fam in CENSUS_CHECK.values() for v in fam.values())

NON_FOOTBALL_TYPES = ["anytime_touchdowns", "receptions", "two_plus_touchdowns", "receiving_yards", "q1_moneyline"]

# ---- odds x family cells: only committed cells are populated
inter = struct["STRUCTURAL_INTERACTION_CELLS"]
AVAILABLE_ODDS_FAMILY = {
    ("other_structured", "2_25_2_50"): inter["2_25_2_50__OTHER_STRUCTURED"],
    ("total_corners", "2_25_2_50"): inter["2_25_2_50__TOTAL_CORNERS"],
}
ODDS_X_FAMILY = {}
for fam in CANON_FAMILIES:
    ODDS_X_FAMILY[fam] = {}
    for bid, blabel in BUCKETS:
        if (fam, bid) in AVAILABLE_ODDS_FAMILY:
            c = from_struct_cell(AVAILABLE_ODDS_FAMILY[(fam, bid)], "COMBINED")
            c["PERIOD_SCOPE"] = "COMBINED only (no AUG / SEP_EARLY / SEP_LATE split committed)"
            c["SOURCE"] = "football-structural-authority-v2 / STRUCTURAL_INTERACTION_CELLS"
            ODDS_X_FAMILY[fam][bid] = {"LABEL": blabel, "STATUS": "AVAILABLE_COMBINED_ONLY", "COMBINED": c,
                                       "AUG": nc_cell("period split not committed"), "SEP_EARLY": nc_cell("period split not committed"),
                                       "SEP_LATE": nc_cell("period split not committed")}
        else:
            ODDS_X_FAMILY[fam][bid] = {"LABEL": blabel, "STATUS": NC,
                                       "REASON": "no committed family x odds aggregate; emptiness of the cell is unknown; server-side GROUP BY on the clone was not reachable"}

POOLED_ODDS = {}
for bid, blabel in BUCKETS:
    POOLED_ODDS[bid] = {"LABEL": blabel, "SCOPE": "ordinary HOLD, all resolved non-exact-score families pooled, one bet per event per cell",
                        "PERIODS": {p: from_struct_cell(odds_grid[STRUCT_KEY[p]][bid], p) for p in PERIODS}}

LIVE_FAMILY_CELLS = {}
for fam, c in audit["LIVE_POLICY_REPLAY"]["BY_FAMILY"].items():
    LIVE_FAMILY_CELLS[fam] = from_audit_cell(c, 52)
    LIVE_FAMILY_CELLS[fam]["Z_HIT_VS_MEAN_ENTRY"] = z_hit(LIVE_FAMILY_CELLS[fam])
    LIVE_FAMILY_CELLS[fam]["SCOPE"] = "entry_price [0.50,0.54), COMBINED only, one bet per event within the family cell"

# ---------------------------------------------------------------- write helpers
os.makedirs(OUT, exist_ok=True)


def wjson(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, indent=2, sort_keys=False, ensure_ascii=False) + "\n")


def wtext(name, text):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(text)


def fmt(v):
    if v is None:
        return "-"
    if v == NC:
        return "NC"
    return str(v)


def mtable(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(fmt(x) for x in r) + " |")
    return "\n".join(out)


def metric_row(label, period, c):
    if "STATUS" in c:
        return [label, period] + ["NC"] * 11
    return [label, period, c["N_SELECTED"], c["N_SETTLED"], c["N_OPEN"], c["W"], c["L"], c["PNL_U"], c["ROI_PCT"],
            c["MAXDD_U"], c["MEAN_DECIMAL_ODDS"], c["MEDIAN_DECIMAL_ODDS"], c["EVIDENCE_STATUS"]]


METRIC_HDR = ["Model", "Period", "N_SEL", "N_SET", "N_OPEN", "W", "L", "PnL_u", "ROI_%", "MaxDD_u", "MeanDecOdds", "MedDecOdds", "Evidence"]

# ---------------------------------------------------------------- 1. CORE COMPARISON
pol_order = ["CURRENT_LIVE_FOOTBALL_REFERENCE", "CANDIDATE_V3_CONTROL", "P50_52", "P50_54", "ORDINARY_FOOTBALL_ODDS_1_75_2_00"]
md = []
md.append("# FOOTBALL_CORE_COMPARISON - Aug04..Sep24 historical authority\n")
md.append("Status: **HISTORICAL_REFERENCE_PNL / NOT_EXECUTION_AUTHORITY / AGGREGATE_ONLY**. Clone reads: 0 rows (committed aggregates only). DB writes 0. Production reads 0. Sep25+ is not included.\n")
md.append("`NC` = `" + NC + "`: the exact metric is not present in any committed canonical aggregate and was **not** reconstructed or approximated.\n")
md.append("## Provenance (reused, not rebuilt)\n")
md.append(f"Reference commit (read-only worktree): `{REF_HEAD}` (`origin/claude/tender-johnson-z3zm8e`; these authorities are committed there and not yet on `main`).\n")
md.append(mtable(["Input", "Last commit", "SHA-256"], [[k, v["LAST_COMMIT"][:12], v["SHA256"]] for k, v in INPUTS.items()]))
md.append("\nSemantics inherited from the inputs: SELECTION_BEFORE_SETTLEMENT_V1, one bet per physical event **per policy/cell**, chronological-first, flat 1u, DISPLAY_ODDS = 1/entry_price, OPEN != LOSS (OPEN excluded from PnL/ROI, counted in N_OPEN), exact-score and unresolved market types excluded from ordinary HOLD. MaxDD is chronological and is shown negative (closer to 0 is better).\n")
md.append("Periods: AUG 2026-08-04..08-31 (28 d), SEP_EARLY 09-01..09-12 (12 d), SEP_LATE 09-13..09-24 (12 d), COMBINED 52 d. Historical capture limitations remain: sibling identities are never fabricated; unresolved sport/market rows are excluded fail-closed.\n")
md.append("## Comparability warning\n")
md.append("The five policies do **not** share one candidate universe: the live reference is restricted to moneyline/totals/spreads; P50_52/P50_54/ODDS_1_75_2_00 use all resolved non-exact-score families; P50 bands are entry [0.50,0.54)/[0.50,0.52) while 1.75-2.00 is entry (0.50,0.5714], so they overlap but are not nested (P50 includes entry == 0.50). Rankings below are therefore **factual attribution, not a like-for-like tournament**.\n")
md.append("## Policy definitions (resolved from Git)\n")
for k in pol_order:
    md.append(f"- **{k}** - {POLICIES[k]['DEFINITION']}  \n  Source: `{POLICIES[k]['SOURCE']}`")
md.append("")
md.append("## Per-policy, per-period economics\n")
rows = []
for k in pol_order:
    for p in PERIODS:
        rows.append(metric_row(k, p, POLICIES[k]["PERIODS"][p]))
md.append(mtable(METRIC_HDR, rows))
md.append("\nMean decimal odds are published as MEAN for P50_*/live (`AVG_DECIMAL_ODDS`, computed as mean of 1/entry) and as MEAN/MEDIAN display odds for ODDS_1_75_2_00; the table's MedDecOdds is `NC` for policies whose audit does not publish a median.\n")
md.append("### P50 SEP_LATE sub-periods (as published, not merged)\n")
rows = []
for k in ("P50_52", "P50_54"):
    for sp, c in POLICIES[k]["SEP_LATE_SUBPERIODS"].items():
        rows.append(metric_row(k, sp, c))
md.append(mtable(METRIC_HDR, rows))
def _sum_sel(k):
    pol = POLICIES[k]
    return sum(c["N_SELECTED"] for c in [pol["PERIODS"]["AUG"], pol["PERIODS"]["SEP_EARLY"], pol["SEP_LATE_SUBPERIODS"]["SEP_13_20"], pol["SEP_LATE_SUBPERIODS"]["SEP_21_24"]])


md.append(f"\nSum of the four published period rows differs from the COMBINED row (P50_52 selected {_sum_sel('P50_52')} vs {POLICIES['P50_52']['PERIODS']['COMBINED']['N_SELECTED']}; P50_54 selected {_sum_sel('P50_54')} vs {POLICIES['P50_54']['PERIODS']['COMBINED']['N_SELECTED']}) because each period is selected independently while COMBINED dedupes events across periods. This is shown, not smoothed.\n")
md.append("## Supply and price descriptors\n")
rows = []
for k in pol_order:
    for p in PERIODS:
        c = POLICIES[k]["PERIODS"][p]
        if "STATUS" in c:
            rows.append([k, p, "NC", "NC", "NC", "NC", "NC", "NC", "NC"])
        else:
            rows.append([k, p, c["SELECTED_PER_CALENDAR_DAY"], c["ACTIVE_DAY_N"], c["MEAN_BETS_PER_ACTIVE_DAY"],
                         c["MEDIAN_BETS_PER_ACTIVE_DAY"], c["P25_P75_BETS_PER_ACTIVE_DAY"], c["MEAN_ENTRY_PRICE"], c["MEDIAN_ENTRY_PRICE"]])
md.append(mtable(["Model", "Period", "Selected/calendar-day (N_SEL / days, exact)", "ACTIVE_DAY_N", "Mean bets/active day", "Median bets/active day", "P25/P75 bets/active day", "Mean entry", "Median entry"], rows))
md.append("\nOnly the ordinary-HOLD pool has committed active-day distributions (COMBINED: 45 active days of 52, mean 83.62/day, median 51, P25 7, P75 129 - a pooled figure, not any policy). Per-policy active-day, bets/day percentiles and median entry price require per-day rows that the bounded-read contract does not allow, so they are `NC`.\n")
md.append("## Core Pareto set (COMBINED; PnL, ROI, MaxDD, selected per calendar day)\n")
md.append("Models with all four COMBINED metrics: " + ", ".join(sorted(comparable)) + ". CANDIDATE_V3_CONTROL is excluded (`CONTROL_NOT_HISTORICALLY_COMPARABLE`).\n")
rows = []
for k in sorted(comparable):
    v = comparable[k]
    rows.append([k, v[0], v[1], v[2], v[3], ", ".join(dominated_by[k]) or "-"])
md.append(mtable(["Model", "PnL_u", "ROI_%", "MaxDD_u", "Sel/cal-day", "Dominated by"], rows))
md.append(f"\n**CORE_PARETO_SET = {{{', '.join(PARETO_SET)}}}** (not dominated on all four metrics by any other comparable model). Pareto membership is a descriptive statement across differing universes, not a promotion.\n")
md.append("## Period stability (concentration and price-implied diagnostic)\n")
rows = []
for k in ("P50_52", "P50_54"):
    for sp, c in POLICIES[k]["SEP_LATE_SUBPERIODS"].items():
        rows.append([k, sp, c["PNL_U"], c["HIT_RATE_PCT"], c["MEAN_ENTRY_PRICE"], z_hit(c)])
    for p in ("AUG", "SEP_EARLY", "COMBINED"):
        c = POLICIES[k]["PERIODS"][p]
        rows.append([k, p, c["PNL_U"], c["HIT_RATE_PCT"], c["MEAN_ENTRY_PRICE"], z_hit(c)])
c = POLICIES["CURRENT_LIVE_FOOTBALL_REFERENCE"]["PERIODS"]["COMBINED"]
rows.append(["CURRENT_LIVE_FOOTBALL_REFERENCE", "COMBINED", c["PNL_U"], c["HIT_RATE_PCT"], c["MEAN_ENTRY_PRICE"], z_hit(c)])
md.append(mtable(["Model", "Period", "PnL_u", "Hit_%", "Mean entry", "z(hit vs mean entry)"], rows))
o = POLICIES["ORDINARY_FOOTBALL_ODDS_1_75_2_00"]["PERIODS"]
sl_share = round(100 * o["SEP_LATE"]["PNL_U"] / (o["AUG"]["PNL_U"] + o["SEP_EARLY"]["PNL_U"] + o["SEP_LATE"]["PNL_U"]), 1)
md.append(f"\n- ODDS_1_75_2_00: AUG {o['AUG']['PNL_U']:+}u, SEP_EARLY {o['SEP_EARLY']['PNL_U']:+}u, SEP_LATE {o['SEP_LATE']['PNL_U']:+}u - SEP_LATE carries {sl_share}% of period-sum PnL. Its SEP_LATE hit rate is {o['SEP_LATE']['HIT_RATE_PCT']}% at mean display odds {o['SEP_LATE']['MEAN_DECIMAL_ODDS']} (mean-odds figure, so no exact z is computed).")
md.append("- P50_52 / P50_54 / live reference: every band near entry 0.50 shows hit rates far above price-implied probability from Sep13 onward (z column, mean entry from the audit; hit rate uses settled bets only). SEP_EARLY is negative for both P50 bands. **Sep13+ outperformance across every 0.50-band cell is a stability flag, not a confirmation**: it needs production forward confirmation before any freeze, and the settled-only denominator excludes 42-56 OPEN bets in SEP_21_24.\n")
md.append("## Reconciliation of required leads\n")
lead_rows = [
    ["P50_52", "Defined and reported (audit v2), COMBINED +110.05u / ROI 26.45% / MaxDD -14.57; dominated by the live reference on all four combined metrics; SEP_LATE not mergeable (sub-periods preserved)"],
    ["P50_54", "Defined and reported (audit v2), COMBINED +100.25u / ROI 18.10% / MaxDD -11.46; dominated by ODDS_1_75_2_00; SEP_LATE not mergeable"],
    ["football odds 1.75-2.00", "Defined and reported for all four periods (structural authority); largest PnL and lowest MaxDD of the comparable set; 91.8% of period-sum PnL sits in SEP_LATE"],
    ["moneyline / spreads / totals", "Reported as family cohort (see FOOTBALL_MARKET_FAMILY_COHORT.md); live-band family cells also reported"],
    ["total_corners / other_structured / exact_score", "Reported as family cohort with period splits; exact_score kept outside ordinary HOLD"],
    ["Candidate V3 control", "CONTROL_NOT_HISTORICALLY_COMPARABLE (see policy row); not the champion by construction"],
]
md.append(mtable(["Lead", "Status"], lead_rows))
md.append("\n## Not comparable from canonical aggregates (explicit list)\n")
md.append("- Per-period AUG / SEP_EARLY / SEP_LATE for CURRENT_LIVE_FOOTBALL_REFERENCE.\n- Exact SEP_LATE (09-13..09-24) row for P50_52 and P50_54.\n- Any Candidate V3 historical PnL/ROI/MaxDD/supply.\n- Per-policy ACTIVE_DAY_N, mean/median/P25/P75 bets per active day, median entry price, and median decimal odds for P50_*/live (only the pooled ordinary-HOLD daily distribution and mean values are committed).\n")
md.append("Why: the clone accepts neither SQL (Supabase MCP denied for project nppznoujvnyjargjkmnv) nor PostgREST aggregates (`PGRST123`), and the exact selection/MaxDD semantics live in the client engine that needs the full 75,743-row corpus. Reading it was not authorised (cap 200 raw rows), and re-implementing settlement in SQL was excluded.\n")
wtext("FOOTBALL_CORE_COMPARISON.md", "\n".join(md) + "\n")

# ---------------------------------------------------------------- 2. FAMILY COHORT
md = []
md.append("# FOOTBALL_MARKET_FAMILY_COHORT - Aug04..Sep24\n")
md.append("Status: **HISTORICAL_REFERENCE_PNL / NOT_EXECUTION_AUTHORITY / ATTRIBUTION ONLY**. Each family is evaluated independently with at most one economic bet per physical event; family rows are **not** a portfolio and must not be summed.\n")
md.append("`NC` = `" + NC + "`. Server-side GROUP BY was not reachable (Supabase MCP denied for the clone; PostgREST aggregates disabled; no aggregate RPC), so only committed aggregates are used; nothing is estimated.\n")
md.append("Evidence status: N_SETTLED >= 100 MAIN_EVIDENCE; 50-99 PROMISING_SMALL_SAMPLE; < 50 SMALL_SAMPLE. All rows are kept; small cells are not promoted.\n")
md.append("## Canonical families (structural authority buckets)\n")
hdr = ["Family", "Period", "N_SEL", "N_SET", "N_OPEN", "W", "L", "PnL_u", "ROI_%", "MaxDD_u", "MeanDecOdds", "MedDecOdds", "Sel/cal-day", "Evidence"]
rows = []
for fam in CANON_FAMILIES + ["UNRESOLVED_MARKET_TYPE"]:
    for p in PERIODS:
        c = FAMILIES[fam][p]
        rows.append([fam, p, c["N_SELECTED"], c["N_SETTLED"], c["N_OPEN"], c["W"], c["L"], c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"],
                     c["MEAN_DECIMAL_ODDS"], c["MEDIAN_DECIMAL_ODDS"], c["SELECTED_PER_CALENDAR_DAY"], c["EVIDENCE_STATUS"]])
md.append(mtable(hdr, rows))
md.append("\nMEAN/MEDIAN_ENTRY_PRICE, ACTIVE_DAY_N and bets-per-active-day statistics per family are `NC` (not in the structural authority). `UNRESOLVED_MARKET_TYPE` is a fail-closed diagnostic bucket, excluded from ordinary HOLD and from every leader list below. `soccer_exact_score` is kept outside ordinary HOLD.\n")
md.append("## other_structured: which families are actually present\n")
md.append("The structural authority folds every type outside {moneyline, totals, spreads, total_corners, soccer_exact_score} into `other_structured`. The frozen overlay (Git artifact, no prices/settlement) lists the actual types. Events-present is a **presence census**, not N_SELECTED and not economics; economics per sub-family are `NC` because no committed aggregate splits them.\n")
census_hdr = ["Market type (as named in overlay)", "Structural bucket", "AUG events", "SEP_EARLY events", "SEP_LATE events", "COMBINED events", "Economics"]
rows = []
for mt in census_types:
    c = CENSUS[mt]
    rows.append([mt, c["IN_STRUCTURAL_BUCKET"], c["EVENTS_PRESENT"]["AUG"], c["EVENTS_PRESENT"]["SEP_EARLY"], c["EVENTS_PRESENT"]["SEP_LATE"], c["EVENTS_PRESENT"]["COMBINED"], "NC"])
md.append(mtable(census_hdr, rows))
md.append(f"\nCensus validation: distinct events per bucket equal the structural N_SELECTED for all six named buckets and `other_structured` in every period: **{CENSUS_ALL_MATCH}**.\n")
EXPECTED = ["moneyline", "spreads", "totals", "total_corners", "team_totals", "first_half_totals", "second_half_totals",
            "first_half_team_totals", "second_half_team_totals", "halftime_result", "second_half_result", "both_teams_to_score",
            "first_half_btts", "second_half_btts", "first_to_score", "exact_score", "other_structured"]
rows = []
for name in EXPECTED:
    rows.append([name, "yes" if (name in CENSUS or name == "other_structured") else "no (exact name)"])
md.append("Expected family names from the mission versus names actually present (exact-name test only; no merging, no invented families):\n")
md.append(mtable(["Expected name", "Present under exact name"], rows))
md.append("\n`other_structured` is the structural bucket, not an overlay market type. `first_half_btts` / `second_half_btts` exist only as `both_teams_to_score_first_half` / `both_teams_to_score_second_half`; `halftime_result`, `second_half_result`, `first_to_score`, `exact_score` exist only with a `soccer_` prefix.\n")
md.append(f"**Data-quality flag:** market types {', '.join(NON_FOOTBALL_TYPES)} appear inside the canonical soccer denominator (a few events each, all in other_structured). They look non-football; they are reported, not dropped, and should be reviewed in the denominator lineage before any sleeve uses other_structured.\n")
md.append("## Odds x market family\n")
md.append("Committed family x odds aggregates exist for **two cells only** (COMBINED, no period split). Every other family x odds x period cell is `NC`; whether those cells are empty is unknown. No new band was searched or optimised.\n")
rows = []
for (fam, bid), cell in AVAILABLE_ODDS_FAMILY.items():
    c = from_struct_cell(cell, "COMBINED")
    lab = dict(BUCKETS)[bid]
    rows.append([fam, lab, c["N_SELECTED"], c["N_SETTLED"], c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"], c["EVIDENCE_STATUS"]])
md.append(mtable(["Family", "Odds cell", "N_SEL", "N_SET", "PnL_u", "ROI_%", "MaxDD_u", "Evidence"], rows))
md.append("\nThese two cells were pre-specified in the earlier structural mission, not derived here; they are still post-hoc relative to that mission's outputs and need forward confirmation.\n")
md.append("### Pooled ordinary-HOLD odds attribution (all resolved non-exact families together, COMBINED)\n")
rows = []
for bid, blabel in BUCKETS:
    c = POOLED_ODDS[bid]["PERIODS"]["COMBINED"]
    rows.append([blabel, c["N_SELECTED"], c["N_SETTLED"], c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"], c["EVIDENCE_STATUS"]])
md.append(mtable(["Odds", "N_SEL", "N_SET", "PnL_u", "ROI_%", "MaxDD_u", "Evidence"], rows))
md.append("\nPer-period pooled cells are in FOOTBALL_MARKET_ODDS_COHORT.json (`POOLED_ODDS_ATTRIBUTION`).\n")
md.append("### Live-band family cells (entry [0.50,0.54), COMBINED)\n")
rows = []
for fam, c in LIVE_FAMILY_CELLS.items():
    rows.append([fam, c["N_SELECTED"], c["N_SETTLED"], c["N_OPEN"], c["W"], c["L"], c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"], c["MEAN_ENTRY_PRICE"], c["Z_HIT_VS_MEAN_ENTRY"], c["EVIDENCE_STATUS"]])
md.append(mtable(["Family", "N_SEL", "N_SET", "N_OPEN", "W", "L", "PnL_u", "ROI_%", "MaxDD_u", "Mean entry", "z(hit vs entry)", "Evidence"], rows))
sp = LIVE_FAMILY_CELLS["spreads"]
md.append(f"\n**Anomaly flag:** spreads in this band show {sp['W']}W/{sp['L']}L (hit {sp['HIT_RATE_PCT']}%) at mean entry {sp['MEAN_ENTRY_PRICE']} (z = {sp['Z_HIT_VS_MEAN_ENTRY']}), whereas spreads over all prices are {FAMILIES['spreads']['COMBINED']['PNL_U']}u / ROI {FAMILIES['spreads']['COMBINED']['ROI_PCT']}%. A hit rate this far from price-implied needs a lineage/settlement audit before spreads are treated as a sleeve. Family cells here are independent (their PnLs do not sum to the live TOTAL).\n")
md.append("## Leader tables (from committed aggregates only)\n")
def fam_line(fam, p="COMBINED"):
    c = FAMILIES[fam][p]
    return [fam, c["N_SETTLED"], c["PNL_U"], c["ROI_PCT"], c["MAXDD_U"], c["EVIDENCE_STATUS"]]
md.append("**MAIN_EVIDENCE families (COMBINED N_SETTLED >= 100, ordinary or diagnostic):**\n")
main_rows = [fam_line(f) for f in CANON_FAMILIES + ["UNRESOLVED_MARKET_TYPE"] if FAMILIES[f]["COMBINED"]["N_SETTLED"] >= 100]
md.append(mtable(["Family", "N_SET", "PnL_u", "ROI_%", "MaxDD_u", "Evidence"], main_rows))
all_pos = [f for f in CANON_FAMILIES if all(FAMILIES[f][p]["PNL_U"] > 0 for p in ("AUG", "SEP_EARLY", "SEP_LATE"))]
tc = FAMILIES["total_corners"]
md.append("\n**Positive-PnL families in COMBINED** (attribution only, not a sleeve decision): "
          + ", ".join(f"{f} ({FAMILIES[f]['COMBINED']['PNL_U']:+}u, ROI {FAMILIES[f]['COMBINED']['ROI_PCT']}%)" for f in CANON_FAMILIES if FAMILIES[f]["COMBINED"]["PNL_U"] > 0)
          + f". Canonical families with positive PnL in all three periods: {', '.join(all_pos) or 'none'}. "
          + f"total_corners: AUG {tc['AUG']['PNL_U']:+}u on {tc['AUG']['N_SETTLED']} settled ({tc['AUG']['EVIDENCE_STATUS']}), SEP_EARLY {tc['SEP_EARLY']['PNL_U']:+}u on {tc['SEP_EARLY']['N_SETTLED']} ({tc['SEP_EARLY']['EVIDENCE_STATUS']}), SEP_LATE {tc['SEP_LATE']['PNL_U']:+}u on {tc['SEP_LATE']['N_SETTLED']} ({tc['SEP_LATE']['EVIDENCE_STATUS']}), COMBINED MaxDD {tc['COMBINED']['MAXDD_U']}u. "
          + f"moneyline COMBINED {FAMILIES['moneyline']['COMBINED']['PNL_U']:+}u / ROI {FAMILIES['moneyline']['COMBINED']['ROI_PCT']}% with MaxDD {FAMILIES['moneyline']['COMBINED']['MAXDD_U']}u and SEP_EARLY {FAMILIES['moneyline']['SEP_EARLY']['PNL_U']:+}u.\n")
md.append("**PROMISING_SMALL_SAMPLE cells:** total_corners SEP_EARLY (70 settled); 2.25-2.50 x total_corners COMBINED (77 settled, +22.78u, ROI 29.59%, MaxDD -7.0u).\n")
md.append("**Negative families (COMBINED):** " + ", ".join(f"{f} ({FAMILIES[f]['COMBINED']['PNL_U']}u, ROI {FAMILIES[f]['COMBINED']['ROI_PCT']}%, N_SET {FAMILIES[f]['COMBINED']['N_SETTLED']})" for f in CANON_FAMILIES + ["UNRESOLVED_MARKET_TYPE"] if FAMILIES[f]["COMBINED"]["PNL_U"] < 0) + ".\n")
md.append("## Not comparable from canonical aggregates (explicit list)\n")
md.append("- Economics for every individual other_structured sub-family (team_totals, first/second-half totals, BTTS variants, halftime/second-half result, first_to_score, corner variants, ...).\n- Every family x odds x period cell other than the two committed COMBINED cells.\n- Per-family ACTIVE_DAY_N, mean/median bets per active day, mean/median entry price.\n")
wtext("FOOTBALL_MARKET_FAMILY_COHORT.md", "\n".join(md) + "\n")

# ---------------------------------------------------------------- 3. ODDS COHORT JSON
odds_json = {
    "MISSION": "FOOTBALL_CHAMPION_AND_MARKET_COHORT_CLOSURE_V3",
    "STATUS": "PARTIAL_AGGREGATE_ONLY",
    "NOT_EXECUTION_AUTHORITY": True,
    "NC_LABEL": NC,
    "PERIODS": PERIOD_RANGE,
    "EVIDENCE_STATUS_RULE": {"MAIN_EVIDENCE": "N_SETTLED>=100", "PROMISING_SMALL_SAMPLE": "50<=N_SETTLED<100", "SMALL_SAMPLE": "N_SETTLED<50"},
    "AGGREGATION_PATH": "COMMITTED_CANONICAL_AGGREGATES_ONLY (server-side GROUP BY unreachable on the clone: MCP execute_sql denied; PostgREST aggregates disabled PGRST123; no aggregate RPC)",
    "INPUTS": INPUTS,
    "REFERENCE_COMMIT": REF_HEAD,
    "FAMILY_METRICS": FAMILIES,
    "ODDS_X_FAMILY": ODDS_X_FAMILY,
    "POOLED_ODDS_ATTRIBUTION": POOLED_ODDS,
    "LIVE_BAND_FAMILY_CELLS": LIVE_FAMILY_CELLS,
    "OTHER_STRUCTURED_CENSUS": {"NOTE": "presence census from frozen overlay; not N_SELECTED, no economics", "TYPES": CENSUS, "VALIDATION_ALL_MATCH": CENSUS_ALL_MATCH, "VALIDATION": CENSUS_CHECK,
                                "NON_FOOTBALL_TYPES_IN_SOCCER_DENOMINATOR": NON_FOOTBALL_TYPES},
}
wjson("FOOTBALL_MARKET_ODDS_COHORT.json", odds_json)

# ---------------------------------------------------------------- 4. PERIOD STABILITY JSON
def stab(cells):
    pnls = {p: c["PNL_U"] for p, c in cells.items() if "STATUS" not in c}
    return pnls


stability = {
    "MISSION": "FOOTBALL_CHAMPION_AND_MARKET_COHORT_CLOSURE_V3",
    "NOT_EXECUTION_AUTHORITY": True,
    "NC_LABEL": NC,
    "PERIODS": PERIOD_RANGE,
    "POLICIES": {},
    "FAMILIES": {},
    "CORE_PARETO": {"BASIS": "COMBINED PnL, ROI, MaxDD, selected per calendar day; comparable models only",
                    "COMPARABLE": sorted(comparable), "DOMINATED_BY": dominated_by, "PARETO_SET": PARETO_SET,
                    "EXCLUDED": {"CANDIDATE_V3_CONTROL": "CONTROL_NOT_HISTORICALLY_COMPARABLE"}},
}
for k, pol in POLICIES.items():
    entry = {"PERIOD_METRICS": pol["PERIODS"]}
    if "SEP_LATE_SUBPERIODS" in pol:
        entry["SEP_LATE_SUBPERIODS"] = pol["SEP_LATE_SUBPERIODS"]
    if k == "CANDIDATE_V3_CONTROL":
        entry["STATUS"] = pol["STATUS"]
    else:
        pn = stab({p: pol["PERIODS"][p] for p in ("AUG", "SEP_EARLY", "SEP_LATE") if "STATUS" not in pol["PERIODS"][p]})
        if k in ("P50_52", "P50_54"):
            pn = {"AUG": pol["PERIODS"]["AUG"]["PNL_U"], "SEP_EARLY": pol["PERIODS"]["SEP_EARLY"]["PNL_U"],
                  "SEP_13_20": pol["SEP_LATE_SUBPERIODS"]["SEP_13_20"]["PNL_U"], "SEP_21_24": pol["SEP_LATE_SUBPERIODS"]["SEP_21_24"]["PNL_U"]}
            entry["SUM_OF_PERIOD_SELECTED_N"] = sum(c["N_SELECTED"] for c in [pol["PERIODS"]["AUG"], pol["PERIODS"]["SEP_EARLY"], pol["SEP_LATE_SUBPERIODS"]["SEP_13_20"], pol["SEP_LATE_SUBPERIODS"]["SEP_21_24"]])
            entry["COMBINED_SELECTED_N"] = pol["PERIODS"]["COMBINED"]["N_SELECTED"]
        if pn:
            tot = sum(pn.values())
            entry["PERIOD_PNL_U"] = pn
            entry["PERIOD_PNL_SUM_U"] = round(tot, 2)
            entry["POSITIVE_PERIOD_N"] = sum(1 for v in pn.values() if v > 0)
            entry["PERIOD_N"] = len(pn)
            late = {kk: v for kk, v in pn.items() if kk in ("SEP_LATE", "SEP_13_20", "SEP_21_24")}
            entry["SEP_LATE_SHARE_OF_PERIOD_PNL_PCT"] = round(100 * sum(late.values()) / tot, 1) if tot else None
        zs = {}
        for pn_, c in pol["PERIODS"].items():
            z = z_hit(c)
            if z is not None:
                zs[pn_] = z
        for sp_, c in pol.get("SEP_LATE_SUBPERIODS", {}).items():
            z = z_hit(c)
            if z is not None:
                zs[sp_] = z
        entry["Z_HIT_VS_MEAN_ENTRY"] = zs or NC
    stability["POLICIES"][k] = entry
for fam in CANON_FAMILIES + ["UNRESOLVED_MARKET_TYPE"]:
    pn = {p: FAMILIES[fam][p]["PNL_U"] for p in ("AUG", "SEP_EARLY", "SEP_LATE")}
    stability["FAMILIES"][fam] = {
        "PERIOD_PNL_U": pn,
        "PERIOD_ROI_PCT": {p: FAMILIES[fam][p]["ROI_PCT"] for p in ("AUG", "SEP_EARLY", "SEP_LATE")},
        "PERIOD_N_SETTLED": {p: FAMILIES[fam][p]["N_SETTLED"] for p in ("AUG", "SEP_EARLY", "SEP_LATE")},
        "PERIOD_EVIDENCE": {p: FAMILIES[fam][p]["EVIDENCE_STATUS"] for p in PERIODS},
        "POSITIVE_PERIOD_N": sum(1 for v in pn.values() if v > 0),
        "COMBINED": {k2: FAMILIES[fam]["COMBINED"][k2] for k2 in ("N_SETTLED", "PNL_U", "ROI_PCT", "MAXDD_U", "EVIDENCE_STATUS")},
    }
wjson("PERIOD_STABILITY.json", stability)

# ---------------------------------------------------------------- 5. FORWARD CONFIRMATION
forward = {
    "MISSION": "FOOTBALL_CHAMPION_AND_MARKET_COHORT_CLOSURE_V3",
    "STATUS": "DEFERRED_TO_PRODUCTION_FORWARD_CONFIRMATION",
    "HISTORICAL_PERIOD_END": "2026-09-24",
    "REASON": "This DB Clone mission is historical authority only. No Sep25+ production results exist in these artifacts and none were fabricated.",
    "PRODUCTION_DB_READS": 0,
    "PRODUCTION_WRITES": 0,
    "CANDIDATES_FOR_FORWARD_CONFIRMATION": {
        "NOTE": "Descriptive shortlist from historical aggregates only. Not a freeze, not a promotion; the Founder decides what to fix.",
        "CORE_PARETO_SET": PARETO_SET,
        "SLEEVE_CANDIDATES_TO_CONFIRM": ["total_corners", "total_corners@odds[2.25,2.50)"],
        "STABILITY_FLAGS": ["Sep13+ hit rates far above price-implied in every 0.50-band cell", "spreads live-band anomaly needs lineage audit", "other_structured contains non-football market types"],
    },
    "CONFIRMATION_PRECONDITIONS": ["fix policy definitions before reading any Sep25+ result", "same SELECTION_BEFORE_SETTLEMENT semantics, one bet per physical event, OPEN != LOSS", "report OPEN separately until settled"],
}
wjson("CURRENT_FORWARD_CONFIRMATION.json", forward)

# ---------------------------------------------------------------- 6. SHA256SUMS
names = ["FOOTBALL_CORE_COMPARISON.md", "FOOTBALL_MARKET_FAMILY_COHORT.md", "FOOTBALL_MARKET_ODDS_COHORT.json",
         "PERIOD_STABILITY.json", "CURRENT_FORWARD_CONFIRMATION.json", "build_football_champion_market_cohort_v1.py"]
lines = []
for n in names:
    with open(os.path.join(OUT, n), "rb") as f:
        lines.append(f"{hashlib.sha256(f.read()).hexdigest()}  {n}")
wtext("SHA256SUMS.txt", "\n".join(lines) + "\n")
print(json.dumps({"PARETO_SET": PARETO_SET, "CENSUS_ALL_MATCH": CENSUS_ALL_MATCH, "FILES": names}))
