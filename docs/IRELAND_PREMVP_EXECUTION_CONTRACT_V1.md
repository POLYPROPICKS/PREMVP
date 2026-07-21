# IRELAND ⇄ PREMVP Execution Contract v1

Canonical documentation of the **already-implemented** PREMVP executor contract
that the separate Ireland execution kernel consumes. This is documentation of
proven source/test behavior — **not** a runtime exporter and not a new format.

| Fact | Value |
| --- | --- |
| Audited PREMVP source head | `0fcbd0ce47c1269205f618715534bf3ff4619957` |
| Patch applied on top | `Define PREMVP Ireland execution contract` (numeric-amount coercion repair) |
| Schema evidence | `FOUNDER_SCHEMA_ARTIFACT_PROVEN_2026_07_19` — the founder supplied a Supabase snippet CSV export ("Untitled query (70).csv", captured 2026-07-19) covering `event_execution_queue` and `executor_order_events`. This session did not run any live query against production and did not independently re-verify the artifact against the database; the facts below are recorded as **founder-attested**, not as a live audit performed here. |
| Direct tests | 45/45 GREEN (`tests/contur3/executorOrderEvents.callbackContract.test.ts`, `executorQueueMark.callbackContract.test.ts`, `executorCallbackMigration.test.ts`) |
| Connected PREMVP↔Ireland delivery | **NOT TESTED.** Nothing in this document or the underlying tests exercises a real network call to or from Ireland. |

Provenance legend:
- **SOURCE-PROVEN** — asserted by reading the repo source directly.
- **TEST-PROVEN** — asserted by a passing direct automated test in this repo.
- **FOUNDER_SCHEMA_ARTIFACT_PROVEN** — asserted by the founder-supplied CSV
  schema export dated 2026-07-19; not independently queried or re-verified by
  this session against the live database.
- **NOT_YET_CONNECTED_TESTED** — no end-to-end PREMVP↔Ireland call has been
  made or tested; behavior across the real network boundary is unproven.

---

## 1. Endpoints

### `GET /api/executor/queue` — the only executable source for Ireland
Auth: `x-executor-secret`. Returns `event_execution_queue` rows with
`status=READY` and `latest_entry_iso > now`, ordered by `preferred_entry_iso`
asc then `queued_at` asc, capped by `EXECUTOR_QUEUE_MAX_CANDIDATES` (default 15).
It does **not** rank, rebalance, or pull broad candidates. (SOURCE-PROVEN:
`app/api/executor/queue/route.ts`.)

Response envelope: `ok`, `schema="executor-queue-v1"`,
`execution_mode="NIGHT_LIVE_EXECUTION"`, `source="event_execution_queue"`,
`plan_run_id`, `generated_at_iso`, `candidate_count`, `candidates[]`,
`next_due_iso`, `diagnostics`, `ireland_contract`.

Per-candidate contract (`mapQueueRowToIrelandCandidate`, SOURCE-PROVEN
`lib/executor/executorQueueTypes.ts`): `candidate_id`, `order_key`,
`idempotency_key`, `plan_run_id`, `rebalance_run_id`, `reservation_id`,
`match_family_key`, `event_slug`, `event_title`, `sport`, `condition_id`,
`token_id`, `side`, `market_slug`, `stake_usd`, `max_stake_usd`
(= `stake_usd`), `max_entry_price`/`price_cap`, `preferred_entry_iso`,
`latest_entry_iso`, `game_start_iso`, `entry_state`, `selection_rank`,
`is_executable=true`. **Stake/price source of truth is the queue row, never a
constant.**

### `POST /api/executor/order-events` — Ireland reports an order event
Auth: `x-executor-secret`. Delegates to `handleOrderEventSubmission`
(SOURCE-PROVEN `lib/executor/executorCallbackContract.ts`).

- **Required:** `token_id`, `idempotency_key`. Missing → `400`. (TEST-PROVEN 1–2.)
- The `idempotency_key` **must** match an existing `event_execution_queue` row;
  no match → `409 REJECTED_QUEUE_ROW_NOT_FOUND`. (TEST-PROVEN 9.)
- Submission is validated against the queue row (stake/price/identity) before
  insert; violation → `409 REJECTED_QUEUE_POLICY_MISMATCH`. (TEST-PROVEN 8.)
- First delivery → `INSERTED` (`200`, `duplicate:false`). (TEST-PROVEN 4.)
- Exact duplicate (same canonical payload) → `DUPLICATE` (`200`, same row, no
  second insert). (TEST-PROVEN 5, 10.)
- Conflicting duplicate (same `idempotency_key`, different economic payload) →
  `409 IDEMPOTENCY_CONFLICT`. (TEST-PROVEN 6, 11.)
- `clob_order_id` collision under a different key → `409 CLOB_ORDER_ID_CONFLICT`.
  (TEST-PROVEN 7.)
- A concurrent unique-violation race is re-read from the canonical row, never
  trusted from the pre-check alone. (TEST-PROVEN 10–11.)

**Response authority:** the server row `id`/`created_at`/`idempotency_key` are
authoritative; Ireland does not author them.

### `POST /api/executor/queue/mark` — Ireland updates queue state
Auth: `x-executor-secret`. Requires `source="ireland_queue_only"` and a
`status` in the accepted set `{CLAIMED, EXECUTED, SKIPPED, FAILED, EXPIRED}`.
(SOURCE-PROVEN `queue/mark/route.ts`; `QUEUE_MARK_ACCEPTED_STATUSES`.)

- `EXECUTED` is **server-verified**: `live_order_confirmed=true` is treated as an
  Ireland *assertion only* and is never sufficient. The queue row's
  `idempotency_key`/`condition_id`/`token_id`/`side` must match a real stored
  `executor_order_events` row or the mark is rejected
  (`REJECTED_ORDER_EVENT_REQUIRED` / `REJECTED_CONFIRMATION_REQUIRED`).
  (TEST-PROVEN 10–13b.)
- Repeating an already-`EXECUTED` mark is an idempotent no-op — no duplicate
  `mark_history` entry. (TEST-PROVEN 14+15.)
- `EXECUTED` can **never** be regressed to a non-`EXECUTED` status
  (`rejectsExecutedRegression`). (TEST-PROVEN 16.)

---

## 2. Idempotency & cross-endpoint ordering

| Verdict | Result | Basis |
| --- | --- | --- |
| `ORDER_EVENTS_IDEMPOTENCY` | **PROVEN** | TEST-PROVEN 4–7, 10–11 |
| `QUEUE_MARK_IDEMPOTENCY` | **PROVEN** | TEST-PROVEN 14+15 |
| `RESPONSE_AUTHORITY` | **PROVEN** | server-generated ids/statuses; EXECUTED server-verified |
| `CROSS_ENDPOINT_ORDERING` | **SAFE** (retry-independent) | see below |
| `LIVE_SCHEMA_COMPATIBILITY` | **FOUNDER_SCHEMA_ARTIFACT_PROVEN** (compatible against the 2026-07-19 CSV export; not independently re-queried this session) | see §3 |

The two endpoints are independent and retry-safe: `order-events` persists the
economic event keyed by `idempotency_key`; `queue-mark EXECUTED` refuses to
advance until that stored event exists. Therefore:
- order-events succeeds / queue-mark fails → queue-mark is safely retried later;
  the stored event persists and is required for the eventual EXECUTED mark.
- queue-mark attempted first / order-events not yet stored → EXECUTED is
  rejected (`REJECTED_ORDER_EVENT_REQUIRED`), so no premature terminal state.
- duplicate callbacks on either endpoint are harmless no-ops.
Neither endpoint assumes the other committed atomically. (SOURCE/TEST-PROVEN.)

---

## 3. Live-schema facts — `FOUNDER_SCHEMA_ARTIFACT_PROVEN`

Source: founder-supplied Supabase snippet CSV export ("Untitled query (70).csv"),
captured 2026-07-19. This is a **founder-attested artifact**, not a live query
run by this session, and not independently re-verified against production
here. It corroborates the same conclusion previously documented in source
comments (`order-events/route.ts` L188–193, `executorCallbackContract.ts`
L14–20), which trace back to a prior founder-provided 43-column
`information_schema` dump plus a live `42703` error.

#### `event_execution_queue` — queue-side identifiers (FOUNDER_SCHEMA_ARTIFACT_PROVEN)
Queue identifiers live **here**, on the queue row, not on `executor_order_events`:
`id` (uuid, NOT NULL), `reservation_id` (uuid, nullable), `plan_run_id` (text,
NOT NULL), `rebalance_run_id` (text, NOT NULL), `match_family_key` (text, NOT
NULL), `game_start_iso` (timestamptz, NOT NULL), `condition_id`/`token_id`/`side`
(text, NOT NULL), `market_slug` (text, nullable), `tier` (text, NOT NULL),
`stake_usd` (numeric, NOT NULL), `preferred_entry_iso`/`latest_entry_iso`
(timestamptz, NOT NULL), `status` (text, NOT NULL, default `READY`), `order_key`
(text, nullable), `idempotency_key` (text, nullable), `diagnostics` (jsonb, NOT
NULL, default `{}`), `created_at`/`updated_at` (timestamptz, NOT NULL).

#### `executor_order_events` — 43 columns total (FOUNDER_SCHEMA_ARTIFACT_PROVEN)
- `id` uuid NOT NULL default `gen_random_uuid()`; `created_at` timestamptz NOT
  NULL default `now()`.
- `event_type` text NOT NULL default `'order_event'`; `source` text NOT NULL
  default `'ireland_executor'`; `environment` text NOT NULL default
  `'production'`. The route may omit these on submission and let the proven
  live defaults apply, or send explicit values (SOURCE-PROVEN: values are
  passed through `str()` and stripped from the insert payload when
  null/undefined, never forced).
- `idempotency_key`, `clob_order_id`, `market_slug`, `condition_id` — text,
  nullable.
- **`token_id` — text, NOT NULL.** Mandatory at persistence level; the route
  independently rejects a missing `token_id` before any insert is attempted
  (TEST-PROVEN 1).
- `selected_side`, `side`, `order_status` — text, nullable.
- `success`, `dry_run`, `live_confirm` — boolean, nullable.
- `submitted_price`, `submitted_size`, `stake_usd` — numeric, nullable.
- `making_amount`, `taking_amount` — **numeric, nullable.** Must be persisted
  as numeric JSON values, never string-coerced — a plain `str()` coercion
  previously discarded JSON-number values silently. Repaired in this
  checkpoint via `coerceNumericAmount()` (TEST-PROVEN 17–18; SOURCE-PROVEN
  `lib/executor/executorCallbackContract.ts`).
- Observed price/liquidity and fee fields (`observed_best_bid`,
  `observed_best_ask`, `observed_price`, `observed_spread`, `max_entry_price`,
  `fee_usd`, `slippage_usd`, etc.) — numeric where present.
- **Absent from `executor_order_events` — must never be inserted:**
  `queue_id`, `reservation_id`, `match_family_key`. These are queue-side
  identifiers (see the `event_execution_queue` block above) and have no
  corresponding column on `executor_order_events`. The route does not insert
  them (TEST-PROVEN 13–15).

Migration `supabase/migrations/20260719_executor_order_events_schema_and_idempotency.sql`
is **known to diverge** from the live table and must **not** be applied or
treated as source of truth.

### Bounded repair applied in this milestone
`making_amount`/`taking_amount` were coerced to text via `str()`, which silently
dropped JSON-number values Ireland may legitimately send for numeric columns.
Replaced with `coerceNumericAmount()` (accepts a finite number OR a numeric
string; rejects non-numeric to avoid inserting text into a numeric column).
RED → GREEN captured (TEST-PROVEN 17–18).

---

## 4. Field ownership (hard rules)

- `selected_outcome` / `selected_side` — **ALLOWED** as selected-intent identity;
  it is not settlement truth.
- `real_pnl_usd` — **FORBIDDEN from Ireland.** PREMVP computes actual PnL later
  from real fills, fees and market resolution. Ireland must not author it.
- `winning_outcome` — **FORBIDDEN from Ireland.** It is resolution truth, not an
  execution fact.
- `ACCEPTED` is **not** equivalent to `FILLED`. Order acceptance never implies a
  completed fill; fill accounting is downstream PREMVP work.

---

## 5. Not yet connected/tested (Stage B scope)

Schema compatibility is now `FOUNDER_SCHEMA_ARTIFACT_PROVEN` (§3). What remains
unproven is the **connected** behavior — an actual PREMVP↔Ireland call has
never been made or tested from this repository:

- `ORDER_EVENTS_CONTRACT`: end-to-end call from a real Ireland client —
  **NOT_YET_CONNECTED_TESTED**
- `QUEUE_MARK_CONTRACT`: end-to-end call from a real Ireland client —
  **NOT_YET_CONNECTED_TESTED**
- `LIVE_SCHEMA_CONTRACT`: independent live `information_schema` re-query by
  this session (as opposed to the founder-supplied CSV artifact) —
  **NOT_YET_CONNECTED_TESTED**

Do not read this document as evidence that connected PREMVP↔Ireland delivery
has passed. It has not been attempted.

No production reads, writes, migrations, Ireland calls, or CLOB orders occurred
while producing this document. No secrets or raw production rows are included.
