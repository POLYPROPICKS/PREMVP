# DRIFT_MONITORING_LOG.md — PolyProPicks

<!-- ACTIVATION POINT: When any rule violation occurs; when monitoring agent outputs REJECT -->
<!-- TOKEN LOADING RULE: Tier 3. Append after violations. Not at session start. -->
<!-- OWNER: Monitoring agent generates entry; Founder pastes it here -->
<!-- REQUIRED OUTPUT FIELD: Every RULE_COMPLIANCE_MONITOR_AGENT REJECT must produce a log entry -->
<!-- STOP/REJECT CONDITION: 2+ violations of same type in one week → update source artifact -->
<!-- MONITORING CHECK: Review log weekly alongside AUTOMATION_SCORECARD -->

---

## How to use

When RULE_COMPLIANCE_MONITOR_AGENT returns REJECT or STOP:
1. Copy the "READY-TO-PASTE DRIFT LOG ENTRY" block from the audit output
2. Paste it below under the current week

**Do NOT log ACCEPT tasks unless they reveal a specific process lesson.**
Only log: REJECT, STOP, or meaningful near-miss violations worth tracking.

---

## Threshold rules

```
TASK-LEVEL threshold:
  2 REJECT or STOP events in one week
  → reset next chat session with CHAT_STARTER_PROMPT.md
  → name the violated rule explicitly in the reset message

WEEKLY-LEVEL threshold:
  AUTOMATION_SCORECARD overall score <70 for two consecutive weekly reviews
  → full contour review required
  → identify lowest-scoring category → update corresponding artifact

Same critical violation 2× in one week  → update CLAUDE_CODE_EXECUTION_PROTOCOL.md
Same high violation 3× in one week      → update VERIFICATION_GATES.md
5+ violations in one week               → full contour review immediately
```

---

## Violation severity levels

| Level | Meaning | Required action |
|---|---|---|
| Critical | Any critical rule failed (no snippets, no build, manual edit, patch without inspect) | Log immediately; rerun task |
| High | High rule failed (no diff stat, no Gate 1 verdict, cacheStatus missing) | Log; note in next task |
| Medium | Medium rule failed (no execution mode stated, zone mixing) | Log; monitor for repeat |
| Pattern | Same violation 2+ times in one week | Update source artifact |

---

## Active violations log

### Week of 14.05.2026

```
DATE: 14.05.2026
TASK: UI: replace Profit tile with Market Return (1a8d782)
SCORE: ~60/100
DECISION: LESSON
CRITICAL VIOLATIONS:
- CSS structure patch applied without inspect-only (:first-child conflict missed)
HIGH VIOLATIONS:
- No inspect of active CSS selectors before structural change
FOUNDER TIME: medium (required 2 follow-up fix commits: 9109138, a2a661c)
CORRECTION APPLIED: yes — inspect-only before CSS structure change reinforced
```

---

## Violation entry format

When monitoring agent returns REJECT, paste this block:

```
DATE: [date]
TASK: [1-line description]
SCORE: [N]/100
DECISION: [REJECT / STOP]
CRITICAL VIOLATIONS:
- [rule # and description or "none"]
HIGH VIOLATIONS:
- [rule # and description or "none"]
FOUNDER TIME: [low / medium / high]
CORRECTION APPLIED: [yes — what changed / no — why deferred]
```

---

## Artifact correction log

When a violation triggers artifact update:

| Date | Violation pattern | Artifact updated | Change made |
|---|---|---|---|
| — | No corrections yet | — | — |

---

## Drift trend summary

| Period | Violations | Most common | Trend |
|---|---|---|---|
| 14.05.2026 | 1 | CSS patch without inspect-only | Baseline — first real task |
