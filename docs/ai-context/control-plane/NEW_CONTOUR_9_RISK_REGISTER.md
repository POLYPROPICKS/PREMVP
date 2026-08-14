# NEW_CONTOUR_9 — 90-day risk register and intervention policy

## Authority and timing classes

This is a Founder-approved architecture risk policy, not an operational-state artifact and not runtime proof. Likelihood is judgement, not false precision.

- **A — MUST FIX BEFORE FIRST LIVE BET:** implement the smallest prevention now.
- **B — MUST PROVE BEFORE FIRST LIVE BET:** obtain bounded evidence; modify only if proof fails.
- **C — FIX BEFORE MATERIAL SCALE:** keep a measured threshold and correct before scale.
- **D — FIX ONLY AFTER RUNTIME EVIDENCE:** observe first; size alone is not a defect.
- **E — OFFLINE / NON-BLOCKING:** protect offline workflow without delaying the live contour.
- **DO_NOT_BUILD:** explicitly rejected unless the architecture-freeze evidence standard is met.

| Risk | Layer | Likelihood | Impact | When | Detection | Minimal prevention | Recovery | Do not overengineer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R01 Unbounded serving growth | Hot state | Medium | High | A | steady-state count vs current inventory | physical eligible-state prune | bounded rebuild after cause fix | no new hot table |
| R02 Horizon prune re-emission loop | Producer/serving | Medium | High | A | repeat-cycle insert/churn test | evict only expired or terminal | restore eligible row; stop bad prune | no 24h row-age prune |
| R03 Planning query/index/formula drift | Planning | Medium | High | B/C | EXPLAIN and rollout capacity gate | formula allowlist + access-path proof | revert formula/index change | no index framework |
| R04 Non-atomic Queue claim | Queue | Medium | Critical | B | concurrent READY claim test | CAS/idempotency; one consumer | quarantine duplicate and reconcile | no new queue |
| R05 Rebalance N+1 at ~1k reservations | Rebalance | Medium | High | B/D | capacity round trips/latency | measure current path | batch only after proof | no speculative batching |
| R06 Resolver backlog | Resolver | Medium | High | C/D | pending count, oldest age, throughput, errors | monitor four signals | clear proven bottleneck | no resolver table |
| R07 Analytics compete with money jobs | Database | Medium | Critical | A/C | primary query attribution | quarantine broad analytics offline | pause analytics/use clone | no OLAP cluster now |
| R08 Serving DELETE/vacuum bloat | PostgreSQL | Medium | Medium | D | dead tuples/vacuum/latency | normal autovacuum observation | tune after evidence | no vacuum program |
| R09 Obsolete GSP indexes | PostgreSQL | Medium | Medium | D | post-live index usage audit | retain until evidence | remove one proven-unused index | no index purge campaign |
| R10 Broad GSP reads return to product | Architecture | Medium | Critical | A/C | code review/tests/query evidence | permanent live-path prohibition | replace with exact-ID/hot path | no history redesign |
| R11 Research formula joins live money | Formula policy | Medium | Critical | B | formula-family acceptance test | explicit live allowlist | disable family and reconcile | no formula platform |
| R12 Formula-version accumulation | Model lifecycle | Medium | Medium | C | allowlist/cardinality review | retirement discipline | retire inactive versions | no version service |
| R13 Synchronous GSP write dependency | Producer | Medium | High | D | write latency/error evidence | accept current lineage contract | assess fan-out after live proof | no outbox now |
| R14 Reservation history hits active queries | Reservation | Low | Medium | D | latency/EXPLAIN | bounded active predicate | add narrow evidence-led index | no partitioning |
| R15 Queue history hits polling | Queue | Low | High | D | poll latency/EXPLAIN | bounded active predicate | add narrow evidence-led index | no queue redesign |
| R16 Duplicate callback | Callback | Medium | Critical | B | replay test | persisted idempotency key | quarantine/reconcile duplicate | no callback platform |
| R17 Non-idempotent settlement/fees/PnL | Financial | Medium | Critical | B/C | replay and reconciliation proof | deterministic ledger/idempotency | halt money path and reconcile | no finance rewrite |
| R18 job_runs diagnostics bloat | Telemetry | Medium | Low | D | row growth/query cost | compact aggregates | add measured retention | no event warehouse |
| R19 Cron/pool overlap | Operations | Medium | High | C | overlap/connection high-water | simple staggering/quarantine | reduce schedule overlap | no scheduler platform |
| R20 Schema/index/function drift outside Git | Provenance | Medium | High | C | Git-to-DB provenance audit | close drift before freeze/scale | reconcile documented drift | no schema-control platform |
| R21 Pre-money loss tolerance after money | Recovery | Medium | Critical | C | recovery/RPO review | set financial-state recovery policy | halt scale until compliant | no invented RPO/RTO |
| R22 Timestamp serialization regression | Identity | Medium | High | B/C | typed-instant contract tests | deterministic serialization | reject/replay malformed boundary | no time abstraction rewrite |
| R23 Fuzzy re-derived provider identity | Identity | Medium | Critical | B | exact-ID lineage test | persist/use exact IDs | quarantine ambiguous record | no fuzzy matcher |
| R24 Torn current provider universe | Producer | Low | High | B/D | partial-cycle concurrency test | test current semantics first | retry bounded cycle | no generation snapshots |
| R25 Prune concurrency with producer/Planning | Hot state | Medium | Critical | A/B | concurrent prune/producer/Planning tests | transaction-safe minimal prune | pause prune and rebuild bounded state | no lock framework |
| R26 Resolver-update historical bloat | Resolver/history | Medium | Medium | D | row/update growth evidence | observe write pattern | narrow correction after proof | no History V2 |
| R27 Observation makes broad historical reads | Observability | Medium | High | C | query logging/EXPLAIN | exact-ID bounded observation | replace one read path | no observability platform |
| R28 Safety caps become scale ceilings | Capacity | Medium | High | B/C | capacity test classification | test each cap's purpose | tune only proven ceiling | never blindly remove caps |
| R29 One Ireland consumer too slow | Ireland execution | Low | High | D | queue age/throughput | measure one consumer | increase only after proof | no premature parallelism |
| R30 Multiple Ireland consumers too early | Ireland execution | Medium | Critical | C | CAS/concurrency receipt | explicit prohibition until proof | return to one consumer | no worker pool |
| R31 Modelling queries primary GSP | Analytics | Medium | High | A/E | query/source audit | clone/export/Parquet policy | stop query and use offline copy | no primary OLAP tuning |
| R32 Parquet/archive integrity failure | Offline archive | Low | High | E | row counts/checksums | validate every export | re-export from backup clone | no data lake |
| R33 New ClickHouse/Redis/Kafka/etc. | Infrastructure | Medium | High | DO_NOT_BUILD | proposal lacks bottleneck case | architecture-freeze rule | reject proposal | do not pre-provision |
| R34 New projections create dual truth | Architecture | Medium | Critical | DO_NOT_BUILD | ownership ambiguity | one hot authority | remove unproven projection | do not duplicate state |
| R35 Endless DB engineering delays value | Governance | High | Critical | A | milestone has no business transition | freeze rule; next-value sequencing | stop/re-contract to next value step | no broad architecture program |

## Intervention policy

At roughly 10k Signal Pair observations/day and 1k execution decisions/day, only R01, R02, R07, R10, R25, R31, and R35 justify pre-live implementation policy; all other entries are either proof, capacity, or evidence gates. Expected Reservation/Queue scale (~90k/quarter) is not a storage trigger. No risk is solved by history deletion, broad backfill, or new infrastructure without a measured failing boundary.

The fixed near-term cleanup scope is: producer-coupled bounded serving prune, PostgreSQL autovacuum, optional diagnostic retention later, and validated offline export/archive. New work must cite the register ID, timing class, detection evidence, and the smallest prevention.
