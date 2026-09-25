# SUMMER_ORIGINAL_BUILD_RECIPE_V1 — FROZEN

Status: FROZEN (diagnosis-only; read-only mission)
Scope: PREMVP only. No Ireland. No new extraction. No economic hypothesis tested.
Purpose: freeze the semantic build recipe of the accepted 22,095-row summer research
universe, and classify SUMMER_DISCOVERY_UNIVERSE_V2 against it.

## 0. Evidence base (repository-internal, verifiable)

| # | Artifact | What it proves |
|---|---|---|
| E1 | `supabase/migrations/20260603_research_signal_snapshots.sql` | GSRS grain, scope, odds corridor, columns, "before product gates", "no resolver columns" |
| E2 | `supabase/migrations/20260603_research_snapshots_features_v1.sql` | GSRS `event_id`, `hours_until_start_num`, `opposing_price_num` |
| E3 | `lib/feed/discoverSportsMarkets.ts` (~L750–880) | exact research intake predicate, event identity, side emission, price field, league/sport derivation |
| E4 | `supabase/migrations/20260730_sports_event_market_inventory.sql` | physical-occurrence identity contract `(provider, provider_event_id, provider_market_id, event_start_iso)` |
| E5 | `supabase/migrations/20260811_generated_signal_pairs_provider_event_context_index.sql` | GSP carries `diagnostics.providerEventContext = {v, provider, eventId, eventStartIso}`; documents 57014 root cause |
| E6 | `modeling/sql_registry/datasets/all_sports_research_candidates_v1.sql` | research layer source = GSRS, grain = snapshot row |
| E7 | `modeling/sql_registry/datasets/all_sports_resolved_candidates_v1.sql` | resolved layer source = GSP, grain = `condition_id::selected_token_id`, settlement col `signal_result` |
| E8 | `modeling/evidence/2026-08-28-.../dataset/dataset_freeze_manifest.json` | prior GSP freeze: `T90Contract = LATEST_SNAPSHOT_AT_OR_BEFORE_EVENT_START_MINUS_90_MINUTES`, `resolvedRules = resolved_at IS NOT NULL`, no dedup before export |
| E9 | `lib/feed/types.ts` L5 | `FORMULA_VERSION = "trusted-initial-formula-v1.1"` is a global product constant, not a research predicate |
| E10 | `lib/executor/buildFireModelCandidates.ts` L1561-1597 | canonical deterministic ordering is **DESC** (`created_at DESC, id DESC`) everywhere |

NOT AVAILABLE (named explicitly): no `C:\tmp` / Windows research workspace is reachable from this
execution environment; no row-level summer export file, no cohort manifest, and no
`5f6491ea…` / `016508af…` payload exists anywhere in the PREMVP tree or git history.
The two historical SHAs are therefore **UNVERIFIABLE — referenced, not reproduced**.
This does not block reconstruction: every semantic below is independently derivable from E1–E10.

## 1. EARLY_BUILD_RECIPE (Jun08–Jul01, reported final 1,788)

- ORIGINAL SOURCE: `public.generated_signal_research_snapshots` (GSRS). GSRS was created
  2026-06-03, i.e. it exists for the whole EARLY window. [E1, E6]
- SOURCE WINDOW: `snapshot_at` is observation time; `game_start_iso` is event time.
  Cohort boundary is on **event start**, not snapshot time. Because GSRS intake enforces a
  24h research horizon (`event_start <= now + 24h`, E3 L281), every event is observed at most
  24h before start — snapshot window ≈ event window, offset ≤ 24h.
- T90 SEMANTICS: `snapshot_at <= game_start_iso - 90 minutes`. Same contract as E8.
- ROW SELECTION: latest eligible observation per identity key, ordered
  `snapshot_at DESC, created_at DESC, id DESC`. [E10 confirms DESC house rule]
- SIDE / MARKET SELECTION: GSRS intake emits **both** sides of every binary market
  (`for sideIndex 0..1`, E3). Side is NOT chosen by price at intake. The odds corridor
  `1.25 ≤ 1/selected_price ≤ 4.00` (≈ price 0.25–0.80) is applied **per side**, so a market
  can contribute 1 or 2 sides. Price therefore *bounds* the universe but does not *select* the side.
- PROVIDER EVENT IDENTITY: Gamma `market.events[0].id` → stored as GSRS `event_id`
  (and mirrored into GSP `diagnostics.providerEventContext.eventId`). [E2, E3 L763, E5]
- PHYSICAL EVENT IDENTITY: `(provider='polymarket', provider_event_id, event_start_iso)`. [E4]
  One physical event → many markets → many condition_ids → up to 2 tokens each.
- SETTLEMENT: GSRS has **no resolver columns** [E1]. EARLY settlement was necessarily an
  external join: `condition_id` → market → `selected_token_id` → terminal token outcome.
- SPORT: league grain — `raw Gamma category`, fallback `leagueFromSlug(event_slug)`;
  `family_source ∈ {gamma.category, slug_inference}`; admission gated by
  `providerSportFamily` + `scoreOwnershipForSportFamily == SUPPORTED_BY_SCORE_MODEL`. [E3]
  This is "Sport Taxonomy V2, provider-backed where available".
- ENTRY PRICE: `selected_price_num` = Gamma `outcomePrices[sideIndex]` **as observed at the
  selected T90 snapshot**. Not a settlement-time or generation-time price.
- LEAD TIME: `game_start_iso − snapshot_at` (materialized as `hours_until_start_num`). [E2]
- FINAL ELIGIBILITY: temporal (T90) selection ran **first**; WIN/LOSS filtering ran **after**.
- FINAL DENOMINATOR: 1,788 reported at "provider-event" grain. Over 24 days ≈ 74/day —
  consistent with one row per provider event. SUPPORTABLE but not byte-reproducible.
- CHRONOLOGICAL ORDER: `game_start_iso ASC`, tiebreak `snapshot_at ASC, id ASC`.

## 2. JULY_BUILD_RECIPE (Jul02–Aug01, reported final 1,602)

Identical to §1 in every semantic. This cohort is the one with an explicit historical
architecture statement, and that statement **matches** the repository evidence exactly:
GSRS source, `snapshot_at <= game_start_iso − 90m`, `snapshot_at DESC, created_at DESC, id DESC`,
settlement via `condition_id → market → selected_token_id → terminal token outcome`,
identity via `condition_id → Gamma events[].id`, event-level row selection before settlement
filtering, Sport Taxonomy V2. Nothing in E1–E10 contradicts it.
Reported SHAs `5f6491ea…` (final) and `016508af…` (exact-T90 source) are UNVERIFIABLE here.

## 3. MAIN_BUILD_RECIPE (Aug05–Aug27, reported 18,705)

RESOLVED: MAIN was **not** GSRS-sourced. MAIN = `public.generated_signal_pairs` (GSP),
matching the registered contract `all_sports_resolved_candidates_v1` [E7] and the prior
GSP byte-freeze [E8].

- ORIGINAL SOURCE: `public.generated_signal_pairs`.
- GRAIN: `condition_id::selected_token_id` — a **side-level** row, explicitly registered [E7].
- SOURCE WINDOW: `created_at` (generation time) bounded the cohort; event time via
  `diagnostics.providerEventContext.eventStartIso`.
- T90: `LATEST_SNAPSHOT_AT_OR_BEFORE_EVENT_START_MINUS_90_MINUTES` [E8] — same rule,
  different carrier (GSP row created_at / provider event start, not GSRS snapshot_at).
- ROW SELECTION: `created_at DESC, id DESC` (latest). [E10]
- SETTLEMENT: native GSP columns — `signal_result ∈ ('won','lost')`, `resolved_at IS NOT NULL`,
  `entry_price_num > 0`. No external token-outcome join needed. [E7, E8]
- ENTRY PRICE: `entry_price_num`.
- SPORT: from GSP diagnostics / structured provider sport with text fallback
  (`deriveSportScopeWithUpstreamPriority`, `lib/executor/buildFireModelCandidates.ts` L950/L2051).
- DENOMINATOR: 18,705 over 23 days ≈ 813/day. **This is not a provider-event count.**

### DECLARED UNIT INCONSISTENCY IN THE HISTORICAL LINEAGE ITSELF
EARLY+JULY (3,390 rows) are provider-event grain; MAIN (18,705) is condition×token grain.
The "22,095 provider-event rows" total is therefore an **arithmetic sum across two different
units**. This is a real defect in the accepted lineage, not a V2 artifact, and any
reconstruction must pick one unit and restate both halves in it.
Historical "cross-input collisions = 0" is consistent with disjoint cohort date windows
(note Jul02–Aug01 vs Aug05–Aug27 leaves **Aug02–Aug04 uncovered** — a real gap, not a rounding).

## 4. ORIGINAL_UNIT

Per-cohort:
- EARLY / JULY: **one row per provider event** (post-T90, post-settlement).
- MAIN: **one row per (condition_id, selected_token_id)**.
Not physical-event; not condition-level; the union is heterogeneous.

## 5. IDENTITY_AUTHORITY

- provider_event_id := Gamma `market.events[0].id`
  (GSRS `event_id` / GSP `diagnostics->providerEventContext->>eventId`). [E2,E3,E5]
- physical_event_id := `polymarket::<provider_event_id>::<event_start_iso>`. [E4]
- market identity := `condition_id`. side identity := `selected_token_id`.
- **`condition_id` is NOT a provider_event_id.** One provider event carries many markets;
  many condition_ids map to one provider event. Using condition_id as the event key
  silently inflates the event count and destroys one-bet-per-event de-duplication.

## 6. TEMPORAL_SELECTION_AUTHORITY

`snapshot_at <= game_start_iso − 90 minutes`, then **latest** eligible observation,
ordered `snapshot_at DESC, created_at DESC, id DESC`. Selection precedes settlement filtering.

## 7. SIDE_SELECTION_AUTHORITY

Both binary sides enter the universe; each side independently passes the European-odds
corridor `[1.25, 4.00]`. Price bounds admission; price does not choose the side.
Any downstream one-row-per-event collapse is a separate, explicit step that must declare
its own tiebreak — it was NOT part of intake.

## 8. SETTLEMENT_AUTHORITY

- EARLY / JULY: `condition_id → market → selected_token_id → terminal token outcome` (external).
- MAIN: `signal_result ∈ ('won','lost') AND resolved_at IS NOT NULL AND entry_price_num > 0`.
These are two different settlement routes and must be labeled per-cohort in any merged corpus.

## 9. SPORT_AUTHORITY

`gamma.category` → else `leagueFromSlug(event_slug)`; admission requires
`providerSportFamily` present AND `scoreOwnershipForSportFamily == SUPPORTED_BY_SCORE_MODEL`.
`family_source` must be carried per row. Keyword-only derivation is NOT the historical taxonomy.

## 10. PRICE_AUTHORITY

- EARLY / JULY: `selected_price_num` at the selected T90 snapshot (with `opposing_price_num`).
- MAIN: `entry_price_num`.
Universe is inherently bounded to ≈ 0.25–0.80 by the odds corridor; a 0.50–0.60 bucket is
fully inside it, so the bucket is not corridor-truncated.

## 11. ORIGINAL_VS_V2_SEMANTIC_DIFF

| Axis | ORIGINAL_SUMMER | SUMMER_DISCOVERY_UNIVERSE_V2 | Class |
|---|---|---|---|
| SOURCE | GSRS (EARLY/JULY) + GSP (MAIN) | GSP only | MATERIAL_POPULATION_CHANGE |
| UNIT | provider event (E/J) / condition×token (MAIN) | condition×token only | MATERIAL_IDENTITY_CHANGE |
| IDENTITY | Gamma `events[0].id` | `provider_event_id = condition_id` | MATERIAL_IDENTITY_CHANGE |
| PHYSICAL EVENT | `provider_event_id + event_start_iso` | `condition_id::selected_token_id` | MATERIAL_IDENTITY_CHANGE |
| TEMPORAL_SELECTION | **latest** (`… DESC, created_at DESC, id DESC`) | **MIN(created_at, id)** = earliest | MATERIAL_LOOKAHEAD_OR_TIMING_CHANGE |
| T90 | `snapshot_at <= start − 90m` enforced | not applied | MATERIAL_LOOKAHEAD_OR_TIMING_CHANGE |
| SIDE_SELECTION | both sides, odds corridor 1.25–4.00 per side | both sides, no corridor | MATERIAL_POPULATION_CHANGE |
| PRICE | T90 snapshot `selected_price_num` / `entry_price_num` | earliest-row price | MATERIAL_LOOKAHEAD_OR_TIMING_CHANGE |
| SPORT | gamma.category → slug, score-ownership gated | keyword-derived PARTIAL | MATERIAL_POPULATION_CHANGE |
| SETTLEMENT | token terminal outcome (E/J) / signal_result (MAIN) | signal_result | NON_MATERIAL_DIFFERENCE for MAIN; MATERIAL for E/J |
| EVENT_DEDUP | provider-event collapse (E/J) | none | MATERIAL_IDENTITY_CHANGE |
| COHORT_BOUNDARY | event-start based, 3 cohorts, Aug02–04 gap | single window, generation-time | MATERIAL_POPULATION_CHANGE |
| FORMULA_FILTER | none (GSRS is "before product gates") | `formula_version = trusted-initial-formula-v1.1` | MATERIAL_POPULATION_CHANGE |
| CHRONOLOGICAL_ORDER | `game_start_iso ASC` | created_at / unstated | MATERIAL_POPULATION_CHANGE |

## 12. ANSWERS TO THE NINE QUESTIONS

1. **Is MIN(created_at,id) semantically wrong?** YES. The original rule is the *latest*
   eligible observation at or before T−90. MIN takes the *first ever* observation — typically
   ~24h before start, at a different price, from a different market state. It is a systematic
   timing change (an early-price bias, not a look-ahead), and it changes the entry price
   of essentially every row.
2. **Is `condition_id` a valid provider_event_id?** NO. Correct route:
   `condition_id → Gamma market → events[0].id`, persisted as GSRS `event_id` /
   GSP `diagnostics->providerEventContext->>eventId`.
3. **Is `condition_id::selected_token_id` a valid physical_event_id?** NO — it is the
   *side* key (registered as such in `all_sports_resolved_candidates_v1`). Physical event
   is `polymarket::<provider_event_id>::<event_start_iso>`.
4. **What unit did 22,095 contain?** Mixed: 3,390 provider-event rows + 18,705
   condition×token rows. Not one unit. Declared defect.
5. **Was `trusted-initial-formula-v1.1` part of the original predicate?** NO for EARLY/JULY —
   GSRS scope is explicitly "before product gates" and `formula_version` is nullable there.
   It is a global serving constant [E9]. Applying it can only shrink the population
   (drops NULL / earlier-version rows) and imports a product-serving gate into a
   research universe. Direction: monotonically smaller, magnitude unquantified without a scan.
6. **MAIN source?** `public.generated_signal_pairs` — resolved-candidate contract
   `all_sports_resolved_candidates_v1`, corroborated by the 2026-07-16 GSP byte-freeze.
7. **Why did historical MAIN return 18,705 while live GSP times out (57014)?** Because the
   historical read used indexed/bounded predicates over a smaller table, while the V2 read
   evaluates an unindexed predicate over the full GSP row count. This exact failure is
   documented three times in this repo (`idx_gsp_pending_resolution` 2026-07-02,
   `idx_gsp_shadow_dedup` 2026-08-05, `idx_gsp_provider_event_context` 2026-08-11 [E5]).
   It is a read-plan defect, not a data-availability defect. Fix is keyset pagination on
   `(created_at DESC, id DESC)` over bounded date slices — the pattern already implemented at
   `lib/executor/buildFireModelCandidates.ts` L1526–1562.
8. **Is price 0.50–<0.60, N=10,452 traceable?** The *recipe* is traceable and re-executable
   (§1/§3 + bucket on the price authority of §10). The *original row file* is absent from
   PREMVP; N=10,452 is therefore reproducible-in-principle, not byte-verifiable today.
9. **Can V2 be transformed into original semantics without re-reading the DB?** NO.
   V2 retained only the earliest row per side, so the T90 observation and its price were
   never materialized. Reconstructing them requires re-reading the source.

## 13. V2_DISPOSITION

**V2_PARTIALLY_REUSABLE.**

Reusable:
- the GSP extraction harness and its pagination/IO scaffolding;
- the cohort date boundaries as a scoping input;
- `condition_id` and `selected_token_id` as *market* and *side* keys (correctly renamed);
- V2 as a coverage/row-count reconnaissance baseline for the MAIN window.

Not reusable (must be discarded):
- every temporal selection and every entry price (MIN semantics, no T90);
- `provider_event_id` and `physical_event_id` columns (wrong identity);
- the keyword sport labels;
- the `formula_version` filter;
- all economic aggregates computed on it.

## 14. NON_COMPARABLE_RESULTS_TO_QUARANTINE

`V2 PRICE 0.50–<0.60 / N=211 / ROI=+46.92% / PnL=+99u`
→ **NON_COMPARABLE_EXPLORATORY_RESULT**. Different population, different unit, different
entry price, different temporal anchor. Must not enter the experiment ledger as evidence for
or against any betting hypothesis, and must never be compared to the historical N=10,452 bucket.

## 15. NEXT_MATERIALIZATION_RECIPE — SUMMER_CANONICAL_SUBSTRATE_MATERIALIZATION_V3

Emit ONE corpus at ONE unit; carry cohort provenance per row.

1. Extract per cohort, bounded by **event start**, in ≤7-day slices, using keyset pagination
   on the source's `(created_at DESC, id DESC)` — never an unindexed JSONB containment
   predicate (57014 avoidance, E5).
   - EARLY Jun08–Jul01 and JULY Jul02–Aug01 → GSRS.
   - MAIN Aug05–Aug27 → GSP. Explicitly decide and record Aug02–Aug04 (gap or extend).
2. Apply T90: keep observations with `snapshot_at <= game_start_iso − 90 minutes`
   (GSP analogue: row timestamp ≤ providerEventContext.eventStartIso − 90m).
3. Select ONE row per `(condition_id, selected_token_id)` by
   `snapshot_at DESC, created_at DESC, id DESC`. **Never MIN.**
4. Attach identity: `provider_event_id` from `event_id` /
   `diagnostics->providerEventContext->>eventId`;
   `physical_event_id = 'polymarket::' || provider_event_id || '::' || event_start_iso`.
   Rows with no resolvable provider event → quarantine bucket, never fuzzy-matched, counted.
5. Attach sport: `gamma.category` → `leagueFromSlug(event_slug)`; carry `family_source`
   and score-ownership class per row. No keyword-only labels.
6. Attach price: `selected_price_num` (GSRS) / `entry_price_num` (GSP) **from the row
   selected in step 3**. Carry `opposing_price_num` and `hours_until_start_num`.
7. Apply NO `formula_version` filter. Carry `formula_version` as a column so its effect
   can be measured later rather than baked in.
8. Settle AFTER steps 2–7: EARLY/JULY via terminal token outcome for `selected_token_id`;
   MAIN via `signal_result IN ('won','lost') AND resolved_at IS NOT NULL AND entry_price_num > 0`.
   Carry `settlement_route` per row.
9. Emit at **side grain** (`condition_id::selected_token_id`) as the canonical substrate, and
   emit a separate deterministic provider-event collapse view with its tiebreak declared
   in the manifest. Publish both denominators. Do not target 22,095.
10. Order chronologically by `game_start_iso ASC, snapshot_at ASC, id ASC` for MaxDD and
    forward 500-event blocks.
11. Freeze with a manifest carrying: per-cohort row counts, source table, SHA256 of the raw
    and compressed export, quarantine counts by reason, and the Aug02–04 decision.

Conservative substitutions where history is unrecoverable, declared not pretended:
- the two historical SHAs cannot be reproduced → V3 mints its own and claims **recipe
  equivalence, not byte equivalence**;
- the EARLY/JULY provider-event collapse tiebreak was never written down → V3 declares
  `highest selected_price_num, then condition_id ASC` and records it in the manifest.
