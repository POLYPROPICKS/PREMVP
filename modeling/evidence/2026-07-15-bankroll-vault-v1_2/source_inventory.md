# Source inventory

At `b0b3eed`, replay code is `lib/modeling/bankrollVaultReplay.ts`; CLI is `scripts/modeling/strategies/run-bankroll-vault-replay.ts`; core test suite is `tests/modeling/bankrollVaultReplay.test.ts`; reused variant evaluator is `lib/modeling/historicalFunnelVariants.ts`; and its tests are `tests/modeling/historicalFunnelVariants.test.ts`.

The three commit provenance trail is `30c0299` (introduce), `8b31031` (selection contract correction), and `b0b3eed` (T−90/strong sporting-match finalization). Exact exports, responsibilities, CLI flags, invariants, and test groups are preserved in `../../BANKROLL_VAULT_REPLAY_HANDOFF.md`.

Canonical provider identity path: Gamma/Polymarket `event.id` → `PolymarketRawEvent.id` → `canonicalProviderEventKeyFromEvent()` / `extractCandidateMarkets()` → `CandidateMarket.canonicalProviderEventKey` → `enrichMarket()` → `LandingCardDiagnostics.canonicalEventKey` → unchanged `writeGeneratedSignalPairs()` persistence in `generated_signal_pairs.diagnostics` → `normalizeGeneratedSignalPairRow()` → exported `canonical_event_key`.

Implementation files: `lib/feed/types.ts`, `lib/feed/buildLandingCards.ts`, and `scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts`. Coverage: `tests/modeling/providerMatchIdentityMapping.test.ts` and `tests/modeling/exportGeneratedSignalPairsFromSupabase.test.ts`. No migration is required because the existing physical `diagnostics` JSON field carries the value. Missing `event.id` remains missing; no slug, condition, or team-name fallback is used.

Complete diagnostic snapshot: `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\sporting_match_identity_diagnostic.json`; SHA-256 `d052c48b9bc28b7abb5415f2efa01373d85f6fb102db35f4b98dcbc68998d424`.
