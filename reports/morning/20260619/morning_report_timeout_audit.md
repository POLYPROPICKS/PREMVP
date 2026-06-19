# Morning Report Timeout Audit - 2026-06-19

## Incident

`npm run ops:morning-report -- --dry-run --email=alexgrushin@gmail.com`
reached the resolver pipeline and then failed inside `scripts/morning-model-report.ts`:

```text
[morning-model] FAILED: generated_signal_pairs: canceling statement due to statement timeout
```

## Timeout Source

The timed-out query was `fetchAllResolvedRows()` in
`scripts/morning-model-report.ts`.

Previous shape:

```text
from generated_signal_pairs
select *
where signal_result is not null
  and condition_id is not null
  and selected_token_id is not null
order by created_at, id
range(...)
```

## Root Cause

The query was paginated, but it selected `*` from `generated_signal_pairs`.
That can pull heavy JSON/raw payload columns that the morning report does not
need for the current freeze and model recalculation. The extra payload increases
query and transfer cost enough to hit Supabase statement timeout on the fresh
larger corpus.

## Repair

`fetchAllResolvedRows()` now:

- selects only the columns needed by the report/model freeze;
- uses page size `500`;
- orders by stable primary key `id`;
- logs every page:

```text
[morning-model] generated_signal_pairs page X rows=Y total=Z
```

The morning report also logs the resolved freeze summary:

```text
[morning-model] resolved freeze rows=N strict=N events=N max_resolved_at=...
```

## Stale Dataset Guard

The morning report now fails explicitly with `DATASET_STALE_BLOCKER` if:

- strict resolved rows are still `<= 707`, or
- `max_resolved_at <= 2026-06-17T09:01:31.130Z`.

The historical ICE707 file remains reference-only and is not used as current
counterfactual input.

## Post-Repair Dry Run

Command:

```bash
npm run ops:morning-report -- --dry-run --email=alexgrushin@gmail.com
```

Result:

- resolver pipeline: PASS
- generated_signal_pairs pages: 37 pages, 18,025 rows fetched
- strict_resolved_total: 943
- event_groups: 640
- max_resolved_at: 2026-06-19T07:31:33.458Z
- delta_vs_ICE707: +236 rows / +139 event groups
- email: not sent, dry-run mode
- subject: `PolyProPicks Morning Model Report - 2026-06-19 - N=943`
- attachmentCount: 3

Generated XLSX files:

- `polypropicks_morning_report_20260619.xlsx` - 59,322 bytes
- `ceo_dashboard_details_20260619.xlsx` - 17,522 bytes
- `ice_four_models_counterfactual_20260619.xlsx` - 16,281 bytes
