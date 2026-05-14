# RULE_COMPLIANCE_MONITOR_AGENT.md v0 — PolyProPicks Compliance Monitor

<!-- ACTIVATION POINT: After any patch/inspect/significant Claude or Claude Code response -->
<!-- TOKEN LOADING RULE: Load when auditing. Tier 1. Do NOT load at session start. -->
<!-- OWNER: Founder invokes; Claude Chat executes; output auto-generates drift entry -->
<!-- REQUIRED OUTPUT FIELD: Compliance score + decision + ready-to-paste drift entry -->
<!-- STOP/REJECT CONDITION: Score < 70 → REJECT response; do not accept task as done -->
<!-- MONITORING CHECK: This IS the monitoring check — self-referential -->

## 1. When to invoke

Invoke monitoring agent after:
- Any `exact-patch` task
- Any `backend-API` task
- Any `frontend-UI` task
- Any task where Claude Code returned a response claiming completion
- Any response that felt uncertain or incomplete
- Any enforcement-contour artifact change: `CLAUDE.md`, `AGENTS.md`, `VERIFICATION_GATES.md`,
  `RULE_COMPLIANCE_MONITOR_AGENT.md`, `AUTOMATION_SCORECARD.md`, `DRIFT_MONITORING_LOG.md`,
  `TASK_ROUTING_MATRIX.md`, `CLAUDE_CODE_EXECUTION_PROTOCOL.md`,
  `CONTEXT_HANDOFF_TEMPLATE.md`, `OPERATOR_ACCEPTANCE_CHECKLIST.md`

Do NOT invoke for:
- Direct CMD (git status, simple curl)
- Architecture-review-only responses
- Trivial docs edits with no workflow impact (e.g. typo fix in non-enforcement file)

## 2. How to invoke

Founder: paste this prompt into Claude Chat with the Claude/Code response attached.

---

## 3. Monitor agent prompt (paste into Claude Chat)

```
═══════════ COMPLIANCE AUDIT — POLYPROPICKS ═══════════

You are the PolyProPicks rule compliance monitor.
Audit the Claude/Claude Code response below.
Do NOT add missing fields — only audit what is present.
Be strict. Partial credit = FAIL for critical rules.

TASK DESCRIPTION:
[paste the original task or goal in 1–2 lines]

CLAUDE/CODE RESPONSE TO AUDIT:
[paste full response]

═══════════ AUDIT CHECKLIST ═══════════

Evaluate each rule. Mark: PASS / FAIL / N/A
N/A rules: allowed ONLY if genuinely inapplicable (e.g. no git diff for inspect-only).
N/A must be justified inline: "N/A — [reason]". Unjustified N/A = FAIL.
N/A rules are excluded from the denominator. ≥6 unjustified N/As = "audit evasion" → score 0.

CRITICAL RULES (any FAIL = overall REJECT):
[ ] 1. Task classified before action (task type stated explicitly)
[ ] 2. No manual founder edit instruction ("open file X and replace")
[ ] 3. Old snippet present for code-changing task
[ ] 4. New snippet present for code-changing task
[ ] 5. git status --short present in response (patch task)
[ ] 6. npm run build result present (patch task)
[ ] 7. No "done" or "success" without proof package
[ ] 8. Build failure acknowledged as FAIL total (not partial)
[ ] 9. No patch started without inspect evidence (when source uncertain)
[ ] 10. Allowed files listed + diff matches allowed list

HIGH RULES (2+ FAILs = REJECT):
[ ] 11. git diff --stat present (patch task)
[ ] 12. Founder visual check noted as YES/NO with specifics
[ ] 13. Risks/unverified assumptions listed
[ ] 14. Stop conditions checked and reported
[ ] 15. cacheStatus noted if API endpoint checked
[ ] 16. Gate 1 verdict explicitly stated (PASS/FAIL/STOP)

MEDIUM RULES:
[ ] 17. Execution mode stated (Direct CMD / Claude Code / etc.)
[ ] 18. Founder action stated as one clear action
[ ] 19. No task zone mixing (UI + backend in same response)
[ ] 20. No broad refactor proposed

═══════════ SCORING ═══════════

N/A RULES:
- N/A is valid only with inline justification: "N/A — [reason]"
- Unjustified N/A = FAIL
- N/A rules (justified) are EXCLUDED from denominator
- Applicable rules = PASS + FAIL rules only (N/A excluded)
- ≥6 unjustified N/As = "audit evasion" → total score = 0

Applicable critical rules: [N_applicable] / 10
Applicable high rules: [N_applicable] / 6
Applicable medium rules: [N_applicable] / 4

Critical rules passed: [N_passed] / [N_applicable]
High rules passed: [N_passed] / [N_applicable]
Medium rules passed: [N_passed] / [N_applicable]

Weighted score formula:
  Score = (applicable weighted passed / applicable weighted total) × 100

  Critical: ([passed] / [applicable]) × 60 = [points]
  High:     ([passed] / [applicable]) × 18 = [points]
  Medium:   ([passed] / [applicable]) × 4  = [points]
  Bonus:    all applicable critical passed = +18
  Total: [total] / 100

Zero-applicable-category rule:
  If a category has 0 applicable rules → exclude that category weight from applicable total.
  Do NOT divide by zero.
  Example: if all Medium rules are N/A → applicable total = 60+18 = 78, not 82.

⚠️ ANY CRITICAL FAIL = REJECT regardless of total score.

═══════════ DECISION ═══════════

[ ] ACCEPT (score ≥ 85, no critical FAIL)
[ ] CONDITIONAL ACCEPT (score 70–84, no critical FAIL — note gaps)
[ ] REJECT — REQUIRE RERUN (any critical FAIL OR score < 70)
[ ] STOP — DANGEROUS (scope expansion / dirty files / build fail ignored)

═══════════ VIOLATIONS ═══════════

Critical violations:
- [rule #] [description]

High violations:
- [rule #] [description]

Missing evidence:
- [what is absent]

═══════════ FOUNDER TIME ESTIMATE ═══════════

Commands founder ran or must run: [count]
Manual edit required: YES / NO
Estimated active minutes: [low <5 / medium 5–15 / high >15]

═══════════ CORRECTION INSTRUCTION ═══════════

If REJECT: [exact rerun instruction — what to add to next Claude Code prompt]
If STOP: [exact stop condition — what to investigate first]
If ACCEPT: proceed with Gate 2 if visual task; or commit gate if code task

═══════════ READY-TO-PASTE DRIFT LOG ENTRY ═══════════

Generate this entry ONLY if decision = REJECT, STOP, or ACCEPT/CONDITIONAL ACCEPT
reveals a meaningful process lesson worth tracking.

If no entry needed, output: "No drift log entry required."
Do NOT instruct founder to paste ACCEPT tasks into DRIFT_MONITORING_LOG.md by default.

If entry IS needed, copy this block into DRIFT_MONITORING_LOG.md:

```
DATE: [today's date]
TASK: [task description 1 line]
SCORE: [N]/100
DECISION: [REJECT / STOP / LESSON]
CRITICAL VIOLATIONS:
- [list or "none"]
HIGH VIOLATIONS:
- [list or "none"]
FOUNDER TIME: [low/medium/high]
CORRECTION APPLIED: [yes — what changed / no — why deferred]
```

═══════════ END AUDIT ═══════════
```

---

## 4. Score interpretation

| Score | Meaning | Action |
|---|---|---|
| ≥ 85 | ACCEPT — workflow followed | Proceed to commit gate or Gate 2 |
| 70–84 | CONDITIONAL ACCEPT | Note gaps; proceed with caution |
| 50–69 | REJECT | Rerun with correction instruction |
| < 50 | REJECT — serious drift | Log violation; reset chat context with starter prompt |
| Any critical FAIL | REJECT regardless of score | Do not accept task as done |

## 5. Drift threshold and reset

If score < 70 occurs **2 times in one week**:
→ Paste CHAT_STARTER_PROMPT.md at start of next chat
→ Explicitly name the violated rule(s) in the starter
→ Add 1 task to "mandatory monitor coverage" for next 5 tasks

If score < 70 occurs **5 times in one week**:
→ Review CLAUDE_CODE_EXECUTION_PROTOCOL.md for gaps
→ Update the artifact with stronger stop condition for the failing rule

## 6. Artifact status

| Field | Value |
|---|---|
| Version | v0 |
| Readiness | Usable v0 — test on first real task |
| Missing | Scorecard integration (add after 5 tasks) |
| Next update | After first real monitoring run |
