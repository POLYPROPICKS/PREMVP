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

- `SOURCES/ARCHITECT_SNAPSHOT.md` (GENERATED_SNAPSHOT) — sha256 `d099a10f5a4868249f2ad17709ea42ecea0e43b304deaad15326f8731479b903`
- `SOURCES/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md` (GENERATED_BUNDLE) — sha256 `8dca5501258f453c0575fd451ff53c13baf8ed86bc6d4daed9b61a91bedc02d3`
- `SOURCES/PROMPT__PROTOCOL.md` (MISSION_CONTRACT) — sha256 `87567e6fc8b34b8371a0e299ffc4bcbcd98baae4a745f2c084c63c70a76b0bc4`
- `SOURCES/COMPLETION_ENVELOPE.schema.json` (COMPLETION_CONTRACT) — sha256 `7fe32fbf1853e6382539ac515e43c7ca55eb240dcd65dc09c80f4b9a0173d5b7`

## 3. Replace the Project Instructions

Replace the entire Project Instructions field with the contents of `PROJECT_INSTRUCTIONS.txt` — sha256 `a150156733ad844903e0ff51803db5e5fbe4bcf8db434e7f5a9541587c7a9a08`. Do not append to the previous instructions.

## 4. Verify

`npm run control-plane:project-package:check` must PASS at the commit these files were generated from.
