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

- `SOURCES/ARCHITECT_SNAPSHOT.md` (GENERATED_SNAPSHOT) — sha256 `00eae0ed04765ce510bcd35de15377703b2619ca9b8fd1cd80ad6ad560361790`
- `SOURCES/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md` (GENERATED_BUNDLE) — sha256 `1372e7f285bd8f85ae26c29981d84987fc3ddc71d3fac58dfafacc1914c9f72c`
- `SOURCES/PROMPT__PROTOCOL.md` (MISSION_CONTRACT) — sha256 `fa352374dd40d5ed358b2fc907e1096f91a6eb79320ab60ed310f593cd5f2130`
- `SOURCES/COMPLETION_ENVELOPE.schema.json` (COMPLETION_CONTRACT) — sha256 `d2d04e17b6353dd1d62c5c9551cc306809a39be8a4343fe9a3939add5ff725d1`

## 3. Replace the Project Instructions

Replace the entire Project Instructions field with the contents of `PROJECT_INSTRUCTIONS.txt` — sha256 `495cb87461e97a91ce2b6327ebd2ca08f7bb524fc1151f6a0146d289f409a8a9`. Do not append to the previous instructions.

## 4. Verify

`npm run control-plane:project-package:check` must PASS at the commit these files were generated from.
