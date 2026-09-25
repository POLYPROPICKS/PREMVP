/**
 * COMPLETE_SEP01_08_CONTRACT_A_REPLAY_FIELDS_AND_RERUN_V1 — one-time field materializer.
 *
 * The compact Sep01–08 D-1 corpus stores two disjoint populations
 * (SEP_PUBLIC_RICH_V1 with event_start but no market_type; SEP_SHADOW_STRATEGIC_V1
 * with market_type but no event_start). Neither carries BOTH per identity, so
 * CONTRACT_A_FILTER_SIM_CURRENT cannot evaluate its market-anchor + timing gates
 * on Sep01–08 from local artifacts alone.
 *
 * Authority order (mission): (1) local immutable artifacts — insufficient, proven
 * disjoint; (2) local vendored evidence — same; (3) ONE bounded READ-ONLY
 * historical production ingest.
 *
 * This script performs (3): a narrow JSON-path projection of
 * `generated_signal_pairs` for 2026-09-01..08 from canonical production
 * (nbnldzfsxffztsfrrxqy), and writes one
 * `CONTRACT_A_FIELDS_OVERLAY_<day>.jsonl.gz` per day into the plane's evidence
 * dir, keyed by `lower(condition_id)|selected_token_id`, EARLIEST row per
 * identity (decision-time / PIT). Only the Contract-A-required analytical fields
 * are materialized — nothing is synthesized; identities the source cannot supply
 * are simply absent from the overlay and stay UNKNOWN downstream.
 *
 * Not part of the replay path. Run once:
 *   npm run modeling:offline-replay:ingest-contract-a-fields
 *
 * Hard boundaries: production READ only, 0 mutations, no clone, no deploy.
 */
import { gzipSync } from "node:zlib";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_REF = "nbnldzfsxffztsfrrxqy";
const OUT_DIR = join("modeling", "evidence", "offline-replay-plane-v1", "research-evidence");
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"];
const PAGE = 1000;

const SELECT = [
  "id",
  "condition_id",
  "selected_token_id",
  "created_at",
  "event_slug",
  "market_slug",
  "mt:diagnostics->providerEventContext->>marketType",
  "game:diagnostics->providerEventContext->>game",
  "start1:diagnostics->>gameStartIso",
  "start2:diagnostics->providerEventContext->>eventStartIso",
  "sf:diagnostics->>providerSportFamily",
  "sc:diagnostics->>providerSportCode",
  "cov:diagnostics->>dataCoverage",
  "rcov:diagnostics->>researchDataCoverage",
  "pe:diagnostics->>providerEventId",
].join(",");

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
  const started = Date.now();
  let grandRows = 0;
  const summary: Record<string, { scanned: number; identities: number; both: number }> = {};

  for (const day of DAYS) {
    const path = join(OUT_DIR, `CONTRACT_A_FIELDS_OVERLAY_${day}.jsonl.gz`);
    if (existsSync(path)) {
      console.log(`  ${day}: overlay already present — skipped (delete the file to re-ingest)`);
      continue;
    }
    const lo = `${day}T00:00:00Z`;
    const hi = `${day}T23:59:59.999Z`;
    const firstByIdentity = new Map<string, Record<string, unknown>>();
    let cursor = "";
    let scanned = 0;
    for (;;) {
      let q = sb
        .from("generated_signal_pairs")
        .select(SELECT)
        .gte("created_at", lo)
        .lte("created_at", hi)
        .order("id", { ascending: true })
        .limit(PAGE);
      if (cursor) q = q.gt("id", cursor);
      const { data, error } = await q;
      if (error) throw new Error(`${day} cursor@${cursor}: ${error.message}`);
      const page = data as any[];
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      for (const r of page) {
        scanned++;
        const id = `${String(r.condition_id ?? "").toLowerCase()}|${r.selected_token_id ?? ""}`;
        if (firstByIdentity.has(id)) continue;
        const start = r.start1 ?? r.start2 ?? null;
        const covRaw = r.cov ?? r.rcov ?? null;
        firstByIdentity.set(id, {
          identity: id,
          condition_id: String(r.condition_id ?? "").toLowerCase() || null,
          selected_token_id: r.selected_token_id != null ? String(r.selected_token_id) : null,
          marketType: r.mt ?? r.game ?? null,
          eventStartIso: start,
          providerSportFamily: r.sf ?? null,
          providerSportCode: r.sc ?? null,
          dataCoverage: covRaw != null ? Number(covRaw) : null,
          providerEventId: r.pe ?? null,
          eventText: r.event_slug ?? null,
          marketText: r.market_slug ?? null,
          sourceCreatedAt: r.created_at ?? null,
          provenance: "generated_signal_pairs.diagnostics (production READ, one-time ingest)",
        });
      }
      if (page.length < PAGE) break;
    }
    const rows = [...firstByIdentity.values()];
    const both = rows.filter((r) => r.marketType && r.eventStartIso).length;
    writeFileSync(path, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")));
    summary[day] = { scanned, identities: rows.length, both };
    grandRows += rows.length;
    console.log(`  ${day}: scanned ${scanned} → ${rows.length} identities (${both} with market_type+event_start) → ${path}`);
  }

  console.log(`\nPROJECT_REF=${ref}  MUTATIONS=0  overlay_identities=${grandRows}  elapsed_ms=${Date.now() - started}`);
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
