#!/usr/bin/env bash
# IRELAND_BATTLE_QUEUE_ONLY_INSTALL_AND_UNLOCK.sh
# Contur3 Battle 2026-06-23 — Ireland Queue-Only Watcher Installer & Unlock
#
# COPY-PASTE SAFE for Ireland terminal.
# DO NOT execute from PREMVP Claude Code.
#
# Usage (hard-stop ON, dry verification only):
#   bash IRELAND_BATTLE_QUEUE_ONLY_INSTALL_AND_UNLOCK.sh
#
# Usage (CEO unlock, removes hard-stop):
#   bash IRELAND_BATTLE_QUEUE_ONLY_INSTALL_AND_UNLOCK.sh --remove-hard-stop=CEO_APPROVED
#
# ROLLBACK at any time:
#   touch /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP
#   pkill -f "[c]ontur3_battle_queue_only_watcher.py" || true

set -euo pipefail

EXECUTOR_DIR="/home/ubuntu/polymarket-executor"
cd "$EXECUTOR_DIR" || { echo "ERROR: cannot cd $EXECUTOR_DIR"; exit 1; }

# ── Hard-stop: ON by default ──────────────────────────────────────────────────
touch /tmp/PPP_LIVE_HARD_STOP
mkdir -p data && touch data/PPP_LIVE_HARD_STOP
echo "[HARD-STOP] Hard-stop files created. Live sends BLOCKED."

# ── Load env ──────────────────────────────────────────────────────────────────
ENV_FILE="config/executor-source.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  echo "[ENV] Loaded $ENV_FILE"
else
  echo "WARN: $ENV_FILE not found — falling back to env vars"
fi

BASE="${BASE:-https://polypropicks.com}"
QUEUE_SOURCE="${QUEUE_SOURCE:-/api/executor/queue}"
SECRET="${PPP_SECRET:-${EXECUTOR_SECRET:-}}"

if [ -z "$SECRET" ]; then
  echo "ERROR: PPP_SECRET or EXECUTOR_SECRET must be set"; exit 1
fi
if [ "$BASE" != "https://polypropicks.com" ]; then
  echo "ERROR: BASE must be https://polypropicks.com, got: $BASE"; exit 1
fi
if [ "$QUEUE_SOURCE" != "/api/executor/queue" ]; then
  echo "ERROR: QUEUE_SOURCE must be /api/executor/queue, got: $QUEUE_SOURCE"; exit 1
fi

echo "[CONTRACT] BASE=$BASE  QUEUE_SOURCE=$QUEUE_SOURCE"

# ── Quarantine old wrappers ───────────────────────────────────────────────────
OLD_WRAPPERS=(
  "scripts/run_ireland_trusted_live.sh"
  "scripts/ireland_trusted_pull_loop.py"
  "scripts/run_tonight_live_loop.sh"
  "scripts/start_contur3_p0f_live.sh"
  "scripts/start_contur3_p0f_norepull_live.sh"
)
for w in "${OLD_WRAPPERS[@]}"; do
  if [ -f "$w" ]; then
    chmod -x "$w" 2>/dev/null || true
    echo "[QUARANTINE] $w — not executable"
  else
    echo "[OK] old wrapper not found: $w"
  fi
done

# ── Verify active source does NOT call forbidden endpoints ────────────────────
if grep -r "/api/executor/night-plan\|/api/executor/candidates" scripts/ 2>/dev/null | grep -v "\.py~\|#"; then
  echo "ERROR: Active source references forbidden endpoints (night-plan or broad candidates)"; exit 1
fi
echo "[OK] No forbidden endpoint references in scripts/"

# ── Write contur3_battle_queue_only_watcher.py ───────────────────────────────
WATCHER="scripts/contur3_battle_queue_only_watcher.py"
cat > "$WATCHER" << 'PYEOF'
#!/usr/bin/env python3
"""
contur3_battle_queue_only_watcher.py
Contur3 Battle Queue-Only Watcher — 2026-06-23
Polls /api/executor/queue, executes ALL valid READY candidates sequentially.
Hard-stop checked before every send. Never calls /night-plan or broad candidates.
"""
import os, sys, time, json, logging, subprocess, pathlib, datetime, requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/contur3_battle_watcher.log", mode="a"),
    ],
)
log = logging.getLogger("contur3_battle")

BASE = os.environ.get("BASE", "https://polypropicks.com")
SECRET = os.environ.get("PPP_SECRET") or os.environ.get("EXECUTOR_SECRET", "")
QUEUE_URL = BASE + "/api/executor/queue"
MARK_URL  = BASE + "/api/executor/queue/mark"
HEADERS   = {"x-executor-secret": SECRET}

HARD_STOP_FILES = ["/tmp/PPP_LIVE_HARD_STOP", "data/PPP_LIVE_HARD_STOP"]
MAX_STAKE_USD   = 7
BATTLE_START_UTC = 19   # 22:00 Minsk = 19:00 UTC
BATTLE_END_UTC   = 4    # 07:00 Minsk = 04:00 UTC
DEFAULT_POLL_SEC = 60

pathlib.Path("logs").mkdir(exist_ok=True)


def hard_stop_active() -> bool:
    return any(pathlib.Path(f).exists() for f in HARD_STOP_FILES)


def in_battle_window() -> bool:
    h = datetime.datetime.utcnow().hour
    # 19:00–24:00 or 00:00–04:00 UTC
    return h >= BATTLE_START_UTC or h < BATTLE_END_UTC


def validate_candidate(c: dict) -> str | None:
    """Returns error string if invalid, else None."""
    if c.get("source") and c["source"] not in ("event_execution_queue", None):
        return f"invalid source={c.get('source')}"
    if not c.get("condition_id"):
        return "missing condition_id"
    if not c.get("token_id"):
        return "missing token_id"
    if not c.get("side"):
        return "missing side"
    stake = c.get("stake_usd", 0)
    if stake > MAX_STAKE_USD:
        return f"stake_usd={stake} > {MAX_STAKE_USD}"
    slug = (c.get("market_slug") or "").lower()
    family = (c.get("market_family") or "").lower()
    key = (c.get("match_family_key") or "").lower()
    halftime_re = "halftime|half.time|first.half|1st.half|leading.at.halftime|draw.at.halftime"
    import re
    for field in (slug, family, key):
        if re.search(halftime_re, field):
            return f"halftime/first-half market blocked: {field}"
    # Entry window check
    latest_iso = c.get("latest_entry_iso")
    if latest_iso:
        import datetime as dt
        try:
            latest = dt.datetime.fromisoformat(latest_iso.replace("Z", "+00:00"))
            if latest < dt.datetime.now(dt.timezone.utc):
                return f"latest_entry_iso expired: {latest_iso}"
        except Exception:
            pass
    order_key = c.get("order_key")
    if not order_key:
        return "missing order_key"
    return None


def mark(queue_id: str, status: str, reason: str = "", live_confirmed: bool = False,
         order_id: str = "", tx_hash: str = ""):
    try:
        payload = {
            "queue_id": queue_id,
            "status": status,
            "source": "ireland_queue_only",
            "reason": reason,
            "live_order_confirmed": live_confirmed,
            "polymarket_order_id": order_id or None,
            "tx_hash": tx_hash or None,
            "executed_at_iso": datetime.datetime.utcnow().isoformat() + "Z" if live_confirmed else None,
        }
        r = requests.post(MARK_URL, json=payload, headers=HEADERS, timeout=15)
        log.info(f"MARK {queue_id} → {status}: HTTP {r.status_code}")
    except Exception as e:
        log.warning(f"MARK failed for {queue_id}: {e}")


def send_order(candidate: dict) -> dict:
    """
    Real order sending must be implemented here by Ireland operator.
    This stub performs NO real sends and returns the dry-run envelope.
    Replace with actual Polymarket API call after CEO unlock.
    """
    raise NotImplementedError(
        "send_order not implemented — Ireland operator must wire actual execution here"
    )


def poll_and_execute():
    try:
        r = requests.get(QUEUE_URL + "?includeUpcoming=1", headers=HEADERS, timeout=20)
        if r.status_code == 401:
            log.error("Queue endpoint returned 401 — check PPP_SECRET"); return None
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        log.error(f"Queue poll failed: {e}"); return None

    if not data.get("ok"):
        log.error(f"Queue ok=false: {data.get('error')}"); return None

    source = data.get("source")
    if source != "event_execution_queue":
        log.error(f"SPLIT BRAIN: queue source={source}"); return None

    candidates = data.get("candidates", [])
    count = data.get("candidate_count", 0)
    next_due = data.get("next_due_iso")
    next_check = data.get("next_check_after_seconds", DEFAULT_POLL_SEC)
    log.info(f"Queue: candidates={count}  next_due={next_due}  next_check={next_check}s")

    executed = skipped = failed = 0
    order_keys_sent: set[str] = set()

    for c in candidates:
        if c.get("entry_state") != "IN_WINDOW":
            log.info(f"SKIP (not in window): {c.get('match_family_key')} entry_state={c.get('entry_state')}")
            skipped += 1
            continue

        err = validate_candidate(c)
        if err:
            log.warning(f"SKIP (validation fail: {err}): {c.get('match_family_key')}")
            mark(c.get("candidate_id",""), "SKIPPED", reason=f"validation:{err}")
            skipped += 1
            continue

        order_key = c["order_key"]
        if order_key in order_keys_sent:
            log.warning(f"SKIP (duplicate order_key): {order_key}")
            mark(c.get("candidate_id",""), "SKIPPED", reason="duplicate_order_key")
            skipped += 1
            continue

        if hard_stop_active():
            log.warning(f"HARD-STOP active — aborting all remaining sends")
            break

        queue_id = c.get("candidate_id", "")
        log.info(f"CLAIM {queue_id}  order_key={order_key}  stake={c.get('stake_usd')}")
        mark(queue_id, "CLAIMED")

        try:
            result = send_order(c)
            order_keys_sent.add(order_key)
            log.info(f"EXECUTED {queue_id}: {result}")
            mark(queue_id, "EXECUTED", live_confirmed=True,
                 order_id=result.get("order_id",""), tx_hash=result.get("tx_hash",""))
            executed += 1
        except NotImplementedError as e:
            log.warning(f"send_order not implemented: {e}")
            mark(queue_id, "SKIPPED", reason="send_order_not_implemented")
            skipped += 1
        except Exception as e:
            log.error(f"FAILED {queue_id}: {e}")
            mark(queue_id, "FAILED", reason=str(e))
            failed += 1

    log.info(f"Round done: executed={executed} skipped={skipped} failed={failed}")
    return next_check


def main():
    remove_hard_stop = "--remove-hard-stop=CEO_APPROVED" in sys.argv
    log.info("=== Contur3 Battle Queue-Only Watcher starting ===")
    log.info(f"BASE={BASE}  QUEUE={QUEUE_URL}")

    if remove_hard_stop:
        log.info("[CEO UNLOCK] Removing hard-stop files")
        for f in HARD_STOP_FILES:
            try: pathlib.Path(f).unlink(missing_ok=True)
            except Exception: pass
        log.info("[CEO UNLOCK] Hard-stop removed. LIVE SENDS ENABLED.")
    else:
        log.info("[HARD-STOP] Hard-stop active. This run is SAFE/DRY until CEO unlock.")

    while True:
        if not in_battle_window():
            log.info("Outside battle window (22:00–07:00 Minsk). Sleeping 300s.")
            time.sleep(300)
            continue

        if hard_stop_active():
            log.info("HARD-STOP active — poll-only mode. No orders will be sent.")

        next_check = poll_and_execute()
        sleep_sec = next_check if (next_check and next_check > 0) else DEFAULT_POLL_SEC
        sleep_sec = min(sleep_sec, 300)
        log.info(f"Sleeping {sleep_sec}s")
        time.sleep(sleep_sec)


if __name__ == "__main__":
    main()
PYEOF

chmod +x "$WATCHER"
echo "[WATCHER] $WATCHER written and marked executable"

# ── CEO unlock gate ───────────────────────────────────────────────────────────
REMOVE_HS=false
for arg in "$@"; do
  [ "$arg" = "--remove-hard-stop=CEO_APPROVED" ] && REMOVE_HS=true
done

if [ "$REMOVE_HS" = "true" ]; then
  echo ""
  echo "═══ CEO UNLOCK REQUESTED ═══"
  # Verify queue source is correct before unlock
  Q_RESP=$(curl -s "${BASE}${QUEUE_SOURCE}?includeUpcoming=1" -H "x-executor-secret: ${SECRET}" 2>/dev/null || echo '{"ok":false}')
  Q_SOURCE=$(echo "$Q_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('source','null'))" 2>/dev/null || echo "null")
  Q_NORANK=$(echo "$Q_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('ireland_contract',{}); print(str(c.get('do_not_rank',False)).lower())" 2>/dev/null || echo "false")
  Q_NOBROAD=$(echo "$Q_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('ireland_contract',{}); print(str(c.get('do_not_pull_broad_candidates',False)).lower())" 2>/dev/null || echo "false")

  echo "Queue source: $Q_SOURCE"
  echo "do_not_rank: $Q_NORANK"
  echo "do_not_pull_broad_candidates: $Q_NOBROAD"

  if [ "$Q_SOURCE" != "event_execution_queue" ]; then
    echo "ERROR: queue source=${Q_SOURCE} — REFUSING CEO UNLOCK"; exit 1
  fi
  if [ "$Q_NORANK" != "true" ] || [ "$Q_NOBROAD" != "true" ]; then
    echo "ERROR: ireland_contract broken — REFUSING CEO UNLOCK"; exit 1
  fi

  rm -f /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP
  echo "[CEO UNLOCK] Hard-stop removed. LIVE MODE ACTIVE."
else
  echo ""
  echo "Hard-stop remains ON. To unlock: re-run with --remove-hard-stop=CEO_APPROVED"
fi

# ── Final status ──────────────────────────────────────────────────────────────
echo ""
echo "═══ CONTUR3 BATTLE QUEUE-ONLY STATUS ═══"
echo "Hard-stop:"
ls /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP 2>/dev/null && echo "  ACTIVE (sends blocked)" || echo "  REMOVED (CEO unlock done)"
echo "Queue source: ${BASE}${QUEUE_SOURCE}"
echo "Watcher: $WATCHER"
echo "Log: logs/contur3_battle_watcher.log"
echo ""
echo "═══ ROLLBACK COMMAND ═══"
echo "touch /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP"
echo "pkill -f '[c]ontur3_battle_queue_only_watcher.py' || true"
echo ""

# ── Process list ──────────────────────────────────────────────────────────────
echo "── Running watcher processes ──"
pgrep -a -f "contur3_battle_queue_only_watcher" || echo "(none running)"
