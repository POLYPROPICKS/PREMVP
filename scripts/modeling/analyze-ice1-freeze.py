#!/usr/bin/env python3
import csv
import json
import os
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = Path(os.environ.get("ICE1_MODEL_BASE_DIR") or Path.cwd())
INPUT = Path(os.environ.get("ICE1_MODEL_INPUT_PATH") or (BASE / "input" / "ice1_resolved_now_freeze_2026_06_17_0800_minsk.csv"))
REPORTS = Path(os.environ.get("ICE1_MODEL_REPORTS_DIR") or (BASE / "reports"))
TABLES = Path(os.environ.get("ICE1_MODEL_TABLES_DIR") or (BASE / "tables"))


def parse_dt(value):
    if not value:
        return None
    s = str(value).strip().replace("Z", "+00:00")
    if s.endswith("+00"):
        s = s[:-3] + "+00:00"
    if " " in s and "T" not in s:
        s = s.replace(" ", "T", 1)
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def num(value):
    if value is None:
        return None
    s = str(value).strip()
    if s == "" or s.lower() in {"null", "none", "nan"}:
        return None
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def pct(x):
    return "" if x is None else f"{x:.1f}%"


def money(x):
    return "" if x is None else f"${x:.2f}"


def cell(x):
    if x is None:
        return ""
    if isinstance(x, float):
        return f"{x:.4f}".rstrip("0").rstrip(".")
    return str(x)


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for row in rows:
            w.writerow({h: row.get(h, "") for h in headers})


def write_md_table(path, title, rows, headers):
    lines = [f"# {title}", ""]
    if not rows:
        lines.append("_No rows._")
    else:
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
        for row in rows:
            lines.append("| " + " | ".join(str(row.get(h, "")) for h in headers) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


@dataclass
class Row:
    raw: dict
    idx: int
    created_at: datetime | None
    resolved_at: datetime | None
    condition_id: str
    selected_token_id: str
    event_key: str
    signal_result: str
    ret: float | None
    score: float | None
    coverage: float | None
    price: float | None
    hours: float | None
    formula_version: str
    sport: str
    league: str
    market_family: str
    resolved_timing_bucket: str
    raw_json: dict
    smart_money: float | None
    whale_public: float | None
    pre_event: float | None

    @property
    def usable(self):
        return self.ret is not None

    @property
    def is_win(self):
        sr = self.signal_result.lower()
        if sr in {"win", "won", "hit", "correct", "yes", "winning"}:
            return True
        if self.ret is not None and self.ret > 0:
            return True
        return False

    @property
    def is_loss(self):
        sr = self.signal_result.lower()
        if sr in {"loss", "lost", "miss", "incorrect", "no", "losing"}:
            return True
        if self.ret is not None and self.ret < 0:
            return True
        return False

    @property
    def pnl10(self):
        return None if self.ret is None else 10.0 * self.ret / 100.0


def raw_metric(raw_json, key):
    if not isinstance(raw_json, dict):
        return None
    v = num(raw_json.get(key))
    if v is not None:
        return v
    diag = raw_json.get("diagnostics")
    if isinstance(diag, dict):
        v = num(diag.get(key))
        if v is not None:
            return v
    for m in raw_json.get("trust_metrics", []) if isinstance(raw_json.get("trust_metrics"), list) else []:
        if isinstance(m, dict) and str(m.get("id", "")).lower() in {key, key.replace("_score_num", "")}:
            return num(m.get("value") or m.get("bar"))
    return None


def load_rows():
    rows = []
    with INPUT.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for idx, r in enumerate(reader, 1):
            raw_json = {}
            try:
                raw_json = json.loads(r.get("raw_json") or "{}")
            except Exception:
                raw_json = {}
            ret = num(r.get("realized_return_pct"))
            sr = (r.get("signal_result") or "").strip().lower()
            if ret is None:
                if sr in {"win", "won", "hit", "correct", "yes"}:
                    ret = 100.0
                elif sr in {"loss", "lost", "miss", "incorrect", "no"}:
                    ret = -100.0
            rows.append(Row(
                raw=r,
                idx=idx,
                created_at=parse_dt(r.get("created_at")),
                resolved_at=parse_dt(r.get("resolved_at")),
                condition_id=(r.get("condition_id") or "").strip(),
                selected_token_id=(r.get("selected_token_id") or "").strip(),
                event_key=(r.get("event_key") or r.get("market_slug") or "").strip(),
                signal_result=sr,
                ret=ret,
                score=num(r.get("signal_confidence_num")),
                coverage=num(r.get("data_coverage_num")),
                price=num(r.get("entry_price_num")),
                hours=num(r.get("hours_until_start_num")),
                formula_version=(r.get("formula_version") or "").strip(),
                sport=(r.get("sport_or_scope") or "UNKNOWN").strip() or "UNKNOWN",
                league=(r.get("league") or "UNKNOWN").strip() or "UNKNOWN",
                market_family=(r.get("market_family") or "UNKNOWN").strip() or "UNKNOWN",
                resolved_timing_bucket=(r.get("resolved_timing_bucket") or "UNKNOWN").strip() or "UNKNOWN",
                raw_json=raw_json,
                smart_money=raw_metric(raw_json, "smart_money_score_num") or raw_metric(raw_json, "smart-money"),
                whale_public=raw_metric(raw_json, "whale_public_score_num") or raw_metric(raw_json, "public-vs-whale"),
                pre_event=raw_metric(raw_json, "pre_event_score_num") or raw_metric(raw_json, "pre-event-score"),
            ))
    return rows


def timing_bucket(r):
    h = r.hours
    if h is None:
        return "UNKNOWN"
    if h < 0:
        return "LIVE_OR_UNKNOWN"
    if h < 0.25:
        return "PRE_0_15M"
    if h < 1:
        return "PRE_15_59M"
    if h < 3:
        return "PRE_1_3H"
    if h < 6:
        return "PRE_3_6H"
    if h < 12:
        return "PRE_6_12H"
    if h < 24:
        return "PRE_12_24H"
    return "PRE_24H_PLUS"


def price_bucket(r):
    p = r.price
    if p is None:
        return "UNKNOWN"
    if p < 0.25:
        return "<0.25"
    if p < 0.35:
        return "0.25-0.34"
    if p < 0.45:
        return "0.35-0.44"
    if p < 0.55:
        return "0.45-0.54"
    if p < 0.65:
        return "0.55-0.64"
    return "0.65+"


def coverage_bucket(r):
    c = r.coverage
    if c is None:
        return "UNKNOWN"
    if c < 50:
        return "<50"
    if c < 65:
        return "50-64"
    if c < 75:
        return "65-74"
    return "75+"


def score_bucket(r):
    s = r.score
    if s is None:
        return "UNKNOWN"
    if s < 60:
        return "<60"
    if s < 65:
        return "60-64"
    if s < 68:
        return "65-67"
    if s < 72:
        return "68-71"
    if s < 75:
        return "72-74"
    if s < 80:
        return "75-79"
    return "80+"


def bad_bucket(r):
    return (
        r.coverage is not None and 50 <= r.coverage <= 74 and
        r.price is not None and 0.44 <= r.price <= 0.58
    )


def avoid_6_24(r):
    return r.hours is not None and 6 <= r.hours < 24


def avoid_3_12(r):
    return r.hours is not None and 3 <= r.hours < 12


def chronological(rows):
    return sorted(rows, key=lambda r: (r.resolved_at or r.created_at or datetime.min.replace(tzinfo=timezone.utc), r.idx))


def max_drawdown(pnls):
    peak = 0.0
    equity = 0.0
    max_dd = 0.0
    for p in pnls:
        equity += p
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    return max_dd


def losing_streak(rows):
    worst = cur = 0
    for r in chronological(rows):
        if r.pnl10 is not None and r.pnl10 < 0:
            cur += 1
            worst = max(worst, cur)
        else:
            cur = 0
    return worst


def metrics(rows, name=None):
    usable = [r for r in rows if r.usable]
    wins = sum(1 for r in usable if r.is_win)
    losses = sum(1 for r in usable if r.is_loss)
    pnls = [r.pnl10 for r in chronological(usable) if r.pnl10 is not None]
    pnl = sum(pnls)
    turnover = 10 * len(usable)
    dd = max_drawdown(pnls)
    avg = statistics.mean([r.ret for r in usable]) if usable else None
    med = statistics.median([r.ret for r in usable]) if usable else None
    event_count = len({r.event_key for r in usable if r.event_key})
    out = {
        "policy": name or "",
        "N": len(usable),
        "events": event_count,
        "wins": wins,
        "losses": losses,
        "win_rate": (wins / (wins + losses) * 100) if (wins + losses) else None,
        "pnl10": pnl,
        "roi": (pnl / turnover * 100) if turnover else None,
        "avg_return": avg,
        "median_return": med,
        "max_dd": dd,
        "pnl_dd": (pnl / dd) if dd > 0 else (999 if pnl > 0 else 0),
        "worst_losing_streak": losing_streak(usable),
    }
    return out


def latest_window(rows, hours):
    usable = [r for r in rows if r.usable and (r.resolved_at or r.created_at)]
    if not usable:
        return []
    latest = max((r.resolved_at or r.created_at) for r in usable)
    start = latest - timedelta(hours=hours)
    return [r for r in usable if (r.resolved_at or r.created_at) >= start]


def one_per_event(rows, threshold, best):
    groups = defaultdict(list)
    for r in rows:
        if r.score is not None and r.score >= threshold:
            groups[r.event_key or r.condition_id].append(r)
    selected = []
    for xs in groups.values():
        if best == "coverage":
            selected.append(sorted(xs, key=lambda r: (r.coverage or -1, r.score or -1, -(r.price or 9)), reverse=True)[0])
        else:
            selected.append(sorted(xs, key=lambda r: (r.score or -1, r.coverage or -1, -(r.price or 9)), reverse=True)[0])
    return selected


def policy_defs(rows):
    return [
        ("FLAT_ALL", lambda r: True),
        ("SCORE_GE_60", lambda r: r.score is not None and r.score >= 60),
        ("SCORE_GE_65", lambda r: r.score is not None and r.score >= 65),
        ("SCORE_GE_68", lambda r: r.score is not None and r.score >= 68),
        ("SCORE_GE_72", lambda r: r.score is not None and r.score >= 72),
        ("SCORE_GE_75", lambda r: r.score is not None and r.score >= 75),
        ("SCORE_GE_80", lambda r: r.score is not None and r.score >= 80),
        ("SCORE_GE_65_AVOID_6_24H", lambda r: r.score is not None and r.score >= 65 and not avoid_6_24(r)),
        ("SCORE_GE_72_AVOID_6_24H", lambda r: r.score is not None and r.score >= 72 and not avoid_6_24(r)),
        ("SCORE_GE_65_AVOID_3_12H_LEGACY", lambda r: r.score is not None and r.score >= 65 and not avoid_3_12(r)),
        ("SCORE_GE_72_AVOID_3_12H_LEGACY", lambda r: r.score is not None and r.score >= 72 and not avoid_3_12(r)),
        ("COVERAGE_GE_75_ALL", lambda r: r.coverage is not None and r.coverage >= 75),
        ("COVERAGE_GE_75_SCORE_GE_65", lambda r: r.coverage is not None and r.coverage >= 75 and r.score is not None and r.score >= 65),
        ("COVERAGE_GE_75_SCORE_GE_72", lambda r: r.coverage is not None and r.coverage >= 75 and r.score is not None and r.score >= 72),
        ("COVERAGE_50_74_SCORE_GE_65", lambda r: r.coverage is not None and 50 <= r.coverage <= 74 and r.score is not None and r.score >= 65),
        ("COVERAGE_50_74_SCORE_GE_72", lambda r: r.coverage is not None and 50 <= r.coverage <= 74 and r.score is not None and r.score >= 72),
        ("PRICE_035_044_ALL", lambda r: r.price is not None and 0.35 <= r.price < 0.45),
        ("PRICE_035_044_SCORE_GE_65", lambda r: r.price is not None and 0.35 <= r.price < 0.45 and r.score is not None and r.score >= 65),
        ("PRICE_035_044_SCORE_GE_72", lambda r: r.price is not None and 0.35 <= r.price < 0.45 and r.score is not None and r.score >= 72),
        ("PRICE_025_034_ALL", lambda r: r.price is not None and 0.25 <= r.price < 0.35),
        ("PRICE_045_054_ALL", lambda r: r.price is not None and 0.45 <= r.price < 0.55),
        ("BAD_BUCKET_COV50_74_PRICE044_058_ALL", bad_bucket),
        ("EXCLUDE_BAD_BUCKET_SCORE_GE_65", lambda r: r.score is not None and r.score >= 65 and not bad_bucket(r)),
        ("EXCLUDE_BAD_BUCKET_SCORE_GE_72", lambda r: r.score is not None and r.score >= 72 and not bad_bucket(r)),
        ("ONE_PER_EVENT_SCORE_GE_65_BEST_SCORE", lambda r: False),
        ("ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE", lambda r: False),
        ("ONE_PER_EVENT_SCORE_GE_65_BEST_COVERAGE", lambda r: False),
        ("ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", lambda r: False),
        ("ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE", lambda r: False),
        ("FIREMODEL1_APPROX_CURRENT", lambda r: r.score is not None and r.score >= 65 and r.coverage is not None and r.coverage >= 50 and not bad_bucket(r)),
        ("ALT_SM_GUARD_ON_PRIMARY_APPROX", lambda r: r.score is not None and r.score >= 65 and r.coverage is not None and r.coverage >= 50 and (r.smart_money is None or r.smart_money < 85) and not bad_bucket(r)),
        ("ALT3_FLAT10_RAW_PROFIT_APPROX", lambda r: r.score is not None and r.score >= 65),
        ("ALT1_ONE_PER_EVENT_BEST_COVERAGE_APPROX", lambda r: False),
        ("TRUST_V2_EXEC_A_TOP33_APPROX", lambda r: r.score is not None and r.coverage is not None and r.price is not None and (r.score + r.coverage) >= 140 and 0.25 <= r.price <= 0.65),
        ("TRUST_V2_EXEC_C_TOP33_APPROX", lambda r: False),
        ("FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX", lambda r: r.score is not None and r.score >= 65 and (r.smart_money is None or r.smart_money < 85)),
    ]


def status_for(m, operational=False, approx=False):
    n, pnl, roi, dd = m["N"], m["pnl10"], m["roi"], m["max_dd"]
    if operational:
        return "OPERATIONAL_GUARD_ONLY"
    if n < 20:
        return "NEED_MORE_DATA"
    if pnl > 0 and roi is not None and roi >= 10 and dd <= max(60, abs(pnl) * 1.2):
        return "KEEP" if approx else "LOCK"
    if pnl > 0 and roi is not None and roi > 0:
        return "SHADOW"
    return "REJECT"


def row_for_policy(name, selected):
    m = metrics(selected, name)
    for label, hrs in [("24h", 24), ("48h", 48), ("96h", 96), ("7d", 168)]:
        wm = metrics(latest_window(selected, hrs))
        m[f"{label}_N"] = wm["N"]
        m[f"{label}_pnl10"] = wm["pnl10"]
        m[f"{label}_roi"] = wm["roi"]
    m["status"] = status_for(m, operational=name.startswith("BAD_BUCKET"), approx="APPROX" in name)
    return m


def compute_policies(rows):
    out = []
    for name, pred in policy_defs(rows):
        if name == "ONE_PER_EVENT_SCORE_GE_65_BEST_SCORE":
            selected = one_per_event(rows, 65, "score")
        elif name == "ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE":
            selected = one_per_event(rows, 72, "score")
        elif name == "ONE_PER_EVENT_SCORE_GE_65_BEST_COVERAGE":
            selected = one_per_event(rows, 65, "coverage")
        elif name == "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE":
            selected = one_per_event(rows, 72, "coverage")
        elif name == "ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE":
            selected = [r for r in one_per_event(rows, 72, "coverage") if not avoid_6_24(r)]
        elif name == "ALT1_ONE_PER_EVENT_BEST_COVERAGE_APPROX":
            selected = one_per_event([r for r in rows if not bad_bucket(r)], 65, "coverage")
        elif name == "TRUST_V2_EXEC_C_TOP33_APPROX":
            candidates = [r for r in rows if r.score is not None and r.coverage is not None]
            selected = sorted(candidates, key=lambda r: (r.score or 0) + (r.coverage or 0), reverse=True)[:33]
        else:
            selected = [r for r in rows if pred(r)]
        out.append(row_for_policy(name, selected))
    return out


def table_policy_rows(policies):
    headers = ["policy", "N", "events", "wins", "losses", "win_rate", "pnl10", "roi", "avg_return", "median_return", "max_dd", "pnl_dd", "worst_losing_streak", "24h_N", "24h_pnl10", "24h_roi", "48h_N", "48h_pnl10", "48h_roi", "96h_N", "96h_pnl10", "96h_roi", "7d_N", "7d_pnl10", "7d_roi", "status"]
    rows = []
    for m in policies:
        rows.append({k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()})
    write_csv(TABLES / "policy_kpis.csv", rows, headers)
    md_rows = []
    for m in rows:
        md = dict(m)
        for k in ["win_rate", "roi", "avg_return", "median_return", "24h_roi", "48h_roi", "96h_roi", "7d_roi"]:
            md[k] = pct(md.get(k)) if md.get(k) != "" else ""
        for k in ["pnl10", "max_dd", "24h_pnl10", "48h_pnl10", "96h_pnl10", "7d_pnl10"]:
            md[k] = money(md.get(k)) if md.get(k) != "" else ""
        md_rows.append(md)
    write_md_table(REPORTS / "01_policy_kpis.md", "Ice1 Policy KPI Table", md_rows, headers)


def cohort_status(m):
    if m["N"] < 10:
        return "LOW_N"
    if m["pnl10"] > 0 and (m["roi"] or 0) > 5:
        return "PROMISING"
    if m["pnl10"] < 0 and (m["roi"] or 0) < -5:
        return "BAD"
    return "MIXED"


def make_cohort(rows, name, keyfn):
    groups = defaultdict(list)
    for r in rows:
        groups[keyfn(r)].append(r)
    out = []
    for k, xs in groups.items():
        m = metrics(xs)
        out.append({
            "cohort_table": name,
            "cohort": k,
            "N": m["N"],
            "wins": m["wins"],
            "losses": m["losses"],
            "win_rate": round(m["win_rate"], 4) if m["win_rate"] is not None else "",
            "pnl10": round(m["pnl10"], 4),
            "roi": round(m["roi"], 4) if m["roi"] is not None else "",
            "avg_return": round(m["avg_return"], 4) if m["avg_return"] is not None else "",
            "max_dd": round(m["max_dd"], 4),
            "status": cohort_status(m),
        })
    return sorted(out, key=lambda x: (x["cohort_table"], str(x["cohort"])))


def compute_cohorts(rows):
    specs = [
        ("score_bucket", score_bucket),
        ("price_bucket", price_bucket),
        ("coverage_bucket", coverage_bucket),
        ("timing_bucket", timing_bucket),
        ("sport_or_scope", lambda r: r.sport),
        ("league", lambda r: r.league),
        ("market_family", lambda r: r.market_family),
        ("formula_version", lambda r: r.formula_version),
        ("resolved_timing_bucket", lambda r: r.resolved_timing_bucket),
        ("price_x_coverage", lambda r: f"{price_bucket(r)} x {coverage_bucket(r)}"),
        ("score_x_price", lambda r: f"{score_bucket(r)} x {price_bucket(r)}"),
        ("score_x_coverage", lambda r: f"{score_bucket(r)} x {coverage_bucket(r)}"),
        ("sport_x_price", lambda r: f"{r.sport} x {price_bucket(r)}"),
        ("sport_x_coverage", lambda r: f"{r.sport} x {coverage_bucket(r)}"),
        ("timing_x_score", lambda r: f"{timing_bucket(r)} x {score_bucket(r)}"),
        ("market_family_x_score", lambda r: f"{r.market_family} x {score_bucket(r)}"),
    ]
    all_rows = []
    for name, fn in specs:
        all_rows.extend(make_cohort(rows, name, fn))
    headers = ["cohort_table", "cohort", "N", "wins", "losses", "win_rate", "pnl10", "roi", "avg_return", "max_dd", "status"]
    write_csv(TABLES / "cohort_tables.csv", all_rows, headers)
    md_rows = []
    for r in all_rows:
        d = dict(r)
        d["win_rate"] = pct(d["win_rate"]) if d["win_rate"] != "" else ""
        d["roi"] = pct(d["roi"]) if d["roi"] != "" else ""
        d["avg_return"] = pct(d["avg_return"]) if d["avg_return"] != "" else ""
        d["pnl10"] = money(d["pnl10"])
        d["max_dd"] = money(d["max_dd"])
        md_rows.append(d)
    write_md_table(REPORTS / "02_cohorts.md", "Ice1 Cohort Tables", md_rows, headers)
    return all_rows


def stake_for(r, policy):
    if policy == "flat_5":
        return 5
    if policy == "flat_7":
        return 7
    if policy == "flat_10":
        return 10
    if policy == "bounded_variable":
        if r.score is None:
            return 0
        if r.score >= 72 and (r.coverage or 0) >= 75 and not bad_bucket(r) and not avoid_6_24(r):
            return 10
        if r.score >= 65 and (r.coverage or 0) >= 75 and r.price is not None and 0.35 <= r.price < 0.45:
            return 7
        if r.score >= 65:
            return 5
        return 0
    if policy == "defensive":
        return 5 if r.score is not None and r.score >= 65 and not bad_bucket(r) and not avoid_6_24(r) else 0
    if policy == "aggressive":
        return 10 if r.score is not None and r.score >= 65 else 0
    return 0


def simulate_bankroll(rows):
    policies = ["flat_5", "flat_7", "flat_10", "bounded_variable", "defensive", "aggressive"]
    out = []
    for p in policies:
        bank = 300.0
        peak = bank
        min_bank = bank
        max_dd = 0.0
        turnover = 0.0
        pnl = 0.0
        worst_loss = cur_loss = 0
        bets = 0
        for r in chronological([x for x in rows if x.usable]):
            stake = stake_for(r, p)
            if stake <= 0:
                continue
            bets += 1
            turnover += stake
            rpnl = stake * (r.ret or 0) / 100.0
            pnl += rpnl
            bank += rpnl
            peak = max(peak, bank)
            min_bank = min(min_bank, bank)
            max_dd = max(max_dd, peak - bank)
            if rpnl < 0:
                cur_loss += 1
                worst_loss = max(worst_loss, cur_loss)
            else:
                cur_loss = 0
        out.append({
            "stake_policy": p,
            "bets": bets,
            "final_bank": round(bank, 2),
            "total_pnl": round(pnl, 2),
            "roi_on_turnover": round((pnl / turnover * 100), 4) if turnover else "",
            "max_drawdown_dollars": round(max_dd, 2),
            "max_drawdown_pct": round((max_dd / peak * 100), 4) if peak else "",
            "minimum_equity": round(min_bank, 2),
            "CSM": round(pnl / max_dd, 4) if max_dd else (999 if pnl > 0 else 0),
            "LHM_proxy": "open-position chronology unavailable",
            "worst_losing_streak": worst_loss,
            "survives_300": "YES" if min_bank > 0 else "NO",
            "path_comment": "plausible_to_1k_only_with_scale_and_edge" if bank > 300 else "not_plausible_without_filtering",
        })
    headers = ["stake_policy", "bets", "final_bank", "total_pnl", "roi_on_turnover", "max_drawdown_dollars", "max_drawdown_pct", "minimum_equity", "CSM", "LHM_proxy", "worst_losing_streak", "survives_300", "path_comment"]
    write_csv(TABLES / "bankroll_simulations.csv", out, headers)
    md_rows = []
    for r in out:
        d = dict(r)
        d["final_bank"] = money(d["final_bank"])
        d["total_pnl"] = money(d["total_pnl"])
        d["roi_on_turnover"] = pct(d["roi_on_turnover"]) if d["roi_on_turnover"] != "" else ""
        d["max_drawdown_dollars"] = money(d["max_drawdown_dollars"])
        d["max_drawdown_pct"] = pct(d["max_drawdown_pct"]) if d["max_drawdown_pct"] != "" else ""
        d["minimum_equity"] = money(d["minimum_equity"])
        md_rows.append(d)
    REPORTS.joinpath("03_bankroll_simulations.md").write_text(
        "# Ice1 Bankroll Simulations\n\nKELLY_NOT_AVAILABLE until calibrated probability exists.\n\n" +
        "| " + " | ".join(headers) + " |\n" +
        "| " + " | ".join(["---"] * len(headers)) + " |\n" +
        "\n".join("| " + " | ".join(str(r.get(h, "")) for h in headers) + " |" for r in md_rows) +
        "\n\n$300 -> $1k/$3k/$10k is not validated by this freeze alone; use as shadow sizing evidence only.\n",
        encoding="utf-8",
    )
    return out


def summary_report(rows):
    key_fields = ["signal_confidence_num", "data_coverage_num", "entry_price_num", "hours_until_start_num", "sport_or_scope", "market_family", "realized_return_pct"]
    formula_counts = defaultdict(int)
    for r in rows:
        formula_counts[r.formula_version or "UNKNOWN"] += 1
    created = [r.created_at for r in rows if r.created_at]
    resolved = [r.resolved_at for r in rows if r.resolved_at]
    missing = {k: sum(1 for r in rows if (r.raw.get(k) or "").strip() == "") for k in key_fields}
    strict = len({f"{r.condition_id}::{r.selected_token_id}" for r in rows if r.condition_id and r.selected_token_id})
    events = len({r.event_key for r in rows if r.event_key})
    lines = [
        "# Ice1 Input Freeze Summary",
        "",
        f"- CSV path used: `{INPUT}`",
        f"- row count: {len(rows)}",
        f"- usable resolved rows: {sum(1 for r in rows if r.usable)}",
        f"- distinct condition_id + selected_token_id: {strict}",
        f"- distinct events: {events}",
        f"- created_at range: {min(created).isoformat() if created else 'UNKNOWN'} -> {max(created).isoformat() if created else 'UNKNOWN'}",
        f"- resolved_at range: {min(resolved).isoformat() if resolved else 'UNKNOWN'} -> {max(resolved).isoformat() if resolved else 'UNKNOWN'}",
        "",
        "## Formula Version Counts",
        "",
    ]
    for k, v in sorted(formula_counts.items()):
        lines.append(f"- {k}: {v}")
    lines += ["", "## Missingness", ""]
    for k, v in missing.items():
        lines.append(f"- {k}: {v}")
    REPORTS.joinpath("00_input_freeze_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"row_count": len(rows), "usable": sum(1 for r in rows if r.usable), "strict": strict, "events": events}


def decision_board(policies, bankroll):
    include = {
        "SCORE_GE_65", "SCORE_GE_72", "SCORE_GE_72_AVOID_6_24H",
        "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE",
        "ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE",
        "FIREMODEL1_APPROX_CURRENT", "ALT_SM_GUARD_ON_PRIMARY_APPROX",
        "ALT3_FLAT10_RAW_PROFIT_APPROX", "ALT1_ONE_PER_EVENT_BEST_COVERAGE_APPROX",
        "TRUST_V2_EXEC_A_TOP33_APPROX", "TRUST_V2_EXEC_C_TOP33_APPROX",
        "FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX",
    }
    selected = [p for p in policies if p["policy"] in include]
    selected.sort(key=lambda m: (m["pnl_dd"], m["pnl10"]), reverse=True)
    rows = []
    for i, m in enumerate(selected, 1):
        rows.append({
            "rank": i,
            "policy": m["policy"],
            "role": "candidate_model" if "APPROX" in m["policy"] else "decision_candidate",
            "exact_vs_approx": "APPROX" if "APPROX" in m["policy"] else "EXACT_RULE",
            "N": m["N"],
            "pnl": money(m["pnl10"]),
            "roi": pct(m["roi"]),
            "maxDD": money(m["max_dd"]),
            "pnlDD": round(m["pnl_dd"], 4),
            "7d_roi": pct(m["7d_roi"]),
            "7d_pnl": money(m["7d_pnl10"]),
            "bankroll_300_survival": "YES" if any(b["survives_300"] == "YES" for b in bankroll) else "NO",
            "status": m["status"],
            "reason": "best risk-adjusted freeze evidence" if m["pnl10"] > 0 else "negative freeze PnL",
        })
    headers = ["rank", "policy", "role", "exact_vs_approx", "N", "pnl", "roi", "maxDD", "pnlDD", "7d_roi", "7d_pnl", "bankroll_300_survival", "status", "reason"]
    write_md_table(REPORTS / "04_decision_board.md", "Ice1 Decision Board", rows, headers)
    write_csv(TABLES / "decision_board.csv", rows, headers)
    return rows


def run_log(summary):
    REPORTS.joinpath("00_run_log.md").write_text(
        "# Ice1 Modeling Run Log\n\n"
        f"- run: 2026-06-17 Ice1 modeling sprint on fresh resolved freeze\n"
        f"- input: `{INPUT}`\n"
        f"- mode: local analysis only; no DB, no curl, no production code changes\n"
        f"- resolved labeled corpus: {summary['usable']} usable rows\n"
        f"- note: post-c88f036 rows are not modeled until resolved/labeled\n",
        encoding="utf-8",
    )


def next_phase_prompt(summary, top_policy):
    text = f"""# Next Phase Prompt

CODEX TASK - Ice1 next modeling phase

MODE: Local analysis first. No DB writes. No live executor changes without explicit approval.

Objective:
Use the Ice1 sprint outputs in `modeling/ice1_modeling_20260617_0800_minsk/` to reconstruct exact FireModel definitions from local repo scripts/artifacts, then compare them against `{top_policy}` on the same freeze.

Inputs:
- Freeze rows: {summary['usable']}
- Reports: `reports/01_policy_kpis.md`, `reports/04_decision_board.md`
- Tables: `tables/policy_kpis.csv`, `tables/cohort_tables.csv`, `tables/bankroll_simulations.csv`

Required:
1. Recover exact FireModel1 / ALT / TRUST / FLOW definitions from repo artifacts.
2. Label anything unrecoverable as APPROX.
3. Re-run KPI, drawdown, and $300 bankroll sims.
4. Decide whether any model should move from SHADOW to pilot.
5. Do not touch production/live executor files.
"""
    REPORTS.joinpath("05_next_phase_prompt.md").write_text(text, encoding="utf-8")


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    TABLES.mkdir(parents=True, exist_ok=True)
    rows = load_rows()
    summary = summary_report(rows)
    if summary["usable"] < 500:
        raise SystemExit("STOP: fewer than 500 usable resolved rows")
    if not any(r.ret is not None for r in rows):
        raise SystemExit("STOP: no numeric realized_return_pct")
    run_log(summary)
    policies = compute_policies(rows)
    table_policy_rows(policies)
    cohorts = compute_cohorts(rows)
    bankroll = simulate_bankroll(rows)
    board = decision_board(policies, bankroll)
    best = max(policies, key=lambda m: (m["pnl_dd"], m["pnl10"]))
    top_pnl = sorted(policies, key=lambda m: m["pnl10"], reverse=True)[:5]
    top_pnl_dd = sorted(policies, key=lambda m: (m["pnl_dd"], m["pnl10"]), reverse=True)[:5]
    next_phase_prompt(summary, best["policy"])
    overview = {
        "summary": summary,
        "top_pnl_dd": top_pnl_dd,
        "top_pnl": top_pnl,
        "bankroll": bankroll,
        "decision_board": board,
        "cohort_rows": len(cohorts),
    }
    (TABLES / "run_summary.json").write_text(json.dumps(overview, indent=2, default=str), encoding="utf-8")
    print(json.dumps({
        "resolved_N": summary["usable"],
        "events": summary["events"],
        "strict_tokens": summary["strict"],
        "top_pnl_dd": [m["policy"] for m in top_pnl_dd],
        "top_pnl": [m["policy"] for m in top_pnl],
        "best_bankroll": max(bankroll, key=lambda b: (b["final_bank"], b["CSM"]))["stake_policy"],
    }, indent=2))


if __name__ == "__main__":
    main()
