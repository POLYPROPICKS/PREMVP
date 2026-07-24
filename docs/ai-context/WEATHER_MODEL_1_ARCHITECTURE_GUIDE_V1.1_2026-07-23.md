# PolyProPicks / PREMVP
# WEATHER MODEL 1
## Architecture Guide v1.1
### Атрибуция рынка, сбор данных, минимальный DB-контур, immutable datasets и roadmap реализации

**Дата:** 2026-07-23
**Версия:** 1.1 — исправлено по независимому архитектурному review
**Статус:** APPROVED ARCHITECTURE CANDIDATE; runtime ещё не доказан
**Проект:** PolyProPicks / PREMVP
**Repo:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`
**Production:** `https://polypropicks.com`
**Stack:** Next.js / React / TypeScript / Supabase / Railway
**Первый venue:** Polymarket
**Первый universe:** US Daily Maximum Temperature, 5–10 целевых событий/станций
**Терминал:** Windows CMD
**Отдельный рабочий контекст:** рекомендован отдельный Weather project/chat, чтобы не смешивать Weather, Contur3 recovery и Liquidity runtime memory

---

# 0. Engineering header

```text
TASK CLASSIFICATION:
architecture-review / data-platform / docs-context / weather-model-1

EXECUTION MODE:
Claude Chat architecture
→ bounded Codex/Claude Code implementation
→ Luna evidence collection
→ Founder gates

COMMIT: NO — для этого документа
PUSH: NO
DEPLOY: NO
PR: NO
```

## ALLOWED FILES

На текущем шаге:

```text
Этот Markdown.
Read-only project instruction files.
Read-only Git/source inspection в W0.
```

## FORBIDDEN FILES / ДЕЙСТВИЯ

```text
Не менять production source.
Не менять Supabase.
Не менять Railway.
Не менять LIQUIDITY_MODEL.
Не трогать Contur3/Ireland/live execution.
Не трогать UI/payment/auth.
Не создавать Weather model до Dataset V1.
Не отправлять orders.
```

## STOP CONDITIONS

```text
1. Git base 5805a3f vs 4c5bdc5 не reconciled → W1 не начинать.
2. Existing helper reuse не inspected → новый collector-kernel не писать.
3. Реализация требует изменения lib/liquidity/** → STOP.
4. Source/identity/dataset contracts не заморожены → ingestion не начинать.
5. Migration меняет существующие таблицы → STOP.
6. Raw object lineage отсутствует → normalized rows не принимать.
7. Dataset export неполный → DQA/modeling блокируются.
8. Dataset ID/hash/schema не совпадают → FAIL CLOSED.
9. Full-path test начинается после source boundary → тест недостаточен.
10. Runtime/proving-run evidence отсутствует → не заявлять production readiness.
```

---

# 1. Executive verdict

## 1.1. Принятое направление

Weather Model 1 строится:

```text
SAME PREMVP REPO
+
SEPARATE FEATURE BRANCH
+
SAME SUPABASE PROJECT FOR SHORT MVP
+
SEPARATE weather_* TABLES
+
SEPARATE scripts/weather/**
+
SEPARATE tests/weather/**
+
SEPARATE FUTURE RAILWAY CRON
+
POLYMARKET FIRST
+
NO CHANGES TO LIQUIDITY
```

## 1.2. Главный принцип

Weather Model 1 — не «weather predictor» и не новая торговая стратегия на первом этапе.

Первая цель:

> Получить чистый, атрибутированный, point-in-time воспроизводимый corpus, где каждая market/contract/snapshot строка имеет source lineage, canonical identity, временную семантику, raw evidence и принадлежность к immutable dataset version.

Правильная цепочка:

```text
Git/base freeze
→ reuse inspection
→ collector + contract foundation
→ minimal DB contour
→ Gamma inventory
→ CLOB snapshots
→ station/settlement attribution
→ Dataset V1 sealing
→ baseline evaluation
→ forecast/model research
→ forward shadow
```

## 1.3. Runtime confidence

```text
ARCHITECTURE CONFIDENCE: MEDIUM-HIGH
SOURCE REUSE CONFIDENCE: PARTIAL until W0 inspect
DATABASE CONFIDENCE: MEDIUM
RUNTIME CONFIDENCE: NOT PROVEN
MODEL EDGE: NOT TESTED
```

Ни один LLM-review не заменяет proving runs.

---

# 2. Review corrections: объективное решение

Ниже — не автоматическое согласие с reviewer, а окончательное решение tech lead.

| Recommendation | Decision | Final treatment |
|---|---|---|
| Storage → DB atomicity contract | **ACCEPT** | Raw page сохраняется первым; DB evidence ссылается на Storage; orphan Storage допустим и reconciled; orphan DB без raw запрещён |
| Snapshot key без payload hash | **ACCEPT WITH GUARD** | Unique slot = source contract + token + planned capture bucket; payload hash отдельно; конфликт с другим payload → DQA collision, не второй snapshot |
| Source contracts in Git, not authored in DB | **ACCEPT** | Source contracts — immutable TypeScript/JSON declarations; run ledger хранит ID/hash/Git SHA |
| Mandatory Git reconciliation | **ACCEPT** | W0 — первый обязательный milestone |
| W2A only two tables | **ACCEPT** | Runs + cohorts; dataset versions переносится в Dataset phase |
| Partial unique index instead of advisory lock | **MODIFY** | Advisory lock rejected; partial unique index alone insufficient; use DB-backed lease claim through one atomic Postgres RPC + unique active lock key |
| Membership = snapshots only in V1 | **ACCEPT** | Typed membership deferred |
| Replace depth columns with JSON | **ACCEPT WITH MODIFICATION** | Capture stores versioned `depth_metrics_json`; Dataset V1 materializes numeric depth features; no unversioned JSON semantics |
| Add attribution gate in W3 | **ACCEPT AND STRENGTHEN** | 100% target cohort exact; all other discovered candidates classified, never force fuzzy attribution |
| Remove dataset aliases | **ACCEPT** | Explicit dataset ID only until first evaluator exists |
| Station catalog as static repo JSON | **ACCEPT FOR PILOT** | Versioned and hashed repo catalog for 5–10 stations; DB table deferred to global/Kalshi expansion |
| Reduce external review prompt | **DONE** | Review completed; no second 50-question review needed |
| Extract-to-neutral instead of rewrite | **ACCEPT, SUBJECT TO INSPECT** | W0 proves exact reusable functions before any move |
| Merge W1A + W1B | **ACCEPT** | One feature branch/PR, two atomic commits and two internal gates |
| Merge W2A + W2B | **PARTIAL** | One DB+inventory milestone allowed, but migration and collector remain separate commits/gates |
| One report as acceptance surface | **ACCEPT** | `reports/weather/weather_latest.md` + JSON/machine summary; raw DB/log evidence remains source truth |
| Autopilot commit | **CONDITIONAL** | Allowed only when executor prompt says `COMMIT: YES`, Gate 1 passes, allowed files exact; push/deploy remain founder-controlled |
| Batch inserts and bounded roundtrips | **ACCEPT** | W4 has measurable DB-roundtrip gate |
| One raw object per API response page | **ACCEPT** | Not one object per market |

---

# 3. Scope isolation

## 3.1. Separate context, same repo

Weather should run in a dedicated Weather project/chat.

Reason:

- Contur3 recovery has unrelated execution/recovery constraints.
- Liquidity has its own production metrics and defects.
- Mixing memory previously caused incorrect runtime reconstruction.
- Dedicated context reduces false reuse and stale assumptions.

This does **not** require a separate Git repository for the short MVP.

## 3.2. Domain boundaries

```text
WEATHER DATA CONTOUR
- source collection
- raw evidence
- attribution
- normalization
- datasets

WEATHER MODELING
- forecasts
- calibration
- probabilities
- selection

DISPLAY
- UI/read models

LIVE EXECUTION
- orders/fills
```

Current approved scope ends at Dataset V1 plus baseline data sufficiency.

---

# 4. What is reused from LIQUIDITY_MODEL

## 4.1. Reuse candidates

Must be verified in W0:

```text
lib/liquidity/captureSchedule.ts
lib/liquidity/captureSuppression.ts
lib/liquidity/failureBuckets.ts
lib/liquidity/orderbookMath.ts
tests/liquidity/**
machine-readable summary pattern
npm script / cron runner pattern
```

## 4.2. Reuse method

Not:

```text
copy file
rename Liquidity → Weather
```

Correct:

```text
inspect pure behavior
→ add regression characterization tests if missing
→ extract only domain-neutral logic
→ update Liquidity imports without behavior change
→ run full test:liquidity
→ add Weather tests
```

## 4.3. Forbidden reuse

```text
sports event-start cadence
sports phase buckets
sports watchlist
market-family gates
deferred volume semantics
post-game lifecycle
entry/exit pairing
sports identity
```

## 4.4. Reuse gate

W0 report must classify every candidate:

```text
REUSE_UNCHANGED
EXTRACT_WITH_REGRESSION
WEATHER_NEW
REJECT_REUSE
UNKNOWN
```

No new collector-kernel file may duplicate existing behavior without this classification.

---

# 5. Source contracts

## 5.1. Source of truth

Source contracts live in Git/code, not as DB-authored records.

Proposed location:

```text
lib/weather/source-contracts/
  polymarketGammaWeather.v1.ts
  polymarketClobTopBook.v1.ts
```

Each exports:

```text
id
venue
apiFamily
adapterVersion
schemaVersion
timestampSemantics
paginationContract
retryContract
activeClosedContract
normalizationBoundary
canonical serialization
contractHash
```

## 5.2. Evidence persisted per run

`weather_collector_runs` stores:

```text
source_contract_id
source_contract_hash
source_contract_git_sha
collector_version
schema_version
```

Thus old runs remain interpretable even after code changes.

## 5.3. Contract change rule

Any semantic change creates a new ID:

```text
POLYMARKET_GAMMA_WEATHER_V1
→ POLYMARKET_GAMMA_WEATHER_V2
```

Never mutate V1 behavior under the same ID.

---

# 6. Polymarket identity contract

## 6.1. Identity spaces

```text
canonical_weather_event_id
venue_event_id
condition_id
token_id
snapshot_id
resolution_id
dataset_version_id
```

They are never interchangeable.

## 6.2. Authority order

```text
condition_id = venue market authority
token_id = venue contract/outcome authority
venue_event_id = event grouping metadata
slug/title = non-authoritative metadata
```

Slug or title may create:

```text
UNATTRIBUTED_CANDIDATE
```

but never `ATTRIBUTED_EXACT` without exact mapping.

## 6.3. Canonical event serialization

Pilot V1:

```text
country_code
| station_authority
| station_id
| measurement_type
| local_measurement_date
| measurement_window_start_local
| measurement_window_end_local
| canonical_unit
| settlement_semantics_version
```

Example:

```text
US|NWS|KNYC|DAILY_MAX_TEMP|2026-08-01|00:00:00|23:59:59|F|V1
```

Then:

```text
canonical_weather_event_id = SHA-256(canonical string)
```

All component fields are retained, not only hash.

## 6.4. Pilot station catalog

For 5–10 stations, use versioned repo JSON:

```text
config/weather/us-daily-max-stations.v1.json
```

Contains:

```text
stationAuthority
stationId
city
state
timezone
coordinates
venue aliases
settlement source hints
catalogVersion
```

Artifact hash is stored in run/dataset manifests.

DB station catalog is deferred until:

- global cities;
- multiple authorities;
- station changes over time;
- Kalshi expansion;
- manual curation workflow.

## 6.5. Attribution statuses

```text
ATTRIBUTED_EXACT
UNATTRIBUTED
AMBIGUOUS
REJECTED
```

Manual review status is deferred until an actual workflow exists.

Target pilot cohort:

```text
100% ATTRIBUTED_EXACT
```

If any target event is not exact, it is excluded and W3 gate fails for that target.

---

# 7. Minimal code architecture

Paths are PROPOSED until W0 proves existing structure.

```text
lib/
  collector-kernel/
    cadence.ts
    failureBuckets.ts
    suppression.ts
    safeLog.ts
    idempotency.ts
    payloadHash.ts
    runLedger.ts
    leaseLock.ts
    trace.ts

  weather/
    types.ts
    canonicalIdentity.ts
    attribution.ts
    datasetContract.ts
    datasetManifest.ts
    source-contracts/
      polymarketGammaWeather.v1.ts
      polymarketClobTopBook.v1.ts
    polymarket/
      gammaAdapter.ts
      clobTopBookAdapter.ts

scripts/
  weather/
    run-weather-auto-capture.mjs
    capture-weather-inventory.mjs
    capture-weather-snapshots.mjs
    audit-weather-data.mjs
    seal-weather-dataset.mjs

tests/
  collector-kernel/
  weather/
  fixtures/weather/

config/
  weather/
    us-daily-max-stations.v1.json

reports/
  weather/
    weather_latest.md
    weather_latest.json
```

## Dependency direction

```text
collector-kernel
↑
weather contracts/domain
↑
Polymarket adapters
↑
repositories/scripts
```

`collector-kernel` cannot import Weather or Liquidity.

---

# 8. Raw evidence and atomicity

## 8.1. Invariant

```text
No normalized DB row without raw evidence reference.
```

## 8.2. Write order

For each API response page:

```text
1. Fetch response.
2. Validate transport/body envelope enough to hash.
3. Store one immutable raw object in Supabase Storage.
4. Compute/store payload hash and storage path.
5. Persist raw-object metadata and normalized rows in DB transaction/batch.
6. Mark run result.
```

## 8.3. Failure modes

### Storage succeeds, DB fails

Allowed temporary state:

```text
ORPHAN_STORAGE_OBJECT
```

Recovery:

- retry DB using same payload hash/storage path;
- scheduled reconciler lists recent Storage objects not referenced in DB;
- never delete automatically during pilot.

### DB succeeds, Storage fails

Forbidden.

Repository must not commit normalized evidence unless raw object exists.

### Same page fetched twice

Raw dedup uses:

```text
source_contract_id
+ endpoint/page identity
+ payload_hash
```

Identical raw bytes may reference one storage object, while run-to-object linkage records each receipt/run.

This avoids duplicating large objects while preserving receipt history.

## 8.4. Object granularity

```text
one raw object per API response page
```

Not per market and not one giant run file.

---

# 9. Run ledger and locking

## 9.1. Why advisory locks are rejected

Supabase/PostgREST/connection pooling can break assumptions of session-scoped `pg_advisory_lock`.

Therefore Weather V1 uses a DB-backed lease claim.

## 9.2. Lock contract

One atomic Postgres RPC/function:

```text
claim_weather_run(
  lock_key,
  run_key,
  run_kind,
  lease_seconds,
  source_contract_id,
  source_contract_hash,
  source_contract_git_sha
)
```

Transaction behavior:

```text
1. Find active RUNNING row for lock_key.
2. If lease not expired → return SKIPPED_LOCKED.
3. If expired → mark old run STALE.
4. Insert new RUNNING row.
5. Return new run id and lease expiry.
```

Unique protection:

```text
partial unique index on lock_key where status = 'RUNNING'
```

The index is a guard; the RPC is the crash-recovery/atomic claim mechanism.

## 9.3. Heartbeat

For short runs, heartbeat is optional.

Add heartbeat only if measured run duration approaches lease.

Pilot rule:

```text
lease >= 3 × P95 run duration
```

## 9.4. Statuses

```text
RUNNING
SUCCEEDED
PARTIAL
FAILED
SUPPRESSED
SKIPPED_LOCKED
STALE
```

`PLANNED` is not persisted as a run row in V1; plan-only output is a report.

---

# 10. Snapshot idempotency

## 10.1. Planned capture slot

```text
capture_bucket = floor(scheduled_at_utc / cadence)
```

The scheduler provides the planned slot.

## 10.2. Unique key

```text
SHA-256(
  source_contract_id
  + token_id
  + capture_bucket_start_utc
)
```

Payload hash is not part of the unique key.

## 10.3. Duplicate behavior

Same key, same payload:

```text
DUPLICATE_BUCKET_RETRY
→ do nothing
→ record counter
```

Same key, different payload:

```text
DUPLICATE_BUCKET_COLLISION
→ keep first accepted snapshot immutable
→ save new raw page evidence
→ create blocking/diagnostic DQA issue
→ do not create second canonical snapshot
```

This proves schedule semantics rather than silently multiplying rows.

## 10.4. Late run

A late run still writes into its planned capture bucket, not current wall-clock bucket.

If lateness exceeds policy:

```text
SNAPSHOT_TOO_LATE
```

The raw response may be retained but model-ready membership excludes it unless policy says otherwise.

---

# 11. Minimal database contour

The schema is intentionally reduced.

## 11.1. Migration 1 — control plane

### `public.weather_collector_runs`

```text
id uuid primary key
contour text not null default 'weather'
run_kind text not null
run_key text not null
capture_cohort_id uuid null
source_contract_id text not null
source_contract_hash text not null
source_contract_git_sha text not null
started_at timestamptz not null
lease_expires_at timestamptz not null
finished_at timestamptz null
status text not null
lock_key text not null
collector_version text not null
schema_version text not null
summary_json jsonb not null default '{}'
error_bucket text null
error_message_safe text null
created_at timestamptz not null default now()
```

Constraints:

```text
status in (
RUNNING, SUCCEEDED, PARTIAL, FAILED,
SUPPRESSED, SKIPPED_LOCKED, STALE
)
```

Indexes:

```text
partial unique(lock_key) where status = 'RUNNING'
(run_kind, started_at desc)
(status, started_at desc)
(capture_cohort_id, started_at desc)
```

### `public.weather_capture_cohorts`

```text
id uuid primary key
name text not null unique
universe_contract_id text not null
universe_hash text not null
universe_json jsonb not null
cadence_policy_json jsonb not null
starts_at timestamptz not null
ends_at timestamptz null
status text not null
created_at timestamptz not null default now()
sealed_at timestamptz null
```

Status:

```text
PLANNED, CAPTURING, SEALED, ABORTED
```

`universe_json` is an execution record; authoritative universe declaration remains in Git/config and is hash-linked.

## 11.2. Migration 2 — raw inventory and identities

### `public.weather_raw_objects`

```text
id uuid primary key
collector_run_id uuid not null references weather_collector_runs(id)
source_contract_id text not null
endpoint_key text not null
page_key text null
source_observed_at timestamptz null
received_at timestamptz not null
payload_hash text not null
storage_path text not null
content_type text not null
byte_size bigint not null
created_at timestamptz not null default now()
```

Recommended uniqueness:

```text
(source_contract_id, endpoint_key, coalesce(page_key,''), payload_hash)
```

Run receipt linkage must not be lost when raw bytes deduplicate. If one physical object is referenced by many runs, introduce a small receipt join only when actual duplicate frequency justifies it. Do not prebuild it.

### `public.weather_venue_markets`

This combines Gamma event and market metadata for the narrow Polymarket pilot.

```text
id uuid primary key
venue text not null
venue_event_id text not null
condition_id text not null
canonical_weather_event_id text null
station_id text null
measurement_type text null
local_measurement_date date null
timezone text null
canonical_unit text null
attribution_status text not null
attribution_reason text null
event_slug_raw text null
event_title_raw text null
market_slug_raw text null
market_title_raw text null
active boolean null
closed boolean null
open_time timestamptz null
close_time timestamptz null
resolution_source_raw text null
raw_object_id uuid not null references weather_raw_objects(id)
first_seen_at timestamptz not null
last_seen_at timestamptz not null
metadata_hash text not null
created_at timestamptz not null default now()
```

Unique:

```text
(venue, condition_id)
```

Metadata changes do not rewrite raw evidence. Current normalized metadata may update only if `metadata_hash` changes; source history remains reconstructable through raw objects and future optional history table.

### `public.weather_contracts`

```text
id uuid primary key
weather_venue_market_id uuid not null references weather_venue_markets(id)
venue text not null
token_id text not null
outcome_name_raw text not null
outcome_side text null
lower_bound numeric null
upper_bound numeric null
lower_inclusive boolean null
upper_inclusive boolean null
canonical_unit text null
contract_semantics_version text not null
first_seen_at timestamptz not null
last_seen_at timestamptz not null
metadata_hash text not null
created_at timestamptz not null default now()
```

Unique:

```text
(venue, token_id)
```

## 11.3. Migration 3 — snapshots

### `public.weather_market_snapshots`

```text
id uuid primary key
collector_run_id uuid not null references weather_collector_runs(id)
capture_cohort_id uuid not null references weather_capture_cohorts(id)
weather_contract_id uuid not null references weather_contracts(id)
raw_object_id uuid not null references weather_raw_objects(id)
source_contract_id text not null
capture_bucket_start timestamptz not null
scheduled_at timestamptz not null
source_observed_at timestamptz null
received_at timestamptz not null
captured_at timestamptz not null
best_bid numeric null
best_ask numeric null
midpoint numeric null
last_trade numeric null
spread numeric null
reported_volume numeric null
reported_liquidity numeric null
depth_metrics_json jsonb null
depth_schema_version text null
snapshot_status text not null
payload_hash text not null
idempotency_key text not null unique
created_at timestamptz not null default now()
```

Indexes:

```text
(weather_contract_id, captured_at desc)
(capture_cohort_id, capture_bucket_start)
(snapshot_status, captured_at)
```

No fixed `depth_1c/2c/5c` columns in capture V1.

## 11.4. Deferred to settlement phase

```text
weather_observations
weather_resolutions
weather_data_quality_issues
```

Station catalog remains Git JSON in pilot.

## 11.5. Deferred to Dataset V1 phase

```text
weather_dataset_versions
weather_dataset_membership
```

---

# 12. Dataset V1 contract

## 12.1. Membership

V1 membership contains **only snapshot rows**.

```text
dataset_version_id
snapshot_id
canonical_weather_event_id
condition_id
token_id
ordinal
```

No typed members.

## 12.2. Dataset table

### `weather_dataset_versions`

Created in Dataset phase:

```text
id text primary key
capture_cohort_id uuid not null
dataset_schema_version text not null
identity_contract_version text not null
normalization_version text not null
dedup_policy text not null
lower_bound timestamptz not null
upper_bound timestamptz not null
row_count bigint not null
canonical_event_count bigint not null
condition_count bigint not null
token_count bigint not null
content_hash text not null
manifest_hash text not null unique
dqa_status text not null
lifecycle_status text not null
manifest_json jsonb not null
created_at timestamptz not null default now()
approved_at timestamptz null
approved_by text null
```

### `weather_dataset_membership`

```text
dataset_version_id text not null
snapshot_id uuid not null
canonical_weather_event_id text not null
condition_id text not null
token_id text not null
ordinal bigint not null
created_at timestamptz not null default now()

primary key(dataset_version_id, snapshot_id)
unique(dataset_version_id, ordinal)
```

## 12.3. Lifecycle

```text
SEALED
→ DQA_PASSED
→ APPROVED_FOR_RESEARCH
```

or:

```text
SEALED → REJECTED
```

No aliases in V1.

## 12.4. Explicit selection

Every evaluator requires:

```text
--dataset-version WEATHER_PM_US_DAILY_MAX_V1_...
```

Missing, unknown or incompatible ID blocks execution.

## 12.5. Hash canonicalization

Canonical content record:

```text
ordinal
snapshot_id
canonical_weather_event_id
condition_id
token_id
capture_bucket_start
normalized feature values
source_contract_id
payload_hash
```

Rules:

- UTF-8;
- fixed field order;
- fixed numeric formatting;
- null represented consistently;
- sorted by deterministic ordinal;
- newline-delimited canonical JSON;
- SHA-256.

Manifest hash includes:

```text
dataset ID
bounds
schema versions
identity version
normalization version
dedup policy
counts
content hash
station catalog hash
source contract hashes
code Git SHA
```

Repeated sealing against the same frozen boundary must produce identical bytes/hashes.

---

# 13. Depth semantics

## 13.1. Capture

Capture stores:

```text
best bid/ask/spread
versioned depth_metrics_json
raw page lineage
```

Example:

```json
{
  "within_1c": 1200.0,
  "within_2c": 2100.0,
  "within_5c": 5200.0
}
```

This JSON is invalid without:

```text
depth_schema_version
```

## 13.2. Dataset materialization

Dataset V1 materializes numeric features:

```text
depth_1c
depth_2c
depth_5c
```

using a pinned calculation version.

Thus capture storage remains flexible, while model-ready data is typed and reproducible.

## 13.3. Reuse condition

Existing Liquidity orderbook math can be extracted only if W0 proves:

- same CLOB level semantics;
- same side/price interpretation;
- same depth units;
- tests cover Weather-shaped fixture.

---

# 14. Collector flow

```text
cron/runner
→ plan capture bucket
→ atomic lease claim
→ create RUNNING row
→ fetch API page(s)
→ store one raw object per page
→ validate source envelope
→ parse events/markets/contracts
→ exact attribution
→ batched DB transaction/upsert
→ produce structured trace
→ finish run
→ write latest report
```

## 14.1. Batched DB operations

For snapshot run:

```text
one batched insert/upsert for raw metadata per page set
one batched snapshot insert for all due contracts
one terminal run update
```

Target:

```text
≤5 DB roundtrips per run
excluding Storage upload and venue HTTP requests
```

No per-token REST insert loop.

## 14.2. Planning estimate

Illustrative only:

```text
10 events
× 20 binary markets
× 2 outcome tokens
× 144 ten-minute slots/day
≈ 57,600 token snapshots/day
```

Actual event/bin/token counts must be measured in W3.

Supabase viability must be based on measured rows/day and bytes/day, not this estimate.

---

# 15. Data quality gates

## 15.1. W3 inventory

Target cohort:

```text
100% target events ATTRIBUTED_EXACT
100% target conditions persisted
100% target token IDs persisted
100% persisted rows have raw lineage
0 silent duplicates
```

All other discovered candidates:

```text
100% classified:
ATTRIBUTED_EXACT / UNATTRIBUTED / AMBIGUOUS / REJECTED
```

No minimum exact rate is imposed on non-target candidates because that would incentivize unsafe fuzzy matching.

## 15.2. W4 snapshots

```text
>=98% scheduled runs terminally completed
no unexplained gap >2 cadence intervals
0 canonical duplicate snapshot slots
all collisions reported
bid <= ask where both exist
prices in valid range
non-negative depth
100% snapshot raw lineage
measured DB roundtrips <= gate
measured storage/DB growth reported
```

## 15.3. Settlement

Before model eligibility:

```text
exact station
exact timezone
exact local measurement day
exact measurement window
exact unit
exact bin semantics
exact resolution source
final/corrected status
```

## 15.4. Dataset

```text
availableRows == fetchedRows
missingRows = 0
exportCompleteness = COMPLETE
fixed upper bound
deterministic keyset export
deterministic normalization
deterministic dedup
all members exact-attributed
identical rerun hash
```

---

# 16. Testing standard

## 16.1. TDD

Every parser, transformation, repository helper and dataset function:

```text
RED
→ minimal implementation
→ GREEN
→ regression
```

No fake TDD if no test target exists.

## 16.2. Required fixtures

- active Gamma event;
- closed Gamma event;
- display title inside slug;
- absent slug;
- duplicate titles;
- same title, different condition IDs;
- multiple tokens;
- token order change;
- malformed outcomes;
- missing condition;
- missing token;
- non-array body;
- page boundary;
- retryable error;
- terminal error;
- CLOB 404;
- same bucket same payload;
- same bucket different payload;
- late capture;
- DST/local date boundary.

## 16.3. DEV RULE 2 full path

Required regression:

```text
raw Gamma page
→ real adapter
→ real validator
→ real identity extraction
→ real attribution
→ real repository transaction
→ inventory query
→ dataset manifest builder
```

Structured trace:

```text
stage
inputCount
outputCount
targetEventPresent
targetConditionPresent
targetTokenPresent
rejectedTargets
firstRejectionReason
sanitizedRelevantValues
```

Unit tests starting at `NormalizedWeatherMarket` cannot certify source-boundary correctness.

## 16.4. Atomicity tests

```text
Storage success / DB failure
retry with same raw object
DB transaction rollback
no DB evidence without Storage
orphan Storage reconciler detection
same raw bytes in two runs
```

## 16.5. Lease tests

```text
first claim succeeds
second concurrent claim locked
expired lease marks previous STALE
new claim succeeds atomically
terminal run releases active uniqueness
crash recovery
```

## 16.6. Dataset switch tests

- dataset ID mandatory;
- unknown ID blocked;
- hash mismatch blocked;
- schema mismatch blocked;
- identity mismatch blocked;
- Dataset A unchanged after B;
- repeated sealing identical;
- intentionally capped export blocked;
- display slice blocked.

---

# 17. Operator acceptance surface

Each phase produces:

```text
reports/weather/weather_latest.md
reports/weather/weather_latest.json
```

The Markdown is founder-readable.

The JSON/machine line is parser-readable.

Required top block:

```text
WEATHER_PHASE_VERDICT:
phase:
git_sha:
source_contract:
cohort:
runs_expected:
runs_completed:
raw_objects:
markets:
contracts:
snapshots:
exact_attribution:
duplicates:
collisions:
gaps:
dqa:
gate:
next_action:
```

The report is the acceptance surface, but not a replacement for source DB/log evidence.

---

# 18. Security and operations

- Weather venue access is read-only.
- No order endpoints.
- Service-role only in server/Railway environment.
- No secrets in logs/reports/raw objects.
- Auth headers never persisted.
- Env names use `WEATHER_` prefix.
- Weather cron separate from Liquidity.
- Weather disable switch required before cron deployment.
- No `railway up`.
- Push to approved main triggers Railway only after explicit deploy gate.
- Production DB migration apply is separate from migration code commit.

---

# 19. Supabase and ClickHouse

## 19.1. Supabase approved for short MVP

Conditions:

- narrow Polymarket universe;
- Gamma inventory;
- REST top-of-book;
- no full L2 WebSocket;
- raw page objects in Storage;
- batched inserts.

## 19.2. Measured migration triggers

Reassess at any:

```text
>3–5M snapshots/month
regular diagnostic query >10–20 seconds
Weather and Liquidity DB contention
connection-pool pressure
retention cost becomes material
WebSocket/L2 approved
60–90-day corpus degrades operations
```

ClickHouse is not a W1–W6 dependency.

---

# 20. Weather Model 1 — upper-level roadmap

The roadmap is one program with two contours.

```text
CONTOUR A — DATA FOUNDATION
WM1-0 through WM1-6

CONTOUR B — MODEL RESEARCH
WM1-7 through WM1-10
```

Only Contour A is approved for implementation now.

---

## WM1-0 — Base Reconciliation + Reuse Inventory

**Task class:** inspect-only
**Model:** Sol
**Environment:** local PREMVP repo, Windows CMD/Codex
**Value:** prevents duplicate code and wrong-base development
**Commit/PUSH/Deploy:** NO/NO/NO

Scope:

```text
git reconciliation:
5805a3f vs 4c5bdc5

narrow source inspection:
Liquidity cadence/failure/suppression/orderbook/tests
existing dataset manifest/hash/export helpers
current Supabase migration conventions
```

Evidence:

```text
AHEAD / BEHIND / DIVERGED
exact approved base candidate
reuse matrix
exact source paths
no edits
```

Stop:

```text
dirty unexpected
instruction file missing
base cannot be reconciled
reuse requires Liquidity behavior change
```

Next:

```text
1. Founder chooses base SHA.
2. Create Weather feature branch and execute WM1-1.
```

---

## WM1-1 — Collector + Identity + Dataset Contract Foundation

**Task class:** TDD implementation
**Model:** Terra
**Branch:** approved Weather feature branch
**Value:** creates neutral infrastructure and future-safe dataset contracts
**Commit:** YES, two atomic commits after internal gates
**Push:** feature branch only if explicitly approved
**Deploy:** NO

Commit A:

```text
extract neutral collector helpers
run ledger/lease interfaces
raw/DB atomicity helpers
trace
plan-only runner
```

Commit B:

```text
source contract declarations
canonical identity
station config V1
dataset manifest/compatibility
explicit dataset selection contract
```

No DB. No venue API.

Verification:

```text
test:liquidity
test:collector-kernel
test:weather
npx tsc --noEmit
npm run build
git diff --check
```

---

## WM1-2 — Minimal DB + Gamma Inventory

**Task class:** backend-API / data ingestion
**Model:** Terra, with Sol pre-review of migration contract
**Value:** first durable market identity graph
**Commit:** YES, migration and collector as separate commits
**Push:** feature branch only
**Deploy:** NO until local/migration gates

Migration tables:

```text
weather_collector_runs
weather_capture_cohorts
weather_raw_objects
weather_venue_markets
weather_contracts
```

Collector:

```text
Gamma active + closed discovery
one raw object per response page
condition/token authority
exact target attribution
batched writes
latest report
```

Next:

```text
1. Apply approved migration.
2. Run WM1-3 proving capture.
```

---

## WM1-3 — Three-Day Inventory Proving Run

**Task class:** CMD/cron verification
**Model:** Luna
**Value:** proves reliability and attribution before high-volume snapshots
**Commit:** NO unless report tooling fix required
**Deploy:** separate Weather runner only after founder approval

Universe:

```text
5–10 US daily max targets
inventory cadence 10–15 min
```

Gate:

```text
100% target exact attribution
100% target conditions/tokens persisted
100% raw lineage
0 silent duplicates
all errors bucketed
run ledger/lease proven
```

If fail:

```text
inspect first failing stage
minimal patch
restart proving window
```

---

## WM1-4 — CLOB Top-of-Book Capture + Seven-Day Proving Run

**Task class:** backend-API / TDD
**Model:** Terra
**Value:** creates executable-price history
**Commit:** YES
**Deploy:** separate cron after gates

Adds:

```text
weather_market_snapshots
POLYMARKET_CLOB_TOPBOOK_V1
capture slots
idempotency collisions
versioned depth metrics
batched inserts
```

Proving run:

```text
7 days
5–10 min cadence
```

Gate:

```text
>=98% runs complete
no unexplained >2-slot gaps
0 canonical slot duplicates
all collisions visible
DB roundtrip gate
growth report
```

---

## WM1-5 — Settlement Attribution + Observation Truth

**Task class:** architecture + backend
**Model:** Sol design, Terra implementation
**Value:** connects market contracts to physical truth
**Commit:** YES
**Deploy:** read-only collectors only

Adds when justified:

```text
weather_observations
weather_resolutions
weather_data_quality_issues
```

Station catalog remains repo JSON unless evidence requires DB history.

Gate:

```text
every eligible target:
station
timezone
local day
measurement window
unit
bin semantics
resolution source
final result
```

---

## WM1-6 — Dataset V1 Seal

**Task class:** dataset engineering / TDD
**Model:** Sol review + Terra implementation + Luna evidence
**Value:** creates first reproducible research corpus
**Commit:** YES
**Deploy:** NO model execution

Adds:

```text
weather_dataset_versions
weather_dataset_membership
seal/audit scripts
```

Artifact:

```text
WEATHER_PM_US_DAILY_MAX_DATASET_V1
```

Gate:

```text
COMPLETE export
fixed bounds
deterministic membership
identical rerun hashes
DQA_PASSED
founder approval
```

---

## WM1-7 — Market Calibration Baseline

**Status:** future, blocked by WM1-6
**Model:** Sol/Terra
**Value:** measures whether market probabilities are already efficient

No external forecast API yet.

Compare:

```text
market probability
realized frequency
calibration by price band
bin coherence
time-to-resolution
liquidity/spread
```

No public alpha claim.

---

## WM1-8 — Forecast Vintage Data Contour

**Status:** future
**Value:** adds point-in-time weather information

Sources selected only after benchmark design.

Requires:

```text
forecast run time
valid time
received time
provider/model version
raw vintage evidence
```

No historical actuals masquerading as forecast vintages.

---

## WM1-9 — Weather Model Class 1

**Status:** future
**Value:** station-calibrated bin probabilities

TDD/frozen research:

```text
market baseline
raw weather baseline
station calibration
intraday observations
paid provider incremental value
```

Fixed-$100 replay only after model selector frozen.

---

## WM1-10 — Forward Shadow

**Status:** future
**Value:** proves real-time behavior without orders

Requires:

```text
explicit Dataset/Model version
live recommendations
executable ask
spread/slippage
no retrospective entry
no parameter mutation
```

Live execution remains separate founder decision.

---

# 21. Prompt routing protocol

Before every executor prompt, state:

```text
Exact environment/server
Exact repo/path
Value of this step
Current Weather Model 1 phase
Next two steps
Chosen model and why
```

Model rules:

```text
Luna:
git/status/test runs/evidence/proving reports

Terra:
bounded implementation with frozen contracts/files/tests

Sol:
source uncertainty, cross-layer design, migrations,
identity/dataset safety, independent review
```

---

# 22. Founder decisions now frozen

Recommended final decisions:

```text
1. Weather work moves to dedicated Weather project/chat.
2. Same PREMVP repo, isolated feature branch.
3. Same Supabase project for short MVP only.
4. No changes to Liquidity.
5. Polymarket first; Kalshi after Dataset V1.
6. Source contracts live in Git.
7. Lock uses atomic DB lease claim + unique RUNNING lock key.
8. Dataset membership V1 contains snapshots only.
9. Explicit dataset IDs; no aliases.
10. Station catalog is versioned repo JSON for pilot.
11. WM1-1 is one PR with two atomic commits.
12. No Weather model before WM1-6.
```

---

# 23. W0 inspect-only executor prompt

Use only after this architecture is accepted.

Before prompt:

```text
SERVER/ENVIRONMENT:
Local Windows repo only. No Railway/Supabase writes.

REPO:
C:\WORK\KalshiProPulse\sipropicks-premvp1-1

VALUE:
Reconcile the correct base and prove exact reusable source before Weather implementation.

CURRENT PHASE:
Weather Model 1 / WM1-0

NEXT TWO STEPS:
1. Founder selects base SHA.
2. WM1-1 Collector + Contract Foundation.

MODEL:
Sol — source uncertainty, Git divergence and cross-layer reuse safety.
```

_______ НАЧАЛО КОМАНДЫ ДЛЯ CODEX _______

TASK CLASSIFICATION: inspect-only / docs-context / source-reuse
EXECUTION MODE: Codex
MODEL: Sol

COMMIT: NO
PUSH: NO
DEPLOY: NO
PR: NO

REPO:
C:\WORK\KalshiProPulse\sipropicks-premvp1-1

READ FIRST:
- CLAUDE.md
- AGENTS.md
- AUTOMATION_MODE_HANDOFF.md
- OPERATOR_ACCEPTANCE_CHECKLIST.md
- VERIFICATION_GATES.md
- WINDSURF_WORKFLOW_RULES.md
- TASK_ROUTING_MATRIX.md
- CLAUDE_CODE_EXECUTION_PROTOCOL.md
- README.md if setup is unclear

If a required file is missing: STOP and report.

GOAL:
Without editing, reconcile local 5805a3f against origin/main 4c5bdc5 and inspect only the exact existing helpers relevant to Weather Model 1 reuse.

PRECHECK:
- cd /d C:\WORK\KalshiProPulse\sipropicks-premvp1-1
- git branch --show-current
- git status --short
- git rev-parse HEAD
- git rev-parse origin/main
- git log --oneline --decorate -12

GIT RECONCILIATION:
Run read-only evidence sufficient to classify:
- local HEAD vs origin/main = AHEAD / BEHIND / DIVERGED / EQUAL
- commits only in 4c5bdc5..5805a3f
- commits only in 5805a3f..4c5bdc5
- exact changed file stats for unique commits
Do not checkout, reset, fetch, merge, rebase, commit or push.

ALLOWED FILES TO INSPECT:
- package.json
- lib/liquidity/captureSchedule.ts
- lib/liquidity/captureSuppression.ts
- lib/liquidity/failureBuckets.ts
- lib/liquidity/orderbookMath.ts
- scripts/liquidity/run-liquidity-auto-capture.mjs
- tests/liquidity/**
- current dataset/hash/manifest/export helpers found through exact references
- current Supabase migration conventions
- relevant instruction files listed above

FORBIDDEN:
- No broad repo audit
- No edits
- No generated files
- No build/dev server
- No API/curl
- No Supabase/Railway
- No secrets
- No Contur3/Ireland/live execution inspection beyond Git file stats
- No implementation recommendation that changes Liquidity behavior

QUESTIONS:
1. What exact base relationship exists?
2. Which SHA is the safest candidate base, without choosing for founder?
3. Which Liquidity helpers are pure and reusable unchanged?
4. Which require extraction with Liquidity regression tests?
5. Which are sports/CLOB-specific and must not be reused?
6. Does a neutral collector kernel already exist?
7. Do dataset manifest/hash/completeness helpers already exist?
8. What exact test commands cover the reusable behavior?
9. What exact files would WM1-1 need to touch?
10. Would any safe extraction require behavior changes in Liquidity? If yes, STOP.

REQUIRED OUTPUT:
1. PRECHECK
2. GIT BASE VERDICT
3. UNIQUE COMMIT EVIDENCE
4. FILES INSPECTED
5. REUSE MATRIX:
   - REUSE_UNCHANGED
   - EXTRACT_WITH_REGRESSION
   - WEATHER_NEW
   - REJECT_REUSE
   - UNKNOWN
6. EXISTING DATASET/EXPORT HELPERS
7. EXACT WM1-1 ALLOWED FILE CANDIDATES
8. TEST COMMANDS
9. RISKS
10. STOP CONDITIONS
11. FOUNDER DECISION:
    exact base choices, no recommendation disguised as fact

NO FILES EDITED.
NO COMMIT.
NO PUSH.
NO DEPLOY.

_______ КОНЕЦ КОМАНДЫ ДЛЯ CODEX _______

---

# 24. Final verdict

```text
WEATHER_MODEL_1_ARCHITECTURE:
version: 1.1
review: ACCEPTED WITH CORRECTIONS
same_repo: YES
dedicated_context: YES
same_supabase_short_mvp: YES
polymarket_first: YES
liquidity_modified: NO
source_contracts: GIT
lock: ATOMIC_DB_LEASE
snapshot_idempotency: CONTRACT+TOKEN+BUCKET
raw_atomicity: STORAGE_FIRST
dataset_membership_v1: SNAPSHOTS_ONLY
dataset_aliases: NO
runtime_proven: NO
safe_next_step: WM1-0 INSPECT-ONLY
modeling_allowed: ONLY AFTER WM1-6
```
