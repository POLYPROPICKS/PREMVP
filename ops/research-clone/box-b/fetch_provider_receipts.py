#!/usr/bin/env python3
"""Box B provider receipt collector (read-only HTTPS; no DB access, no secrets).

Usage: fetch_provider_receipts.py <frozen_input.csv> <out_dir>
Writes raw provider bodies byte-for-byte, then receipts_index.json (digests,
timestamps, classification). Classification never treats absence as LOSS/VOID.
"""
import hashlib, json, re, sys, time, urllib.request, urllib.error, datetime, pathlib

GAMMA = "https://gamma-api.polymarket.com/markets"
CLOB = "https://clob.polymarket.com/markets/"
COND_RE = re.compile(r"^0x[0-9a-f]{64}$")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def get(url):
    checked = now()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "boxb-collector/1"}), timeout=30) as r:
            return r.status, r.read(), None, checked
    except urllib.error.HTTPError as e:
        return e.code, e.read(), None, checked
    except Exception as e:  # network failure: no body at all
        return None, b"", f"{type(e).__name__}: {e}", checked


def receipt(out, name, provider, kind, key, url):
    status, body, err, checked = get(url)
    (out / f"{name}.raw").write_bytes(body)
    return {"provider": provider, "request_kind": kind, "request_key": key, "request_url": url,
            "http_status": status, "fetch_error": err, "fetched_at": checked,
            "raw_digest": hashlib.sha256(body).hexdigest(), "file": f"{name}.raw", "bytes": len(body)}


def parse(rc):
    try:
        return json.loads(pathlib.Path(rc["_dir"], rc["file"]).read_bytes().decode("utf-8"))
    except Exception:
        return None


def classify(cond, g_rc, c_rc, g, c):
    """Return (status, reason, winner, gamma_winner, clob_winner, tokens, resolved_at, time_src)."""
    base = dict(winner=None, gw=None, cw=None, tokens=None, resolved_at=None, time_src=None)
    if g_rc["http_status"] != 200 or c_rc["http_status"] != 200:
        return "LOOKUP_FAILED", f"gamma_http={g_rc['http_status']} clob_http={c_rc['http_status']}", base
    if not (isinstance(g, list) and len(g) == 1 and isinstance(c, dict)):
        return "LOOKUP_FAILED", f"gamma_shape_ok={isinstance(g, list) and len(g)==1} clob_shape_ok={isinstance(c, dict)}", base
    gm = g[0]
    if gm.get("conditionId") != cond or c.get("condition_id") != cond:
        return "CONFLICT", "condition_id mismatch between request and provider payloads", base
    try:
        gt = json.loads(gm["clobTokenIds"]); gp = [float(x) for x in json.loads(gm["outcomePrices"])]
        ct = [t["token_id"] for t in c["tokens"]]
    except Exception as e:
        return "LOOKUP_FAILED", f"unparseable provider payload: {type(e).__name__}", base
    base["tokens"] = gt
    if sorted(gt) != sorted(ct) or len(gt) != len(gp):
        return "CONFLICT", "gamma and clob token sets differ", base
    g_closed, c_closed = bool(gm.get("closed")), bool(c.get("closed"))
    winners = [t["token_id"] for t in c["tokens"] if t.get("winner")]
    g_win = [gt[i] for i, p in enumerate(gp) if p == 1.0]
    if g_closed != c_closed:
        return "CONFLICT", f"closed differs gamma={g_closed} clob={c_closed}", base
    if not g_closed:
        return "PENDING", "market not closed on either provider", base
    ct_time = gm.get("closedTime") or gm.get("umaEndDate")
    if ct_time and gm.get("closedTime"):
        resolved_at = gm["closedTime"].replace(" ", "T"); src = "gamma.closedTime"
        if re.search(r"[+-]\d\d$", resolved_at): resolved_at += ":00"
    elif gm.get("umaEndDate"):
        resolved_at = gm["umaEndDate"]; src = "gamma.umaEndDate"
    else:
        resolved_at = src = None
    base.update(gw=g_win[0] if len(g_win) == 1 else None, cw=winners[0] if len(winners) == 1 else None,
                resolved_at=resolved_at, time_src=src)
    if len(g_win) == 1 and len(winners) == 1 and all(p in (0.0, 1.0) for p in gp):
        if g_win[0] != winners[0]:
            return "CONFLICT", "gamma and clob name different winner tokens", base
        if not resolved_at:
            return "PENDING", "closed with winner but no provider resolution time", base
        base["winner"] = winners[0]
        return "FINAL", "gamma+clob closed, identical single winner, provider time present", base
    if not winners and gp and all(p == 0.5 for p in gp):
        if not resolved_at:
            return "PENDING", "closed 50/50 but no provider resolution time", base
        return "VOID", "closed, no winner token, outcomePrices all 0.5", base
    if len(winners) > 1 or len(g_win) > 1:
        return "CONFLICT", "multiple winner tokens", base
    return "PENDING", "closed but no terminal winner/void evidence yet", base


def main(inp, outdir):
    out = pathlib.Path(outdir); out.mkdir(parents=True, exist_ok=True)
    idx = []
    for i, line in enumerate(open(inp).read().split()):
        cond_in, token = line.strip().split(",")
        item = {"seq": i + 1, "input_condition_id": cond_in, "input_token_id": token,
                "has_paper_decision_evidence_only": i < 8}
        cond, lookup_note = cond_in, None
        if not COND_RE.match(cond_in):
            # Malformed identity (wrong length): resolve ONLY through the exact token id.
            g0 = receipt(out, f"{i+1:02d}_gamma_token", "gamma", "token_id", token,
                         f"{GAMMA}?clob_token_ids={token}&closed=true")
            body = json.loads((out / g0["file"]).read_bytes() or b"[]") if g0["http_status"] == 200 else []
            ids = {m.get("conditionId") for m in body}
            item["token_lookup_receipt"] = g0
            if len(ids) == 1:
                cond = ids.pop()
                it = iter(cond[2:])
                item["identity_repair"] = {"input_len": len(cond_in), "resolved_condition_id": cond,
                    "resolved_via": "gamma clob_token_ids exact match, closed=true",
                    "input_is_subsequence_of_provider_id": all(ch in it for ch in cond_in[2:])}
            else:
                item["identity_repair"] = {"resolved_condition_id": None}
                item["classification"] = {"status": "LOOKUP_FAILED", "reason": "malformed condition_id and token lookup not unique"}
                idx.append(item); continue
        g_rc = receipt(out, f"{i+1:02d}_gamma", "gamma", "condition_id", cond, f"{GAMMA}?condition_ids={cond}&closed=true")
        c_rc = receipt(out, f"{i+1:02d}_clob", "clob", "condition_id", cond, f"{CLOB}{cond}")
        for rc in (g_rc, c_rc): rc["_dir"] = str(out)
        g, c = parse(g_rc), parse(c_rc)
        st, reason, d = classify(cond, g_rc, c_rc, g, c)
        for rc in (g_rc, c_rc): rc.pop("_dir")
        item.update(condition_id=cond, gamma_receipt=g_rc, clob_receipt=c_rc,
                    token_membership_of_input_token=(token in (d["tokens"] or [])),
                    classification={"status": st, "reason": reason, "winner_token_id": d["winner"],
                                    "gamma_winner_token_id": d["gw"], "clob_winner_token_id": d["cw"],
                                    "market_token_ids": d["tokens"], "resolved_at": d["resolved_at"],
                                    "resolution_time_source": d["time_src"]})
        idx.append(item); time.sleep(0.2)
    (out / "receipts_index.json").write_text(json.dumps(idx, indent=1, sort_keys=True) + "\n")
    from collections import Counter
    print(dict(Counter(x["classification"]["status"] for x in idx)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
