# Work_tru_PPP04July — Stable Working Model, 4 July

## Status

- Stable checkpoint for UI_recovery_plan1.
- Phase 1 Top Weekly: PASS.
- Phase 2 Latest Resolved: PASS.
- Phase 3A WhyTrust isolated endpoint + ledger + graph: LOCAL PASS.
- Production verification required after merge.

## Golden Rules

- WhyTrust / White Rust is isolated.
- WhyTrust API/data must be used only by WhyTrust.
- Do not mix WhyTrust with Top Weekly, Latest Resolved, Paywall, landing feed, or PremiumEventCard.
- Do not use `/api/signals/resolved` for WhyTrust.
- Do not use `/api/why-trust/track-record` for anything except WhyTrust.

## Block Ownership Map

| Block | UI owner | Endpoint | Response fields | Data source | Tests |
|---|---|---|---|---|---|
| Top Weekly proof | landing carousel / weekly proof block | `/api/signals/resolved?mode=latest&days=7&limit=7` | `legacyWeekResultsCard` (winsCount, lossesCount, projectedRoiPct) | legacy `generated_signal_pairs` proof | `tests/signals/resolvedLatestContract.test.ts` |
| Paywall proof | `components/modals/PassOfferModal.tsx` | `/api/signals/resolved?mode=latest&days=7&limit=7` | `legacyWeekResultsCard` | legacy `generated_signal_pairs` proof | `tests/signals/resolvedLatestContract.test.ts` |
| Latest Resolved | `components/resolved-signals/**` | `/api/signals/resolved?mode=latest&days=14&limit=7` | `json.signals` | `generated_signal_pairs` (legacy fallback) | `tests/signals/resolvedLatestContract.test.ts` |
| WhyTrust counters | `components/why-trust/WhyTrustSection.tsx` | `/api/why-trust/track-record?days=14&limit=25` | `weekResultsCard.rawShownRows / uniqueMatches / resolvedCount / pendingCount / status` | `track_record_window_summary` | `tests/signals/whyTrustTrackRecordContract.test.ts` |
| WhyTrust ledger | `components/why-trust/WhyTrustSection.tsx` | `/api/why-trust/track-record?days=14&limit=25` | `weekResultsCard.trackRecordDisplayTable.rows` | `track_record_shown_signal_history` JOIN `generated_signal_pairs` (preview) or `track_record_window_results` (ready) | `tests/signals/whyTrustTrackRecordContract.test.ts` |
| WhyTrust graph | `components/why-trust/WhyTrustSection.tsx` | `/api/why-trust/track-record?days=14&limit=25` | `weekResultsCard.returnCurve` | same ledger rows (cumulative `projectedReturnUsd`) | `tests/signals/whyTrustTrackRecordContract.test.ts` |

## WhyTrust Funnel

1. `track_record_display_signals` materializes displayed signals.
2. `track_record_shown_signal_history` preserves shown signal history.
3. `generated_signal_pairs` provides resolved outcomes.
4. `track_record_window_summary` stores counters/status.
5. `track_record_window_results` stores ready-window detail rows when thresholds are met.
6. While `status=insufficient_history`, the WhyTrust endpoint builds honest preview ledger rows from shown history joined to generated pairs (real resolved won/lost only).
7. `returnCurve` is built from the same preview ledger rows.
8. `netProfitUsd` and `netReturnPct` remain 0 while insufficient to avoid premature performance claims.

## Current Proof

- PR43 branch: `claude/whytrust-isolated-endpoint-phase3a-x2od06`
- Commits:
  - `561f892` isolated WhyTrust endpoint
  - `b13e124` returnCurve from preview ledger rows
- Founder local proof:
  - build PASS
  - ledgerRows=25
  - curveLen=25
  - sumMatchesLast=true
  - graph visible
  - ledger visible
  - Top Weekly visible
  - Latest visible
  - Paywall proof visible

## Forbidden Regressions

- Do not edit `/api/signals/resolved` to fix WhyTrust.
- Do not make Latest depend on WhyTrust.
- Do not make Top Weekly or Paywall consume the WhyTrust endpoint.
- Do not fake rows.
- Do not set `insufficient_history` to `ready`.
- Do not claim guaranteed profit.
- Do not run refresh/RPC/cron without explicit founder approval.

## Known Risk

- Legacy 7d proof query can occasionally timeout.
- This is separate from PR43 and must be handled in a future bounded performance task if production probes fail.
