# Polymarket Sport/Market Classification — Field Audit and Join Strategy (Phase 3E.8D)

## 1. Real corpus identity field audit (1,850-row strict-dedup canonical corpus)

Measured directly on the corpus at hash `90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72`:

| Field | Populated | Unique values |
|---|---|---|
| `event_slug` | 100.0% (1,850/1,850) | 1,129 |
| `market_slug` | 100.0% (1,850/1,850) | 586 |
| `event_id` | 0.0% — not a physical column on the export | 0 |
| `market_id` | 0.0% — not a physical column on the export | 0 |
| `condition_id` | 100.0% (1,850/1,850) | 1,646 |
| `question` | 0.0% — not a physical column | — |
| `title` | 0.0% — not a physical column | — |
| `category` | 0.0% — not a physical column | — |
| `subcategory` | 0.0% — not a physical column | — |
| `series` | 0.0% — not a physical column | — |
| `league` | 0.0% — not a physical column | — |
| `sport` | 0.0% — not a physical column | — |
| `diagnostics` | 100.0% (1,850/1,850) | — |

**Important corpus-specific finding:** the top-level `event_slug` field on this corpus is a **human-readable title string** (e.g. `"Valorant: Shopify Rebellion Black vs Azure Dragon Gaming (BO3) - VCL North America: Stage 3 Group St"`, sometimes truncated with `...`), not a URL-style slug. The top-level `market_slug` field is likewise a human question string (e.g. `"Spread: Belgium (-1.5)"`). Neither is guaranteed to be the literal path segment the Gamma API's `/events/slug/{slug}` or `/markets/slug/{slug}` endpoints expect — those endpoints are still the correct official join point per the task's priority order, but exact-match success against these values could not be verified in this session (network blocked; see §3).

A real URL-style slug does exist deeper in the row, at `diagnostics.marketSlug` (e.g. `"val-srb-adg-2026-06-18-game2-round-handicap-srb-4pt5"`), but it is populated on only **26.0%** of rows (481/1,850, 354 unique values) — far too sparse to serve as the primary join key.

## 2. Join strategy selected

Per the task's priority (`event_slug → event_id → market_slug → market_id`), and given `event_id`/`market_id` are entirely absent:

1. **Primary: `event_slug`** (100% populated, 1,129 unique identities) → `GET /events/slug/{slug}`.
2. **Fallback: `market_slug`** (100% populated, 586 unique identities) — used only for rows where `event_slug` is absent → `GET /markets/slug/{slug}`.

This yields a maximum of **1,129 + up to 586 = ≤1,715** unique official-metadata requests for the full 1,850-row corpus (most rows share an `event_slug` with siblings, so the real number of distinct HTTP calls is bounded by unique identity count, not row count — the identity collector in `lib/modeling/polymarketMetadataEnrichment.ts` enforces this: one request per unique identity, never one per raw snapshot).

## 3. Official fetch attempt — network status in this session

All three Gamma API endpoint classes (`/sports`, `/sports/market-types`, `/tags`) were probed directly from this session's sandbox before implementation:

```
curl https://gamma-api.polymarket.com/sports              -> CONNECT tunnel failed, response 403
curl https://gamma-api.polymarket.com/sports/market-types  -> CONNECT tunnel failed, response 403
curl https://gamma-api.polymarket.com/tags                 -> CONNECT tunnel failed, response 403
```

The environment's outbound network proxy (`$HTTPS_PROXY/__agentproxy/status`) reports this as a `connect_rejected` **policy denial** for `gamma-api.polymarket.com:443` — a hard sandbox-level block, not a transient/retryable failure and not an authentication problem. This is consistent across all three probed endpoint classes.

**Consequence:** the real official-metadata fetch could not be executed in this session. The enrichment layer (`lib/modeling/polymarketMetadataEnrichment.ts`) is fully implemented and unit-tested offline against an injected fake fetch (`tests/modeling/polymarketMetadataEnrichment.test.ts`, 25 tests). The real-run script (`scripts/modeling/strategies/fetch-polymarket-metadata-enrichment.ts`) uses the platform's real `fetch` and will succeed once run from an environment with outbound access to `gamma-api.polymarket.com` — but running it here produces a network error, honestly reported by the CLI as a non-zero exit with a secret-free message, not a fabricated success.

## 4. Residual reason codes

`lib/modeling/polymarketMetadataEnrichment.ts` classifies every identity that could not be resolved to official metadata with one of:

`MISSING_EVENT_IDENTITY`, `OFFICIAL_EVENT_NOT_FOUND`, `OFFICIAL_MARKET_NOT_FOUND`, `NO_SPORT_TAG`, `NO_COMPETITION_TAG`, `NO_MARKET_TYPE_FIELD`, `AMBIGUOUS_MULTI_SPORT_TAGS`, `NON_SPORT_EVENT`, `UNSUPPORTED_OFFICIAL_MARKET_TYPE`, `BOUNDED_FALLBACK_ONLY`, `FETCH_ERROR`.

`FETCH_ERROR` is what every identity in this corpus received in this session's real-run attempt, because the fetch never reached the official API at all (network-level rejection before an HTTP response existed).
