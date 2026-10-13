# Box B — Market Outcome Authority (pilot v1)

Status: **REVIEW PENDING — not applied to any database.** Target: Research DBClone `nppznoujvnyjargjkmnv` only.

## What this is

Box B is a permanent, market-scoped store of **real provider outcomes**, independent of model bets,
Ledger, ROI and stakes. This package is the first production-grade increment (schema + 20-market pilot);
the schema is built for full historical backfill and a daily collector without redesign.

The earlier Box B draft (`20261013100000…`, SHA `b656244f…`) was lost with a temporary container.
**This is a new implementation of the approved semantics with a new SHA-256 — it is not the old file.**

## Artifacts and hashes

| Artifact | SHA-256 |
|---|---|
| `ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql` | `0643c807eae6b17475d2948af3146251838dd9b86e52955a5d8456c0c4dc4766` |
| `ops/research-clone/box-b/pilot_insert.sql` | `c45455b18c966dde1ce04ee61004d0ab5eccc32d69dbe2850f22a67da0582f6a` |
| `ops/research-clone/box-b/operator_dbclone_box_b_v1.sql` (the single operator script) | `26bc5ed895570a0c8605fcd98331e504e24521de2e8972d75e88f77ff374a58f` |
| `ops/research-clone/box-b/market20_frozen_input.csv` (our copy of the frozen input) | `1cd9b923ee4055f5900af4f3bb9cf0a4d63071cc33018e7cfc777556a585ba81` |
| `ops/research-clone/box-b/receipts/receipts_index.json` | `2cb76f8c37a8e3ed9fe7932e97c088993777ff19e4d43038038793508b043551` |

The Founder-declared manifest SHA `a09d3d6f…` could **not** be reproduced: the original JSON file was not
supplied and none of the obvious serialisations of the 20 pairs hash to it. The CSV above is the pairs exactly as
given in the mission text; its own SHA is recorded here instead. The old membership/pilot SHAs
(`aa5e…`, `5b29…`) are not used.

## Design

* `market_outcome_provider_receipts` — raw provider bodies, byte-exact; `raw_digest = sha256(raw_body)` is a CHECK
  constraint, so the table cannot hold a body that does not match its digest. Unique on
  `(provider, request_kind, request_key, raw_digest)`: re-loading the same receipt is a no-op.
* `market_outcome_revisions` — one row per claim about a market, PK `(condition_id, revision_no)`, a hash chain
  (`prev_revision_digest` → `revision_digest`), `evidence_digest` for idempotency, status
  `FINAL | PENDING | VOID | CONFLICT | LOOKUP_FAILED`. Re-submitting evidence identical to the latest revision
  inserts nothing; new evidence (including a flip back to older evidence) becomes the next revision.
* The insert trigger re-validates every FINAL/VOID **inside the database** against the stored receipts (market
  identity, both providers closed, token sets equal, Gamma `outcomePrices` 1/0 and CLOB `winner` naming the same
  token, or 0.5/0.5 and no winner for VOID, and `resolved_at` equal to the provider's own `closedTime`/`umaEndDate` under its
  source label; missing prices/tokens are refused, never defaulted). A caller cannot assert an outcome the receipts do not show.
* `market_outcome_current` (security_invoker view) — newest non-`LOOKUP_FAILED` claim per market, plus
  `last_checked_at`. A failed lookup is recorded as history but never hides a standing FINAL.
* ACL: `public/anon/authenticated/blind_model_reader` hold nothing (also revoked on the validator function);
  `service_role` has SELECT+INSERT only; RLS enabled; UPDATE/DELETE/TRUNCATE are blocked by triggers even for the
  owner (`BOX_B_APPEND_ONLY`, SQLSTATE 23001).
* No `bet_row_key`, ROI, stake, Ledger or paper-decision column, no FK leaving Box B, no change to any existing
  table. `has_paper_decision` appears only in this evidence file, never in the database.

## Provider receipts (collected 2026-10-13 over HTTPS, read-only)

Counts from the real responses: **FINAL 20, PENDING 0, VOID 0, CONFLICT 0, LOOKUP_FAILED 0**
(41 receipt rows: 20×Gamma `condition_ids=…&closed=true`, 20×CLOB `/markets/{condition_id}`, +1 Gamma token lookup).
The sampled input token was the winner in only 9 of 20 markets, so the pilot does not simply echo the observed side.

| # | paper decision (evidence only) | condition_id | status | winner token | resolved_at (gamma.closedTime) | input token |
|---|---|---|---|---|---|---|
| 1 | yes | `0x1720920991…e5c1e3` | FINAL | `…97641940` | 2026-10-10T15:29:31+00:00 | non-winner |
| 2 | yes | `0x6e15658c01…9df673` | FINAL | `…69403712` | 2026-10-10T10:45:27+00:00 | non-winner |
| 3 | yes | `0xeee5fdb976…95c123` | FINAL | `…62983268` | 2026-10-10T09:37:30+00:00 | winner |
| 4 | yes | `0xb9e1088429…cb14b2` | FINAL | `…90269709` | 2026-10-10T14:11:31+00:00 | non-winner |
| 5 | yes | `0x173579dbc6…05ace4` | FINAL | `…62165465` | 2026-10-10T15:31:31+00:00 | winner |
| 6 | yes | `0x76549b9272…c41b01` | FINAL | `…22382546` | 2026-10-10T15:38:18+00:00 | winner |
| 7 | yes | `0xe5072ab231…1f3d93` | FINAL | `…86298942` | 2026-10-10T13:50:15+00:00 | non-winner |
| 8 | yes | `0x2743aca0d4…4e387b` | FINAL | `…53136692` | 2026-10-10T16:04:31+00:00 | winner |
| 9 | no | `0x714dc8537a…12ad64` | FINAL | `…47296528` | 2026-10-09T02:13:57+00:00 | winner |
| 10 | no | `0x932da2432f…a41818` | FINAL | `…67738855` | 2026-10-10T07:07:43+00:00 | non-winner |
| 11 | no | `0x03b9c4701a…652990` | FINAL | `…98460036` | 2026-10-09T19:21:43+00:00 | winner |
| 12 | no | `0xb85ad4c07c…c2fa65` | FINAL | `…44729243` | 2026-10-09T05:38:57+00:00 | winner |
| 13 | no | `0xb1db5441e1…d548e2` | FINAL | `…23583660` | 2026-10-10T11:27:43+00:00 | non-winner |
| 14 | no | `0x843b9358b9…d70b97` | FINAL | `…31014278` | 2026-10-11T01:55:47+00:00 | non-winner |
| 15 | no | `0x8da7644456…0ee82e` | FINAL | `…29650400` | 2026-10-09T05:09:42+00:00 | non-winner |
| 16 | no | `0x99e0d8fcbf…2eaae2` | FINAL | `…05345379` | 2026-10-09T01:43:56+00:00 | non-winner |
| 17 | no | `0xa2afb9debe…bdac35` | FINAL | `…15190472` | 2026-10-08T10:28:27+00:00 | non-winner |
| 18 | no | `0x5d3a11b3f2…3dd1c5` | FINAL | `…95100936` | 2026-10-08T16:45:26+00:00 | winner |
| 19 | no | `0xb08ba128f9…4fbc20` | FINAL | `…24520726` | 2026-10-08T21:34:14+00:00 | non-winner |
| 20 | no | `0x1bd8dc4dbd…76d68f` | FINAL | `…30323672` | 2026-10-09T19:05:41+00:00 | winner |

### Input defect found: market #10

The frozen `condition_id` for pair 10 is 63 characters (a valid one is 66). It was **not** guessed or padded. It was
resolved only through its exact `token_id` (Gamma `clob_token_ids=…&closed=true`), which returns exactly one market,
`0x932da2432f49631d03571050c7dfc33f851607d840147bc2eea3ea3acaa41818`; the input is a subsequence of it (three characters, `ea3`, were lost in transcription).
The token receipt is stored as its own receipt row.

## Verification

`tests/research-clone/boxBOutcomeBehavior.sh` (PostgreSQL 16 scratch cluster, Supabase-style default privileges
that auto-grant new tables even to `blind_model_reader`): applies the operator script, reloads the pilot twice
(still 20 revisions / 41 receipts), runs 56 probes (structure, ACL matrix incl. validator EXECUTE and the identity sequence, append-only for owner and `service_role`,
digest/validator rejections, revision chain, A→B→A history, LOOKUP_FAILED handling), proves the script refuses a
second apply, a non-DBClone database and rolls back fully on mid-script failure, and runs 11 negative controls
(each injected regression — dropped trigger, granted reader, extra `bet_row_key` column, neutered validator,
touched observation table, validator EXECUTE or sequence granted, RLS off, PUBLIC grant … — is detected by the same suite).
Receipt: `ops/research-clone/box-b/pg_test_receipt.txt`.
`tests/research-clone/boxBOutcomeStatic.test.ts` re-checks hashes, receipt digests and forbidden tokens in the normal repo test run.

## Known limits (stated, not hidden)

* **Provenance trust root is the writer.** The database proves a stored receipt is internally consistent and that a FINAL/VOID
  matches it, but it cannot prove the body really came from Polymarket: a malicious `service_role` could insert a fabricated body
  that hashes correctly. Receipt rows are append-only, so any such write is permanent and attributable (`recorded_by`, `recorded_at`).
  A later PENDING/CONFLICT revision supersedes a FINAL in `market_outcome_current` (history stays in the chain), so consumers must
  not treat the view as immutable-final. Stored bodies are byte-exact, including the trailing LF both providers append.
* **DBClone identity is by sentinel table.** The script's guard is the presence of `research_inplay_core_path_observations`; it cannot
  distinguish a Production database that also has that table. The operator must confirm the SQL Editor is open on project
  `nppznoujvnyjargjkmnv` before running. After any failed run, check `to_regclass('public.market_outcome_revisions') is null` before retrying.
  The script is a large single paste; an editor that truncates it fails closed (no `COMMIT`).

* A database superuser can disable triggers / `session_replication_role=replica`; Box B defends against application roles, not DBA bypass.
* Nothing has been applied to DBClone. This session's Supabase connector does not list `nppznoujvnyjargjkmnv`, and the registered
  HTTPS migration route needs a Supabase token that is not present, so DBClone existence and the live migration ledger are **unverified** from here.
  The operator script's guards fail closed if the project is not a Research DBClone, if Box B exists, or if version `20261013130000` is registered.
* The script does not register the version in `supabase_migrations`; ledger registration is a separate operator decision.
* `resolved_at` is Gamma `closedTime` (UMA/close time as reported by the provider), recorded with its source label.

## Apply (after R4 PASS only)

Paste `ops/research-clone/box-b/operator_dbclone_box_b_v1.sql` into the SQL Editor of project `nppznoujvnyjargjkmnv`. It is one transaction
(`BEGIN … COMMIT`) with pre-checks and post-checks; any failure rolls everything back. Never run it on Production.

## Next

1. Daily outcome collector with catch-up + full historical backfill (writes through `service_role`, same insert contract).
2. Frozen Ledger decisions JOIN Box B outcomes and a fixed SQL scoreboard (ROI lives outside Box B).
