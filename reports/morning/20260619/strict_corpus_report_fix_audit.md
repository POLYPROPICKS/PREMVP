# Strict Corpus Morning Report Fix Audit

## Bug
The morning report still needed a full strict corpus, but the previous raw-offset scan was the real timeout source.

## Fix
- Keep keyset pagination by `resolved_at desc, created_at desc, id desc`.
- Dedupe on the fly into strict keys.
- Return the strict corpus only.
- No artificial raw cap; keyset paging finishes without timeout.

## Verification
- `npm run ops:morning-package -- --skip-live-priority`
- `npm run ops:morning-send-ready -- --dry-run --email=alexgrushin@gmail.com`
