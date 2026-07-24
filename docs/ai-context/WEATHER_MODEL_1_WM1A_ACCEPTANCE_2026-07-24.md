# WM1-1A Acceptance Record — 2026-07-24

## Decision

- milestone: WM1-1A Contract Foundation
- Founder decision: ACCEPTED
- approved base SHA: `2fff78a1c522f17e48ec770e410a566f515fa74f`
- branch: `codex/weather-model-1-wm1a-contract-foundation`
- accepted HEAD: `5d2d9e761b78cb8952767a3d9008d05503d46ef9`

## Accepted commits

- `5833186` — Weather: add deterministic source and dataset contracts
- `93e4eae` — Weather: add plan-only collector control contracts
- `5d2d9e7` — Docs: enforce PROMPT__PROTOCOL

## Verification retained

Writer verification: Weather tests PASS (7/7); collector-kernel tests PASS (5/5); Weather plan PASS; Liquidity tests PASS (94/94); TypeScript PASS; build PASS; and `git diff --check` PASS.

Independent targeted delta-review: status PASS; station catalog PASS; canonical identity PASS; dataset compatibility PASS; manifest determinism PASS; commit boundaries PASS; WM1-1A gate PASS; blocking findings: none.

The four original findings—station catalog, canonical identity, dataset compatibility, and manifest determinism—are corrected and independently verified PASS. `package-lock.json` is unchanged, Liquidity is untouched, and no push or deploy occurred.

## Boundary

`runtime_proven: NO`. This acceptance covers the contract foundation only. It does not authorize WM1-2 or runtime collection, Gamma/CLOB network calls, Supabase schema or writes, Railway cron, dataset sealing, or modeling/scoring work.

Next milestone: WM1-2 Source Inventory. Separate Founder approval is required before it starts.
