# Morning Report Resolved-Only Query Repair Audit

## Root Cause
`morning-model-report.ts` still paginated `generated_signal_pairs` with offset-based paging over the resolved subset. On Railway that produced many pages and eventually hit Supabase statement timeout.

## Repair
- Keep explicit resolved-only filters.
- Replace offset paging with keyset paging by `resolved_at desc, created_at desc, id desc`.
- Continue using explicit columns only.
- Keep strict dedupe on `condition_id::selected_token_id`.

## Verification Target
- `ops:morning-package -- --skip-live-priority`
- `ops:morning-send-ready -- --dry-run --email=alexgrushin@gmail.com`
- Expect no statement timeout and a READY manifest.
