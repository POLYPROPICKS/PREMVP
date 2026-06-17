# Founder Email Dispatcher Spec

## Purpose

Unify founder/report emails behind one Railway cron service so manual Run now and schedule-driven runs use the same entrypoint.

## Single Cron Service

- Service: `ops-report-email-cron`
- Schedule: `*/15 * * * *`
- Command: `npm run founder:emails -- --mode=auto --email=alexgrushin@gmail.com`
- Manual Run now: `npm run founder:emails -- --mode=all --email=alexgrushin@gmail.com`

## Recipient Rules

Priority:

1. `--email=...`
2. `FOUNDER_EMAIL_TO`
3. `MORNING_MODEL_EMAIL_TO`
4. `NIGHT_PLAN_EMAIL_TO`
5. `alexgrushin@gmail.com`

## Dispatch Modes

- `--mode=morning` sends the morning model report
- `--mode=night-plan` sends the night portfolio plan
- `--mode=alert` sends the shortage/alert email if the night-plan alert path exists
- `--mode=all` sends morning, then night-plan, then alert
- `--mode=auto` sends only when the current Minsk time falls in the matching window

## Required Env

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `FOUNDER_EMAIL_TO=alexgrushin@gmail.com`
- `MORNING_MODEL_EMAIL_TO=alexgrushin@gmail.com`
- `NIGHT_PLAN_EMAIL_TO=alexgrushin@gmail.com`

## Notes

- The dispatcher is a thin wrapper over the existing founder email scripts.
- If a child email command fails, the dispatcher exits non-zero and reports which email failed.
- `NO_EMAIL_DUE` is logged when `--mode=auto` is outside all dispatch windows.
