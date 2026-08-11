---
name: polypropicks-production-debug
description: "Investigate a production incident or regression with Sentry evidence correlated to current Git and source. Use for production failures, regressions, or Sentry issue/event diagnosis; do not use for ordinary code or product work without an incident."
---

# PolyProPicks production debug

Use this skill only for a production incident or regression. It requires the selected
executor's narrow `SENTRY_READ_DEBUG` capability; never require Sentry for ordinary code work.

1. Query Sentry issues/events first; inspect the event stack and context, not only its title.
2. Record frequency, first/last seen, environment, and release when available.
3. Correlate affected release and source frames with current Git; establish whether source changed.
4. Find the smallest defensible root cause, reproduce or add a regression test when feasible,
   fix that cause, and run relevant verification.
5. A build alone never proves a production fix. If Sentry is unavailable, report
   `SENTRY_EVIDENCE_UNAVAILABLE` and use other authoritative evidence when sufficient; never fabricate findings.

Do not enable replay, broad tracing, profiling, or PII collection for an incident unless its
scope explicitly requires them.
