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

- `SOURCES/ARCHITECT_SNAPSHOT.md` (GENERATED_SNAPSHOT) — sha256 `40ef2882a837c3ae2c0d74347a0d2fc40071a386ed9d43510251cfbcbf0c012a`
- `SOURCES/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md` (GENERATED_BUNDLE) — sha256 `2ab145ebb5b6d196b4adf64597e64183b5e10c61fbc988e2aa1353a9320dac91`
- `SOURCES/PROMPT__PROTOCOL.md` (MISSION_CONTRACT) — sha256 `fa352374dd40d5ed358b2fc907e1096f91a6eb79320ab60ed310f593cd5f2130`
- `SOURCES/COMPLETION_ENVELOPE.schema.json` (COMPLETION_CONTRACT) — sha256 `d2d04e17b6353dd1d62c5c9551cc306809a39be8a4343fe9a3939add5ff725d1`

## 3. Replace the Project Instructions

Replace the entire Project Instructions field with the contents of `PROJECT_INSTRUCTIONS.txt` — sha256 `b8e2871fe7521e84df3361a9fbbe48914e71515d01e45b2e841474a2107785b6`. Do not append to the previous instructions.

## 4. Verify

`npm run control-plane:project-package:check` must PASS at the commit these files were generated from.
