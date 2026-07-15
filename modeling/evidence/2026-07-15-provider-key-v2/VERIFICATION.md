# Verification

- Full, read-only keyset export: 51,157 rows across 52 pages; `COMPLETE_BY_EXHAUSTION` / `LAST_PAGE_SHORT`.
- Dataset SHA-256: `04819301273ae802736c4146470e20d77002f57d808e61bd470b1ed5ed14c6f1`.
- `canonical_event_key`: 0/51,157 rows (0%); no multi-market provider-key group exists in this historical export.
- Replay invariants PASS: accepted eSports = 0; selected observations = strong sporting-match groups = 0; simultaneous positions = 0 <= 30; open exposure = 0 <= 80; daily accepted signals = 0 <= 100.
- Verdict: `HISTORICAL_ROWS_REQUIRE_PROVIDER_KEY_BACKFILL`.
- Existing historical rows do not contain `diagnostics.canonicalEventKey`. New rows will receive it only after the source-code patch is deployed and a generation run writes new diagnostics. Recreating historical provider identity is not safe from this export alone; it needs time-aligned archived provider payloads. Updating historical Supabase rows would be a backfill requiring founder approval; no update was performed.
