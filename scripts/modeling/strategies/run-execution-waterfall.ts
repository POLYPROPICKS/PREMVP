#!/usr/bin/env -S node --import tsx
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildExecutionWaterfall, compactExecutionWaterfall } from "../../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

export function runExecutionWaterfall(input: string, output: string): void {
  const rows = JSON.parse(readFileSync(input, "utf8")) as ExportRow[];
  const result = compactExecutionWaterfall(buildExecutionWaterfall(rows, loadExecutableFunnelClassifier()));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
if (require.main === module) {
  const input = process.argv[2], output = process.argv[3];
  if (!input || !output) throw new Error("usage: run-execution-waterfall <input.json> <output.json>");
  runExecutionWaterfall(input, output);
}
