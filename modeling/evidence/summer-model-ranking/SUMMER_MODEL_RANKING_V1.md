# RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1 — six-model summer scorecard

basis: AUGUST_MAIN_DB_ENRICHMENT_V1  sha256=3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93
formula_version=shadow-strategic-sports-v1  base_event_n=18705  price+sport-present parent N=18702
decision span 2026-08-05T13:37:00.153Z -> 2026-08-25T16:07:57.730Z  (20.1 days)

| model | predicate | N | W | L | PnL_u | ROI% | MaxDD_u | bets/day | +wk | -wk |
|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 0.50 <= entry_price < 0.60 | 9976 | 5341 | 4635 | 507.53 | 5.09 | -51.38 | 496.2 | 4 | 0 |
| C1 | 0.50 <= entry_price < 0.60 AND sport_family = soccer | 3253 | 1915 | 1338 | 431.22 | 13.26 | -16.94 | 161.8 | 4 | 0 |
| C2 | 0.50 <= entry_price < 0.60 AND lead_time_hours >= 24 | 2868 | 1634 | 1234 | 309.77 | 10.80 | -14.39 | 142.65 | 4 | 0 |
| C3 | 0.50 <= entry_price < 0.60 AND sport_family = soccer AND lead_time_hours >= 24 | 2004 | 1173 | 831 | 266.42 | 13.29 | -13.94 | 99.68 | 4 | 0 |
| C4 | 0.50 <= entry_price < 0.60 AND (sport_family = soccer OR lead_time_hours >= 24) | 4117 | 2376 | 1741 | 474.56 | 11.53 | -16.41 | 204.78 | 4 | 0 |
| C5 | 0.50 <= entry_price < 0.60 AND sport_family != table-tennis | 6547 | 3625 | 2922 | 506.00 | 7.73 | -24.50 | 325.64 | 4 | 0 |

## C0 — PRICE_ANCHOR
weekly: 2026-08-03:116.3u/4.2%(n2741)  2026-08-10:164.3u/6.9%(n2379)  2026-08-17:173.2u/5.2%(n3354)  2026-08-24:53.8u/3.6%(n1502)
largest single-day positive-PnL share: 11.5%  largest single-event share: 0.02%
sport: table-tennis 3429 (34.37%), soccer 3253 (32.61%), tennis 1918 (19.23%), esports 476 (4.77%), cricket 411 (4.12%), baseball 372 (3.73%), golf 43 (0.43%), basketball 29 (0.29%), other 12 (0.12%), american-football 9 (0.09%), volleyball 9 (0.09%), handball 6 (0.06%), rugby 5 (0.05%), mma 4 (0.04%)
market family: unknown 9860 (98.84%), Esports 69 (0.69%), Sports 39 (0.39%), Tennis 4 (0.04%), UFC 2 (0.02%), MLS 1 (0.01%), NBA 1 (0.01%)

## C1 — HIGH_ROI
weekly: 2026-08-03:73.1u/7.7%(n950)  2026-08-10:150.3u/18.1%(n831)  2026-08-17:167.8u/14.6%(n1146)  2026-08-24:40.1u/12.3%(n326)
largest single-day positive-PnL share: 15.01%  largest single-event share: 0.06%
sport: soccer 3253 (100%)
market family: unknown 3229 (99.26%), Sports 23 (0.71%), MLS 1 (0.03%)

## C2 — LEAD_GE_24H
weekly: 2026-08-03:41.9u/5.5%(n766)  2026-08-10:90.6u/17.8%(n508)  2026-08-17:121.3u/11.4%(n1068)  2026-08-24:55.9u/10.6%(n526)
largest single-day positive-PnL share: 13.65%  largest single-event share: 0.06%
sport: soccer 2004 (69.87%), tennis 321 (11.19%), cricket 212 (7.39%), baseball 182 (6.35%), esports 84 (2.93%), golf 35 (1.22%), basketball 16 (0.56%), handball 6 (0.21%), rugby 4 (0.14%), mma 2 (0.07%), american-football 1 (0.03%), other 1 (0.03%)
market family: unknown 2867 (99.97%), Esports 1 (0.03%)

## C3 — SOCCER_AND_LEAD_GE_24H (C1 INTERSECT C2)
weekly: 2026-08-03:34.5u/6.2%(n559)  2026-08-10:85.1u/24.4%(n348)  2026-08-17:104.3u/13.3%(n787)  2026-08-24:42.6u/13.7%(n310)
largest single-day positive-PnL share: 13.46%  largest single-event share: 0.09%
sport: soccer 2004 (100%)
market family: unknown 2004 (100%)

## C4 — BALANCED / CURRENT OPERATING MODEL
weekly: 2026-08-03:80.6u/7.0%(n1157)  2026-08-10:155.8u/15.7%(n991)  2026-08-17:184.7u/12.9%(n1427)  2026-08-24:53.4u/9.9%(n542)
largest single-day positive-PnL share: 13.74%  largest single-event share: 0.05%
sport: soccer 3253 (79.01%), tennis 321 (7.8%), cricket 212 (5.15%), baseball 182 (4.42%), esports 84 (2.04%), golf 35 (0.85%), basketball 16 (0.39%), handball 6 (0.15%), rugby 4 (0.1%), mma 2 (0.05%), american-football 1 (0.02%), other 1 (0.02%)
market family: unknown 4092 (99.39%), Sports 23 (0.56%), Esports 1 (0.02%), MLS 1 (0.02%)

## C5 — PNL_SCALE
weekly: 2026-08-03:97.4u/6.2%(n1580)  2026-08-10:156.6u/10.0%(n1563)  2026-08-17:196.3u/8.6%(n2278)  2026-08-24:55.8u/5.0%(n1126)
largest single-day positive-PnL share: 11.92%  largest single-event share: 0.03%
sport: soccer 3253 (49.69%), tennis 1918 (29.3%), esports 476 (7.27%), cricket 411 (6.28%), baseball 372 (5.68%), golf 43 (0.66%), basketball 29 (0.44%), other 12 (0.18%), american-football 9 (0.14%), volleyball 9 (0.14%), handball 6 (0.09%), rugby 5 (0.08%), mma 4 (0.06%)
market family: unknown 6431 (98.23%), Esports 69 (1.05%), Sports 39 (0.6%), Tennis 4 (0.06%), UFC 2 (0.03%), MLS 1 (0.02%), NBA 1 (0.02%)

