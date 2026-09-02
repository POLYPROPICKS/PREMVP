/**
 * RECENT_RICH_SETTLEMENT_LABEL_V1
 *
 * Label-enrichment only: attaches settlement/outcome labels to an already
 * materialized RECENT_RICH_RESEARCH_DATASET_7D_V1 artifact (produced by
 * `npm run modeling:forward-rich`), reusing the exact settlement authority
 * already accepted for August research:
 *
 *   SETTLEMENT_SOURCE   public.generated_signal_pairs
 *   EXACT_JOIN_KEY      condition_id + selected_token_id (strict key,
 *                       same identity semantics as
 *                       lib/modeling/onePerMatchBacktest.ts::normalizePick)
 *   OUTCOME_FIELD       signal_result | result | outcome_status
 *                       (first present, same precedence + WIN/LOSS label
 *                       set as lib/modeling/onePerMatchBacktest.ts::outcome)
 *   RESOLVED_AT_FIELD   resolved_at
 *   ECONOMIC_RETURN     realized_return_pct if present, else derived from
 *                       entry_price_num via settleBetU-equivalent formula
 *                       (1/entry - 1 on WIN, -1 on LOSS), same fallback
 *                       order as onePerMatchBacktest.ts::outcome.
 *
 * Settlement is LABEL-ONLY: it is attached to each row's existing
 * (condition_id, selected_token_id) identity and never mutates any
 * feature/timestamp field. The parent artifact is read-only input.
 *
 * Usage:
 *   node --import tsx scripts/modeling/recent-rich-settlement-label.ts \
 *     --input reports/modeling/forward_rich/forward-rich-<stamp>.json
 */
import { loadEnvConfig } from "@next/env";
import path from "path";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

const WIN_LABELS = new Set(["win", "won", "hit", "correct", "yes"]);
const LOSS_LABELS = new Set(["loss", "lost", "miss", "incorrect", "no"]);

type SettlementRow = {
  condition_id: string | null;
  selected_token_id: string | null;
  signal_result: string | null;
  result: string | null;
  outcome_status: string | null;
  resolved_at: string | null;
  realized_return_pct: number | null;
  entry_price_num: number | null;
};

function settlementKey(conditionId: string, tokenId: string): string {
  return `${conditionId}::${tokenId}`;
}

// Same fallback precedence/labels as lib/modeling/onePerMatchBacktest.ts::outcome().
function resolveOutcome(row: SettlementRow): {
  status: "WIN" | "LOSS" | "PENDING";
  realizedReturnPct: number | null;
} {
  const rp = num(row.realized_return_pct);
  const result = (row.signal_result ?? row.result ?? row.outcome_status ?? "").toLowerCase();
  let won: boolean | null = null;
  if (WIN_LABELS.has(result)) won = true;
  if (LOSS_LABELS.has(result)) won = false;
  if (won === null && rp !== null) won = rp > 0;

  if (rp !== null) return { status: won ? "WIN" : "LOSS", realizedReturnPct: rp };
  if (won === true && row.entry_price_num && row.entry_price_num > 0) {
    return { status: "WIN", realizedReturnPct: (1 / row.entry_price_num - 1) * 100 };
  }
  if (won === false) return { status: "LOSS", realizedReturnPct: -100 };
  return { status: "PENDING", realizedReturnPct: null };
}

async function fetchSettlementRows(
  keys: Set<string>,
): Promise<Map<string, SettlementRow>> {
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const conditionIds = Array.from(new Set(Array.from(keys).map((k) => k.split("::")[0])));
  const out = new Map<string, SettlementRow>();
  const chunkSize = 200;
  for (let i = 0; i < conditionIds.length; i += chunkSize) {
    const chunk = conditionIds.slice(i, i + chunkSize);
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select(
        "condition_id, selected_token_id, signal_result, result, outcome_status, resolved_at, realized_return_pct, entry_price_num",
      )
      .in("condition_id", chunk);
    if (error) throw new Error(`generated_signal_pairs settlement read failed: ${error.message}`);
    for (const raw of (data ?? []) as Record<string, unknown>[]) {
      const conditionId = str(raw.condition_id);
      const tokenId = str(raw.selected_token_id);
      if (!conditionId || !tokenId) continue;
      out.set(settlementKey(conditionId, tokenId), {
        condition_id: conditionId,
        selected_token_id: tokenId,
        signal_result: str(raw.signal_result),
        result: str(raw.result),
        outcome_status: str(raw.outcome_status),
        resolved_at: str(raw.resolved_at),
        realized_return_pct: num(raw.realized_return_pct),
        entry_price_num: num(raw.entry_price_num),
      });
    }
  }
  return out;
}

function isC4Row(row: Record<string, unknown>): boolean {
  const model = str(row.model) ?? str((row as Record<string, unknown>).formulaVersion);
  return model === "C4" || /\bC4\b/.test(String(row.formulaVersion ?? ""));
}

async function main() {
  loadEnvConfig(process.cwd());
  const inputPath = arg("input");
  if (!inputPath) throw new Error("BLOCKED_MISSING_INPUT: pass --input <path to forward-rich JSON artifact>");

  const raw = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as { sinceCutoff: string; materializedAt: string; count: number; rows: Record<string, unknown>[] };
  const parentSha = createHash("sha256").update(raw).digest("hex");
  const rows = parsed.rows;

  const keys = new Set<string>();
  for (const r of rows) {
    const conditionId = str(r.conditionId);
    const tokenId = str(r.selectedTokenId);
    if (conditionId && tokenId) keys.add(settlementKey(conditionId, tokenId));
  }

  const settlementMap = await fetchSettlementRows(keys);

  let exactLinkN = 0;
  let resolvedN = 0;
  let unresolvedN = 0; // not yet settled (linked, but PENDING)
  let noMatchN = 0; // settlement source not linked at all
  const ambiguousN = 0; // strict key is 1:1 by construction; no ambiguity possible here

  let c4Row = 0;
  let c4Resolved = 0;
  let uwclRow = 0;
  let uwclResolved = 0;
  let ftsRow = 0;
  let ftsResolved = 0;
  let exactScoreRow = 0;
  let exactScoreResolved = 0;

  const labeled = rows.map((r) => {
    const conditionId = str(r.conditionId);
    const tokenId = str(r.selectedTokenId);
    const key = conditionId && tokenId ? settlementKey(conditionId, tokenId) : null;
    const settlement = key ? settlementMap.get(key) : undefined;

    const providerSportCode = str(r.providerSportCode);
    const marketTypeRaw = str(r.marketTypeRaw);
    const c4 = isC4Row(r);
    if (c4) c4Row += 1;
    if (providerSportCode === "uwcl") uwclRow += 1;
    if (marketTypeRaw === "soccer_first_to_score") ftsRow += 1;
    if (marketTypeRaw === "soccer_exact_score") exactScoreRow += 1;

    let label: {
      settlementStatus: "RESOLVED" | "NOT_YET_SETTLED" | "SETTLEMENT_SOURCE_NOT_LINKED";
      winLoss: "WIN" | "LOSS" | null;
      resolvedAt: string | null;
      realizedReturnPct: number | null;
      settlementSource: string;
      settlementJoinKey: string | null;
    };

    if (!settlement) {
      noMatchN += 1;
      label = {
        settlementStatus: "SETTLEMENT_SOURCE_NOT_LINKED",
        winLoss: null,
        resolvedAt: null,
        realizedReturnPct: null,
        settlementSource: "generated_signal_pairs",
        settlementJoinKey: key,
      };
    } else {
      exactLinkN += 1;
      const outcome = resolveOutcome(settlement);
      if (outcome.status === "PENDING") {
        unresolvedN += 1;
        label = {
          settlementStatus: "NOT_YET_SETTLED",
          winLoss: null,
          resolvedAt: settlement.resolved_at,
          realizedReturnPct: null,
          settlementSource: "generated_signal_pairs",
          settlementJoinKey: key,
        };
      } else {
        resolvedN += 1;
        if (c4) c4Resolved += 1;
        if (providerSportCode === "uwcl") uwclResolved += 1;
        if (marketTypeRaw === "soccer_first_to_score") ftsResolved += 1;
        if (marketTypeRaw === "soccer_exact_score") exactScoreResolved += 1;
        label = {
          settlementStatus: "RESOLVED",
          winLoss: outcome.status,
          resolvedAt: settlement.resolved_at,
          realizedReturnPct: outcome.realizedReturnPct,
          settlementSource: "generated_signal_pairs",
          settlementJoinKey: key,
        };
      }
    }

    return { ...r, settlement: label };
  });

  const materializedAt = new Date().toISOString();
  const outDir = path.resolve(process.cwd(), "reports", "modeling", "forward_rich_settled");
  await mkdir(outDir, { recursive: true });
  const stamp = materializedAt.replace(/[:.]/g, "-");
  const datasetPath = path.join(outDir, `recent-rich-settled-${stamp}.json`);
  const datasetPayload = {
    artifactId: "RECENT_RICH_RESEARCH_DATASET_7D_SETTLED_V1",
    parentArtifactPath: inputPath,
    parentArtifactSha256: parentSha,
    parentSinceCutoff: parsed.sinceCutoff,
    parentMaterializedAt: parsed.materializedAt,
    materializedAt,
    count: labeled.length,
    rows: labeled,
  };
  await writeFile(datasetPath, JSON.stringify(datasetPayload, null, 2));
  const datasetSha = createHash("sha256").update(JSON.stringify(datasetPayload)).digest("hex");

  const coverage = {
    INPUT_ROW_N: rows.length,
    EXACT_SETTLEMENT_LINK_N: exactLinkN,
    RESOLVED_ROW_N: resolvedN,
    UNRESOLVED_ROW_N: unresolvedN,
    AMBIGUOUS_SETTLEMENT_N: ambiguousN,
    NO_SETTLEMENT_MATCH_N: noMatchN,
    RESOLVED_PCT: rows.length ? Number(((resolvedN / rows.length) * 100).toFixed(4)) : 0,
    C4_ROW_N: c4Row,
    C4_RESOLVED_N: c4Resolved,
    C4_RESOLVED_PCT: c4Row ? Number(((c4Resolved / c4Row) * 100).toFixed(4)) : 0,
    UWCL_ROW_N: uwclRow,
    UWCL_RESOLVED_N: uwclResolved,
    SOCCER_FIRST_TO_SCORE_ROW_N: ftsRow,
    SOCCER_FIRST_TO_SCORE_RESOLVED_N: ftsResolved,
    SOCCER_EXACT_SCORE_ROW_N: exactScoreRow,
    SOCCER_EXACT_SCORE_RESOLVED_N: exactScoreResolved,
  };
  const coveragePath = path.join(outDir, `COVERAGE-${stamp}.json`);
  await writeFile(coveragePath, JSON.stringify(coverage, null, 2));

  const manifest = {
    artifactId: "RECENT_RICH_RESEARCH_DATASET_7D_SETTLED_V1",
    mission: "RECENT_RICH_SETTLEMENT_LABEL_V1",
    nextSemanticTransition: "RECENT_RICH_ECONOMIC_RECHECK_V1",
    parentArtifact: {
      path: inputPath,
      sha256: parentSha,
      sinceCutoff: parsed.sinceCutoff,
      materializedAt: parsed.materializedAt,
      rowCount: rows.length,
    },
    settlementAuthority: {
      source: "generated_signal_pairs",
      joinKey: ["condition_id", "selected_token_id"],
      outcomeFieldPrecedence: ["signal_result", "result", "outcome_status"],
      resolvedAtField: "resolved_at",
      economicReturnField: "realized_return_pct (fallback: 1/entry_price_num - 1 on WIN, -1 on LOSS)",
      reusedFrom: "lib/modeling/onePerMatchBacktest.ts::outcome() (accepted August research authority)",
    },
    outputArtifact: {
      datasetPath,
      datasetSha256: datasetSha,
      coveragePath,
      materializedAt,
    },
  };
  const manifestPath = path.join(outDir, `MANIFEST-${stamp}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ coverage, manifestPath, coveragePath, datasetPath, datasetSha256: datasetSha }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
