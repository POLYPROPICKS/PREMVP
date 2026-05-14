# AUTOMATION_SCORECARD.md — PolyProPicks

<!-- ACTIVATION POINT: After every 3–5 real tasks; weekly review -->
<!-- TOKEN LOADING RULE: Tier 3. Load after tasks for scoring. Not at session start. -->
<!-- OWNER: Monitoring agent drafts score; Founder approves/corrects; Claude Chat interprets trend -->
<!-- REQUIRED OUTPUT FIELD: Score per category + overall + trend -->
<!-- STOP/REJECT CONDITION: Overall score <70 two weeks in a row → review contour artifacts -->
<!-- MONITORING CHECK: Score trend is the primary drift detector -->

---

## How to score

After 3–5 real tasks, rate each category 1–5.
Formula: Weighted = (Score / 5) × Weight. Total = sum of all weighted scores.
Compare to previous week for trend.

Scale: 1 = never / 2 = rarely / 3 = sometimes / 4 = usually / 5 = always

**Example calculation:**
Category 1 weight 25%, score 4: (4/5) × 25 = 20 points
Category 2 weight 15%, score 3: (3/5) × 15 = 9 points
... sum all 7 categories = total /100

---

## Scorecard

| # | Category | Weight | Score 1–5 | Weighted | Notes |
|---|---|:---:|:---:|:---:|---|
| 1 | Founder active minutes per task ≤10 min | 25% | | | Count from task start to accepted result |
| 2 | Routine verification delegated or consolidated | 15% | | | Did Claude Code run checks, or founder ≤2 bundled CMD? |
| 3 | Inspect-before-patch followed | 15% | | | Was source confirmed before patch? |
| 4 | Proof package complete (snippets+git+build) | 15% | | | Were all required fields present? |
| 5 | Repository safety (0 unexpected dirty events) | 10% | | | Any unexpected dirty files this period? |
| 6 | False success prevention (0 "done" w/o proof) | 10% | | | Any unproven "done" claims? |
| 7 | Rework cycles ≤1 per issue | 10% | | | Failed patches per issue this period |

**Total weighted score: ___ / 100**

---

## Score interpretation

| Score | Meaning | Action |
|---|---|---|
| ≥85 | L3 stable — contour working | Continue; monitor for drift |
| 70–84 | L2.5 acceptable | Note which categories are weak |
| 50–69 | Process correction needed | Review failing categories; update artifact |
| <50 | Serious drift | Paste CHAT_STARTER_PROMPT; identify root cause |

---

## Weekly log

| Week | Score | Weakest category | Action taken |
|---|---|---|---|
| 14.05.2026 | baseline — no data yet | — | First real tasks pending |

---

## Category guidance

**Category 1 — Founder time:**
Estimate: task clearly explained → result accepted. Include CMD runs, paste-backs, review time.
Target: ≤10 min routine tasks; ≤20 min complex patches.

**Category 2 — Delegation:**
Score 5 if verification was run by Claude Code OR founder ran ≤2 clearly bundled CMD commands.
Score 3 if founder ran a few commands but they were short and clear.
Score 1 if founder ran long command chains or interpreted raw logs manually.

**Category 3 — Inspect compliance:**
Score 5 if every uncertain task started with inspect-only.
Score 1 if patches were applied based on memory/assumptions.

**Category 4 — Proof package:**
Score 5 if every patch response had snippets + git status + build result.
Score 1 if "done" was claimed without evidence.

**Category 5 — Repo safety:**
Score 5 if zero unexpected dirty file events.
Score 1 if dirty files were ignored or caused confusion.

**Category 6 — False success:**
Score 5 if zero unproven completion claims.
Score 1 if "fixed" or "done" appeared without proof.

**Category 7 — Rework:**
Score 5 if every issue resolved in ≤1 attempt.
Score 1 if same issue required 3+ patch attempts.

---

## Drift threshold

Two consecutive weeks below 70 → required action:
1. Identify lowest-scoring category
2. Find corresponding artifact (CLAUDE_CODE_EXECUTION_PROTOCOL, VERIFICATION_GATES, etc.)
3. Add or strengthen the failing rule
4. Log correction in DRIFT_MONITORING_LOG.md
