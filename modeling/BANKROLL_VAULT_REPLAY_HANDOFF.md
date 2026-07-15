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

## TDD map

`tests/modeling/bankrollVaultReplay.test.ts` covers constants; T90-1..3 raw snapshot selection; exact B2A/eSports preservation; strong-key one-per-match and fail-closed cases; key-source accounting; ranking; uniqueness; bankroll limits and vault conservation; invalid settlement fields; theoretical label; determinism. `tests/modeling/historicalFunnelVariants.test.ts` covers C1..C19 classifier behavior, F1..F20 value extraction and fail policies, G21..G28 variants, and H1..H6 independent eSports detection.

The task-provided historical targeted result is **99/99 PASS**. The directly reproducible current core pair (`bankrollVaultReplay` plus `historicalFunnelVariants`) is **74/74 PASS**; no 99-test command was recoverable from source. TypeScript: PASS. Build is `BUILD_ENV_ONLY` only when `SUPABASE_URL` is absent; it is not a source/type failure.
