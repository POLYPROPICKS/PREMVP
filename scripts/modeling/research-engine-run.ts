/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — CLI / programmatic entrypoint.
 *
 * Runs one frozen model or all four (C0/C1/C4/C5) against a compatible
 * normalized input and emits machine-readable JSON. No LLM dependency.
 *
 * Usage:
 *   tsx scripts/modeling/research-engine-run.ts --input=<path.json> [--model=C0|C1|C4|C5|all]
 *   tsx scripts/modeling/research-engine-run.ts --demo   [--model=...]
 *   tsx scripts/modeling/research-engine-run.ts --golden
 *
 * --input   Path to a JSON file: an array of ResearchEngineInputEvent.
 * --model   Model id or "all" (default "all").
 * --golden  Also include the accepted golden reference contract.
 * --demo    Use the committed synthetic conformance matrix as input.
 * --pretty  Pretty-print the JSON.
 */
import { readFileSync } from "node:fs";
import {
  runResearchEngine,
  GOLDEN_REFERENCE_CONTRACT_V1,
  CONFORMANCE_MATRIX,
  NEXT_SEMANTIC_TRANSITION,
  type FrozenModelId,
  type ResearchEngineInputEvent,
} from "../../lib/modeling/research-engine";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function loadInput(args: Record<string, string | boolean>): ResearchEngineInputEvent[] {
  if (args.demo) {
    return CONFORMANCE_MATRIX.map((e) => ({
      physicalEventKey: e.physicalEventKey,
      decisionTimestamp: e.decisionTimestamp,
      eventStart: e.eventStart,
      entryPrice: e.entryPrice,
      sportFamily: e.sportFamily,
      outcome: e.outcome,
      ...(e.ref === undefined ? {} : { ref: e.ref }),
    }));
  }
  const inputPath = args.input;
  if (typeof inputPath !== "string") {
    throw new Error("research-engine-run: provide --input=<path.json> or --demo");
  }
  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("research-engine-run: --input file must contain a JSON array");
  }
  return parsed as ResearchEngineInputEvent[];
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const model = (typeof args.model === "string" ? args.model : "all") as
    | FrozenModelId
    | "all";

  const input = loadInput(args);
  const engineResult = runResearchEngine(input, model);

  const payload = {
    mission: "MODEL_RESEARCH_ENGINE_FREEZE_V1",
    engineVersion: engineResult.engineVersion,
    nextSemanticTransition: NEXT_SEMANTIC_TRANSITION,
    llmDependencyAtRuntime: false,
    input: { rows: input.length, source: args.demo ? "conformance-matrix" : args.input },
    models: engineResult.models,
    ...(args.golden ? { goldenReferenceContract: GOLDEN_REFERENCE_CONTRACT_V1 } : {}),
  };

  process.stdout.write(
    JSON.stringify(payload, null, args.pretty ? 2 : 0) + "\n",
  );
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /research-engine-run(\.ts|\.js|\.mjs)?$/.test(process.argv[1]);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(
      `research-engine-run error: ${(err as Error).message}\n`,
    );
    process.exitCode = 1;
  }
}
