# M1 — Unknown / Weak / Activity Markets Audit

Generated: 2026-06-23. Phase: shadow-only, no production eligibility changed.

---

## Purpose

Classify all markets labelled UNKNOWN/WEAK or contaminated by activity labels so that:
- Good markets are not lost to over-blocking
- Bad markets do not slip through to live execution
- Market identity is the foundation for all downstream M2–M4 policy

---

## Warning Code Taxonomy

| Code | Meaning | Default Policy |
|---|---|---|
| `WEAK_MATCH_FAMILY_KEY` | match_family_key backed by condition_id only (not event_slug) | BLOCK — no event-level dedup possible |
| `ACTIVITY_LABEL_IN_MARKET_SLUG` | activity label detected in slug (e.g. player prop, corner, yellow card) | BLOCK — halftime/props hard-blocked |
| `TITLE_OUTCOME_AMBIGUOUS_BLOCKED` | selected_outcome absent or ambiguous | BLOCK — cannot determine side |
| `WEAK_IDENTITY_LIVE_BLOCKED` | identity_quality=WEAK at live execution gate | BLOCK — enforced by buildFireModelCandidates |
| `NO_TOKEN_ID` | token_id missing | BLOCK — Ireland cannot construct order |
| `NO_CONDITION_ID` | condition_id missing | BLOCK — Ireland cannot construct order |
| `MISSING_SELECTED_OUTCOME` | selected_outcome null | BLOCK — cannot determine side/token |
| `SPORT_UNKNOWN` | inferred_sport=UNKNOWN | SHADOW — no automatic block, but no sport policy applied |

---

## Recovery Classification

| Warning Code | Recovery Path | Required Data |
|---|---|---|
| `WEAK_MATCH_FAMILY_KEY` | `RECOVERABLE_WITH_FULL_EVENT_CONTEXT` | event_slug must be present in next snapshot |
| `ACTIVITY_LABEL_IN_MARKET_SLUG` | `KEEP_BLOCKED` | Halftime/props remain permanently blocked |
| `TITLE_OUTCOME_AMBIGUOUS_BLOCKED` | `NEEDS_UPSTREAM_CAPTURE` | selected_outcome must be set in signal snapshot |
| `WEAK_IDENTITY_LIVE_BLOCKED` | `RECOVERABLE_WITH_FULL_EVENT_CONTEXT` | event_slug + team pair extraction |
| `NO_TOKEN_ID` | `NEEDS_UPSTREAM_CAPTURE` | Polymarket API re-fetch required |
| `NO_CONDITION_ID` | `NEEDS_UPSTREAM_CAPTURE` | Polymarket API re-fetch required |
| `MISSING_SELECTED_OUTCOME` | `NEEDS_UPSTREAM_CAPTURE` | Signal snapshot must set selected_outcome |
| `SPORT_UNKNOWN` | `RECOVERABLE_WITH_FULL_EVENT_CONTEXT` | Improve sport classifier using event_slug/title |

---

## Policy Rules (Shadow Phase)

1. **No live eligibility change in this phase.** All changes are documentation only.
2. `ACTIVITY_LABEL_IN_MARKET_SLUG` → permanently `KEEP_BLOCKED` (halftime/props policy unchanged).
3. `WEAK_MATCH_FAMILY_KEY` alone → `RECOVERABLE` if token_id+side present. Log only.
4. `WEAK_IDENTITY_LIVE_BLOCKED` + token_id present + side present + not halftime → eligible for future allow-list review after ≥5 resolved rows.
5. Any market without token_id OR condition_id → cannot enter queue regardless of other signals.

---

## SQL Reference

See `M1_UNKNOWN_MARKETS_SQL.sql` for:
- Count by warning code / sport / family
- Top 50 potentially recoverable markets
- Timestamp and plan_run_id cross-references

---

## Definition of PASS (Future)

Every market that enters `event_execution_queue` has:
- Non-UNKNOWN identity quality, OR
- Explicit allow-list entry with rationale signed off by founder

Current state: SHADOW ONLY — no pass/fail judgement until live resolved data exists.
