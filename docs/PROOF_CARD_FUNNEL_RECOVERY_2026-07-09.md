# Proof Card Funnel Recovery — 2026-07-09

## Accepted decision

Canonical proof-card source is `/api/signals/resolved?mode=latest&days=14&limit=7`.

`app/reconstruction/page.tsx` fetches this once, applies `applyClientFilter`, builds the promotional `WeekResultsCard` with `buildCanonicalProofCard`, and passes the same selected proof rows/card to:

- top proof card
- `PassOfferModal`
- `ResolvedSignalsCarousel`

## Why

The previous `days=7&limit=7` path caused slow `legacySevenDayProof` timeouts and could show broad or mismatched proof such as `26/49` or `5/7` with non-matching chips.

## Acceptance

Founder Gate 2 accepted localhost behavior:

- top proof card shows `5/7 WON`, `Last 14 days`, positive return, 5 green chips and 2 red chips
- paywall proof shows the same proof card
- modal does not fetch `/api/signals/resolved`
- negative/mismatched proof is rejected
- WhyTrust remains untouched

## Guardrails

Do not restore independent resolved fetches inside `PassOfferModal`.
Do not use broad aggregate cards as promotional proof.
Do not change WhyTrust for this proof-card path.
