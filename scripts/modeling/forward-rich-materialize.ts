/**
 * FORWARD_RICH_CAPTURE_V1 — deterministic daily research materializer entrypoint.
 *
 *   npm run modeling:forward-rich -- --since 2026-09-01T00:00:00Z [--write] [--limit 5000]
 *
 * Reads only immutable sources:
 *   - public.generated_signal_pairs               (DECISION_AT, entry price, volumeUsd, classification)
 *   - public.generated_signal_research_snapshots   (append-only score / price observations)
 *
 * Append/cutoff based: only decisions strictly after `--since` are materialized.
 * Never rewrites accepted historical research rows. Without `--write` it prints a
 * deterministic JSON summary and writes nothing.
 *
 * `--write` upserts into `research_forward_rich_rows` IF that table already
 * exists (no migration is created by this mission); otherwise it reports
 * TABLE_ABSENT and still emits the JSON artifact under
 * reports/modeling/forward_rich/.
 */
import { loadEnvConfig } from "@next/env";
import path from "path";
import { mkdir, writeFile } from "fs/promises";

import {
  materializeForwardRichResearch,
  type ForwardRichSignalPair,
  type ForwardRichSnapshotObservation,
} from "../../lib/modeling/forward-rich";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

type Row = Record<string, unknown>;
function obj(v: unknown): Row {
  return v && typeof v === "object" ? (v as Row) : {};
}

async function fetchSignalPairs(sinceCutoff: string): Promise<ForwardRichSignalPair[]> {
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const pageSize = 1000;
  const out: ForwardRichSignalPair[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select(
        "condition_id, selected_token_id, created_at, entry_price_num, diagnostics, formula_version",
      )
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .gt("created_at", sinceCutoff)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`generated_signal_pairs read failed: ${error.message}`);
    const chunk = data ?? [];
    for (const raw of chunk as Row[]) {
      const r = obj(raw);
      const d = obj(r.diagnostics);
      out.push({
        conditionId: String(r.condition_id),
        selectedTokenId: String(r.selected_token_id),
        decisionAt: String(r.created_at),
        sourceCreatedAt: String(r.created_at),
        entryPriceNum: num(r.entry_price_num),
        volumeUsd: num(d.volumeUsd),
        eventStartIso: str(d.gameStartIso),
        providerEventId: str(d.providerEventId),
        marketTypeRaw: str(d.marketType),
        marketFamily: str(d.marketFamily),
        providerSportCode: str(d.providerSportCode),
        providerSportFamily: str(d.providerSportFamily),
        formulaVersion: str(r.formula_version),
      });
    }
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function fetchObservations(sinceCutoff: string): Promise<ForwardRichSnapshotObservation[]> {
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const pageSize = 1000;
  const out: ForwardRichSnapshotObservation[] = [];
  let offset = 0;
  // Observations may pre-date the decision cutoff (pre-decision series), so widen
  // the read window generously; the pure core applies the exact point-in-time cut.
  const readFloor = new Date(new Date(sinceCutoff).getTime() - 30 * 24 * 3600 * 1000).toISOString();
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_research_snapshots")
      .select(
        "condition_id, selected_token_id, snapshot_at, created_at, snapshot_run_id, selected_price_num, opposing_price_num, event_id, game_start_iso, data_coverage_num, diagnostics",
      )
      .gte("snapshot_at", readFloor)
      .order("snapshot_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`generated_signal_research_snapshots read failed: ${error.message}`);
    const chunk = data ?? [];
    for (const raw of chunk as Row[]) {
      const r = obj(raw);
      const d = obj(r.diagnostics);
      const so = obj(d.scoreObservation);
      const fireModel = obj(d.fireModel);
      const modelCandidate = obj(fireModel.modelCandidate);
      out.push({
        conditionId: String(r.condition_id),
        selectedTokenId: String(r.selected_token_id),
        snapshotAt: String(r.snapshot_at),
        sourceCreatedAt: str(r.created_at) ?? String(r.snapshot_at),
        snapshotRunId: str(r.snapshot_run_id),
        scoreValue:
          num(so.scoreValue) ??
          num(d.formulaScore) ??
          num(modelCandidate.score),
        scoreMetricFormulaVersion:
          str(so.metricFormulaVersion) ?? str(fireModel.formulaVersion),
        selectedPriceNum: num(r.selected_price_num),
        opposingPriceNum: num(r.opposing_price_num),
        providerEventId: str(r.event_id),
        gameStartIso: str(r.game_start_iso),
        dataCoverageNum: num(r.data_coverage_num),
      });
    }
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function main() {
  loadEnvConfig(process.cwd());
  const sinceCutoff = arg("since");
  if (!sinceCutoff || Number.isNaN(Date.parse(sinceCutoff))) {
    throw new Error("BLOCKED_MISSING_SINCE: pass --since <ISO 8601 UTC>");
  }
  const materializedAt = new Date().toISOString();
  const limit = num(arg("limit"));
  const write = process.argv.includes("--write");

  const [signalPairs, observations] = await Promise.all([
    fetchSignalPairs(sinceCutoff),
    fetchObservations(sinceCutoff),
  ]);

  let rows = materializeForwardRichResearch({
    signalPairs,
    observations,
    sinceCutoff,
    materializedAt,
  });
  if (limit != null) rows = rows.slice(0, limit);

  const outDir = path.resolve(process.cwd(), "reports", "modeling", "forward_rich");
  await mkdir(outDir, { recursive: true });
  const stamp = materializedAt.replace(/[:.]/g, "-");
  const artifactPath = path.join(outDir, `forward-rich-${stamp}.json`);
  await writeFile(artifactPath, JSON.stringify({ sinceCutoff, materializedAt, count: rows.length, rows }, null, 2));

  let writeStatus: string = "DRY_RUN";
  if (write) {
    const { supabaseAdmin } = await import("../../lib/supabase/server");
    const probe = await supabaseAdmin
      .from("research_forward_rich_rows")
      .select("condition_id")
      .limit(1);
    if (probe.error) {
      writeStatus = `TABLE_ABSENT: ${probe.error.message} (no migration created by FORWARD_RICH_CAPTURE_V1; artifact still written)`;
    } else {
      const payload = rows.map((r) => ({
        condition_id: r.conditionId,
        selected_token_id: r.selectedTokenId,
        decision_at: r.decisionAt,
        materialized_at: r.materializedAt,
        row: r,
      }));
      const { error } = await supabaseAdmin
        .from("research_forward_rich_rows")
        .upsert(payload, { onConflict: "condition_id,selected_token_id,decision_at" });
      writeStatus = error ? `WRITE_FAILED: ${error.message}` : `UPSERTED ${payload.length}`;
    }
  }

  console.log(
    JSON.stringify(
      {
        command: "FORWARD_RICH_CAPTURE_V1__MATERIALIZE",
        sinceCutoff,
        materializedAt,
        signalPairsRead: signalPairs.length,
        observationsRead: observations.length,
        rowsMaterialized: rows.length,
        artifactPath,
        writeStatus,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
