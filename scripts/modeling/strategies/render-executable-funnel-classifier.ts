#!/usr/bin/env -S node --import tsx
// Founder report generator for the executable funnel classifier (Phase
// 3E.3A-1 Commit B).
//
// Renders a deterministic, founder-readable HTML report from the registry
// produced in Commit A. Four sections:
//   1. Formula calculation  -- ordered arithmetic breakdown with exact weights.
//   2. Bundle summary       -- one row per bundle, plain-language columns.
//   3. Detailed funnel      -- per-bundle ordered steps (INPUT..OUTPUT).
//   4. Provenance appendix  -- source agreement + sibling-branch limitation.
//
// Formula arithmetic is kept visually separate from external policy. No CF
// abbreviation, no generic Selection/Ranking/Effect/Conflict column headers,
// no secrets, no raw row payloads. The pure renderer reads no fs/env/network;
// only the CLI wrapper writes the (untracked) HTML file.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  loadExecutableFunnelClassifier,
  validateExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
  type BundleRecord,
  type FunnelStep,
} from "../../../lib/modeling/executableFunnelClassifier";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requirementSummary(bundle: BundleRecord): string {
  const reqs = bundle.orderedFunnel
    .filter((s) => s.action === "REQUIRE")
    .map((s) => s.plainLanguage);
  return reqs.length > 0 ? reqs.map(esc).join(" ") : "Правил-требований в исполняемом коде не найдено.";
}

function exclusionSummary(bundle: BundleRecord): string {
  const ex = bundle.orderedFunnel
    .filter((s) => s.action === "EXCLUDE")
    .map((s) => s.plainLanguage);
  return ex.length > 0 ? ex.map(esc).join(" ") : "Исключений в исполняемом коде не найдено.";
}

function groupingSummary(bundle: BundleRecord): string {
  const g = bundle.orderedFunnel.filter((s) => s.action === "GROUP").map((s) => s.plainLanguage);
  return g.length > 0 ? g.map(esc).join(" ") : "Группировки в исполняемом коде не найдено.";
}

function orderingSummary(bundle: BundleRecord): string {
  const o = bundle.orderedFunnel
    .filter((s) => s.action === "ORDER" || s.action === "KEEP")
    .map((s) => s.plainLanguage);
  return o.length > 0 ? o.map(esc).join(" ") : "Сравнения кандидатов в исполняемом коде не найдено.";
}

function stepRow(bundleId: string, step: FunnelStep): string {
  const src = step.sourceEvidence.map((e) => `${esc(e.path ?? "")}${e.symbol ? " :: " + esc(e.symbol) : ""} (${esc(e.sourceClass)})`).join("<br>");
  return `<tr>
    <td>${step.step}</td>
    <td><strong>${esc(step.action)}</strong></td>
    <td>${esc(step.plainLanguage)}</td>
    <td>${esc(step.field ?? "—")}</td>
    <td>${esc(step.currentDatasetAvailability)}</td>
    <td>${src || "—"}</td>
  </tr>`;
}

function renderFormulaSection(registry: ExecutableFunnelClassifier): string {
  const model = registry.formulaModels.find((m) => m.formulaModelId === "V2_LITE_GROWTH_SAFE");
  if (!model) return "";
  const inputRows = model.inputs
    .map(
      (i) => `<tr><td>${esc(i.field)}</td><td>${esc(i.role)}</td><td>${i.directWeight === null ? "—" : esc(i.directWeight)}</td><td>${esc(i.source)}</td></tr>`,
    )
    .join("\n");
  const stepRows = model.calculationSteps
    .map(
      (s) =>
        `<tr><td>${esc(s.output)}</td><td><code>${esc(s.expression)}</code></td><td>${s.contributions.map((c) => `${esc(c.input)} × ${esc(c.weight)}`).join("<br>")}</td></tr>`,
    )
    .join("\n");
  const capRows = model.capsAndFloors
    .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.plainLanguage)}</td><td>${esc(c.value)}</td></tr>`)
    .join("\n");
  return `<section id="formula">
  <h2>1. Formula calculation — Расчёт формулы (${esc(model.metricFormulaVersion)})</h2>
  <p>Модель score: <code>${esc(model.producingFunction)}</code> в <code>${esc(model.sourcePath)}</code>. Это ARITHMETIC-формула, отдельная от внешних политик отбора/ставки.</p>
  <h3>Входы формулы (вес каждой компоненты)</h3>
  <table><thead><tr><th>Input</th><th>Role</th><th>Direct weight</th><th>Source</th></tr></thead><tbody>
  ${inputRows}
  </tbody></table>
  <h3>Ordered calculation steps</h3>
  <table><thead><tr><th>Output</th><th>Exact operation</th><th>Contributions</th></tr></thead><tbody>
  ${stepRows}
  </tbody></table>
  <h3>Caps and floors</h3>
  <table><thead><tr><th>Name</th><th>Plain language</th><th>Value</th></tr></thead><tbody>
  ${capRows}
  </tbody></table>
</section>`;
}

function renderBundleSummary(registry: ExecutableFunnelClassifier): string {
  const rows = registry.bundles
    .map((b) => {
      const model = b.formulaModelId ?? "—";
      const histStake = b.historicalStakePolicy ? esc(b.historicalStakePolicy.unit) : "—";
      const normStake = b.normalizedEvaluationStakePolicy ? esc(b.normalizedEvaluationStakePolicy.unit) : "—";
      const keep = b.orderedFunnel.filter((s) => s.action === "KEEP").map((s) => esc(s.plainLanguage)).join(" ") || "—";
      const canRun = b.runStatus === "READY_EXACT" ? "Да, точно" : b.runStatus === "RUNNABLE_APPROX_ONLY" ? "Только приблизительно" : "Нет";
      return `<tr>
      <td><strong>${esc(b.bundleId)}</strong><br><em>${esc(b.plainLanguageName)}</em></td>
      <td>${esc(model)}</td>
      <td>${esc(b.orderedFunnel.find((s) => s.action === "INPUT")?.plainLanguage ?? "—")}</td>
      <td>${requirementSummary(b)}</td>
      <td>${exclusionSummary(b)}</td>
      <td>${groupingSummary(b)}</td>
      <td>${orderingSummary(b)}</td>
      <td>${keep}</td>
      <td>${histStake}</td>
      <td>${normStake}</td>
      <td>${canRun}</td>
      <td>${esc(b.plainLanguageBlocker ?? "Блокеров нет.")}</td>
    </tr>`;
    })
    .join("\n");
  return `<section id="bundles">
  <h2>2. Bundle summary — Сводка по моделям</h2>
  <table><thead><tr>
    <th>Bundle</th>
    <th>Какая модель считала score</th>
    <th>Что входит в воронку</th>
    <th>Requirements — Требования</th>
    <th>Exclusions — Исключения</th>
    <th>Grouping — Группировка</th>
    <th>Как сравниваются кандидаты</th>
    <th>Сколько оставляем</th>
    <th>Historical stake — Историческая ставка</th>
    <th>Current evaluation stake — Ставка для оценки</th>
    <th>Можно ли запустить точно сейчас</th>
    <th>Blocker — Блокер</th>
  </tr></thead><tbody>
  ${rows}
  </tbody></table>
</section>`;
}

function renderDetailedFunnels(registry: ExecutableFunnelClassifier): string {
  const blocks = registry.bundles
    .filter((b) => b.orderedFunnel.length > 0)
    .map((b) => {
      const rows = b.orderedFunnel.map((s) => stepRow(b.bundleId, s)).join("\n");
      return `<h3>${esc(b.bundleId)} — статус: ${esc(b.runStatus)}</h3>
    <table><thead><tr><th>Step</th><th>Action</th><th>Exact human-readable rule</th><th>Required field</th><th>Available on canonical corpus?</th><th>Source</th></tr></thead><tbody>
    ${rows}
    </tbody></table>`;
    })
    .join("\n");
  return `<section id="funnels">
  <h2>3. Detailed funnel per bundle — Подробная воронка</h2>
  ${blocks}
</section>`;
}

function renderProvenance(registry: ExecutableFunnelClassifier): string {
  const rows = registry.bundles
    .map((b) => {
      const current = b.sourceEvidence.filter((e) => e.sourceClass === "CURRENT_EXECUTABLE").map((e) => esc(e.path)).join("<br>") || "—";
      const historical = b.sourceEvidence.filter((e) => e.sourceClass !== "CURRENT_EXECUTABLE").map((e) => `${esc(e.path)} (${esc(e.sourceClass)})`).join("<br>") || "—";
      const decision = b.plainLanguageBlocker ? esc(b.plainLanguageBlocker) : "—";
      return `<tr><td>${esc(b.bundleId)}</td><td>${current}</td><td>${historical}</td><td>${esc(b.sourceAgreement)}</td><td>${decision}</td></tr>`;
    })
    .join("\n");
  const decisions = registry.unresolvedDecisions
    .map((d) => `<li><strong>${esc(d.id)}</strong>: ${esc(d.plainLanguage)} <em>(${d.affects.map(esc).join(", ")})</em></li>`)
    .join("\n");
  const siblingNote = `<p class="warn"><strong>Ограничение по происхождению (sibling-branch):</strong> текущая формула присутствует в HEAD и является CURRENT_EXECUTABLE, но её пошаговая история сборки найдена только на sibling-ветке (коммиты f45b77c / 408b38a / 3c31b42), которые НЕ являются предками HEAD. Они помечены как UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH и никогда не подаются как HEAD-родословная.</p>`;
  return `<section id="provenance">
  <h2>4. Provenance and unresolved decisions — Происхождение и нерешённые вопросы</h2>
  ${siblingNote}
  <table><thead><tr><th>Bundle/item</th><th>Current source</th><th>Historical/sibling source</th><th>Agreement status</th><th>Decision required</th></tr></thead><tbody>
  ${rows}
  </tbody></table>
  <h3>Нерешённые решения основателя</h3>
  <ul>
  ${decisions}
  </ul>
</section>`;
}

/**
 * Pure renderer: registry object -> deterministic HTML string. Validates the
 * schema first (throws on invalid). No fs/env/network access.
 */
export function renderExecutableFunnelClassifierReport(registry: ExecutableFunnelClassifier): string {
  validateExecutableFunnelClassifier(registry);
  const style = `<style>
    body{font-family:system-ui,Arial,sans-serif;max-width:1200px;margin:1rem auto;padding:0 1rem;line-height:1.4;}
    table{border-collapse:collapse;width:100%;margin:0.5rem 0 1.5rem;font-size:0.85rem;}
    th,td{border:1px solid #ccc;padding:0.4rem;vertical-align:top;text-align:left;}
    th{background:#f2f2f2;}
    code{background:#f6f8fa;padding:0 0.2rem;}
    section{margin-bottom:2.5rem;}
    .warn{background:#fff3cd;border:1px solid #ffe08a;padding:0.6rem;border-radius:4px;}
    @media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e6e6e6;}th{background:#2a2a2a;}code{background:#2a2a2a;}.warn{background:#3a331a;border-color:#6a5a2a;}td,th{border-color:#444;}}
  </style>`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Executable Funnel Classifier — Founder Report</title>${style}</head>
<body>
<h1>Executable Funnel Classifier — Founder Report</h1>
<p>Схема v${registry.schemaVersion}. HEAD: <code>${esc(registry.generatedFrom.headCommit)}</code>. Политика происхождения: ${esc(registry.generatedFrom.provenancePolicy)}. Только чтение — ни один алгоритм не изменён, ни один конфликт источников не разрешён.</p>
${renderFormulaSection(registry)}
${renderBundleSummary(registry)}
${renderDetailedFunnels(registry)}
${renderProvenance(registry)}
</body></html>`;
}

// ---- CLI ----

const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "executable_funnel_classifier_founder_report.html");

function main(): void {
  const argv = process.argv.slice(2);
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output") {
      output = argv[i + 1] ?? DEFAULT_OUTPUT;
      i += 1;
    }
  }
  const registry = loadExecutableFunnelClassifier();
  const html = renderExecutableFunnelClassifierReport(registry);
  const dir = path.dirname(output);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(output, html, "utf8");
  process.stdout.write(`Wrote founder report to ${output}\n`);
}

if (require.main === module) {
  main();
}
