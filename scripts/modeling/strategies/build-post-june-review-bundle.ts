import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const REVIEW_DIR = "modeling/review/2026-07-17-post-june-canonical-review-v1";
const WALKTHROUGH = "modeling/canonical/model-handoff-v1/docs/POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md";
const SOURCES = [
  ["modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/dataset_freeze_manifest.json", "frozen 49,400-row snapshot manifest", "08760be", "highest", "byte snapshot; original database re-export is partial"],
  ["modeling/canonical/model-handoff-v1/canonical_model_contract.json", "frozen model and identity contract", "e878e0e", "highest", "selector consumes a pre-produced score"],
  ["modeling/canonical/model-handoff-v1/locked_signal_identity_set.json", "original 231-member identity set", "e878e0e", "highest", "membership is not chronological order"],
  ["modeling/canonical/model-handoff-v1/locked_execution_sequence.json", "original 231-row replay order", "e878e0e", "highest", "same-time ordering is committed, not inferred"],
  ["modeling/evidence/2026-07-17-suspicious-growth-temporal-audit-v1/SUSPICIOUS_GROWTH_TEMPORAL_AUDIT_RU.md", "temporal audit explanation and verdict", "08760be", "evidence", "early growth requires temporal and attribution scrutiny"],
  ["modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/attribution_coverage.json", "attribution confidence coverage", "2061356", "evidence", "no HIGH/MEDIUM trusted coverage"],
  ["modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/ATTRIBUTION_REPAIR_AND_GROWTH_EXPLANATION_RU.md", "attribution repair explanation and verdict", "2061356", "evidence", "LOW fields are diagnostic, not canonical metadata"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june_contract.json", "post-June scope contract", "e878e0e", "highest", "fixed cutoff; not optimization"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june9_primary_execution_sequence.json", "124-row membership and order hashes", "e878e0e", "highest", "subset begins by Minsk local time"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/fixed_1u_signal_control.json", "flat 1u signal control", "e878e0e", "evidence", "gross, before venue-specific costs"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/execution_cost_sensitivity.json", "generic cost sensitivity", "e878e0e", "evidence", "not a venue fee claim"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/temporal_stability.json", "stability statistics", "e878e0e", "evidence", "124 observations; not certainty"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/comparison_summary.json", "fresh-state policy replay summary", "e878e0e", "evidence", "policy output is not production approval"],
  ["modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/freeze_verdict.json", "canonical freeze verdict", "e878e0e", "highest", "review remains required"],
  [WALKTHROUGH, "newcomer-readable canonical walkthrough", "this branch", "explanatory", "does not replace machine evidence"]
] as const;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const read = (root: string, file: string) => readFileSync(resolve(root, file));

export function buildPostJuneReviewBundle(root = process.cwd()) {
  const output = resolve(root, REVIEW_DIR);
  if (!existsSync(resolve(root, WALKTHROUGH))) throw new Error(`Missing walkthrough: ${WALKTHROUGH}`);
  mkdirSync(output, { recursive: true });
  const inventory = SOURCES.map(([path, role, producingCommit, authorityLevel, knownLimitation]) => ({
    relativePath: path, role, sha256: sha(read(root, path)), gitTracked: true, producingBranchCommit: producingCommit, authorityLevel, knownLimitation
  }));
  const questions = [
    "Обоснована ли граница 9 июня как граница доверия к данным, а не как оптимизация?",
    "Есть ли утечка будущей информации, скрытая в decisionAt, resolvedAt или порядке?",
    "Воспроизводится ли формула выплаты для результата и entryPrice?",
    "Правильно ли fixed-1u отделяет качество сигнала от политики капитала?",
    "Честно ли показаны все сценарии исполнения и отсутствие данных о реальной комиссии?",
    "Стартуют ли обе политики после cutoff с чистого 50u/0u без наследованного состояния?",
    "Корректно ли представлены пропуски, конкуренция и потолок экспозиции?",
    "Достаточна ли выборка для shadow-оценки и нужно ли сначала исправить metadata attribution?"
  ];
  const schema = { reviewerModel: "string", reviewDate: "YYYY-MM-DD", reviewedCommit: "git SHA", datasetHashVerified: "boolean", subsetHashVerified: "boolean", calculationChecks: [{ name: "string", status: "PASS|FAIL|UNRESOLVED", evidence: "string" }], methodologyFindings: ["string"], blockingFindings: ["string"], nonBlockingFindings: ["string"], shadowRecommendation: "string", productionRecommendation: "string", finalVerdict: "ACCEPT_POST_JUNE_BASELINE_FOR_SHADOW_REVIEW|ACCEPT_WITH_BLOCKING_CONDITIONS|REJECT_PENDING_DATA_REPAIR|REJECT_MODEL_NOT_PROMOTABLE" };
  const index = `# Индекс независимого обзора post-June V1\n\n## Статус\n\nБазовая линия post-9-June заморожена **для независимой проверки**, а не для производства. Pre-8-June сохранён, но quarantined из-за нулевого HIGH/MEDIUM покрытия sport, league и market family.\n\n## Открытие\n\nНачните с [полного walkthrough](../../canonical/model-handoff-v1/docs/POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md), затем откройте локально [post_june_canonical_pnl.html](../../evidence/2026-07-17-post-june-canonical-freeze-v1/post_june_canonical_pnl.html). HTML автономен: браузер не должен получать сеть.\n\n## Карта доказательств\n\n${inventory.map(x => `- \`${x.relativePath}\` — ${x.role}; SHA-256: \`${x.sha256}\`; authority: ${x.authorityLevel}; limitation: ${x.knownLimitation}.`).join("\n")}\n\n## Frozen и non-frozen\n\nFrozen: байты корпуса, manifest, 231 identities, sequence, и уже созданные evidence-пакеты. Этот review bundle и walkthrough являются объяснением и проверочной оболочкой; они не меняют сигнал, результаты или policy parameters. Первичный subset содержит 124 строк: membership hash \`ed9d96af2bcdc6e262f2a018248e17cca8485846fa5e558265534012393bcc02\`, execution-order hash \`26a964d5d432e151f132698fa2f1a40906dddc409309d4bae4c90a1b846f4ce0\`.\n\n## Git lineage\n\nTemporal audit: ccc46d1 → 1fe6a81 → 08760be. Attribution repair: 401a142 → 2061356. Post-June freeze: cc2a1ec → e878e0e. Этот bundle должен быть рассмотрен на commit текущей ветки.\n`;
  const prompt = `# Независимая проверка: bounded inspect-only prompt\n\nРаботайте как GPT-5.6 Sol или эквивалентная независимая reasoning-модель. Режим **inspect-only**: не изменяйте репозиторий, не запускайте оптимизацию, не выбирайте другую дату cutoff и не одобряйте production только потому, что тесты проходят.\n\nПрочитайте REVIEW_BUNDLE_INDEX_RU.md, полный walkthrough и перечисленные source artifacts. Независимо пересчитайте hashes, membership/order, fixed-1u PnL, cost formula, и fresh-state replay reconciliations настолько, насколько позволяют committed data и source/tests. Попытайтесь опровергнуть выводы: ищите temporal leakage, survivorship, ошибку payout, неверную Minsk границу, attribution risk, hidden pre-cutoff capital state, и неверное представление skips/concurrency/exposure.\n\nОтветьте разделами: verified facts; calculation mismatches; methodology concerns; data-trust concerns; model-risk concerns; capital-policy concerns; missing tests; blocking conditions; recommended next milestone; final verdict.\n\nФинальный verdict строго один из: \`ACCEPT_POST_JUNE_BASELINE_FOR_SHADOW_REVIEW\`, \`ACCEPT_WITH_BLOCKING_CONDITIONS\`, \`REJECT_PENDING_DATA_REPAIR\`, \`REJECT_MODEL_NOT_PROMOTABLE\`. Production approval не является допустимым автоматическим выводом этого задания.\n`;
  const files: Record<string, string> = {
    "source_inventory.json": json(inventory),
    "review_questions.json": json(questions),
    "expected_verdict_schema.json": json(schema),
    "REVIEW_BUNDLE_INDEX_RU.md": index,
    "INDEPENDENT_REVIEW_PROMPT_RU.md": prompt
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(resolve(output, name), value, "utf8");
  const manifest = Object.fromEntries(Object.keys(files).sort().map(name => [name, sha(files[name])]));
  writeFileSync(resolve(output, "manifest.json"), json({ version: "POST_JUNE_CANONICAL_REVIEW_V1", files: manifest }), "utf8");
  return { output: relative(root, output).replaceAll("\\", "/"), sourceInventory: inventory, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) console.log(json(buildPostJuneReviewBundle()));
