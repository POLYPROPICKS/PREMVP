# Gate 1 limited exception (one-time, documented) — Box B release payload v2

**This is an exception record, NOT a Gate 1 PASS.** `/verify` result for these paths remains **HOLD**
(`ops/` and `tests/` are an unclassified path category in `.claude/commands/verify.md`).

| Field | Value |
|---|---|
| Granted by | Founder, in the session of 2026-10-13 (message "FOUNDER DECISION — LIMITED GATE 1 EXCEPTION: APPROVED") |
| Scope | One-time, SQL-only, Box B PR #530 |
| Payload | `ops/research-clone/box-b/release_v2/payload.sql`, SHA-256 `3e852ebe78e6f1f2c4c2823251be2aee101d913d24186f785068474e7b76fbb8` |
| Covers | Only the Gate 1 HOLD caused by the unclassified paths `ops/` and `tests/` |
| Does not cover | Any other gate; any other payload or SHA; any apply; reclassification of `ops/` or `tests/` for later work |

## Conditions stated by the Founder (verbatim in substance)

1. The existing static checks, PostgreSQL semantic tests and control-plane checks remain **mandatory**.
2. An independent R4 (`premvp.reviewer.contur_gate.v1`) on the exact payload is required; its receipt is stored in Git.
3. **Applying the migration to the DBClone is forbidden for now.** Write permission will be granted separately,
   after R4 PASS and after confirmation that the official Supabase API executes the payload atomically.
4. Production, PR #526, PR #528 and Ireland are not to be touched.

## Status at the time of recording

| Mandatory check | Result |
|---|---|
| Static gate (`boxBReleaseV2Static.test.ts`, `boxBOutcomeStatic.test.ts`) | 10/10 PASS |
| PostgreSQL 16 semantic suite (`boxBReleaseV2Behavior.sh`) | PASS (`pg_test_receipt.txt`) |
| `npm run control-plane:check` | PASS |
| Independent R4 | **PASS** on `9bd9e320` (`r4/`, 0 blocking findings, next phase NOT_READY) |
| Official-API atomicity | **UNVERIFIED** — required before any write is authorized |
| Apply to DBClone | **NOT AUTHORIZED** |
