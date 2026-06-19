# Morning Cron Incident Audit - 2026-06-19

## Expected Schedule

- 09:00 Minsk: Morning Model Report with three XLSX attachments.
- 17:00 Minsk: Night Portfolio Plan.
- 17:45 Minsk: Low Tier1 / low supply alert only if still required.

## Actual Incident

At about 09:04 Minsk the founder received only:

```text
ALERT: Low Tier1 Supply - Night Plan Needs Review
```

The expected Morning Model Report email was not received.

## Routing Found

- Morning report sender: `scripts/morning-model-report.ts`
- Night plan sender: `scripts/send-night-portfolio-plan.ts`
- Low supply alert sender: `scripts/send-night-portfolio-plan.ts --alert-only`
- Dispatcher: `scripts/founder-email-dispatcher.ts`
- Previous cron alias: `ops-report-email-cron = tsx scripts/founder-email-dispatcher.ts`
- Previous dispatcher default: `--mode=auto`
- Legacy bundle risk: `scripts/ops-report-email-bundle.ts` ran resolver, morning,
  night plan, and alert in one process.

## Root Cause

The production-facing email command was not split into separate morning,
night-plan, and alert commands. The old entrypoint allowed mixed routing:

- `auto` mode depended on wall-clock routing inside one dispatcher.
- The legacy bundle could run morning + night plan + alert sequentially.
- A night alert could therefore be sent from the reporting cron path instead of
  being isolated to the 17:45 Minsk alert service.

This made the 09:00 morning report vulnerable to being masked by a night alert.

## Repair

The repo now exposes explicit commands:

- Morning: `npm run ops:morning-report -- --send-test --email=alexgrushin@gmail.com`
- Night plan: `npm run ops:night-plan-email -- --email=alexgrushin@gmail.com`
- Night alert: `npm run ops:night-plan-alert -- --email=alexgrushin@gmail.com`

The `ops-report-email-cron` alias is now morning-only.

## Attachment Generation Status

Verified by post-patch dry-run:

- `polypropicks_morning_report_20260619.xlsx` - 58,946 bytes
- `ceo_dashboard_details_20260619.xlsx` - 17,499 bytes
- `ice_four_models_counterfactual_20260619.xlsx` - 16,225 bytes

Attachment count: 3.

Subject:

```text
PolyProPicks Morning Model Report - 2026-06-19 - N=840
```

Dataset freshness:

- strict_resolved_total: 840
- event_groups: 574
- max_resolved_at: 2026-06-19T07:10:56.830Z
- delta_vs_ICE707: +133 rows / +73 event groups

Counterfactual workbook source after repair:

```text
modeling/morning_model_report/20260619_0600UTC/input/resolved_freeze.csv
```

The historical ICE707 file is ignored for current morning counterfactual
generation and remains baseline/reference only.

## Required Railway UI Change

Use separate services/schedules or set the existing 09:00 Minsk service to:

```bash
npm run ops:morning-report -- --send-test --email=alexgrushin@gmail.com
```
