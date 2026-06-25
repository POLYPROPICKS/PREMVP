# VERIFICATION_GATES.md — PolyProPicks

## CONTUR3 24H LOG-FIRST GATE (canonical)

Before any Contur3 / night-reservation / event-rebalance / Ireland answer claims
readiness, this gate MUST pass:

1. `reports/contur3/live_funnel_latest.md` exists.
2. It is fresh (≤ 30 minutes old during an active battle window). If stale, run
   `npm run contur3:live-funnel-log`.
3. The answer references: latest log path, `generated_at`, `machine_verdict`,
   `hard_anomaly_count`, next due (Minsk), queue count, Ireland status.
4. `npm run contur3:preflight24h` exits 0 (no P0 anomaly) — or the answer
   explicitly explains every P0 anomaly with its recommended command.

If the log is missing, **creating/fixing the logging layer is P0** and no
readiness claim is permitted until it exists.

## General build/proof gates

- `git status --short` clean of unexpected changes.
- `git diff --check` (no whitespace/conflict markers).
- `npx tsc --noEmit` / `npm run build` PASS for changed code.
- Secret scan of the diff PASSES (no `*_SECRET=`, `*_PRIVATE_KEY=`, service role).

## Single source of truth

Funnel definitions live ONLY in
`scripts/contur3/lib/contur3LiveFunnelMonitor.mjs`. New scripts import from it;
they do not redefine normalization or market classification.
