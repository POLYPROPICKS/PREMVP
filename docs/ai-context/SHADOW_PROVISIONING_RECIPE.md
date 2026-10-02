# PROD_SHADOW provisioning recipe (SHADOW_BOOTSTRAP_READINESS_V1)

Status: READY TO PROVISION. Nothing below has been executed; no external resource exists.

## Repo-owned artifacts
| Need | Artifact |
|---|---|
| Schema inventory | `supabase/shadow/required-schema.json` |
| Pre-history tables (not in migrations) | `supabase/shadow/000_prehistory_baseline.sql` |
| Which migrations are skipped (and why) | `supabase/shadow/exclusions.json` (all other migrations apply, in order, incl. future ones) |
| Idempotent apply / verify | `scripts/shadow/shadow-bootstrap.mjs` (`npm run shadow:db:bootstrap`) |
| Signal producer / resolver | `npm run shadow:signals`, `npm run shadow:resolve` (runtime-scoped, `ops/railway/prod-shadow-signals.toml`) |
| Reservation / rebalance trigger | `npm run shadow:cycle -- reservations|rebalance` (SHADOW_* names only) |
| Web service (passive) | `ops/railway/prod-shadow-web.toml` |
| Boot gate | `npm run shadow:boot-check` |

No operational rows are copied; every table starts empty and the shadow fills it by its own pipeline.

## Sequence (future operator)
1. Create an empty Supabase project/database (shadow only).
2. (Refuses a target that already has public tables but no ledger.) `SHADOW_DATABASE_URL=<shadow postgres url> npm run shadow:db:bootstrap` (apply + verify; re-run is a no-op).
3. Verification is part of step 2 (`required-schema.json`: tables, key columns, serving/evidence functions, probe reads).
4. Set service variables (values only in Railway): `SHADOW_SUPABASE_URL`, `SHADOW_SUPABASE_SERVICE_ROLE_KEY`, `SHADOW_EXECUTOR_CANDIDATES_SECRET`, `SHADOW_BASE_URL` (cycle runner). Do NOT set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EXECUTOR_CANDIDATES_SECRET`, `RESERVATION_TIMES_MINSK`.
5. Selector `CONSTRUCTOR_ACTIVE_CONTOUR=PROD_SHADOW` is pinned in every start command.
6. Start the signals service (`prod-shadow-signals.toml`): boot-check, `shadow:signals`, `shadow:resolve`.
7. Shadow GSP and `current_signal_pair_serving` now exist in the shadow DB only.
8. Run `shadow:cycle reservations` (NOTE: no repo-owned recurring scheduler for reservations/rebalance is defined yet; the operator schedules them, rebalance every 5-10 min, always after step 6), then `shadow:cycle rebalance` (always after step 6 produced serving rows).
9. Start the web service (`prod-shadow-web.toml`); `shadow:boot-check` gates it.
10. Passive proof: `GET /api/executor/queue`, `POST /api/executor/queue/mark`, `POST /api/executor/order-events` all return 403 `CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED` with zero DB writes.

## Foreign-binding rule
Any non-default contour (not only moneyMovement=disabled) fails closed at boot if another declaration's binding name is present in the environment (`requiresExclusiveBinding`, `lib/constructor/runtimeContract.ts`).

## Ambient Supabase audit (shadow-reachable paths)
- A (active bypass, FIXED): `lib/feed/{cacheGeneratedSignals,cacheResearchSnapshots,cacheSportsEventMarketInventory,currentSignalPairServing,primaryEvidenceServing}`, producer reservation-pin read, resolver client, default fallbacks in `eventExecutionQueue`, `buildFireModelCandidates`, `reservationMarketBaseline`, `contractARejectionEvidenceWriter` -> all now `scopedSupabaseAdmin()` (runtime scope; unscoped = unchanged process client).
- B (declaration/bootstrap): `lib/constructor/*`, `lib/supabase/{server,adminClientFactory}.ts`, `instrumentation.ts`, `shadow-boot-check.ts`.
- C (not reachable from the shadow path; money/wallet, offline, or DEV-only): `executorWalletStateDbPort`, `makerFallbackSupabasePort`, `modelingData`, `lib/liquidity/*`, `lib/modeling/*`, executor routes' own `supabaseAdmin` (process client = the shadow's own contour client in a shadow process, and the passive guard returns before use).
Remaining relevant leaks: 0.

## Contour identity (PREMVP side implemented)
- Queue GET response carries `contour_id` (top-level and per candidate) = the serving contour; dedicated topology makes the DB's contour the row's originating contour (no migration needed).
- Callbacks (`/api/executor/queue/mark`, `/api/executor/order-events`) read optional body `contour_id`: match -> proceed; mismatch/malformed -> 409 before any DB access; absent -> accepted only on the default contour (`LEGACY_UNSPECIFIED`), rejected (`CONTOUR_ID_REQUIRED`) on non-default ones.

## IRELAND / Codex only — contour echo delta
- Ireland's current state (as seen from PREMVP): it does not echo any contour field on mark/order-events callbacks (PREMVP already emits `contour_id` on the Queue response).
- Proposed field: `contour_id` (string, e.g. `"DEV_LIVE"`).
- Request direction (PREMVP -> Ireland): already emitted on the Queue response (top-level `contour_id` and each candidate's `contour_id`).
- Callback direction (Ireland -> PREMVP): Ireland copies the `contour_id` of the candidate it executed into every `POST /api/executor/queue/mark` and `POST /api/executor/order-events` body, verbatim.
- Echo semantics: exact string echo, no inference, no default. Never invent it for rows lacking it.
- Mismatch behavior: PREMVP answers 409 `CONTOUR_ID_MISMATCH` and mutates nothing; Ireland must treat it as terminal for that instruction and alert.
- Backward compatibility: until Ireland ships the echo, DEV callbacks without `contour_id` are accepted as `LEGACY_UNSPECIFIED`. After Ireland ships and is observed echoing, a later PREMVP change may make it mandatory on DEV.
- PREMVP expectation: field name `contour_id`, JSON string, in the top-level callback body.
- NEXT_REPOSITORY = Ireland; NEXT_EXECUTOR = Codex; NEXT_SCOPE = exact contour-id wire/echo contract only.
