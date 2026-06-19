# FireModel

FireModel is the PolyProPicks private trading model and reporting framework. It is not a public product formula, not a public feed scoring change, and not a World Cup-only model.

## Doctrine

- Primary scope: `ALL_SPORTS`.
- Supported sports scope includes soccer/football/WC, MLB/baseball, esports, tennis, NBA/basketball, NHL/hockey, NFL/American football, other, and UNKNOWN when data is incomplete.
- WC ROI anchors are `Legacy WC Smoke Test` diagnostics only. They are not benchmarks and must not drive champion selection, ranking, promotion, rollback, CEO recommendation, or live contour decisions.
- Public product formula is frozen: `FROZEN_DO_NOT_MODIFY`.
- FireModel is private analytics and live-contour control support.

## Traceability

No ROI number is anonymous. Every trusted row must trace to:

- `model_id`
- `dataset_id`
- `funnel_id`
- `sql_id` or `query_id`
- `run_id`
- artifact path

Registered query contracts live in `modeling/sql_registry/**`. Runtime adapters may use Supabase REST when direct SQL is unavailable, but they must reference registered query IDs and write `query_execution_manifest.json`.

## Funnel

- `L0_RAW_MARKET_INVENTORY`: wide market/research inventory.
- `L1_RESEARCH_CANDIDATES`: research candidate layer.
- `L2_SCORED_CANDIDATES`: candidates with score/confidence coverage.
- `L3_DECISION_LAYER`: published/saved signal layer.
- `L4_EXECUTION_LAYER`: live contour and order/audit events.
- `L5_RESOLUTION_LAYER`: resolved strict candidate corpus.

## Required Daily Report

FireModel report must include:

- At least 4 models from registry.
- All-time, 96h, and 7d metrics.
- Sport, tier, market-family breakdowns.
- Sport x model, tier x model, family x model, and family x sport views.
- Live contour snapshot.
- Denominator check.
- SQL/query manifest.
- Run log summary.
- Warnings.
- Model change detector with `auto_switch_allowed=false`.

## Scripts

- `npm run fire:model:report`
- `npm run fire:model:verify`
- `npm run fire:model:doctor`
- `npm run fire:model:latest`
- `npm run fire:model:compare-last`
- `npm run ops:morning-package -- --skip-live-priority --skip-resolvers --email=alexgrushin@gmail.com` for read-only package verification.
- `npm run ops:morning-send-ready -- --dry-run --email=alexgrushin@gmail.com` for read-only email package verification.

## Operator Rules

- Do not run `railway up`.
- Immediate production verification is Railway UI cron `Run now`.
- Do not interpret FireModel as WC-only.
- Do not hide warnings.
- Do not commit generated XLSX, `modeling/fire_runs`, `tmp`, or morning package artifacts.
- Do not place live orders from FireModel scripts.

## Acceptance Checklist

- `npm run build` passes.
- `npm run fire:model:verify` passes.
- `npm run fire:model:doctor` passes.
- Latest `run_manifest.json` has `primary_scope=ALL_SPORTS`.
- Latest `run_manifest.json` has `legacy_wc_smoke_test_is_benchmark=false`.
- Workbook has model comparison, model change detector, live contour, denominator, sport/tier/family breakdowns, SQL manifest, run log summary, legacy smoke test, and warnings.
- Morning package manifest includes FireModel as fourth attachment when FireModel succeeds.
