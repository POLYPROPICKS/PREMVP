# REPLACE_PROJECT_SOURCES.md

<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:project-package -->

Package schema 1.0. One bounded UI sequence, no shell, no SQL, no secret handling.

## 1. Remove these Project Sources

- `CHATGPT_PROJECT_SETUP.md` — SUPERSEDED — one-time Phase 2 setup guide, not current prompt policy
- `NEW_CONTOUR_3.md` — HISTORICAL — contour handoff, never current state
- `NEW_CONTOUR_4.md` — HISTORICAL — contour handoff, never current state
- `EVIDENCE_LEDGER.md` — HISTORICAL — append-only ledger, never current state
- `PASTED_COMPLETION_REPORTS` — HISTORICAL — superseded by COMPLETION_ENVELOPE.schema.json
- `PROMPT_FAILURE_POSTMORTEMS` — HISTORICAL — lessons, not policy
- `SECRETS_AND_ENV_FILES` — FORBIDDEN — secrets are never uploaded

## 2. Add exactly these four Project Sources

- `SOURCES/ARCHITECT_SNAPSHOT.md` (GENERATED_SNAPSHOT) — sha256 `79550b363d1471e0eb7176f90bab67cbf625f52df9525f397e47410bc913607f`
- `SOURCES/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md` (GENERATED_BUNDLE) — sha256 `6745921d533b24293cdfb6a48532d0eb88083c8880303b4bf7f27656efe0c82a`
- `SOURCES/PROMPT__PROTOCOL.md` (MISSION_CONTRACT) — sha256 `77307e74c921b8327a58f5cf6427fa85958dc76d5c54be041f7c7b41736b5809`
- `SOURCES/COMPLETION_ENVELOPE.schema.json` (COMPLETION_CONTRACT) — sha256 `7af9580d3c03b72e61b63e140165fa0148ff942bb4dc1c8d938a478e78064703`

## 3. Replace the Project Instructions

Replace the entire Project Instructions field with the contents of `PROJECT_INSTRUCTIONS.txt` — sha256 `19241ee1425cb6b909ce7b3c8d91f5d14af541dd53a52aa4998df9ae80307b13`. Do not append to the previous instructions.

## 4. Verify

`npm run control-plane:project-package:check` must PASS at the commit these files were generated from.
