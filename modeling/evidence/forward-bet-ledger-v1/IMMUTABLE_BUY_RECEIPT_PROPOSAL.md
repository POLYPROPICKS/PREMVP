# Immutable forward BUY evidence — isolated proposal

Status: PROPOSAL ONLY. No SQL migration, schema apply, release or data mutation is authorized. Builds on Draft #546 at 63a72d43, itself stacked on Draft #526 at 8bb12ed. Does not change A/B/C, Tail #544, SAFE selectors, stake or quote/fee thresholds.

## First broken edge and current containment

The old cycle performs `upsert(...ignoreDuplicates:true)`, then reads the ledger and matches a new quote receipt to an existing row by row key and VWAP only. A concurrent winner at the same price but different quote/decision times satisfies that test. The database row never froze the new fee/shares/stake/depth/digest, and CURRENT overwrites receipts on the next cycle.

Cycle 2 removes that read-back attribution. Quote-pass receipts are bounded provisional diagnostics; authoritative receipts, persisted BUY count and executable BUY count remain empty/zero. The runtime does not enqueue successful BUY quotes as ledger rows, and insertChoices rejects executable-price rows before any write, even in a mixed legacy batch. This is containment, not an immutable storage implementation.

## Proposed minimal durable boundary

Chosen design for approval: one private append-only attempt/receipt table and one DBClone-owned atomic transaction/RPC, linked to the existing ledger. A receipt-only ledger column would not retain rejected acquisition/quote attempts, so it cannot provide the required prospective denominator. No second accepted-receipt table, object-storage service or CURRENT authority is needed.

- The database generates attempt identity and persistence time. Uniqueness must enforce the existing model × economic-unit first-choice contract and receipt/attempt identity. Keep quote attempts distinct from the accepted economic unit.
- Each immutable attempt records original selection identity (model/version, candidate/observation identity, canonical game/economic unit, condition/token/outcome, scope and reference price), selection/provider/request/receipt/decision/DB timestamps, attempt ordinal/retry policy version, and accepted/rejected outcome/reason.
- Accepted receipt freezes stake/ledger version, filled shares, ask ladder evidence sufficient to reproduce full-stake VWAP, minimum size, tick/precision rules, fee schedule/source/time/formula, per-level fees, total notional/all-in cost, slippage and canonical receipt digest. Bound payload size; use an immutable content-addressed evidence object if needed, not a mutable external URL.
- Server validates all fields, digest and receipt/ledger equality. Check quote freshness and start lead at the database transaction time, not merely before a client network loop. No verified timing or physical-game status can be written by the caller.
- A row-key conflict must return the original winner identity/digest and an explicit conflict outcome. It must never bind a new receipt to the winner by equal VWAP. An economic-unit conflict likewise remains a rejected attempt, not an accepted BUY.
- A transaction failure commits neither accepted receipt nor ledger row. An idempotent replay returns only the original immutable record. UPDATE/DELETE are denied by DB guards; use minimal private grants/RLS and no public ledger/receipt exposure.
- Snapshot/API summaries derive counts from immutable records at a stated cutoff; CURRENT may cache those counts but is never the evidence authority.

## Frozen economics and eligibility

Existing USD 2.50 is ask notional; fees are on top. With a recorded five-share minimum, at least five filled shares requires full-stake VWAP ≤ 0.50. This is a necessary fill condition, not proof of a valid signed market order: limiting price, amount rounding, market/order protocol and current provider minimum also need matching evidence. Keep full-depth, fee, identity and freshness gates.

Historical reference-price distributions cannot establish executable eligibility. Record all future selected attempts and book/fee acquisition failures, below-minimum/depth/staleness rejections, duplicates and retries. Report separately: frozen model selections; BUY-enabled selections; attempts with complete quotes; quote passes; immutable accepted BUYs; independently verified BETs; terminal outcomes. Never replace an unknown denominator with zero or silently backfill it.

Smallest policy decision: retain USD 2.50 and explicitly accept sparse/no BUYs above the minimum boundary for the prospective pilot. A higher stake or different order-type interpretation is a separate Founder decision supported by official semantics; it is not part of this patch. Independently freeze whether only the first quote attempt counts or retries are allowed and how all attempts enter the denominator.

## Acceptance before persistence can be enabled

1. Independently review the exact proposed schema/RPC, concurrency, privileges and immutable identity contract; obtain separate migration/release authorization.
2. Disposable-DB tests: same key/same price/different quote race, same economic unit/different key race, digest mismatch, wrong model/token/condition/unit, stale-at-DB quote, rollback between receipt/ledger, repeat retry and idempotent replay, attempted UPDATE/DELETE, and least-privilege reads. Existing legacy rows and settlement authority must remain unchanged.
3. Atomic returned receipt identity and ledger identity must reconcile one-to-one, with explicit rejected/conflict counts. No accepted execution claim without a complete immutable receipt.
4. Passing focused/legacy/control-plane/type/build checks and independent exact-source review. Then separately authorize DBClone apply/deploy and collect only natural future data.
5. SELL needs a separately frozen exit policy, exact owned shares, contemporaneous full bid depth and fees. Net P&L/ROI remains UNKNOWN until immutable entry plus exit/terminal cash flows reconcile. Retrospective best exits remain oracle bounds, not prospective validation.

## Exact proposed implementation boundary — approval packet, not executable SQL

The following object names are proposed, not claims that objects exist. Target is DBClone `nppznoujvnyjargjkmnv` only. No Production or Ireland access; no migration execution or deployment in this task.

Source basis: `ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql` already makes ledger choices immutable, preserves database-owned first persistence/classification and defines a unique `(model_id, economic_unit_key)` ledger index. Keep that migration byte-identical. Add new objects through a separately generated, reviewed migration only after approval. Preflight must confirm the actual deployed object definitions match the reviewed baseline; mismatch blocks implementation/application.

### One table: `public.forward_buy_receipt_attempts`

| Proposed column/group | Contract |
|---|---|
| `attempt_id uuid` primary key | Caller creates a fresh ID before acquisition; DB verifies idempotency. Reuse with different submitted evidence returns `ATTEMPT_ID_CONFLICT`, never updates the original. |
| `model_id`, `model_version`, `candidate_identity`, `economic_unit_key`, `condition_id`, `selected_token_id`, `selection_observed_at` | Frozen selection-to-provider/economic-unit mapping. Accepted rows require every field and equality with the ledger. Rejected acquisition attempts may lack provider fields, with an explicit reason. |
| `outcome`, `rejection_code`, `ledger_row_key` | DB-authored outcome: `ACCEPTED` or `REJECTED`; accepted requires ledger key and no rejection; rejected requires reason and null ledger key. Separate result `REPLAY` returns an already stored original attempt without inserting a new one. |
| `db_received_at`, `db_persisted_at` | DB-owned clocks, never caller-authorized timing. Check validity at actual persistence; do not treat transaction start as a fresh quote. |
| `selection`, `quote`, `fill`, `fee` in versioned `receipt jsonb` | Freeze source observation/item IDs and source kind, original reference and observation; request start/receipt/provider/decision times; provider book identity and provider digest if available; the complete bounded ask ladder actually used for evaluation; min/tick/order-protocol/encoded amounts; notional/shares/VWAP/all-in cash; schedule/source/time/formula/per-level fees. Failure records retain available acquisition metadata without inventing missing values. |
| `receipt_canonical text`, `receipt_digest text`, `canonical_version` | DB renders a fixed version of canonical receipt bytes and computes SHA256 over their UTF-8 bytes. Persist those exact bytes so an independent verifier can hash them without reproducing a different JavaScript/JSONB serialization. Parsing canonical bytes must equal the validated receipt and duplicated identity columns. Proposed serialization version `PG_JSONB_TEXT_V1`; do not reuse the existing JS digest as if the encodings were identical. Final encoding is part of schema review. |
| `attempt_policy_version`, `attempt_ordinal`, original selection/quote-acquisition ID | Record retries and denominator semantics explicitly. A fresh transport retry uses the same attempt ID; a separately permitted new quote uses a new attempt and preserved selection identity. Default proposed pilot is first quote attempt only, subject to explicit approval; no policy is enabled by this document. |

FK `ledger_row_key` references existing ledger row key, DEFERRABLE INITIALLY DEFERRED. Partial unique indexes on accepted `ledger_row_key` and accepted `(model_id, economic_unit_key)` prevent a second accepted receipt for the same row/unit. Existing ledger uniqueness remains independently enforced. Multiple rejected attempts never consume a second economic position. Receipt immutability trigger rejects UPDATE, DELETE and TRUNCATE. Existing rows are not populated or modified.

### One RPC: `public.record_forward_buy_attempt_v1`

1. Validate explicit clone/source/contract/model versions, selected identity and permitted attempt policy. Preflight confirms the exact persisted source key/uniqueness; then validate supplied source IDs and frozen condition/token/observation/reference against that exact source record. If no unambiguous source linkage exists, reject `SELECTION_SOURCE_UNPROVEN`, not a speculative join. Never select/re-rank candidates or infer missing provider fields. Reject non-finite/invalid decimal data and unsupported schema/formula/order versions.
2. If `attempt_id` exists, compare canonical submitted input identity/bytes, excluding DB-generated response fields. Retain a separate DB-computed submitted-input digest for this comparison. Exact replay returns the original DB-owned receipt/digest/outcome/ledger identity. Different evidence returns `ATTEMPT_ID_CONFLICT`; it cannot be relabeled a replay or overwrite old evidence. The receipt digest covers canonical receipt bytes excluding the digest field itself.
3. For a new attempt, DB stamps receive time, validates required times/order, provider condition/token and selected economic unit, and recomputes full-depth fills/fees from the supplied immutable evidence. Apply the unchanged 30s provider age, 2s clock skew, 10s receipt-to-decision, 60s fee age, 60s quote-at-persist, five-minute start lead, 0.05 fee bound and 0.03 reference slippage rules. Also validate actual current provider min/tick and encoded order quantity after rounding; quote VWAP alone is insufficient. Unapproved rounding tolerances are not introduced.
4. Freeze canonical bytes and digest inside the DB. Accepted evidence must match ledger reference/provider quote/receipt/decision identity, executable price and economic unit exactly, with supported decimal/time normalization. DB computes verification classes using existing guards; caller cannot set VERIFIED or authoritative timing.
5. Use a subtransaction/savepoint around ledger INSERT plus accepted receipt INSERT. Do not use a client-side insert pair, ignore-duplicate success or price read-back matching. A same-key or same-economic-unit conflict rolls that accepted pair back and appends a rejected attempt with a stable conflict reason; return the winning ledger/receipt identity separately. An unexpected database error aborts the transaction rather than fabricating a rejected/accepted success. No accepted receipt may survive without its exact ledger row and no new executable ledger row may survive without its receipt.
6. The response is one explicit status plus original `attempt_id`, `ledger_row_key` if accepted, canonical bytes/digest and DB clocks. Application verifies response identity and digest before counting it. It must not count ignored insert attempts or derive authority from CURRENT.

### Ledger cross-check and least privilege

Add one deferred constraint trigger on executable ledger INSERT/UPDATE, requiring exactly one accepted immutable attempt with matching row/model/economic-unit/condition/token, observation/reference/quote/decision times and executable economics at transaction end. This enforces the boundary even if an existing service writes the ledger directly. Preserve the existing choice immutability and settlement journal rules. A matching reverse deferred check from accepted attempt insertion is also required so a directly inserted accepted receipt cannot point to a legacy/reference-only or mismatched row merely because its FK exists.

Use SECURITY INVOKER. Revoke PUBLIC/anon/authenticated function/table access; grant only the intended DBClone service role the minimum SELECT/INSERT/EXECUTE rights, never UPDATE/DELETE/TRUNCATE. RLS has no public policy. Privileged/bypass-RLS writes must still encounter the immutable and deferred integrity triggers. Do not weaken grants on the existing ledger or settlement tables. A database owner/superuser can alter guards; this is an application-integrity boundary, not protection from the database owner.

Preflight requires zero executable ledger rows lacking immutable receipt evidence. If any exist, STOP for an explicit legacy-quarantine decision; no backfill or fabricated accepted receipt is permitted. Existing reference-only/legacy ledger and A/B/C rows stay untouched.

### Application delta and fail-closed results

After separately approved schema implementation/testing, replace the BUY-only blocked insert branch with the single RPC. Keep legacy/reference inserts on their existing path. Do not remove the current containment guard to use ordinary upsert. Preserve frozen SAFE selection and original observation time. Stamp acquisition/decision as today; preserve actual unsuccessful acquisitions too. Build snapshots by counting immutable accepted attempts and rejected reasons at a cutoff; historical reference prices remain outside the executable denominator.

Fail-closed reasons include missing immutable schema/RPC, missing identity, condition/token/unit mismatch, missing/stale/future quote, stale-at-DB or late start, insufficient depth, unknown/below minimum, unsupported order precision/protocol, unknown/stale/mismatched fee, digest mismatch, attempt-ID conflict, ledger-key conflict, economic-unit conflict and payload budget exceeded. Oversized evidence is rejected, never truncated into an accepted receipt. Missing data is never synthesized. An unverifiable DB response is not accepted execution authority.

The intended code change remains the BUY authority/gate/cycle and focused tests. Schema tests additionally need a disposable Postgres instance; production reads/writes are not a test substitute. Catalog checks, two-client races, accepted/rejected reconciliation, direct-write reverse linkage, rollback, stale-at-DB, idempotency and privileges must pass before the schema or runtime can be considered review-ready for activation.

An immutable digest proves recorded evidence integrity, not that a caller told the truth about the external provider. Provider-book/fee provenance still relies on the reviewed HTTPS acquisition path and its frozen response evidence. Independent verification replays the recorded math and mapping; it does not upgrade actual-start, provider-root identity, profitability or provider authenticity without their separate evidence. Never report those as proven merely because the transaction committed.

### Approval requested by this plan (not requested interactively in this cycle)

Approve only a bounded DBClone implementation of the table, atomic RPC and bidirectional deferred checks above, a frozen first-attempt pilot policy, and its disposable-DB tests. Keep $2.50 and all current selector/quote/fee thresholds. Migration creation is an unapplied artifact until separate exact-SHA/schema review and explicit apply/release approval. No approval here implies #526/#546 merge, deployment, historical data work, SELL/net-profit acceptance or LIVE authorization.
