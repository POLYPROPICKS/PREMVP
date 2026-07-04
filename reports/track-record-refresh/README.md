# reports/track-record-refresh

JSON reports written by `scripts/refresh-track-record-window-results.ts`
(`npm run refresh:track-record` / `npm run refresh:track-record:write`) land
here, one file per run.

- No secrets are ever written to these reports — the runner redacts any
  secret-shaped text before writing.
- These reports are operational evidence of when a refresh ran and whether
  it succeeded, not a source of truth for track-record data itself. The
  source of truth is `public.track_record_window_results` /
  `public.track_record_window_summary` in Supabase.
- Generated reports are not committed to Git as a matter of course — only
  this README and the directory itself are tracked, so the path exists for
  local/CI runs to write into.

See `docs/operations/TRACK_RECORD_REFRESH_RUNBOOK.md` for the full data-flow
and command reference.
