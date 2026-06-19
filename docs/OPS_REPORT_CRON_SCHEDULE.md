# Ops Report Cron Schedule

Status: production routing contract.

## Morning Service / 09:00 Minsk

Railway Custom Start Command:

```bash
npm run ops:morning-report -- --send-test --email=alexgrushin@gmail.com
```

This flow runs:

1. `npm run resolve:signals:live-priority`
2. `npm run resolve:signals:cron`
3. `npm run verify:resolver-pipeline`
4. `npm run morning:model-report -- --send-test --email=alexgrushin@gmail.com`

It must not call the night plan email or the low-supply alert.

## Night Plan Service / 17:00 Minsk

Railway Custom Start Command:

```bash
npm run ops:night-plan-email -- --email=alexgrushin@gmail.com
```

## Night Alert Service / 17:45 Minsk

Railway Custom Start Command:

```bash
npm run ops:night-plan-alert -- --email=alexgrushin@gmail.com
```

The alert command sends only when the night-plan alert path decides a second
alert is required.

## Forbidden Routing

Do not use a semicolon chain that runs morning report, night plan, and alert in
one cron service. If the morning report fails, the night alert must not be sent
as a replacement.

Do not use `npm run night:plan:alert` for the 09:00 Minsk service.

## Verification

Before trusting a morning email cron run:

```bash
npm run verify:resolver-pipeline
npm run morning:model-report -- --dry-run --email=alexgrushin@gmail.com
```

The morning model report must produce exactly three XLSX attachments:

1. `polypropicks_morning_report_YYYYMMDD.xlsx`
2. `ceo_dashboard_details_YYYYMMDD.xlsx`
3. `ice_four_models_counterfactual_YYYYMMDD.xlsx`
