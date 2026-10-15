# Founder decision: MONEYLINE-only new LIVE authority

Decision date: 2026-10-15. Decision authority: Founder release directive.
Policy/rejection version: `FOUNDER_MONEYLINE_ONLY_LIVE_2026_10_15`.

Approved LIVE families: canonical MONEYLINE, both Yes and No, subject to all existing economic gates.
Shadow families: TOTALS Under/Over at every line, SPREADS, TOTAL_CORNERS. Other, unknown and missing families have no new live authority.
Rationale: protect remaining capital following realized six-day losses.

The 2026-10-10 TOTALS Over prohibition remains history; this decision supersedes it for future live admission. No existing Queue row, submitted venue order, callback, fill, balance, reconciliation, settlement or PnL is rewritten. No order is cancelled or resubmitted. Preserve 24/7 scheduling.

Single source: `lib/executor/liveMoneyFamilyAuthority.ts`. Apply before released B selection and T10 economic ranking, at all executable Queue admissions, persisted READY-row wire mapping, and fallback eligibility/publication. Missing canonical identity fails closed. Preserve bands, cap 0.555, timing, stake headroom, execution-mode priority and one exposure per physical match.

A/B strategy observations remain the frozen research baselines. Their hypothetical SELECTED identity is SHADOW_ONLY: it conveys no executable authority and is not a fill. Non-MONEYLINE milestone observations retain books, fees/depth telemetry, original identity and the new rejection reason. No second ledger or fabricated result is introduced.

Rollback requires a NEW explicit Founder decision. Implement its approved allowlist/reasons in the same single-source authority, rerun focused tests/build/control-plane checks, obtain independent exact-SHA review, merge a PR and verify deployment. Do not silently revert this policy or replay blocked historical rows.

## Independent challenge

PROVEN_FACTS: origin/main is 8b37b4f65b1840256279ef5436a20ae1300b8601. Existing selectors and all three Queue admission call sites use shared authority. Queue mapping and fallback use its edge predicate. The old edge predicate exempted missing/unknown families. A/B recording precedes live selection and preserves all observed identities.

SUPPORTED_INFERENCES: a shared allowlist change plus fail-closed edges is the smallest complete enforcement; observation metadata can record rejection using existing columns.

UNVERIFIED_ASSUMPTIONS: deployment and a natural MONEYLINE fill remain pending until runtime evidence is collected.

CONTRADICTIONS: historical tests expected TOTALS Under and corners LIVE; those expectations are superseded by this decision. Two unrelated tests fail identically on pristine origin/main (economicTelemetryCallbackResponse and reservationImmutableQueueBoundary); neither is changed or waived.

FIRST_PROVEN_PROBLEM: the existing live set admits TOTALS and TOTAL_CORNERS, and legacy missing-family rows escape edge refusal.

SMALLEST_DEFENSIBLE_APPROACH: restrict the existing authority to MONEYLINE; preserve observation capture, A/B comparisons and current economic rules; label non-MONEYLINE observations and refuse new wires/fallbacks.

MATERIAL_ALTERNATIVE: NONE within the approved single-authority boundary.

REGRESSION_AND_MAINTENANCE_RISK: manual/legacy rows without canonical MONEYLINE now fail closed by design. Generic economic regression fixtures move to MONEYLINE; family research bands remain unchanged.

Verdict: PROCEED_AS_PROPOSED.

## Verification and deployment

146 focused tests PASS. Canonical build PASS. Control-plane checks PASS (424 pass, 15 skipped). `git diff --check` PASS. Independent release review pending.

Production baseline census: 2026-10-15 08:15:59 UTC. Last 24h: 23 executed MONEYLINE rows, 11 executed TOTALS Under rows, one CLAIMED row each for MONEYLINE and TOTALS Under; no currently actionable READY row in that cohort. These are pre-release facts, never proof of the new policy.

Bounded post-deploy plan: record Railway main-web and rebalance deployment SHA/time; aggregate new Queue by canonical family/side/status, exact idempotency-key-linked executor events by family/type and new-vs-preexisting parent cohort, and milestone/strategy observations by family/phase/rejection. Use no raw rows or speculative joins. Executor callbacks on old parents are not new submission proof. A Queue GET does not persist an emitted-payload receipt; distinguish that evidence limitation from new Queue admission and submission outcomes.

Effective deployed SHA: PENDING.
Verification window: PENDING.
Actual natural MONEYLINE fill: PENDING; never submit a synthetic order for verification.
