/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — ONE RUNNER (CLI).
 *
 *   npm run modeling:offline-replay -- --model all --from 2026-09-01 --to 2026-09-10 \
 *       --as-of 2026-09-10T14:04:29.586Z --group-by sport
 *
 * Flags:
 *   --model=<C0|C1|C2|C3|C4|C5|CONTRACT_A_FILTER_SIM_CURRENT|all>  (repeatable, default all)
 *   --from=YYYY-MM-DD                                              (default 2026-09-01)
 *   --to=YYYY-MM-DD                                                (default 2026-09-10)
 *   --as-of=ISO                                                    (default: <to>T23:59:59.999Z)
 *   --group-by=sport|market_family|none                           (default none)
 *   --evidence-dir=<path>                                          (default: the vendored plane evidence)
 *   --json                                                        emit machine JSON only
 *   --pretty                                                      pretty-print JSON
 *
 * The normal replay path NEVER queries production.
 */
import { runReplay } from "../../lib/modeling/offline-replay/replayRunner";
import { ALL_POLICY_IDS } from "../../lib/modeling/offline-replay/policyRegistry";
import { CONTRACT_A_FILTER_SIM_RULES } from "../../lib/modeling/offline-replay/contractAFilterSim";
import type { GroupedResult, StandardResult } from "../../lib/modeling/offline-replay/types";

const BOOL_FLAGS = new Set(["json", "pretty"]);
const MULTI_FLAGS = new Set(["model"]);

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let val: string | boolean;
    if (eq !== -1) {
      val = arg.slice(eq + 1);
    } else if (BOOL_FLAGS.has(key)) {
      val = true;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      val = argv[++i];
    } else {
      val = true;
    }
    if (MULTI_FLAGS.has(key)) {
      const list = (out[key] as string[]) ?? [];
      if (typeof val === "string") list.push(...val.split(","));
      out[key] = list;
    } else {
      out[key] = val;
    }
  }
  return out;
}

const COLS: (keyof StandardResult)[] = [
  "MODEL",
  "AVAILABLE_PHYSICAL_EVENT_N",
  "FILTER_PASS_EVENT_N",
  "SIMULATED_BET_N",
  "TERMINAL_BET_N",
  "UNRESOLVED_BET_N",
  "WINS",
  "LOSSES",
  "GROSS_PNL_U",
  "GROSS_ROI_PCT",
  "MAX_DD_U",
  "WIN_RATE_PCT",
];

function table(rows: Record<string, unknown>[], cols: string[]): string {
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((v, i) => v.padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join(
    "\n",
  );
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const modelList = Array.isArray(a.model) ? (a.model as string[]) : [];
  const models: string[] | "all" =
    modelList.length === 0 || modelList.includes("all") ? "all" : modelList;
  const from = typeof a.from === "string" ? a.from : "2026-09-01";
  const to = typeof a.to === "string" ? a.to : "2026-09-10";
  const asOf = typeof a["as-of"] === "string" ? (a["as-of"] as string) : `${to}T23:59:59.999Z`;
  const groupBy = (typeof a["group-by"] === "string" ? a["group-by"] : "none") as
    | "sport"
    | "market_family"
    | "none";
  const evidenceDir = typeof a["evidence-dir"] === "string" ? (a["evidence-dir"] as string) : undefined;

  const run = runReplay({ models, from, to, asOf, groupBy, evidenceDir });

  if (a.json) {
    process.stdout.write(JSON.stringify(run, null, a.pretty ? 2 : 0) + "\n");
    return 0;
  }

  console.log(`\n# OFFLINE POLICY REPLAY — ${from} .. ${to}  AS-OF ${asOf}`);
  console.log(`# evidence: ${run.params.evidence_dir}`);
  console.log(
    `# days loaded: ${run.view_meta.days_loaded.join(", ") || "(none)"}` +
      (run.view_meta.days_missing.length ? `  |  missing: ${run.view_meta.days_missing.join(", ")}` : ""),
  );
  console.log(
    `# universe: IDENTITY_N=${run.view_meta.counts.IDENTITY_N}  ` +
      `PHYSICAL_EVENT_N=${run.view_meta.counts.DISTINCT_PHYSICAL_EVENT_N}  ` +
      `TERMINAL_LABELED=${run.view_meta.counts.TERMINAL_LABELED_IDENTITY_N}  ` +
      `UNRESOLVED=${run.view_meta.counts.UNRESOLVED_IDENTITY_N}`,
  );
  console.log(`# economics basis: ${run.economics_basis}`);
  const fc = run.view_meta.field_completeness;
  if (fc) {
    console.log(
      `# field completeness: IDENTITY_N=${fc.IDENTITY_N}  ` +
        `MARKET_TYPE_PRESENT_N=${fc.MARKET_TYPE_PRESENT_N} (${fc.MARKET_TYPE_PRESENT_PCT}%)  ` +
        `EVENT_START_PRESENT_N=${fc.EVENT_START_PRESENT_N} (${fc.EVENT_START_PRESENT_PCT}%)  ` +
        `BOTH_PRESENT_N=${fc.BOTH_PRESENT_N} (${fc.BOTH_PRESENT_PCT}%)  ` +
        `UNKNOWN_BOTH_MISSING_N=${fc.UNKNOWN_BOTH_MISSING_N}  CA_FIELDS_OVERLAY_ENRICHED_N=${fc.CA_FIELDS_OVERLAY_ENRICHED_N}`,
    );
  }
  console.log("");

  console.log("## FOUNDER TABLE 1 — OVERALL");
  console.log(table(run.overall as unknown as Record<string, unknown>[], COLS));

  console.log("\n## FUNNEL + TOP REJECT REASONS (per model)");
  for (const r of run.overall) {
    console.log(
      `  ${r.MODEL}: AVAILABLE_IDENTITY_N=${r.AVAILABLE_IDENTITY_N} → FILTER_PASS_IDENTITY_N=${r.FILTER_PASS_IDENTITY_N} → ` +
        `SIMULATED_BET_N=${r.SIMULATED_BET_N} (TERMINAL ${r.TERMINAL_BET_N} / UNRESOLVED ${r.UNRESOLVED_BET_N})`,
    );
    const reasons = Object.entries(r.REJECT_REASONS);
    if (reasons.length) console.log(`      reject: ${reasons.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }

  if (groupBy !== "none") {
    console.log(`\n## FOUNDER TABLE 2 — BY ${groupBy.toUpperCase()}`);
    const flat: Record<string, unknown>[] = [];
    for (const [model, rows] of Object.entries(run.grouped)) {
      for (const r of rows as GroupedResult[]) {
        if (r.AVAILABLE_IDENTITY_N === 0) continue;
        flat.push({ ...r, MODEL: model, [groupBy.toUpperCase()]: r.GROUP_KEY });
      }
    }
    console.log(
      table(flat, [
        "MODEL",
        groupBy.toUpperCase(),
        "AVAILABLE_PHYSICAL_EVENT_N",
        "FILTER_PASS_EVENT_N",
        "SIMULATED_BET_N",
        "TERMINAL_BET_N",
        "UNRESOLVED_BET_N",
        "WINS",
        "LOSSES",
        "GROSS_PNL_U",
        "GROSS_ROI_PCT",
        "MAX_DD_U",
        "WIN_RATE_PCT",
      ]),
    );
  }

  console.log("\n## CONTRACT A FILTER TRANSPARENCY (what the offline sim applied)");
  console.log(
    table(
      CONTRACT_A_FILTER_SIM_RULES as unknown as Record<string, unknown>[],
      ["FILTER", "CURRENT_CANONICAL_RULE", "SOURCE_OWNER"],
    ),
  );

  console.log(
    `\n# determinism_hash: ${run.determinism_hash}\n# wall_clock_ms: ${run.wall_clock_ms}\n# known policies: ${ALL_POLICY_IDS.join(", ")}`,
  );
  return 0;
}

process.exitCode = main();
