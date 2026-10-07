# PRECONTRACT_RESEARCH_TELEMETRY_GUIDE_V1

This guide is **not a current-state authority**. `CURRENT_STATE.yaml` (`active_research_roadmap`) is the only
operational state artifact and references this guide. This file only explains the Founder-approved decision.

Mission: `PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1`.

## Decision (Founder-approved)

1. Broad research telemetry is independent of Reservation / Contract A.
2. One broad research snapshot only: BUSINESS T20 (`9 < minutes_to_start <= 20`). The persisted phase label is the
   existing `T_MINUS_10` only because shared code requires it. No broad-research T40, no broad-research T3.
3. Daily physical-event cap: 100. One `physical_event_id` consumes one slot; events are deduplicated before ranking.
4. Target mix: soccer 40, tennis 20, remaining sports 40.
5. Inside every allocation: liquidity-first using authoritative `parentEventVolume24hr`
   (`parentEventVolume24hr DESC, event_start_iso ASC, physical_event_id ASC`). Contradictory non-null volumes exclude
   the event (`EVENT_VOLUME_CONTRADICTION`). Never rank by score, Contract A, Reservation rank, coverage or PnL.
6. Other-sport research set: basketball, baseball, hockey, cricket, American football **only if structured identity is
   proven** (otherwise `AMERICAN_FOOTBALL_STRUCTURED_IDENTITY_NOT_PROVEN`; never inferred from text). Up to 4
   highest-volume events per sport first (diversity floor), then pure liquidity across the combined pool. Unused
   floor, soccer or tennis capacity is refilled by global liquidity (`sampling_bucket = GLOBAL_BACKFILL`); events are
   never invented to force the mix, and underfill is recorded (`*_quota_underfill_n`).
7. Market scope: MONEYLINE, SPREAD, TOTAL (existing canonical full-event authority) and soccer full-match
   TOTAL_CORNERS. Corner derivatives, props, exact score, halftime and partial-event markets stay excluded. Tennis and
   cricket spread/total cannot be proven full-event from structured metadata and are skipped (moneyline only).
8. Research data MUST NOT authorize money-path actions.
9. Production storage is bounded: <=128 token rows per event (over-budget events are skipped, never truncated,
   `RESEARCH_EVENT_TOKEN_BUDGET_EXCEEDED`), <=5 new events per tick, 8 s per tick, 7-day retention, purge capped at
   1000 rows per call. Long history belongs in DBClone after the next roadmap transition
   (production -> DBClone -> clone parity proof -> clone-confirmed purge; then 24-48 h hot retention).
10. Existing Reservation T40 is NOT retired by this decision. It remains until its live price-authority dependency is
    separately removed.

## Pre-contract source and carrier

- Source: `public.generated_signal_research_snapshots` (isolated research snapshots written before any Contract A
  decision). `diagnostics.providerEventContext` supplies exact event id, game id and start; `diagnostics` supplies
  `providerSportFamily` / `providerSportCode` / `providerSportSource` and `parentEventVolume24hr`.
- Physical identity: existing `physicalMatchId` (game id when structured, else provider event id).
- Carrier: `public.research_precontract_t20_observations` (no `reservation_id`; reservation tables are untouched).
  Unique on `(physical_event_id, condition_id, token_id, side)`. Scalar evidence only.
- Module: `lib/executor/precontractT20Research.ts`; fail-soft hook in `runEventRebalanceWithEvidence`.
- Job evidence: aggregate-only `job_runs` with source `PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1`.
- Known limit: the candidate read is capped at 5000 newest snapshot rows per UTC day; `daily_volume_rank` is the
  global liquidity rank among that day's eligible events.
