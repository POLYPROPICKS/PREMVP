# PRIMARY_SCORER_STARVATION_AUDIT_V1

Generated from a fresh discovery snapshot at 2026-09-20T07:46:34.104Z.

## CURRENT ORDER

Canonical physical events (keyed): **850**. Candidate identities: **7937**. Unkeyed candidates: **0** (0%).

| attempts | unique events | coverage % | missing-family attempts | cfb attempts |
|---:|---:|---:|---:|---:|
| 100 | 2 | 0.24% | 100 | 0 |
| 250 | 3 | 0.35% | 250 | 0 |
| 500 | 6 | 0.71% | 500 | 0 |
| 608 | 7 | 0.82% | 608 | 0 |
| 1000 | 16 | 1.88% | 942 | 0 |

## EVENT-FAIR COUNTERFACTUAL

Diagnostic-only, in-memory round-robin over the SAME candidate population — never wired into production.

| attempts | unique events | coverage % | additional vs current | coverage multiplier |
|---:|---:|---:|---:|---:|
| 100 | 100 | 11.76% | +98 | 50x |
| 250 | 250 | 29.41% | +247 | 83.333x |
| 500 | 500 | 58.82% | +494 | 83.333x |
| 608 | 608 | 71.53% | +601 | 86.857x |
| 1000 | 850 | 100% | +834 | 53.125x |

At prefix 608: current=7 unique events vs event-fair=608 (gain +601, 86.857x).

## SPORT/FANOUT CONCENTRATION

Identities-per-event: min=1 median=2 p90=23 p99=75 max=95 mean=9.34.

Top fanout events (up to 20):

| physical_event_key | sportFamily | sportCode | identities | share % |
|---|---|---|---:|---:|
| polymarket:nfl-cin-hou-2026-09-20:2026-09-20 | MISSING | nfl | 95 | 1.197% |
| polymarket:nfl-min-chi-2026-09-20:2026-09-20 | MISSING | nfl | 93 | 1.172% |
| polymarket:nfl-jax-den-2026-09-20:2026-09-20 | MISSING | nfl | 91 | 1.147% |
| polymarket:nfl-no-bal-2026-09-20:2026-09-20 | MISSING | nfl | 89 | 1.121% |
| polymarket:nfl-mia-sf-2026-09-20:2026-09-20 | MISSING | nfl | 89 | 1.121% |
| polymarket:nfl-cle-tb-2026-09-20:2026-09-20 | MISSING | nfl | 87 | 1.096% |
| polymarket:nfl-phi-ten-2026-09-20:2026-09-20 | MISSING | nfl | 83 | 1.046% |
| polymarket:nfl-car-atl-2026-09-20:2026-09-20 | MISSING | nfl | 77 | 0.97% |
| polymarket:nfl-lv-lac-2026-09-20:2026-09-20 | MISSING | nfl | 75 | 0.945% |
| polymarket:nfl-was-dal-2026-09-20:2026-09-20 | MISSING | nfl | 75 | 0.945% |
| polymarket:nfl-sea-ari-2026-09-20:2026-09-20 | MISSING | nfl | 73 | 0.92% |
| polymarket:nfl-pit-ne-2026-09-20:2026-09-20 | MISSING | nfl | 71 | 0.895% |
| polymarket:nfl-gb-nyj-2026-09-20:2026-09-20 | MISSING | nfl | 71 | 0.895% |
| polymarket:nfl-ind-kc-2026-09-21:2026-09-21 | MISSING | nfl | 47 | 0.592% |
| polymarket:tpe1-han-tat-2026-09-20-exact-score:2026-09-20 | soccer | tpe1 | 45 | 0.567% |
| polymarket:tpe1-tai-tpc-2026-09-20-exact-score:2026-09-20 | soccer | tpe1 | 45 | 0.567% |
| polymarket:ptc-faz-fig-2026-09-20-exact-score:2026-09-20 | soccer | ptc | 45 | 0.567% |
| polymarket:ptc-cdal-set-2026-09-20-exact-score:2026-09-20 | soccer | ptc | 45 | 0.567% |
| polymarket:ptc-ss-far-2026-09-20-halftime-result:2026-09-20 | soccer | ptc | 45 | 0.567% |
| polymarket:bul-lev-lud-2026-09-20:2026-09-20 | soccer | bul | 44 | 0.554% |

Sport fanout (top 10 by identities):

| sportFamily | sportCode | events | identities | identities/event | share % |
|---|---|---:|---:|---:|---:|
| soccer | ptc | 32 | 1152 | 36 | 14.51% |
| MISSING | nfl | 40 | 1142 | 28.55 | 14.39% |
| tennis | - | 121 | 247 | 2.04 | 3.11% |
| baseball | mlb | 35 | 240 | 6.86 | 3.02% |
| soccer | argpn | 12 | 209 | 17.42 | 2.63% |
| soccer | - | 28 | 170 | 6.07 | 2.14% |
| soccer | nor2 | 7 | 164 | 23.43 | 2.07% |
| soccer | nwsl | 4 | 133 | 33.25 | 1.68% |
| soccer | swe | 15 | 126 | 8.4 | 1.59% |
| soccer | arg | 21 | 121 | 5.76 | 1.52% |

## HYPOTHESIS VERDICTS

- H1 IDENTITY_FANOUT_STARVATION: **SUPPORTED**
- H2 PRODUCT_RANKING_VOLUME_CONCENTRATION: **SUPPORTED**
- H3 MISSING_SPORT_METADATA_CONSUMES_SCORER_BUDGET: **SUPPORTED**
- H4 EVENT_FAIR_ORDER_WOULD_MATERIALLY_INCREASE_PHYSICAL_EVENT_COVERAGE_AT_EQUAL_ATTEMPT_COUNT: **SUPPORTED**
- H5 NULL_PHYSICAL_KEYS_ARE_MATERIAL: **NOT_SUPPORTED**

## SAFE FIX OPTIONS (descriptive only — no implementation, no recommendation to increase load)

| option | physical-event coverage effect | candidate membership impact | DB/network-load impact | semantic risk |
|---|---|---|---|---|
| A. Event-fair round-robin ordering under the unchanged 360s budget | Directly increases distinct physical events opened per attempt count (see EVENT-FAIR table above) | None — same candidate set, only order changes | None — same number of attempts, same per-attempt work | Low: changes WHICH events are opened first, not what qualifies; volume-priority signal is deprioritized within the attempt budget |
| B. Per-event identity cap before the scorer (e.g. cap identities/event) | Increases coverage only if fanout, not raw event count, is the bottleneck | Reduces candidate membership for high-fanout events (fewer sibling/outcome identities attempted per event) | None | Medium: silently drops some already-authorized sibling/outcome identities before they are ever attempted |
| C. Increasing the scorer budget (>360s) | Increases coverage roughly linearly with more wall-clock, without touching order | None | Increases: more enrichment calls, more provider/network load, longer producer runtime | Low semantic risk, but directly increases load — not preferred |
| D. Concurrent scorer enrichment | Could increase coverage without extending wall-clock | None | Increases: parallel provider/network calls, higher burst load, more complex rate-limit exposure | Medium-high: introduces concurrency into a currently strictly sequential, well-understood loop |

This audit's evidence favors an ordering fix (A) over throughput fixes (C, D), since A is the only option that can increase measured physical-event coverage while holding attempt count and load exactly constant.
