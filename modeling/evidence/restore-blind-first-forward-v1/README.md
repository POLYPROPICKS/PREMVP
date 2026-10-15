# RESTORE_BLIND_TO_FIRST_FORWARD_V1 — reviewed Research-only checkpoint

Target: Research DBClone `nppznoujvnyjargjkmnv`. Production and Ireland excluded. PR #538 stays Draft/HOLD; this checkpoint neither imports nor activates its V2 writer, trigger or identity admission contract.

## Business result and exact limits

This migration restores a DB-clock-owned BLIND horizon and a bounded, immutable, settlement-free scored source receipt. It does not claim a forward decision or authorize a BET. A genuine pre-T−90 decision and independent decision first_persisted_at read-back remain separate terminal acceptance requirements. The runtime completion artifact must distinguish horizon/source restoration from a functioning decision writer.

## Why the old path cannot prove the requested result

Live DB catalog at 2026-10-15 08:08:58 UTC: horizon 0 rows; service_role SELECT on each of its three raw views false, horizon INSERT/UPDATE false. Raw prematch/inplay views filter observed_at <= horizon but only LABEL created_at > horizon; late availability is not excluded. T20 projects no receipt timestamp. All three raw sources have zero observed_pre_T90 rows:
prematch 46,324; T20 9,340; inplay 69,707. These historical raw quotes contain no frozen-model score. Filling the singleton or granting raw views cannot create a timely scored input.

The current scored source is public.research_evidence_page_rows. However scripts/research-clone-daily-sync.ts explicitly assigns ingested_at = new Date().toISOString() and UPSERTs it: this is a mutable application transport timestamp, not independently DB-owned first availability. The preflight aggregate's observed<=ingested<=clock figures are SUPPORTED source timing, not proof of earlier DB existence.

At DB clock 08:11:56 UTC, 11,034 recent rows /494 provider event IDs had claimed ingestion by now and scheduled starts >now+90min; 4,949 soccer rows carried a score and 4,944 carried structured market+condition/token fields. Source availability is sufficient for a NEW DB observation receipt, without asserting retroactive receipt times.

## Narrow implementation

- Migration filename generated with Supabase CLI, then moved OUT of production supabase/migrations into ops/research-clone/migrations.
- Zero-argument research_blind_freeze_horizon_v1 reads up to 50 explicit, settlement-free scored rows, then stamps source_received_at and as_of with clock_timestamp AFTER the read. No caller-supplied clock, input rows or actor.
- Source rows, exact observation/item IDs, claimed source ingest timestamp, identity, score/formula and market columns are snapshotted in an append-only receipt. Later updates to source or horizon cannot change that receipt.
- scored_prematch_observations_v1 reads this frozen receipt, requiring observation <= claimed ingestion <= DB receipt <= as-of < scheduled T−90. It does not infer binary market semantics or a physical-game root.
- New public read RPC uses SECURITY INVOKER; only the named readers' SELECT policies apply. The narrow controller uses SECURITY DEFINER solely to retain revoked direct horizon/audit writes; fixed search_path, qualified objects, no parameters/dynamic SQL, no PUBLIC/anon/authenticated execution.
- Existing raw BLIND views are denied to model readers because their late-availability predicates remain unproven. No result/settlement source is granted.
- A capture is a bounded SOURCE SNAPSHOT, not the approved daily sampling cohort, model evaluation or model-specific T90 winner. A caller must recheck current DB time before any new decision.

## Existing immutable contract preflight

Live DB exposes prospective_selection_shadow_runtime and its DB-clock first_persisted_at guard. It contains 3,267 LEGACY ledger claims, zero FORWARD_BET_V1/V2 claims in the preflight aggregate. V2 clock/skip/identity objects are absent. The guard is the deployed V1 contract, with pre-start rather than mandatory T−90 timing and no separate evaluated-SKIP table. This is not a license to fabricate a legacy BET or activate PR #538.

PR #538 head 987badee0833fdc6b8a2ed8eab5f0ec5c1a1f92a is open Draft/HOLD against claude/stoic-noether-39kfqa. Its writer requires a V2 clock/immutable skip contract and candidate-specific identity witnesses; review of that branch does not release it. If a new BET cannot satisfy the existing immutable uniqueness/identity contract, the first writer boundary must be reported, not bypassed.

## Football D−1 input audit (Minsk 2026-10-14)

Settlement-free projected aggregate over source observed_at in [2026-10-13T21:00Z,2026-10-14T21:00Z):
6,402 soccer rows /409 provider event IDs; all carry score, entry price, condition/token/provider-event identity, selected SIDE label, data coverage and volume with semantic. All satisfy observed<=claimed ingestion; 6,111 claim ingestion before scheduled T−90. These claims do not establish historical DB availability.

ZERO rows have both structured market_family and market_type; ZERO have Gamma bid/ask with BBO semantic or decimal odds with semantic. Market type must not be inferred from titles/slugs. The first structural-football input gap is structured market authority; 11 active frozen strategies are registered by active-d1-football-strategies.ts (nine registry strategies, LIVE_B and its causal portfolio), with price/market predicates defined by football-strategy-registry.ts and football-live-safe-rebaseline.ts. No predicate, threshold or strategy is changed, and no retrospective decision is produced.

The historical live-d1-research-corpus.ts reader also selects signal_result and subsequently acquires terminal labels. It is not a settlement-free BLIND reader and is not invoked by this mission. The dedicated source receipt never selects those columns.

## Verification contract

Local embedded PostgreSQL tests cover actual SQL execution, DB clock order, future-claimed-ingest/T90/invalid-date exclusion, snapshot stability after source mutation, no result field, reader/source isolation, raw-view denial, direct-write denial, anonymous RPC denial, append-only audit and repeated horizon capture. No remote writes are allowed until Gate 1 and independent exact-SHA review. Runtime receipts, final verdict, SHA/PR and decision blockers are recorded separately without changing the reviewed migration bytes.

Official security guidance: https://supabase.com/docs/guides/database/functions .
