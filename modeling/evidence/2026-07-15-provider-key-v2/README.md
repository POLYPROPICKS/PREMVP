# Provider-key v2 export and replay evidence

This package records the first full resolved export made after the local provider-ID preservation patch. Raw data and full replay ledger remain outside Git in `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15-provider-key-v2_04819301273a`.

Result: the exporter is capable of emitting `canonical_event_key`, but all 51,157 historical rows predate the persisted diagnostics field. This is evidence-only; no backfill or Supabase update was attempted.
