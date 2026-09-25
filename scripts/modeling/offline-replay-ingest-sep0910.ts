/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — one-time EVIDENCE INGEST for Sep09–10.
 *
 * The Sep09–10 research universe lives in the post-GSP-cutover
 * `primary_evidence_outbox` and is NOT part of the committed immutable D-1
 * corpus. This script performs ONE bounded, READ-ONLY production query
 * (EXPECTED_PROJECT_REF = nbnldzfsxffztsfrrxqy) and writes
 * `CORPUS_2026-09-09.jsonl.gz` / `CORPUS_2026-09-10.jsonl.gz` into the plane's
 * evidence directory, in the SAME row shape the D-1 corpus uses.
 *
 * This is an evidence-preparation step, run once — exactly analogous to the
 * existing `label-september-d1-settlements.ts` that produced the Sep04–08
 * settlement sidecars. It is NOT part of the replay path: once the files exist,
 * `npm run modeling:offline-replay` never touches production.
 *
 * Sep09–10 identities are all UNRESOLVED at the AS-OF instant (markets open),
 * so they enter population counts only and never ROI.
 *
 *   npm run modeling:offline-replay:ingest-sep0910
 *
 * Hard boundaries: production READ only, 0 mutations, no clone, no deploy.
 */
import { gzipSync } from "node:zlib";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const AS_OF = "2026-09-10T14:04:29.586892+00:00";
const EXPECTED_REF = "nbnldzfsxffztsfrrxqy";
const OUT_DIR = join("modeling", "evidence", "offline-replay-plane-v1", "research-evidence");

function env(): { url: string; key: string } {
  const raw = readFileSync(".env.local", "utf8");
  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: map.SUPABASE_URL, key: map.SUPABASE_SERVICE_ROLE_KEY };
}

async function main() {
  const { url, key } = env();
  const ref = (url || "").match(/https:\/\/([a-z0-9]+)\.supabase/)?.[1];
  if (ref !== EXPECTED_REF) {
    console.error(`WRONG_DATABASE_BINDING: expected ${EXPECTED_REF}, got ${ref}`);
    process.exit(2);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: batches, error } = await sb
    .from("primary_evidence_outbox")
    .select("observed_at,evidence_rows")
    .gte("observed_at", "2026-09-09T00:00:00Z")
    .lte("observed_at", AS_OF)
    .order("observed_at");
  if (error) throw new Error(error.message);

  const byDay: Record<string, string[]> = { "2026-09-09": [], "2026-09-10": [] };
  for (const b of batches ?? []) {
    const day = String(b.observed_at).slice(0, 10);
    if (!byDay[day]) continue;
    for (const er of (b.evidence_rows as any[]) ?? []) {
      const d = er.diagnostics ?? {};
      const ctx = d.providerEventContext ?? {};
      const start = ctx.eventStartIso ?? d.gameStartIso ?? null;
      const lead = start ? (Date.parse(start) - Date.parse(b.observed_at)) / 3_600_000 : null;
      const row = {
        conditionId: (d.conditionId ?? er.condition_id ?? "").toLowerCase(),
        selectedTokenId: d.selectedTokenId ?? "",
        selectedOutcome: d.selectedOutcome ?? er.selected_outcome ?? null,
        providerEventId: d.providerEventId ?? ctx.eventId ?? null,
        providerSportFamily: (d.providerSportFamily ?? "").toLowerCase() || null,
        providerSportCode: d.providerSportCode ?? null,
        marketFamily: null,
        marketTypeRaw: ctx.marketType ?? ctx.game ?? null,
        eventStart: start,
        decisionAt: b.observed_at,
        materializedAt: AS_OF,
        leadTimeHours: lead,
        entryPrice: typeof d.currentPrice === "number" ? d.currentPrice : null,
        scoreLevel: typeof d.formulaAudit?.finalSignalV2 === "number" ? d.formulaAudit.finalSignalV2 : null,
        scoreLevelSource: "outbox.diagnostics.formulaAudit.finalSignalV2",
        signal_confidence_num: typeof d.formulaAudit?.displaySignalConfidence === "number" ? d.formulaAudit.displaySignalConfidence : null,
        dataCoverage: typeof d.dataCoverage === "number" ? d.dataCoverage : null,
        volumeUsd: typeof d.parentEventVolume24hr === "number" ? d.parentEventVolume24hr : null,
        formulaVersion: d.formulaUsed ?? null,
        label: "OPEN",
        gammaTerminal: null,
        cloneSignalResult: null,
        populationId: "SEP0910_OUTBOX_ASOF_INGEST_V1",
        rawEmissionsCollapsed: 1,
        evidenceOrigin: "PRIMARY_EVIDENCE_OUTBOX",
      };
      byDay[day].push(JSON.stringify(row));
    }
  }

  for (const [day, lines] of Object.entries(byDay)) {
    if (!lines.length) {
      console.log(`  ${day}: 0 rows (no outbox batches ≤ AS_OF) — skipped`);
      continue;
    }
    const path = join(OUT_DIR, `CORPUS_${day}.jsonl.gz`);
    writeFileSync(path, gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
    console.log(`  ${day}: wrote ${lines.length} rows → ${path}`);
  }
  console.log(`\nPROJECT_REF=${ref}  MUTATIONS=0  AS_OF=${AS_OF}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
