# AUGUST_CLAUDE_CLOUD_ARTIFACT_RECOVERY_V1

RECOVERY ONLY. No reconstruction, no recomputation, no DB/Gamma access performed in this mission.

## Where it was found

Not in canonical Git (already proven absent from `origin/main` by a prior Codex recovery attempt).
Found in **this session's own Claude Code Cloud persistent workspace filesystem** — the same
mechanism the mission named as the recovery target — at:

```
modeling/local_exports/august_main_db_enrichment_v1/AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl
modeling/local_exports/august_main_db_enrichment_v1/AUGUST_MAIN_DB_ENRICHMENT_V1_COVERAGE.json
modeling/local_exports/august_main_db_enrichment_v1/AUGUST_MAIN_DB_ENRICHMENT_V1_MANIFEST.json
modeling/local_exports/august_main_db_enrichment_v1/SHA256_MANIFEST.txt
```

`git status` showed the whole `modeling/local_exports/` directory as untracked (`??`), and
`git check-ignore -v` confirms it is explicitly excluded by `.gitignore:97` — which is exactly
why it never reached canonical Git despite having been fully produced. It survived only because
this execution session's own workspace persisted across the missions in this conversation.

## Identity match (proven, not assumed)

| | expected (from mission) | found |
|---|---|---|
| artifact_id | `AUGUST_MAIN_DB_ENRICHMENT_V1` | `AUGUST_MAIN_DB_ENRICHMENT_V1` (manifest `artifact_id`) |
| SHA256 of `.jsonl` | `3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93` | `3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93` — **exact match**, both from a fresh `sha256sum` of the file on disk and from the manifest's own `output_sha256` field |
| status | — | `IMMUTABLE` (manifest) |
| base population | 18,705 August events, `formula_version='shadow-strategic-sports-v1'` | `base_event_n: 18705`, `enriched_row_n: 18705`, `row_conservation_ok: true`, `base_membership_unchanged: true` (manifest) |
| provenance probe row | `id=b9f19f8a-5b2b-4d90-8a3a-c4922d4d836d`, `created_at=2026-08-05T13:38:10.622Z` (this session's own memory record) | identical `identity_probe_row` in both `AUGUST_MAIN_DB_ENRICHMENT_V1_MANIFEST.json` and `_COVERAGE.json` |

No identity conflict: same file, same manifest, same probe row, same accepted lineage recorded
in this session's persistent memory (`august-main-db-enrichment-v1.md`).

## What was preserved (bytes unchanged)

- `AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl.gz` — the original 241,608,790-byte `.jsonl` file, gzip
  (level 6) compressed only. **Round-trip verified**: `gunzip -c ... | sha256sum` reproduces
  `3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93` exactly. Compression is
  lossless container framing, not a content change.
- `AUGUST_MAIN_DB_ENRICHMENT_V1_COVERAGE.json` — copied verbatim, SHA256 matches the original
  `SHA256_MANIFEST.txt` entry (`c8927652…`).
- `AUGUST_MAIN_DB_ENRICHMENT_V1_MANIFEST.json` — copied verbatim, SHA256 matches the original
  `SHA256_MANIFEST.txt` entry (`b6f7169a…`).
- `SHA256_MANIFEST_ORIGINAL.txt` — the original manifest's own SHA256 listing, preserved as-is
  for independent cross-check.
- `SHA256.txt` — checksums of the files actually stored in this evidence directory.

Implementation code was also recovered as untracked working-tree files and is committed in its
normal source locations (not duplicated into this evidence directory):

- `lib/modeling/august-enrichment/{contract,enrich,index,mainDbLineage,types}.ts`
- `scripts/modeling/build-august-enriched-main.ts`
- `tests/modeling/august-enrichment/{augustEnrichment,mainDbLineage}.test.ts`

No other historical file was restored. `modeling/local_exports/` (the large working-tree source
of this recovery) stays untracked/gitignored as before — only this evidence copy and the source
code are committed.

## Accepted economic anchors (reference only, not recomputed here)

C4 August N=4117 / +474.56u / 11.5269% / -16.41u; `soccer_first_to_score` N=621 / +103.29u /
16.63% / -13.31u; `soccer_exact_score` N=196 / +113.13u / 57.72% / -6.00u; UWCL N=87 / +22.35u /
25.69% / -3.00u. These figures live in `lib/modeling/forward-rich/augustFrozenResearchContext.ts`
(already durable on `origin/main` via PR #225) and are unaffected by this recovery.

## FINAL VERDICT

**A. AUGUST_CLOUD_ARTIFACT_RECOVERED**

Exact accepted artifact found, identity proven byte-for-byte via SHA256, provenance reconciled
against this session's own memory and manifest, bytes preserved unchanged (gzip only, round-trip
verified), and the minimum implementation needed to evaluate it recovered alongside it. No
reconstruction, no DB/Gamma access, no recomputation performed.

Next transition: `AUGUST_C4_SCORECARD_REPRODUCIBILITY_V1`.
