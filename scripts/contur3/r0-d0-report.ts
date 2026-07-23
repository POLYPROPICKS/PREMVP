import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { R0PlanningTrace, R0TraceValidation } from "../../lib/executor/r0PlanningTrace";

export interface R0VerificationGate {
  run_id: string;
  git_sha: string;
  tests: "PASS" | "FAIL" | "UNKNOWN";
  typecheck: "PASS" | "FAIL" | "UNKNOWN";
  build: "PASS" | "FAIL" | "UNKNOWN";
  gate_decision: string;
}

export interface R0D0Aggregate {
  aggregate_sha256: string;
  status: "GREEN" | "RED";
  run_id: string;
  as_of_iso: string;
  generated_at_iso: string;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  current_phase: "R0A";
  first_failing_stage: string | null;
  first_failing_predicate: string | null;
  money_at_risk_usd: number;
  founder_action_required: "YES" | "NO";
  next_allowed_action: string;
  funnel: R0PlanningTrace["stages"];
  final_contract_a_rejections: Record<string, number>;
  validation_failures: string[];
  verification_gate: R0VerificationGate;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildR0D0Aggregate(input: {
  trace: R0PlanningTrace;
  validation: R0TraceValidation;
  verificationGate: R0VerificationGate;
  generatedAtIso: string;
  freshness: R0D0Aggregate["freshness"];
  finalContractARejections: Record<string, number>;
  moneyAtRiskUsd: number;
  nextAllowedAction: string;
}): R0D0Aggregate {
  const firstMissing = input.trace.stages.find(
    (stage) => stage.status !== "MEASURED" || stage.output_count === null
  );
  const firstZero = input.trace.stages.find(
    (stage) => stage.input_count !== null && stage.input_count > 0 && stage.output_count === 0
  );
  const firstFailing = firstMissing ?? firstZero ?? null;
  const rejection = firstFailing
    ? Object.entries(firstFailing.rejection_counts).find(([, count]) => count > 0)?.[0] ?? firstFailing.status
    : null;
  const status: R0D0Aggregate["status"] =
    input.freshness === "FRESH" &&
    input.validation.valid &&
    input.verificationGate.gate_decision === "PASS"
      ? "GREEN"
      : "RED";
  const withoutHash = {
    status,
    run_id: input.trace.run_id,
    as_of_iso: input.trace.as_of_iso,
    generated_at_iso: input.generatedAtIso,
    freshness: input.freshness,
    current_phase: "R0A" as const,
    first_failing_stage: firstFailing?.stage_name ?? null,
    first_failing_predicate: rejection,
    money_at_risk_usd: input.moneyAtRiskUsd,
    founder_action_required: status === "GREEN" ? ("NO" as const) : ("YES" as const),
    next_allowed_action: input.nextAllowedAction,
    funnel: input.trace.stages,
    final_contract_a_rejections: input.finalContractARejections,
    validation_failures: input.validation.failures,
    verification_gate: input.verificationGate,
  };
  return { aggregate_sha256: sha256(withoutHash), ...withoutHash };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderR0D0Markdown(aggregate: R0D0Aggregate): string {
  const rows = aggregate.funnel
    .map(
      (stage) =>
        `| ${stage.stage_index} | ${stage.stage_name} | ${stage.input_entity_type} | ${stage.output_entity_type} | ${stage.transformation_kind} | ${stage.input_count ?? "MISSING"} | ${stage.output_count ?? "MISSING"} | ${stage.status} | ${json(stage.rejection_counts)} |`
    )
    .join("\n");
  return `# Contur3 D0 V0

- status: ${aggregate.status}
- run_id: ${aggregate.run_id}
- as_of_iso: ${aggregate.as_of_iso}
- generated_at_iso: ${aggregate.generated_at_iso}
- freshness: ${aggregate.freshness}
- current_phase: ${aggregate.current_phase}
- first_failing_stage: ${aggregate.first_failing_stage ?? "NONE"}
- first_failing_predicate: ${aggregate.first_failing_predicate ?? "NONE"}
- money_at_risk_usd: ${aggregate.money_at_risk_usd}
- founder_action_required: ${aggregate.founder_action_required}
- aggregate_sha256: ${aggregate.aggregate_sha256}
- next_allowed_action: ${aggregate.next_allowed_action}

## Source to reservation funnel

| # | stage | input entity | output entity | transformation | input | output | status | rejections |
|---:|---|---|---|---|---:|---:|---|---|
${rows}

## Final Contract A rejections

\`${json(aggregate.final_contract_a_rejections)}\`

## Validation

\`${json(aggregate.validation_failures)}\`

## VerificationGate

\`${json(aggregate.verification_gate)}\`
`;
}

export function renderR0D0Html(aggregate: R0D0Aggregate): string {
  const rows = aggregate.funnel
    .map(
      (stage) =>
        `<tr><td>${stage.stage_index}</td><td>${escapeHtml(stage.stage_name)}</td><td>${escapeHtml(stage.input_entity_type)}</td><td>${escapeHtml(stage.output_entity_type)}</td><td>${escapeHtml(stage.transformation_kind)}</td><td>${stage.input_count ?? "MISSING"}</td><td>${stage.output_count ?? "MISSING"}</td><td>${stage.status}</td><td><code>${escapeHtml(json(stage.rejection_counts))}</code></td></tr>`
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Contur3 D0 V0</title>
<style>body{font:14px system-ui;margin:24px;color:#172033}h1{margin-bottom:8px}.status{font-size:20px;font-weight:700;color:${aggregate.status === "GREEN" ? "#087a45" : "#b42318"}}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border:1px solid #d0d5dd;padding:7px;text-align:left}th{background:#f2f4f7}code{white-space:pre-wrap}</style></head>
<body><h1>Contur3 D0 V0</h1><div class="status">${aggregate.status}</div>
<dl>
<dt>run_id</dt><dd>${escapeHtml(aggregate.run_id)}</dd>
<dt>as_of_iso</dt><dd>${escapeHtml(aggregate.as_of_iso)}</dd>
<dt>freshness</dt><dd>${aggregate.freshness}</dd>
<dt>first_failing_stage</dt><dd>${escapeHtml(aggregate.first_failing_stage ?? "NONE")}</dd>
<dt>first_failing_predicate</dt><dd>${escapeHtml(aggregate.first_failing_predicate ?? "NONE")}</dd>
<dt>money_at_risk_usd</dt><dd>${aggregate.money_at_risk_usd}</dd>
<dt>founder_action_required</dt><dd>${aggregate.founder_action_required}</dd>
<dt>aggregate_sha256</dt><dd>${aggregate.aggregate_sha256}</dd>
<dt>next_allowed_action:</dt><dd>${escapeHtml(aggregate.next_allowed_action)}</dd>
</dl>
<table><thead><tr><th>#</th><th>stage</th><th>input entity</th><th>output entity</th><th>transformation</th><th>input</th><th>output</th><th>status</th><th>rejections</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Final Contract A rejections</h2><code>${escapeHtml(json(aggregate.final_contract_a_rejections))}</code>
<h2>Validation</h2><code>${escapeHtml(json(aggregate.validation_failures))}</code>
<h2>VerificationGate</h2><code>${escapeHtml(json(aggregate.verification_gate))}</code>
</body></html>`;
}

export function writeR0D0Report(
  aggregate: R0D0Aggregate,
  outputDir: string
): {
  markdown_path: string;
  markdown_sha256: string;
  html_path: string;
  html_sha256: string;
  json_path: string;
  json_sha256: string;
} {
  const safeRunId = aggregate.run_id.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const markdown = renderR0D0Markdown(aggregate);
  const html = renderR0D0Html(aggregate);
  const jsonText = `${JSON.stringify(aggregate, null, 2)}\n`;
  mkdirSync(outputDir, { recursive: true });
  const markdownPath = path.resolve(outputDir, `r0_d0_${safeRunId}.md`);
  const htmlPath = path.resolve(outputDir, `r0_d0_${safeRunId}.html`);
  const jsonPath = path.resolve(outputDir, `r0_d0_${safeRunId}.json`);
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(jsonPath, jsonText, "utf8");
  return {
    markdown_path: markdownPath,
    markdown_sha256: sha256Text(markdown),
    html_path: htmlPath,
    html_sha256: sha256Text(html),
    json_path: jsonPath,
    json_sha256: sha256Text(jsonText),
  };
}
