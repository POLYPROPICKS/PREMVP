# Founder research paper scorecard

The existing `/founder/modeling` page contains a Research Paper section above its unchanged legacy dashboard iframe. Production LIVE readers, historical assets and frozen evidence are unchanged.

The page, asset route and `/api/founder/modeling/research/scorecard` require the existing signed `ppp_session` Founder Preview identity. Ordinary Premium entitlement is insufficient. The existing preview feature flag must be enabled, expiration must be present and valid, and the signed session cannot exceed 24 hours. Responses are private and uncached. No credentials are passed to the browser.

## Existing pipeline integration

The existing research settlement cycle adds `summary.paper_scorecard` to its existing daily report JSON. It uses canonical settlement positions, preserves Box B/Gamma precedence, and does not create a table, migration, job, service or alternate outcome population. The existing bounded target selection revisits a report missing this summary, including a previously completed day. Its run limits and cadence are unchanged.

The website reads bounded durable sufficient statistics using the existing server-side research credentials. It never downloads raw private decisions for calculation. Exact HEAD counts reconcile the report cohort against current total, BET and WAITING decisions at one request cutoff. Missing summaries or counts that have advanced fail closed with a specific refresh message. Failed/stale attempts are visible. No old snapshot is presented as current.

Deploying the website alone is insufficient: the updated existing research producer must run before its summaries are available. This change does not run that producer or modify database rows during verification. Research REST aggregates need not be enabled.

## Reporting semantics

- Four views share the same half-open UTC admission cohort: strategy, strategy/sport, strategy/market, strategy/sport/market.
- All available dates are the default; 7D/14D/30D include today. Custom dates are inclusive UTC dates, bounded to 366 days.
- BET equals WIN + LOSS + VOID + PENDING. Unresolved outcomes never become losses.
- Gross P&L and settled ROI reuse canonical virtual 1u economics. Net P&L and ROI remain UNKNOWN without actual fee authority.
- Internal hashed event membership deduplicates physical matches across strategies and dates. It is never returned to the browser. Condition membership retains the full-cohort ambiguity guard.
- Outcome freshness is shown per source day. A six-hour eligibility threshold is never a promise of resolution.
- Tail Repricing stays NOT_READY. Structural Payoff Arbitrage stays SCOPED_NO_GO. Execution & Optimal Exit Authority is separate shared economics/data quality.

## Verification

Focused tests cover sentinel-only authorization, signature/expiry failures, protected route responses, weighted Scorecard V2 economics, missing evidence, same-day outcome eligibility, four-view reconciliation, physical-match deduplication, date bounds and unchanged scheduler limits. Synthetic test inputs contain no database snapshot.

Run the four focused files under `tests/research-clone`: `founderModelingAuth`, `paperScorecardSnapshot`, `inplayPerformanceScorecard`, and `inplayPaperSettlementCycle`, using `node --import tsx --test`. Then run `npm run build`.

## Independent challenge

### PROVEN_FACTS

Existing Founder Preview signs a sentinel session. Existing canonical settlement code owns economics and outcome precedence. The durable daily report already has an extensible JSON summary.

### SUPPORTED_INFERENCES

Extending that summary is narrower than adding a query service or enabling REST aggregates.

### UNVERIFIED_ASSUMPTIONS

Deployment and a subsequent scheduled refresh have not occurred as part of this change. End-to-end database-backed display remains gated on that refresh.

### CONTRADICTIONS

No existing page authorization existed before this change. Search-engine exclusion did not enforce access.

### FIRST_PROVEN_PROBLEM

Private research statistics could not safely be connected to an unprotected page and asset route.

### SMALLEST_DEFENSIBLE_APPROACH

Reuse the signed sentinel, existing page, canonical economics and durable daily reports. Fail closed until each report supplies the necessary summary.

### MATERIAL_ALTERNATIVE

An on-request SQL aggregate would require a supported server SQL transport unavailable through the existing REST connection. It is unnecessary with durable reports.

### REGRESSION_AND_MAINTENANCE_RISK

Producer and consumer versions must agree. Missing or stale summaries remain visible as refresh errors, and count reconciliation rejects incomplete cohorts.

Verdict: PROCEED_WITH_CORRECTION — use the existing durable report path rather than assume REST aggregates are enabled.
