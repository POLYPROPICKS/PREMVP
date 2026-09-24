# Football Denominator Reconciliation — 2026-08-04 .. 2026-09-20

Status: **DENOMINATOR / CLASSIFICATION AUTHORITY ONLY**

## Source range

Read-only overlay over `research_model_ready_rows` (research clone `nppznoujvnyjargjkmnv`) for `2026-08-04` through `2026-09-20`, split into August (`2026-08-04..2026-08-31`) and September (`2026-09-01..2026-09-20`).

## Physical events

- August unique physical events: **2514**
- September unique physical events: **8136**
- Combined unique physical events (deduplicated, not summed): **10612**
- Physical events present in both periods (not double-counted in COMBINED): **38**

## Football (soccer) classification

- Explicit soccer (explicit carrier, unambiguous): August 594, September 3980, combined 4560
- Safely recovered soccer (unique provider code and/or `soccer_*` structured market type — never title/slug/odds/result inference): August 95, September 39, combined 134
- Canonical soccer denominator (explicit + all recovered paths): August 689, September 4019, combined 4694
- Unresolved sport (no explicit or safe-recovery evidence): August 1111, September 299, combined 1406
- Explicit sport conflict (disagreeing explicit carriers, fails closed to unresolved): August 0, September 0, combined 0

## Football market-type coverage

Within the canonical soccer denominator (combined scope):

- With a resolved market type: 1011
- Market type unresolved: 3683
- Moneyline: 469
- Totals: 369
- Spreads: 327

(A single physical event may carry more than one structured market and therefore appear in more than one bucket above; each bucket is independently counted, never mutually exclusive.)

## Optional feature availability (never shrinks the football denominator)

Row-level counts across the combined range: lead time available 43479/68949, score level available 32247/68949, data coverage available 19691/68949, volume available 31098/68949.

A football signal with a known market and settlement/display-odds evidence remains in the denominator even when score level, volume, timing, or coverage are missing — these are descriptive-only flags, never exclusion criteria.

## Scope and non-claims

This artifact defines **denominator and sport/market classification authority only**, sourced from the immutable, already-accepted model-ready corpus plus an exact (never fuzzy) `generated_signal_pairs` market-type fallback.

- `NO_MODEL_RANKING_PERFORMED`
- `NO_EXECUTION_ECONOMICS_CLAIM`
- `IMMUTABLE_SOURCE_CORPUS_UNCHANGED`

No hypothesis was tested, no ROI or leaderboard was computed, and the immutable August/September corpus and `research_model_ready_rows`/`research_model_ready_days` tables were not modified — this is a read-only sidecar overlay.
