# BLIND_RESEARCH_DATA_CONTRACT_V1

Normative record of the Founder-approved research data architecture. It fixes decisions; it does **not** claim a runtime
PASS, does not replace `docs/ai-context/control-plane/CURRENT_STATE.yaml` (the only operational-state artifact), and
does not change any model formula, version, threshold or sample.

Key words MUST / MUST NOT / MAY are used in the RFC 2119 sense. Scope: Research DBClone `nppznoujvnyjargjkmnv` only.
Production (`nbnldzfsxffztsfrrxqy`) is never a target of anything in this contract.

## 1. Founder decisions (normative)

| # | Decision |
|---|---|
| D1 | There is exactly **one** Research DBClone. No new database is created for research, scoring or archive. |
| D2 | **Observations and outcomes are physically separate and separate by privilege.** A model-facing identity can reach observations only; it has no route, direct or indirect, to outcomes. |
| D3 | Prematch, T20 and in-play models use the **existing raw archive** (`reservation_market_observations`, `research_precontract_t20_observations`, `research_inplay_core_path_observations`). The history MUST NOT be copied wholesale into a second observation store. |
| D4 | Full event time series are retained: BUY/SELL prices, order book to the depth actually captured, VWAP, fees, match clock and features. Nothing is thinned to make a view convenient. |
| D5 | August–September and October originals MUST NOT be deleted. A historical field that was never captured MUST NOT be reconstructed by inference; it is reported as missing. |
| D6 | A new **market-scoped Box B** stores independent outcomes, for every market, regardless of whether any model chose to bet it. (Not created by this release; see section 6.) |
| D7 | The existing Ledger records the decision and a **database-owned first-persistence time**. Historical Replay is never promoted to Forward BET. |
| D8 | A model reads only **allow-listed as-of observations**: no WIN/LOSS, no future ticks, no label hidden in JSON, no `service_role`. |
| D9 | A frozen **deterministic selector** chooses bets; **approved, versioned SQL** computes results. An LLM takes no part in runtime selection, settlement or ROI computation. |
| D10 | **Reference ROI, executable quoted-scenario ROI and real-fill Net PnL are three different metrics** and MUST be labelled and never merged. |
| D11 | Data is replenished **automatically every day**: source-sync completeness, catch-up of missed days, outcome freshness, and a prohibition on publishing a stale scoreboard as current. |
| D12 | The Clone is the **long-term archive**. Any Production purge requires proof that the data is preserved in the Clone first. |
| D13 | All five SAFE models, the three in-play controls, Alpha 1/2 and the legacy models later run under **this one access policy and independent evaluation**. |
| D14 | Independent evaluation requires, besides blind data access, a **strategy version frozen before the verification sample** exists. |

Historical August–September evidence stays separate from real October prospective tests.

## 2. Verified defect that motivates the release

`research_model_ready_rows` holds ~120k rows carrying `settlement_label` and label-bearing JSON (`frozenLabel`,
`labelAsOf`), and the research conveyor connects with `SUPABASE_CLONE_SERVICE_ROLE_KEY`. `service_role` bypasses RLS, so
database-level blindness of any research selector was unproven (and false by construction). Removing labels from the
historical archive is **not** the fix (D5); making them unreachable for the model identity is.

## 3. Mechanism (DBClone migration `20261012160000_blind_model_input_authority.sql`)

* **Roles** (all `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, no password, no
  membership): `blind_model_reader` (the only model-facing identity), `blind_horizon_writer` (privileged orchestrator that
  sets the as-of horizon), and two reserved **empty** boundaries, `research_ledger_writer` and
  `research_settlement_authority`, for the later privileged Ledger writer and independent settlement (the migration
  asserts they hold nothing). Granting `LOGIN` and a credential is a separate, founder-held deployment stage; this
  migration contains no secret.
* **Projections** (schema `blind_obs`, versioned `_v1`): `prematch_observations_v1`, `t20_observations_v1`,
  `inplay_observations_v1`. Each is an explicit column allow-list (no `*`, no JSON column, no reservation/capture lineage
  ids, no live-policy output, no strategy-decision table) over the **existing** raw table, joined to the one-row
  `blind_obs.model_horizon`. Prematch/T20 additionally require `observed_at < event_start_iso`.
* **View semantics, validated on a real PostgreSQL 16 engine and designed for 17**:
  * The views are **definer** views (no `security_invoker`). `security_invoker = true` would require the reader to hold
    `SELECT` on the base tables, which is exactly what must not exist; a view-only reader cannot work with it.
  * `security_barrier = true` is mandatory: without it a reader-supplied leaky predicate is evaluated on raw rows *before*
    the as-of filter and discloses future rows. The test suite contains a no-barrier control view and shows the leak
    there and not on the real views.
  * Definer views read the raw tables with the executing owner's rights; the migration therefore also asserts that the
    owner can read them (including the RLS owner-bypass rule) so the views cannot silently become empty.
* **As-of horizon** (`blind_obs.model_horizon`, single row): readable and writable by neither the reader nor the API
  roles; written only by `blind_horizon_writer`. No row means **no visible observation** (fail closed). The horizon is
  run-scoped: one horizon per decision cut, set by the orchestrator, never by the model.
* **Fail-closed assertion inside the migration** (PostgreSQL's own effective-privilege functions, so `PUBLIC` grants,
  inherited membership and column ACLs are all counted): the four roles hold no relation, sequence, `SECURITY DEFINER`
  function, schema-`CREATE` or database-`CREATE` privilege beyond the stated allow-list; are members of no other role;
  `blind_obs` contains exactly the horizon table and the three views; the views have no JSON or outcome-shaped columns;
  `PUBLIC`, `anon`, `authenticated` and `service_role` hold nothing in `blind_obs`. Any violation aborts the whole
  transaction, roles included.
* **Release route**: a separate exact-reviewed adapter mode (`--clone-blind-input`) with a pinned SQL hash and project
  ref. It is **not** a general SQL executor, does not extend the generic `clone-schema` allow-list (which cannot create
  roles, views or ACLs), and does not touch the hash-pinned `clone-shadow` mode. Dry-run (rolled back) is mandatory
  before apply; apply also requires the catalog read-back (`readBlindInputCatalog`) to equal the expected counts.

## 4. What is proven, and what is not

| Claim | Status |
|---|---|
| SQL, hash pin, project-ref/production rejection, allow-listed statement shapes, dry-run does not apply | Proven by `tests/control-plane/premvpCloneBlindInputMigration.test.mjs` |
| View/ACL semantics, denial of outcome tables / mixed joins / JSON / DDL / `SET ROLE service_role`, as-of horizon, leaky-predicate control, selector determinism under changed outcomes, raw rows byte-identical | Proven on a scratch PostgreSQL 16 by `tests/control-plane/blindInputPostgresSemantics.test.mjs` (opt-in via `BLIND_INPUT_PG_HOST`) |
| The same on **DBClone itself** (real roles, real grants, real data volume, real owner of the raw tables) | **RUNTIME_UNVERIFIED** until the reviewed apply stage and the login probes of the next mission |
| A frozen production selector executed with the restricted credential and no `service_role` in its process | **RUNTIME_UNVERIFIED** (next mission) |

Known first-apply risk: if DBClone already has `PUBLIC`-executable `SECURITY DEFINER` functions, `PUBLIC` table grants,
or `PUBLIC` `CREATE` on a schema, the migration **aborts by design** and names the object. That is a finding to remediate
under its own review, not a reason to weaken the assertion.

## 5. Known limits (stated, not hidden)

1. The as-of clock is `observed_at`. Availability time (when the Clone received a late sync) is not modelled; T20 has no
   `created_at`.
2. The horizon is a single row, so concurrent runs with different decision cuts must be serialised or run per decision.
3. The reader can still see catalog metadata (table names, `pg_class.reltuples` row-count estimates). Counts are not
   outcomes.
4. In-play rows legitimately contain the score and live status **at or before** the horizon; the final tick is
   unreachable only because the horizon excludes it.
5. Statement-level role defaults (`default_transaction_read_only`, `statement_timeout`, `search_path`) are conveniences the
   session can override; the boundary is privileges, which the tests exercise in read-write transactions.

## 6. Not in this release (next stages, in order)

1. Reviewed apply of exactly this SQL to DBClone through `--clone-blind-input`, then real login-probe negative tests with
   the restricted credential (credential deployed by the founder-held channel, never by `service_role`).
2. Execute one frozen selector against `blind_obs` with no `service_role` in its process environment.
3. Market-scoped independent Box B and the fixed SQL scorer; append-only archive/parity; randomised stratified audit.
4. Daily replenishment and freshness gates (D11) and Production-purge proof (D12).

Reference `PR #526` is untouched by this work.
