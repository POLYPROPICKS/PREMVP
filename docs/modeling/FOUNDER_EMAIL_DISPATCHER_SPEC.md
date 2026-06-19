# Founder Email Dispatcher Spec

## Purpose

Unify founder/report emails behind one Railway cron service so manual Run now and schedule-driven runs use the same entrypoint.

## Cron Services

Morning, night plan, and night alert must be scheduled as separate commands.
Do not use one mixed cron service for all three email flows.

- Morning service: 09:00 Minsk
- Command: `npm run ops:morning-report -- --send-test --email=alexgrushin@gmail.com`

- Night plan service: 17:00 Minsk
- Command: `npm run ops:night-plan-email -- --email=alexgrushin@gmail.com`

- Night alert service: 17:45 Minsk
- Command: `npm run ops:night-plan-alert -- --email=alexgrushin@gmail.com`

Manual all-mode is for local/operator debugging only. It must not be used as a
Railway scheduled command.

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
- `--mode=all` sends morning, then night-plan, then alert; do not schedule this
- `--mode=auto` sends only when the current Minsk time falls in the matching window; do not schedule this

## Required Env

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `FOUNDER_EMAIL_TO=alexgrushin@gmail.com`
- `MORNING_MODEL_EMAIL_TO=alexgrushin@gmail.com`
- `NIGHT_PLAN_EMAIL_TO=alexgrushin@gmail.com`

## Notes

- The dispatcher is a thin wrapper over the existing founder email scripts.
- The default mode is morning-safe. Night plan and alert require explicit modes.
- If a child email command fails, the dispatcher exits non-zero and reports which email failed.
- `NO_EMAIL_DUE` is logged when `--mode=auto` is outside all dispatch windows.
