# NEW_CONTOUR_9 — Minimal history, hot current state, and first reconciled PnL

## Status and authority

**Founder-approved product/architecture decision. Historical checkpoint; not current operational state.**

CURRENT_STATE.yaml remains the only current operational-state artifact. This document does not prove pruning, Queue execution, Ireland execution, live money, settlement, or PnL. The live Git fact resolved for this decision is origin/main = acbad91786e71683bcd31d38d578f66d5ecaa742. The reported production equality, Planning index scan, 15-group Contract A run, Planning 57014 = 0, and natural Reservation/Rebalance-to-Queue completion remain runtime claims pending their own evidence; they are not promoted here.

## Final minimal architecture

Polymarket structured API -> current open provider universe -> resolver/scoring -> candidate Signal Pair -> dedup against current_signal_pair_serving -> generated_signal_pairs INSERT (history + exact lineage id) -> current_signal_pair_serving (hot current authority) -> Contract A Planning -> night_event_reservations -> event-rebalance -> event_execution_queue -> PREMVP/Ireland boundary -> one Ireland consumer -> venue submission -> callback/reconciliation -> settlement -> fees -> reconciled net PnL.

Parallel offline history path: generated_signal_pairs -> PITR/backup clone -> validated export -> Parquet -> DuckDB/Polars -> modelling, backtests, and model improvement.

One PostgreSQL primary is sufficient for the near-term workload. Do not add Redis, Kafka, a second hot Signal Pair table, History V2, ClickHouse, a generation/snapshot architecture, sharding, a database split, a generic cleanup service, a new backfill runner, a new queue, a scheduler platform, or infrastructure chosen only for elegance. Complexity is itself a business risk.

## Hot serving lifecycle

current_signal_pair_serving is the single hot Signal Pair authority for Planning. It is a reconstructible projection with four mandatory lifecycle properties:

| Property | Required meaning |
| --- | --- |
| Admission | A newly computed observation is projected only when a current eligible identity needs serving. |
| Update | A current identity may be refreshed/replaced with its exact persisted lineage id. |
| Eviction | Physical deletion is mandatory when the identity is expired or resolved/terminal. |
| Rebuild | A bounded recovery/bootstrap may reconstruct current eligible state; it is never a normal historical scan. |

The initial physical prune **must be symmetric with producer eligibility/dedup**: conceptually, serve ACTIVE AND unresolved AND expires_at > now; evict expired OR resolved/terminal. Exact predicates are implementation-source authority and must be re-resolved in Step 1.

Do not prune merely because an event is outside the next 24-hour execution horizon. That would allow delete -> dedup identity absent -> producer re-emits -> new history append -> serving write -> delete loops. “24 hours” means event-start relevance for money selection, not source-row created_at age. A valid open identity can remain hot before it becomes eligible for a near-term execution decision.

Permanent invariant: SIZE(current_signal_pair_serving) is a function of the current eligible open market inventory times current live formula identities, never of operating days. Logical filtering alone is insufficient; physical lifecycle is required.

## History and lifecycle policy

generated_signal_pairs remains append history, a lineage anchor, exact-PK lineage reads, and the currently proven bounded resolver workload. It is forbidden from broad Planning reads, current-state reconstruction, producer historical dedup, serving bootstrap, historical backfill, modelling scans, and reporting scans on the live-critical path. Do not delete the valuable corpus. At roughly 10k observations/day (~0.9M/quarter; ~3.65M/year), PostgreSQL remains conventional under bounded access; row count alone does not justify partitioning.

Current state is independent of **historical GSP reads**, but deliberately not yet independent of GSP writes: compute -> GSP append -> obtain exact GSP id -> serving projection. This preserves lineage/FK/downstream contracts. Only after live-money evidence, if necessary, may a future design create a stable Signal Pair identity before persistence and fan it out to hot and history.

| Surface | Role | Lifecycle and retention | Boundary |
| --- | --- | --- | --- |
| current_signal_pair_serving | Hot, reconstructible current state | Mandatory physical eviction; current eligible state only | Producer-coupled bounded prune + normal autovacuum |
| generated_signal_pairs | History and lineage | No cleanup now; retain near-term corpus, archive offline later | No broad money-path reads |
| night_event_reservations | Decision/workflow audit | No cleanup before financial/audit lifecycle; ~90k/quarter is not a storage issue | Active queries stay bounded |
| event_execution_queue | Immutable execution/financial audit | No cleanup before reconciliation/PnL; ~90k/quarter is not a storage issue | Polling stays bounded |
| Execution receipts, callbacks, settlement records | Financial audit | Long-lived; no cleanup before full reconciliation | Exact names/predicates remain source authority |
| job_runs | Telemetry | Compact diagnostics; optional 30–90 day retention only after measured need | Never an event-history warehouse |
| Serving backfill/checkpoint artifacts | Legacy/recovery only | Retire from steady state; preserve only bounded recovery evidence | Never normal production machinery |
| Research/modelling materializations | Analytical | Broad history belongs on clone/export/Parquet, not money-bearing primary | Validate export before use |

The near-term cleanup architecture contains only producer-coupled bounded serving prune, normal PostgreSQL autovacuum, optional diagnostics retention later, and offline export/archive. Anything else requires measured runtime evidence.

## Recovery policy

Before live money, the Founder permits approximately 2–3 days of database data loss for fast recovery while preserving code/schema/contracts. That tolerance does not carry into live money. Reservations, Queue, order receipts, callbacks, settlement, and PnL need a money-appropriate recovery policy before material scale. Exact RPO/RTO are intentionally not invented here.

## Shortest sequence to a reconciled financial value unit

0. Persist this decision, its risk register, and the canonical roadmap.
1. Implement hot physical lifecycle: eligibility-symmetric serving prune and minimal eviction access path; prove expired/resolved eviction, producer and Planning concurrency, idempotency, and no re-emission loop.
2. Prove execution safety: Queue READY-to-CLAIMED/mark semantics and callback replay/idempotency; change code only if proof finds a defect. Start with one Ireland consumer.
3. Run one capacity gate at ~10k provider/current candidates and ~1k Reservation-scale outputs: measure producer duration, query count, rows read/written, serving steady-state count, prune and Planning duration/access path, Rebalance round trips, Queue duplicates, timeouts/deadlocks, and connection high-water mark. Do not build a benchmark platform.
4. Obtain the natural PREMVP proof: producer -> serving -> Planning -> Reservation -> Rebalance -> Queue with exact bounded lineage. Reuse already-accepted natural-heartbeat evidence rather than rerunning it.
5. Seek separate R5/Ireland authorization for one bounded real order with one consumer.
6. Deliver the first financial value unit: callback -> settlement -> fees -> reconciled net PnL.
7. Freeze architecture. Afterwards, a database architecture change needs a concrete production measurement, the exact failing business boundary, and proof that a smaller correction cannot solve it.

## Architecture freeze: explicit non-build list

Do not speculatively implement ClickHouse, Redis, Kafka, a new hot table, History V2, a new queue, a new backfill runner, generation snapshots, sharding, a database split, generic cleanup, generic scheduling, or a generic observability platform. New database architecture after the freeze needs the three-part measured-bottleneck case above.

## Independent challenge

### PROVEN_FACTS

- Live Git resolved origin/main to acbad91786e71683bcd31d38d578f66d5ecaa742.
- The repository contains the named hot serving, GSP, Reservation, Queue, and bounded-recovery surfaces; source documents already establish serving as a bounded operational projection.
- Canonical policy makes CURRENT_STATE.yaml the only current operational-state authority.

### SUPPORTED_INFERENCES

- A single primary and bounded access paths are proportionate to the stated near-term volumes.
- Symmetric eviction is the smallest defense against re-emission caused by horizon-only deletion.

### UNVERIFIED_ASSUMPTIONS

- Reported production/Planning facts and natural heartbeat completion are not independently proven in this documentation mission.
- Exact eviction predicates, Queue CAS behavior, callback semantics, and financial record names require source/runtime resolution in their respective implementation missions.

### CONTRADICTIONS

- The stated 24-hour business selection horizon conflicts with a 24-hour physical serving prune; NEW_CONTOUR_9 resolves this by separating money selection from current-universe eligibility.

### FIRST_PROVEN_PROBLEM

The earliest defensible constraint is that a growing hot projection needs physical lifecycle while remaining symmetric with producer dedup.

### SMALLEST_DEFENSIBLE_APPROACH

Keep one PostgreSQL primary, add only producer-coupled serving prune in Step 1, and move analytics to validated offline history access.

### MATERIAL_ALTERNATIVE

NONE. A new projection, snapshot system, or infrastructure tier would add dual-truth and recovery cost before a measured bottleneck.

### REGRESSION_AND_MAINTENANCE_RISK

Prune introduces concurrency and bloat risks; Step 1 tests and later vacuum observation contain them. The alternative introduces larger, persistent operational complexity.

**Independent-challenge verdict: PROCEED_WITH_CORRECTION** — preserve the minimal architecture, but explicitly reject horizon-based physical eviction and never upgrade reported runtime facts to PASS through this document.
