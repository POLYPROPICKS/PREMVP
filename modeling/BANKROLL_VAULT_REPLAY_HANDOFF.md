# Bankroll/Vault Replay v1.2 — permanent handoff

## Scope and provenance

This handoff preserves the historical, theoretical replay introduced by `30c0299`, corrected by `8b31031`, and finalized by `b0b3eed`. It is not live execution, Ireland work, or a realised-ROI claim.

| Commit | Exact purpose | Files |
|---|---|---|
| `30c0299` | Introduced the pure bankroll/vault historical replay, CLI, and TDD suite. | `lib/modeling/bankrollVaultReplay.ts`, `scripts/modeling/strategies/run-bankroll-vault-replay.ts`, `tests/modeling/bankrollVaultReplay.test.ts` |
| `8b31031` | Corrected replay selection-contract behavior. | Same three files |
| `b0b3eed` | Finalized true T−90 raw-snapshot selection and strong sporting-match replay behavior. | `lib/modeling/bankrollVaultReplay.ts`, `lib/modeling/historicalFunnelVariants.ts`, and their tests |

The immutable corpus snapshot and committed evidence are described in [evidence/2026-07-15-bankroll-vault-v1_2/README.md](evidence/2026-07-15-bankroll-vault-v1_2/README.md).

## Source inventory and contract

`lib/modeling/bankrollVaultReplay.ts` exports the v1.2 identifiers `BANKROLL_VAULT_REPLAY_ENGINE_VERSION`, `MODEL_POLICY_ID`, `SELECTION_OVERLAY_VERSION`, `BANKROLL_POLICY_VERSION`, `REJECTION_REASONS`; types `RejectionReason`, `StrongSportingMatchKeySource`, ledger entries, `DailySummary`, input/result/manifest interfaces; and functions `runBankrollVaultReplay`, `serializeBankrollVaultReplayJson`, `buildBankrollVaultReplayManifest`.

`runBankrollVaultReplay({ rawRows, classifier, insuranceBankroll })` is pure: it strict-deduplicates only for the fixed B2 baseline, chooses each identity's latest raw snapshot at/before `gameStartIso − 90m`, reuses the existing ALT4 plus price/timing predicates, ranks one candidate per strong sporting-match key, and simulates active/vault bankroll constraints. Inputs are not mutated; no fs, env, network, Supabase, forward data, Ireland, fees, slippage, spread, or partial fills are involved.

The strong key is deliberately fail-closed, in priority order: `match_family_key`, `canonical_event_key`, then `parent_event_key`. `event_slug`, `event_title`, `market_slug`, and `condition_id` are never execution grouping fallbacks because they are market-level identities. Ranking is score descending, coverage descending, entry price ascending, created-at descending, observation ID ascending. Invariants include exactly one execution per key, zero duplicate executed keys, max 3% stake, max 80% open exposure, max 30 open positions, max 100 accepted signals/UTC day, vault-only profit sweeps, and active+vault capital conservation.

`scripts/modeling/strategies/run-bankroll-vault-replay.ts` exports `BankrollVaultReplayCliMode`, `BankrollVaultReplayArgs`, `parseBankrollVaultReplayArgs`, and `runBankrollVaultReplayCli`. It is the CLI entrypoint. Default mode is dry-run; `--write-artifacts` atomically emits JSON plus manifest. Supported flags are `--input`, `--classifier`, `--output-root`, `--insurance-bankroll`, `--write-artifacts`, and `--dry-run`; incompatible write/dry-run flags and invalid/missing values fail closed.

`lib/modeling/historicalFunnelVariants.ts` supplies the reused classifier helpers: `isEsports`, `getScoreValue`, `getCoverageValue`, `getSmartMoneyValue`, `getHoursUntilStartValue`, `isAllowedFormulaVersion`, `evaluateHistoricalFunnelVariant`, and `loadExecutableFunnelClassifier` re-export. It owns variant evaluation; replay does not duplicate model predicates.

## Current canonical result and blocker

Against the immutable `b2f5df…1869be45` corpus, the v1.2 replay artifact SHA-256 is `94e1aaf1884f5630f884e23350b3cf8a1262c1583d573fa41093001337cb70c3`; classifier SHA-256 is `ec47640740fbf5a8789ee023fdb41298cde947dcda9e1109af3fc0905305f24f`.

- Base candidate: 549 rows, selection hash `084b2f2d14a3fe62cbfecab88dee1a9979ffd3af10420d253504fe64a8296019`.
- T−90 qualified: 362 rows.
- Strong-key-qualified rows/groups/executions: `0 / 0 / 0`.
- `NO_STRONG_SPORTING_MATCH_KEY`: 362; all three approved strong-key fields have zero coverage.
- Selected rows: 0; post-overlay hash `a03f2ecaaf3502afa004ad6fe5710b79af7a0a41f405c1ec3b844d7f42c39fe2`; theoretical PnL: 0; ROI: `null`.

Ireland remains blocked and is out of scope. The next work is provenance-only: diagnose reusable sporting-match identity candidates without changing bankroll, T−90, ranking, eSports, or base-model behavior.

## Canonical provider match identity preservation

The upstream stable identity is Gamma/Polymarket event payload field `event.id` (`PolymarketRawEvent.id`). `canonicalProviderEventKeyFromEvent()` in `lib/feed/buildLandingCards.ts` accepts only that provider field and fails closed; it never derives identity from `market_slug`, `condition_id`, or team names. `extractCandidateMarkets()` attaches the value to `CandidateMarket.canonicalProviderEventKey`, and `enrichMarket()` writes it as `LandingCardDiagnostics.canonicalEventKey`.

`writeGeneratedSignalPairs()` in `lib/feed/cacheGeneratedSignals.ts` already persists the complete diagnostics object into the existing `generated_signal_pairs.diagnostics` JSON column. No database migration is required. `normalizeGeneratedSignalPairRow()` in `scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts` maps `diagnostics.canonicalEventKey` to exported top-level `canonical_event_key`, while preserving an existing top-level value first and omitting the field when both sources are absent.

Changed files for this contract are `lib/feed/types.ts`, `lib/feed/buildLandingCards.ts`, `scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts`, `tests/modeling/providerMatchIdentityMapping.test.ts`, and `tests/modeling/exportGeneratedSignalPairsFromSupabase.test.ts`. Tests prove shared keys across several markets, separation across provider events, market-slug independence, fail-closed missing IDs, and deterministic preservation of existing export fields.

The complete pre-patch diagnostic is retained outside Git at `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\sporting_match_identity_diagnostic.json`, SHA-256 `d052c48b9bc28b7abb5415f2efa01373d85f6fb102db35f4b98dcbc68998d424`.

## Provider-key v2 export evidence

The first full resolved export after the local source patch is frozen at `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15-provider-key-v2_04819301273a`; input SHA-256 `04819301273ae802736c4146470e20d77002f57d808e61bd470b1ed5ed14c6f1`. It contains 51,157 rows, with 0 `canonical_event_key` values. Replay confirms 370 T−90-qualified rows, 370 `NO_STRONG_SPORTING_MATCH_KEY` rejections, zero selected observations, and zero accepted eSports rows.

Verdict: `HISTORICAL_ROWS_REQUIRE_PROVIDER_KEY_BACKFILL`. The existing historical rows predate persisted `diagnostics.canonicalEventKey`; no automatic backfill was attempted. New rows gain the key only after deployment of `33fb074` and a subsequent generation run. A historical reconstruction requires time-aligned provider payload archives; any Supabase update remains founder-gated.

## Frozen historical-derived replay v1

Commit `dd5215c` adds the isolated, opt-in `HISTORICAL_DERIVED_MATCH_KEY_V1` overlay. It is enabled only by `--match-identity-mode historical-derived-v1`; the default remains `strong-provider-only`. Provider keys retain priority. The historical helper reads only frozen-export fields (`event_slug`, `event_title`, `market_slug`, `diagnostics.marketTitle`, `diagnostics.marketSlug`, and `diagnostics.gameStartIso`), requires a participant pair plus exact start time for high-confidence identity, permits a one-sided row only when it links to exactly one pair at the same start, and otherwise fails closed. It does not alter model, T−90, ranking, bankroll/vault, eSports, provider plumbing, database data, or live execution.

The immutable 49,400-row corpus is `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\generated_signal_pairs_export.json`, SHA-256 `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`. Its full audit is outside Git at `historical-derived-match-v1\historical_match_identity_audit.json`, SHA-256 `94bedae3e573fb6ec3b2b2d2523115bfed63d82dab857c4bdc600f3b88deb239`: 15,988 high-confidence rows, 8,014 uniquely linked rows, 25,398 ambiguous rejected rows, 494 derived groups, and zero collisions.

Replay v1.3 uses simulation `BANKROLL_VAULT_REPLAY_V1_3` and overlay `T90_HISTORICAL_DERIVED_MATCH_V1`. On the same frozen corpus: 362 T−90-qualified rows; 262 high-confidence rows; 47 uniquely linked rows; 53 ambiguous rejected rows; 271 derived/qualified groups; zero collisions; 177 bankroll-accepted executions; 94 wins; 83 losses; gross theoretical PnL 69.46874342; gross theoretical ROI 20.10681091%; ending active/vault balances 84.73437171 each. Replay JSON SHA-256 is `5a0f17ff8db10cfa24fb281bbffdbc26ede45bc0485a1f71a2023c67be10aa67`; manifest file SHA-256 is `6e98ee5344e0df4fc6bfeced0257b07a15785b71d2b8c37f02c5f3a59f42f8c7`.

## Stake/vault optimization v1 — pending founder freeze

The shrinking control `ACTIVE50_VAULT50_STAKE_MAX3_OPEN80_POS30_DAY100_V1` is retained only as comparator. Founder cap is 3% of UTC-cycle reference active equity (free active cash plus unresolved cost basis; vault excluded). `ROBUST_LCB_TIERED_MAX3_V1` uses only outcomes resolved before each decision, Wilson one-sided 90% `qLower`, conservative Kelly, and downward `0/30/50/70/100%` tiers. The selected constrained vault grid row is `A0.75_T1.75_R0.75_S0.25`, selected by the declared 2%-median/p10/p90-drawdown/simplicity objective over 2,000 fixed-seed UTC-day bootstrap samples. Full artifacts remain outside Git under `stake-vault-optimization-v1`; compact evidence is in `modeling/evidence/2026-07-15-stake-vault-optimization-v1`. Final model/selection/risk freeze remains pending founder acceptance.

## TDD map

`tests/modeling/bankrollVaultReplay.test.ts` covers constants; T90-1..3 raw snapshot selection; exact B2A/eSports preservation; strong-key one-per-match and fail-closed cases; key-source accounting; ranking; uniqueness; bankroll limits and vault conservation; invalid settlement fields; theoretical label; determinism. `tests/modeling/historicalFunnelVariants.test.ts` covers C1..C19 classifier behavior, F1..F20 value extraction and fail policies, G21..G28 variants, and H1..H6 independent eSports detection.

The task-provided historical targeted result is **99/99 PASS**. The directly reproducible current core pair (`bankrollVaultReplay` plus `historicalFunnelVariants`) is **74/74 PASS**; no 99-test command was recoverable from source. TypeScript: PASS. Build is `BUILD_ENV_ONLY` only when `SUPABASE_URL` is absent; it is not a source/type failure.

## Final PnL freeze candidate

The exact-rescue v2 audit recovered 0 of the 53 T-90 ambiguous rows and retained all 53 fail-closed with `NO_UNIQUE_EXACT_SLUG_START_LINK`; collision count is zero and 271 defensible matches remain. The fixed-cycle capacity audit reconciles 212 executions (210 full, one 70%, one 50%) plus exactly 59 terminal rejects: 51 `POSITION_LIMIT` and 8 `OPEN_EXPOSURE_LIMIT`; none could execute even at 30% in the historical state.

Four stake policies were compared under the founder 3% cycle-active cap. `FIXED_CYCLE_MAX3_V1` won the declared rule with bootstrap median ending capital 246.07063993, canonical PnL 146.45102873, and maximum total-capital drawdown 29.21517498. The empirical-Bayes PnL-first candidate completed with 212 executions, PnL 47.75692048 and drawdown 9.31996822, but did not win. Vault was recalculated on the winner; `A0.9_T1.25_R0.75_S0.5` was selected (terminal active 112.44376081, vault 134.00726792, total 246.45102873; bootstrap median 249.61382984, p10 195.13869775, p90 drawdown 27.00454481).

This is a candidate only. Founder must accept one model/stake/vault combination before an atomic freeze commit and any Ireland inspect-only review.

## Night/price/capacity/vault final optimization candidate

The final comparator uses `Europe/Minsk` 18:00 reference boundaries. The live-eligible reference winner is `MINSK_NIGHT_FIXED_MAX3_V1`; its maximum remains 3% of realized Active equity captured at the boundary. Enforcing the 18:00–09:00 decision window separately costs 11 executions and 36.78650541 PnL units, so the all-decision scenario remains the candidate pending founder acceptance of that operational trade-off.

The 1,024-map nonzero price-band search did not beat all-100 on the untouched test; all five bands therefore remain 100%. Capacity `36 / 100%` executes 231 of 271 matches with PnL 167.37306991 and drawdown 33.96564534; 39 rows are `POSITION_LIMIT` and one is `EXPOSURE_LIMIT`. `A1_T2_R0.25_S0` is the named MAX_PNL Vault recommendation. The candidate remains non-final until one founder decision.

## Statistical reference oracle

The multiple-testing blocker is isolated in `modeling/evidence/2026-07-16-statistical-reference-oracle`. `arch==8.0.0` under Python 3.12.10 defines deterministic fixtures for corrected stationary-bootstrap block length and Hansen SPA. Approved convention: explicit stationary block size, 20,000 replications, seed `20260716`, `studentize=true`, `nested=false`; `consistent` is the decision p-value, `upper` is conservative White-style corroboration from the same engine, and `lower` is report-only. This validates procedure outputs only, not profitability, and does not resume or alter capital-policy modeling.

## Final scientific historical architecture freeze

The bounded package is `modeling/evidence/2026-07-16-final-scientific-architecture-freeze`. Development/confirmation separation, oracle-backed policy comparison, fixed-vs-dynamic sizing, 24×7/night-only scenarios, capacity locking, and deterministic freeze hashes are complete. Both Phase A sequences retain `NO_VAULT_FIXED100`; SPA consistent values are `0.5864` and `0.3873`, so no protected policy qualifies to replace control.

The historical winner is `B2_TIMING_WITHIN_120M + NO_VAULT_FIXED100 + FIXED_100 + NIGHT_ONLY + positions36/exposure80%/accepted100`. Confirmation: 45 executions, PnL $1,364.53467215, ROI 30.32299271%, ending Total $11,364.53467215, minimum Total $9,800, maximum fall $321.52765544, CVaR95 maximum fall $609.29271625, probability below initial `0.09745`. Status is historical-only: Ireland parity and forward validation remain pending; it is not live approval.

## Final Vault frontier on locked original PRIMARY

The bounded package `modeling/evidence/2026-07-16-final-vault-on-locked-primary` uses only the locked original PRIMARY `B2_PRICE_FLOOR_030_TIMING_WITHIN_120M` sequence: exactly 231 sorted IDs, SHA-256 `99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca`. It evaluates 25 existing Vault-policy grid entries with a 50u initial total bank, 0u Vault, a fixed 1u stake ($100), and no model reselection or dynamic sizing.

The deterministic balanced candidate is `CPPI_0.4_0.5`: 198 executions, 33 Vault risk-budget skips, PnL 51.89997402u, ending Active 61.13998441u, Vault 40.75998961u, Total 101.89997402u, maximum fall 6.43150453u, and bootstrap CVaR95 maximum fall 10.15154317u. The no-Vault fixed-1u control is 231 executions and 52.68123377u PnL with CVaR95 maximum fall 10.44355089u. This is historical pseudo-out-of-sample evidence only and awaits founder acceptance; Ireland remains blocked.
