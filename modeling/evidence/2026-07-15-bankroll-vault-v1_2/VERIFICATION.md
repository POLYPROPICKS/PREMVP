# Verification record

- Byte copy source SHA-256 equals immutable snapshot SHA-256: `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`.
- Snapshot replay was written atomically by the existing CLI and re-read hash-verified. Replay JSON SHA-256: `94e1aaf1884f5630f884e23350b3cf8a1262c1583d573fa41093001337cb70c3`.
- Dry-run and artifact replay agree: 362 T−90 qualified rows, zero strong sporting-match keys, zero selected rows, zero theoretical PnL.
- The task-provided historical targeted result is 99/99 PASS. The directly reproducible current core pair is 74/74 PASS; no 99-test command is recoverable from source. `npx tsc --noEmit`: PASS. `npm run build` is classified `BUILD_ENV_ONLY` when and only when `SUPABASE_URL` is unavailable.
- Ireland was not inspected or changed.
