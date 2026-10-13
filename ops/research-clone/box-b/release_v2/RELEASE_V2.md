# Box B single release payload v2 (DBClone-only, NOT applied)

Status: **RELEASE_HOLD**. Gate 1 exception: **not approved**. Independent R4 on this payload: **not run** (STOP condition).

| Item | Value |
|---|---|
| Target | Research DBClone `nppznoujvnyjargjkmnv` (established by the project-bound API, not by the SQL) |
| Migration name for the official API | `market_outcome_box_b_authority_v1` |
| Payload | `release_v2/payload.sql` |
| Payload SHA-256 | `3e852ebe78e6f1f2c4c2823251be2aee101d913d24186f785068474e7b76fbb8` (262273 bytes) |
| Frozen source | PR #529 head `809093ee09c46ff7ecb588cdc30266465d018c0b` |
| Parts (verbatim) | migration `0643c807…`, `pilot_insert.sql` `c45455b1…`, operator verification block (`26bc5ed8…` script) |
| Rebuild | `python3 ops/research-clone/box-b/build_release_payload_v2.py` (deterministic) |

## What changed versus the operator script

Only the wrapper. Business logic, pilot data and the verification block are byte-identical to the frozen inputs.

- Removed: `begin`/`commit`, `set local` timeouts, the `research_inplay_core_path_observations` sentinel (it never proved target identity), and the `supabase_migrations` version check.
- Kept: replay guard (refuses if Box B tables already exist). It is not an identity check.
- Added: fail-closed count checks (20 distinct `condition_id`, 20 FINAL in revisions and in `market_outcome_current`, 41 receipts, no FINAL without winner).
- The payload never writes `supabase_migrations`. The API assigns the version; record the mapping `name = market_outcome_box_b_authority_v1` ↔ API version ↔ payload SHA-256. Do not rewrite the ledger.

## Atomicity assumption

The payload has no transaction control. It relies on being sent as one multi-statement simple-protocol query (one implicit transaction): any exception, including the verification block, rolls back schema and data. Proven locally on PostgreSQL 16 with `postgres.js` `.simple()` (`tests/research-clone/boxBReleaseV2Behavior.sh`). **Not proven against Supabase's real migration endpoint.** If the endpoint runs statements individually, a mid-batch failure would leave partial state; Architect must confirm single-batch behaviour or request a payload change (new SHA, new R4).

## Evidence (this commit)

| Check | Result |
|---|---|
| Byte-level hashes, verbatim composition, no tx control/ledger write/sentinel, 41+20 inserts | `boxBReleaseV2Static.test.ts` 5/5 (plus v1 static 5/5) |
| PostgreSQL 16 semantic suite on the payload | 56 probes PASS (`release_v2/pg_test_receipt.txt`) |
| Append-only, ACL (`blind_model_reader`, `anon`, `authenticated`, `PUBLIC`), service_role | inside the 56 probes + 11 negative controls PASS |
| Idempotency (pilot reloaded twice → 20 revisions / 41 receipts) | PASS |
| Replay guard, mid-batch rollback, verification rollback, ledger untouched | PASS |
| `npm run control-plane:check` | PASS (439 control-plane tests) |
| `git diff --check` | clean |
| PostgreSQL 17 (Supabase) privileges | **not tested** (PG16 only) |

## Gate 1 and R4

- `/verify` = **HOLD**: `ops/` and `tests/` are an unclassified path category in `.claude/commands/verify.md`. `/verify docs` would misclassify executable SQL; `/verify full` is a build, excluded by the mission.
- A limited SQL-only exception has **not** been approved by the Founder, so none is recorded here. Do not read this document as Gate 1 PASS.
- New independent R4 (`premvp.reviewer.contur_gate.v1`) on this payload is required after the exception and must be stored under `release_v2/r4/` bound to the payload SHA-256 and the reviewed commit. The old R4 claim on `809093ee` does not cover this payload.

## Acceptance for Architect after an authorized apply (read-only)

```sql
select count(distinct condition_id) markets, count(*) filter (where outcome_status='FINAL') final_n from public.market_outcome_revisions;  -- 20, 20
select count(*) from public.market_outcome_current where outcome_status='FINAL';                                                          -- 20
select count(*) from public.market_outcome_provider_receipts;                                                                              -- 41
select has_table_privilege('blind_model_reader', t, 'select,insert,update,delete,truncate,references,trigger') as any_access, t
  from unnest(array['public.market_outcome_revisions','public.market_outcome_provider_receipts','public.market_outcome_current']) t;      -- all false
select has_function_privilege('blind_model_reader','public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)','execute'); -- false
select count(*) from pg_trigger where tgrelid in ('public.market_outcome_revisions'::regclass,'public.market_outcome_provider_receipts'::regclass) and not tgisinternal; -- 5
select version, name from supabase_migrations.schema_migrations where name = 'market_outcome_box_b_authority_v1';                        -- exactly 1 row
```

Source observation tables: the payload references no table outside Box B (static test + negative control `nc_obs_touched`). Live sync can legitimately change those tables, so compare only on quiesced tables or by structure, not by raw counters.
