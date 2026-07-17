# Индекс независимого обзора post-June V1

## Статус

Базовая линия post-9-June заморожена **для независимой проверки**, а не для производства. Pre-8-June сохранён, но quarantined из-за нулевого HIGH/MEDIUM покрытия sport, league и market family.

## Открытие

Начните с [полного walkthrough](../../canonical/model-handoff-v1/docs/POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md), затем откройте локально [post_june_canonical_pnl.html](../../evidence/2026-07-17-post-june-canonical-freeze-v1/post_june_canonical_pnl.html). HTML автономен: браузер не должен получать сеть.

## Карта доказательств

- `modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/dataset_freeze_manifest.json` — frozen 49,400-row snapshot manifest; SHA-256: `4e169008abe0e64865a26304b35cd38a8d5bd6d66e1e716bee53d0389cc56ec7`; authority: highest; limitation: byte snapshot; original database re-export is partial.
- `modeling/canonical/model-handoff-v1/canonical_model_contract.json` — frozen model and identity contract; SHA-256: `f3f0888a9b5e8909e37d1017c60b06729e45dde210cbf269292cc6ec6f8430c5`; authority: highest; limitation: selector consumes a pre-produced score.
- `modeling/canonical/model-handoff-v1/locked_signal_identity_set.json` — original 231-member identity set; SHA-256: `5d650d6f394f61d353fabc501e5c0a4c777599686c472f6b43da39bafa51359d`; authority: highest; limitation: membership is not chronological order.
- `modeling/canonical/model-handoff-v1/locked_execution_sequence.json` — original 231-row replay order; SHA-256: `43f9d20c8f6cbfd800b9b510abc5e2aacdf480b93aa1c95b95e2a7b5790b1d49`; authority: highest; limitation: same-time ordering is committed, not inferred.
- `modeling/evidence/2026-07-17-suspicious-growth-temporal-audit-v1/SUSPICIOUS_GROWTH_TEMPORAL_AUDIT_RU.md` — temporal audit explanation and verdict; SHA-256: `bb9e7e3af24eddbbf71d52d3e71373cde741be37ab325f46c2e846357eff5221`; authority: evidence; limitation: early growth requires temporal and attribution scrutiny.
- `modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/attribution_coverage.json` — attribution confidence coverage; SHA-256: `faf1504439d82c76461d7d13a22cc34c21f8f138718aa0fb6c5f172a26bf17b1`; authority: evidence; limitation: no HIGH/MEDIUM trusted coverage.
- `modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/ATTRIBUTION_REPAIR_AND_GROWTH_EXPLANATION_RU.md` — attribution repair explanation and verdict; SHA-256: `453afcbb78d35272a7132c64dfc15fbca91a85cc656f9fe3a800c6236bdb5c19`; authority: evidence; limitation: LOW fields are diagnostic, not canonical metadata.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june_contract.json` — post-June scope contract; SHA-256: `21228531044f4fa1dc3f544429d390ae96dbb42b2e615188e85b08df5fe2966e`; authority: highest; limitation: fixed cutoff; not optimization.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june9_primary_execution_sequence.json` — 124-row membership and order hashes; SHA-256: `a32020d3ab0bb1bc7fd773ace53aa6bfb0589dc287dd5b94cb488b69b24c237c`; authority: highest; limitation: subset begins by Minsk local time.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/fixed_1u_signal_control.json` — flat 1u signal control; SHA-256: `257a1b9d08094a19227f1fecb0db24a3b879712fbf3f91a055f5835a9e62b080`; authority: evidence; limitation: gross, before venue-specific costs.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/execution_cost_sensitivity.json` — generic cost sensitivity; SHA-256: `4f18b6eb8ed4dda9885a2f43fdd45d4aa4b1a09db54e60e4e34b12a90d7fa35e`; authority: evidence; limitation: not a venue fee claim.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/temporal_stability.json` — stability statistics; SHA-256: `82d8a7e7093adef641298bec9f4b28b3038ce999c52612cefdb4933024ca41bc`; authority: evidence; limitation: 124 observations; not certainty.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/comparison_summary.json` — fresh-state policy replay summary; SHA-256: `bc155a550521e04614080c86c7530675302cab81cb982fca6e7651c443d903fa`; authority: evidence; limitation: policy output is not production approval.
- `modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/freeze_verdict.json` — canonical freeze verdict; SHA-256: `e1134d199e1a49b25ae20e854b7a7120d3c5cbc327a3ea2b592261745f2d7959`; authority: highest; limitation: review remains required.
- `modeling/canonical/model-handoff-v1/docs/POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md` — newcomer-readable canonical walkthrough; SHA-256: `6e4b80afa6da76583f8396c930142b83f6b11ffc7b5e8426b9b1f09c7e861483`; authority: explanatory; limitation: does not replace machine evidence.

## Frozen и non-frozen

Frozen: байты корпуса, manifest, 231 identities, sequence, и уже созданные evidence-пакеты. Этот review bundle и walkthrough являются объяснением и проверочной оболочкой; они не меняют сигнал, результаты или policy parameters. Первичный subset содержит 124 строк: membership hash `ed9d96af2bcdc6e262f2a018248e17cca8485846fa5e558265534012393bcc02`, execution-order hash `26a964d5d432e151f132698fa2f1a40906dddc409309d4bae4c90a1b846f4ce0`.

## Git lineage

Temporal audit: ccc46d1 → 1fe6a81 → 08760be. Attribution repair: 401a142 → 2061356. Post-June freeze: cc2a1ec → e878e0e. Этот bundle должен быть рассмотрен на commit текущей ветки.
