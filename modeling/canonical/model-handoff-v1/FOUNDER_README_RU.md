# Founder README — Canonical Model Handoff V1

Модель отбирает уже оценённые сигналы B2: применяет утверждённые фильтры, группирует один sporting event и исполняет один победивший вариант. Frozen corpus — точные 49,400 строк; байты проверяются SHA. Исходный исторический SQL восстановлен частично, поэтому повторный export не объявляется воспроизводимым.

231 identities — состав когорты, а chronological replay order — отдельный порядок ledgers; сортировать UUID для исполнения нельзя. Fixed Safe ставит 1u и односторонне защищает капитал Vault. Dynamic Protected ставит 3% Active по Minsk-cycle reference и переносит прибыль в Vault по recovery/skim policy; Active и Vault несут состояние между циклами.

Source/tests/data находятся в lib/modeling, tests/modeling, modeling/canonical/datasets/2026-07-15-b2f5dfb5963e, modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault. Нельзя менять signal, dataset/registry SHA, параметры, historical results или смешивать stake/Vault профили. Следующий шаг — только downstream integration после Gate 2A.
