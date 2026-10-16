# PR #545 migration gate recovery — pre-activation evidence

Founder directive: 2026-10-16 PR #545 MIGRATION GATE RECOVERY, starting SHA `e1a3c2dbae8edfbac2c212c7e8a109ea819b154c`. Zero intermediate Founder actions. Stage 200 only; stage 300 must remain inactive. No changes to the prepared implementation, LIVE, Ireland, T40/T20 behavior, virtual models, historical data, 192/16, or Production 48h retention.

## Exact source recovery

10/10 files restored from the full, already-applied SQL payloads returned by the authenticated native endpoint `GET /v1/projects/nbnldzfsxffztsfrrxqy/database/migrations/{version}`. Each native version/name/statements array was byte-for-byte identical to the exact projected Production ledger row. `RECOVERY_MANIFEST.json` records SHA-256, byte size, file, version and Git provenance. No SQL was synthesized, inferred from catalog state, emptied or used as a placeholder. No migration was executed during recovery.

All available remote branches were fetched; Git migration filename history was searched across all refs. Five migrations have corroborating Git source paths under different timestamps. Three match the recorded SQL after trimming; orderbook timing differs only in comments/formatting; state-fields v2 additionally omits double quotes in two descriptive COMMENT strings. The exact native applied payload is preserved in every restored file, including those harmless source differences. The other five are verified native applied release artifacts: one rollback function and four temporary maintenance enable/restore statements. Their original Git files were not found; no Git provenance is invented for them.

Runtime corroboration at 2026-10-16 ~07:48 UTC: all ten expected additive in-play columns have their recorded types. `pg_cron` is absent; the postgres role has zero statement_timeout overrides. The normalized T20 RPC body MD5 `5ca57828ba488bdeb40aa1d452806003` equals the exact recorded rollback-function body. These are read-only checks; T20 was not changed or rerun. Production in-play writer remains at 100 in this pre-activation snapshot.

## Registered migration lifecycle

The original pinned target migration/declaration and prepared application code are unchanged from the starting SHA. `RECOVERY_DRY_RUN.json` proves the registered HTTPS dry-run passed: exact SQL hash, transaction rollback, unchanged schema fingerprint and ledger. That transport's apply branch can rename a server-stamped ledger version; the current Founder prohibition excludes that branch from activation.

A bounded recovery selected the exact PRIMARY project's existing pooler connection descriptor from the read-only Management API, cross-checked host/user/port, and held the already-provisioned DB password only in process memory. The existing registered lifecycle received SUPABASE_DB_URL only for its child invocation; no persistent environment, connector, Railway or Supabase configuration was changed.

`RECOVERY_POOLER_DRY_RUN.json` proves the normal CLI target-only path passed over that official pooler: 41 isolated files, of which 40 are already tracked and never replayed; the sole pending file is `20261016071238_research_inplay_coverage_200_v1.sql`. No include-all, repair, raw SQL bypass, or history-table mutation. Apply is not yet performed in this report.

Only the standard CLI apply path is eligible after exact-SHA review. The declaration intentionally retains no HTTPS apply column declaration; an initial CLI transport failure therefore fails the HTTPS apply gate before mutation, rather than permitting the forbidden ledger-renaming fallback.

## Verification

The 10 restored local files match native payload SHA-256 and byte counts. The original fix's lib/scripts/tests and stage-200 SQL are unchanged from `e1a3c2db`. Migration lifecycle/HTTPS guard tests: 45/45 PASS. `npm run build`: exit 0. `npm run control-plane:check`: exit 0, 425 pass / 16 skip. `git diff --check`: exit 0. Additional full-tsc failures recorded by the original PR remain outside this recovery scope; no broad typecheck success is claimed.

## Natural acceptance remains separate

`RECOVERY_RUNTIME_BASELINE.json` records a frozen cutoff at 2026-10-16T07:30Z. Completed UTC day 2026-10-15: Production and DBClone both 100 distinct matches / 233 markets / 7127 observations, with the same full-content digest. Current partial day: 29 matches on each side, Production 4396 rows versus clone 4286 rows at the cutoff; parity for that current cohort remains pending, not declared lossless. Both databases have zero duplicate IDs and zero events over 192 rows or 16 tokens.

After reviewed activation and deployment, measure the next complete UTC day (2026-10-17 if activation occurs on 2026-10-16). Stage 200 is not PROVEN until a natural UTC day contains more than 100 distinct matches and the frozen persisted cohort matches DBClone by IDs/content, with no collection degradation. No synthetic runtime matches, historical rewrites, or stage-300 activation are authorized by this recovery.
