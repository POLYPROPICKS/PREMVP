/**
 * RESEARCH_CORPUS_SCORE_LEVEL_CORRECTION_V1 — additive Score LEVEL overlay for
 * ALREADY-ACCEPTED immutable D-1 partitions.
 *
 * The accepted `CORPUS_<date>.jsonl.gz` artifacts were frozen before the D-1
 * reader selected `generated_signal_pairs.pre_event_score_num`. Re-freezing them
 * would break their canonical hashes. Instead this produces a SEPARATE,
 * independently-hashed overlay keyed by canonical corpus identity:
 *
 *   modeling/evidence/research-corpus-factory-live-v1/
 *     SCORE_LEVEL_OVERLAY_<date>.jsonl.gz
 *     SCORE_LEVEL_OVERLAY_MANIFEST_<date>.json
 *     SHA256SUMS_SCORE_LEVEL_OVERLAY_<date>.txt
 *
 * Source: bounded research-clone keyset read of GSP over the window span, ONE
 * pass. `pre_event_score_num` is immutable at INSERT (created_at == DECISION_AT)
 * so this is a decision-time-safe LEVEL, not a series. Rows the producer wrote
 * null (SEP_SHADOW_STRATEGIC_V1) stay null — structural absence, never synthesized.
 *
 *   railway run --service research-clone-daily-sync \
 *     npx tsx scripts/modeling/score-level-overlay.ts --window 7
 */
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { resolveWindowDates, type WindowDays } from "@/lib/modeling/research-corpus/rollingCorpus";

const DIR = "modeling/evidence/research-corpus-factory-live-v1";
const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const MINSK_OFFSET_HOURS = 3;
const PAGE = 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
function minskMidnightUtcMs(d: string): number {
  return Date.parse(`${d}T00:00:00.000Z`) - MINSK_OFFSET_HOURS * 3600_000;
}
function canonical(row: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(row));
}

async function main() {
  const windowDays = Number(arg("--window")) as WindowDays;
  if (![7, 14, 30].includes(windowDays)) throw new Error("BLOCKED: --window must be 7|14|30");
  const nowUtc = arg("--now") ?? new Date().toISOString();
  const { dates } = resolveWindowDates(windowDays, nowUtc);
  const present = dates.filter((d) => existsSync(join(DIR, `CORPUS_${d}.jsonl.gz`)));
  if (present.length === 0) throw new Error("BLOCKED: no immutable partitions on disk for this window");

  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key || new URL(url).hostname.split(".")[0] !== EXPECTED_CLONE_REF) {
    console.error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE_OR_MISMATCH");
    process.exit(3);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── bounded keyset read of GSP.pre_event_score_num, one Minsk D-1 window
  //    per partition (fresh cursor per day — the PROVEN shape from the
  //    RECONCILE diagnosis probe that matched 1732/1732). ─────────────────
  const spanStart = new Date(minskMidnightUtcMs(present[0])).toISOString();
  const spanEnd = new Date(minskMidnightUtcMs(present[present.length - 1]) + 24 * 3600_000).toISOString();
  const COLS = "id, condition_id, selected_token_id, created_at, pre_event_score_num";
  const preByKey = new Map<string, number | null>(); // conditionId::token::createdAt -> score
  let gspRowsScanned = 0;
  for (const d of present) {
    const winStart = new Date(minskMidnightUtcMs(d)).toISOString();
    const winEnd = new Date(minskMidnightUtcMs(d) + 24 * 3600_000).toISOString();
    let afterTs = new Date(Date.parse(winStart) - 1).toISOString();
    let afterId = "";
    for (let guard = 0; guard < 2000; guard++) {
      let chunk: Record<string, unknown>[] = [];
      if (afterId) {
        const tie = await db.from("generated_signal_pairs").select(COLS).eq("created_at", afterTs).gt("id", afterId).order("id", { ascending: true }).limit(PAGE);
        if (tie.error) throw new Error(`GSP_TIE:${tie.error.message}`);
        chunk = (tie.data ?? []) as Record<string, unknown>[];
      }
      if (chunk.length === 0) {
        const adv = await db.from("generated_signal_pairs").select(COLS).gt("created_at", afterTs).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE);
        if (adv.error) throw new Error(`GSP_ADV:${adv.error.message}`);
        chunk = (adv.data ?? []) as Record<string, unknown>[];
      }
      if (chunk.length === 0) break;
      if (String(obj(chunk[0]).created_at) >= winEnd) break;
      let crossed = false;
      for (const raw of chunk) {
        const r = obj(raw);
        if (String(r.created_at) >= winEnd) { crossed = true; break; }
        gspRowsScanned++;
        preByKey.set(`${String(r.condition_id)}::${String(r.selected_token_id)}::${String(r.created_at)}`, num(r.pre_event_score_num));
      }
      if (crossed) break;
      if (chunk.length < PAGE) break;
      const last = obj(chunk[chunk.length - 1]);
      afterTs = String(last.created_at);
      afterId = String(last.id);
    }
  }

  const summary: Record<string, unknown>[] = [];
  for (const d of present) {
    const parentGz = readFileSync(join(DIR, `CORPUS_${d}.jsonl.gz`));
    const parentJsonl = gunzipSync(parentGz).toString("utf8");
    const parentSha = createHash("sha256").update(parentJsonl, "utf8").digest("hex");
    const frozenRows = parentJsonl.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

    const overlayRows = frozenRows
      .map((fr) => {
        const k = `${fr.conditionId}::${fr.selectedTokenId}::${fr.decisionAt}`;
        const has = preByKey.has(k);
        const lvl = has ? preByKey.get(k)! : null;
        return {
          conditionId: fr.conditionId,
          selectedTokenId: fr.selectedTokenId,
          decisionAt: fr.decisionAt,
          populationId: fr.populationId,
          scoreLevel: typeof lvl === "number" ? lvl : null,
          scoreLevelSource: typeof lvl === "number" ? "generated_signal_pairs.pre_event_score_num" : null,
          gspIdentityMatched: has,
        };
      })
      .sort((a, b) =>
        a.conditionId !== b.conditionId
          ? a.conditionId < b.conditionId ? -1 : 1
          : a.selectedTokenId !== b.selectedTokenId
            ? a.selectedTokenId < b.selectedTokenId ? -1 : 1
            : a.decisionAt < b.decisionAt ? -1 : a.decisionAt > b.decisionAt ? 1 : 0,
      );

    const jsonl = overlayRows.map(canonical).join("\n") + (overlayRows.length ? "\n" : "");
    const overlaySha = createHash("sha256").update(jsonl, "utf8").digest("hex");
    const gz = gzipSync(Buffer.from(jsonl, "utf8"), { level: 9 });
    const gzPath = join(DIR, `SCORE_LEVEL_OVERLAY_${d}.jsonl.gz`);
    writeFileSync(gzPath, gz);

    // per-population coverage
    const byPop: Record<string, { rows: number; present: number; min: number | null; max: number | null }> = {};
    for (const r of overlayRows) {
      const p = (byPop[r.populationId] ??= { rows: 0, present: 0, min: null, max: null });
      p.rows++;
      if (typeof r.scoreLevel === "number") {
        p.present++;
        p.min = p.min === null ? r.scoreLevel : Math.min(p.min, r.scoreLevel);
        p.max = p.max === null ? r.scoreLevel : Math.max(p.max, r.scoreLevel);
      }
    }

    const manifest = {
      OVERLAY_SCHEMA_VERSION: "score-level-overlay-v1",
      MISSION: "RESEARCH_CORPUS_SCORE_LEVEL_CORRECTION_V1",
      GENERATED_AT: new Date().toISOString(),
      PARTITION_DATE: d,
      PARENT_PARTITION: `CORPUS_${d}.jsonl.gz`,
      PARENT_PARTITION_CANONICAL_SHA256: parentSha,
      PARENT_ARTIFACT_UNCHANGED: true,
      IDENTITY_KEY: "(condition_id, selected_token_id, decisionAt) — canonical corpus identity",
      SCORE_LEVEL_SOURCE: "generated_signal_pairs.pre_event_score_num",
      WRITE_TIME_SEMANTICS: "immutable at GSP INSERT; created_at == DECISION_AT; no writer mutates it after insert",
      PIT_SAFE_AT_DECISION: true,
      SCORE_SERIES_RELATIONSHIP: "distinct from the GSRS score DerivedSeries; LEVEL is never a series and never synthesized",
      OVERLAY_ROW_N: overlayRows.length,
      POPULATIONS: Object.keys(byPop).sort().map((pop) => ({
        population_id: pop,
        OVERLAY_ROW_N: byPop[pop].rows,
        SCORE_LEVEL_PRESENT_N: byPop[pop].present,
        SCORE_LEVEL_COVERAGE_PCT: byPop[pop].rows ? Math.round((byPop[pop].present / byPop[pop].rows) * 10000) / 100 : 0,
        MIN: byPop[pop].min,
        MAX: byPop[pop].max,
        STRUCTURAL_NULL_NOTE: pop === "SEP_SHADOW_STRATEGIC_V1"
          ? "producer writes pre_event_score_num = null; absence is structural and preserved"
          : null,
      })),
      SOURCE_SPAN: { startUtc: spanStart, endUtc: spanEnd, gsp_rows_scanned: gspRowsScanned },
      OVERLAY_CANONICAL_CONTENT_SHA256: overlaySha,
      OVERLAY_CANONICAL_CONTENT_DEFINITION:
        "sha256(utf8) of newline-joined canonical (sorted-key) JSON of every overlay row in (condition_id, selected_token_id, decisionAt) order",
      PRODUCTION_PRIMARY_READS: 0,
      PRODUCTION_WRITES: 0,
    };
    const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
    writeFileSync(join(DIR, `SCORE_LEVEL_OVERLAY_MANIFEST_${d}.json`), manifestJson);
    writeFileSync(
      join(DIR, `SHA256SUMS_SCORE_LEVEL_OVERLAY_${d}.txt`),
      [
        `${overlaySha}  OVERLAY_CANONICAL_CONTENT`,
        `${createHash("sha256").update(gz).digest("hex")}  SCORE_LEVEL_OVERLAY_${d}.jsonl.gz`,
        `${createHash("sha256").update(manifestJson, "utf8").digest("hex")}  SCORE_LEVEL_OVERLAY_MANIFEST_${d}.json`,
        `${parentSha}  PARENT_CORPUS_${d}_CANONICAL_CONTENT (unchanged)`,
      ].join("\n") + "\n",
    );
    summary.push({
      d,
      OVERLAY_ROW_N: overlayRows.length,
      bytes: statSync(gzPath).size,
      parentShaUnchanged: parentSha,
      populations: manifest.POPULATIONS,
    });
  }

  process.stdout.write(JSON.stringify({ ok: true, window: windowDays, partitions: present, GSP_ROWS_SCANNED: gspRowsScanned, summary }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
