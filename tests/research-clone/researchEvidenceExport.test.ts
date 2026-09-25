// PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 focused coverage.
//
// Proves, without any production or research-clone credential: the empty-clone
// bootstrap repair, the deterministic cursor, the hard 20-envelope page bound,
// idempotent page replay, and that the prepared migration is additive and
// read-only/service-role-only by definition.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveBootstrapWatermark,
  resolveInitialWatermark,
  runAppendSync,
  ZERO_UUID,
  type SyncRow,
  type Watermark,
} from "../../lib/research-clone/dailySync";
import {
  RESEARCH_EVIDENCE_PAGE_MAX_ENVELOPES,
  ResearchExportContractError,
  bootstrapCursor,
  buildEvidencePageArgs,
  compareCursor,
  cursorAdvanced,
  dedupeNarrowRows,
  distinctEvidenceIdentities,
  distinctPhysicalEvents,
  narrowRowKey,
  nextCursor,
  type NarrowEvidenceRow,
} from "../../lib/research-clone/researchEvidenceExport";
import { resolveBootstrapSinceArg } from "../../scripts/research-clone-daily-sync";
import { readResearchEvidencePageRows } from "../../scripts/modeling/live-d1-research-corpus";
import { resolveTennisMoneyEligibility } from "../../lib/executor/tennisLiveEligibility";

const OUTBOX_FIELDS = ["observed_at", "observation_id"] as const;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------- bootstrap

test("empty clone + no checkpoint bootstraps from an explicit since (was a hard failure)", () => {
  assert.equal(
    resolveInitialWatermark(null, null, OUTBOX_FIELDS),
    null,
    "precondition: the pre-repair resolver yields no cursor for a truly empty clone",
  );

  const boot = resolveBootstrapWatermark(null, null, OUTBOX_FIELDS, "2026-09-13T21:00:00.000Z");
  assert.ok(boot, "explicit start authority must produce a usable cursor");
  assert.equal(boot.observation_id, ZERO_UUID);
  assert.equal(
    boot.observed_at,
    "2026-09-13T20:59:59.999Z",
    "seeds 1ms before the window so a row exactly on the boundary is included",
  );
});

test("no initial watermark stays fail-closed only when no explicit start authority exists", () => {
  assert.equal(resolveBootstrapWatermark(null, null, OUTBOX_FIELDS, null), null);
  assert.throws(
    () => resolveBootstrapWatermark(null, null, OUTBOX_FIELDS, "not-a-date"),
    /RESEARCH_CLONE_BOOTSTRAP_SINCE_INVALID/,
  );
});

test("bootstrap never overrides a real watermark or moves a checkpoint backwards", () => {
  const target: Watermark = { observed_at: "2026-09-14T10:00:00.000Z", observation_id: "aaa" };
  const checkpoint: Watermark = { observed_at: "2026-09-14T12:00:00.000Z", observation_id: "bbb" };
  assert.deepEqual(
    resolveBootstrapWatermark(target, checkpoint, OUTBOX_FIELDS, "2026-09-01T00:00:00.000Z"),
    checkpoint,
    "an existing position always wins over the bootstrap seed",
  );
});

test("runAppendSync drains a truly empty clone when given a bootstrap since", async () => {
  const source: SyncRow[] = [
    { id: "i1", observation_id: "11111111-0000-0000-0000-000000000000", observed_at: "2026-09-14T01:00:00.000Z" },
    { id: "i2", observation_id: "22222222-0000-0000-0000-000000000000", observed_at: "2026-09-14T02:00:00.000Z" },
  ];
  const written: SyncRow[] = [];
  const result = await runAppendSync(
    OUTBOX_FIELDS,
    5,
    {
      async sourceMaxWatermark() {
        return { observed_at: source.at(-1)!.observed_at as string, observation_id: source.at(-1)!.observation_id as string };
      },
      async targetMaxWatermark() {
        const last = written.at(-1);
        return last ? { observed_at: last.observed_at as string, observation_id: last.observation_id as string } : null;
      },
      async readCheckpoint() {
        return null;
      },
      async fetchSourcePage(after: Watermark | null) {
        assert.ok(after, "the repair must never hand a null cursor to the source read");
        return source.filter((r) => (r.observed_at as string) > after[OUTBOX_FIELDS[0]]);
      },
      async upsertTargetRows(rows) {
        written.push(...rows);
        return { newRows: rows.length, updatedRows: 0, duplicateN: 0 };
      },
      async writeCheckpoint() {},
    },
    "2026-09-13T21:00:00.000Z",
  );

  assert.equal(result.newRows, 2, "both source rows reached the empty clone");
  assert.equal(result.pending, false);
  assert.equal(written.length, 2);
});

test("--since / --day resolve explicit start authority; absence stays null", () => {
  assert.equal(resolveBootstrapSinceArg(["node", "s", "--since", "2026-09-13T21:00:00Z"]), "2026-09-13T21:00:00.000Z");
  assert.equal(resolveBootstrapSinceArg(["node", "s", "--since=2026-09-13T21:00:00Z"]), "2026-09-13T21:00:00.000Z");
  assert.equal(
    resolveBootstrapSinceArg(["node", "s", "--day", "2026-09-14"]),
    "2026-09-13T21:00:00.000Z",
    "a Minsk calendar day starts at 21:00Z the day before (fixed UTC+3)",
  );
  assert.equal(resolveBootstrapSinceArg(["node", "s"]), null);
  assert.throws(() => resolveBootstrapSinceArg(["node", "s", "--day", "nope"]), /BOOTSTRAP_SINCE_INVALID/);
});

// ------------------------------------------------------------- page bounds

test("page bound cannot exceed 20 envelopes", () => {
  assert.equal(RESEARCH_EVIDENCE_PAGE_MAX_ENVELOPES, 20);
  const args = buildEvidencePageArgs(bootstrapCursor("2026-09-13T21:00:00Z"), "2026-09-14T21:00:00Z");
  assert.equal(args.p_max_envelopes, 20);
  assert.throws(
    () => buildEvidencePageArgs(bootstrapCursor("2026-09-13T21:00:00Z"), "2026-09-14T21:00:00Z", 21),
    ResearchExportContractError,
  );
  assert.throws(
    () => buildEvidencePageArgs(bootstrapCursor("2026-09-13T21:00:00Z"), "2026-09-14T21:00:00Z", 0),
    ResearchExportContractError,
  );
});

test("an explicit upper time bound is required, never implied", () => {
  assert.throws(
    () => buildEvidencePageArgs(bootstrapCursor("2026-09-13T21:00:00Z"), ""),
    /RESEARCH_EXPORT_UPPER_TIME_BOUND_REQUIRED/,
  );
});

// ----------------------------------------------------------- cursor / replay

function row(observedAt: string, envId: string, itemId: string, extra: Partial<NarrowEvidenceRow> = {}): NarrowEvidenceRow {
  return {
    observation_id: envId,
    observed_at: observedAt,
    item_observation_id: itemId,
    condition_id: "c1",
    selected_token_id: "t1",
    metric_formula_version: "v2-lite-growth-safe",
    entry_price_num: 0.42,
    signal_confidence_num: 61,
    signal_result: null,
    formula_version: "f1",
    pre_event_score_num: 55,
    provider_event_id: "e1",
    provider_sport_code: "nba",
    provider_sport_family: "basketball",
    market_family: "moneyline",
    market_type: "binary",
    event_title: null,
    market_question: null,
    game_start_iso: "2026-09-14T18:00:00.000Z",
    volume_usd: 1000,
    volume_semantic: "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr",
    selected_outcome: "Yes",
    data_coverage: 0.9,
    league: null,
    ...extra,
  };
}

test("cursor ordering is deterministic and strictly advancing", () => {
  const page = [
    row("2026-09-14T01:00:00.000Z", "env-a", "item-1"),
    row("2026-09-14T01:00:00.000Z", "env-b", "item-2"),
    row("2026-09-14T02:00:00.000Z", "env-c", "item-3"),
  ];
  const start = bootstrapCursor("2026-09-13T21:00:00Z");
  const after = nextCursor(page, start);
  assert.deepEqual(after, { observedAt: "2026-09-14T02:00:00.000Z", observationId: "env-c" });
  assert.equal(cursorAdvanced(start, after), true);
  assert.equal(compareCursor(after, after), 0);
  assert.deepEqual(nextCursor([], after), after, "an empty page never moves the cursor");
  assert.equal(cursorAdvanced(after, after), false);
});

test("replaying one page is idempotent on (observation_id, item_observation_id)", () => {
  const page = [
    row("2026-09-14T01:00:00.000Z", "env-a", "item-1"),
    row("2026-09-14T01:00:00.000Z", "env-a", "item-2"),
  ];
  const once = dedupeNarrowRows(page);
  const twice = dedupeNarrowRows([...page, ...page]);
  assert.equal(once.length, 2);
  assert.equal(twice.length, 2, "a replayed page produces zero semantic duplicates");
  assert.deepEqual(once.map(narrowRowKey).sort(), twice.map(narrowRowKey).sort());
});

test("identity and physical-event denominators stay separate, never pooled", () => {
  const page = [
    row("2026-09-14T01:00:00.000Z", "env-a", "item-1", { condition_id: "c1", selected_token_id: "t1", provider_event_id: "e1" }),
    row("2026-09-14T01:00:00.000Z", "env-a", "item-2", { condition_id: "c1", selected_token_id: "t2", provider_event_id: "e1" }),
    row("2026-09-14T02:00:00.000Z", "env-b", "item-3", { condition_id: "c2", selected_token_id: "t3", provider_event_id: "e2" }),
  ];
  assert.equal(page.length, 3, "evidence rows");
  assert.equal(distinctEvidenceIdentities(page), 3, "distinct evidence identities");
  assert.equal(distinctPhysicalEvents(page), 2, "distinct physical events");
});

// ------------------------------------------------------- migration contract

test("prepared migration is additive, read-only and service-role-only", () => {
  const sql = readFileSync(repoRoot + "supabase/migrations/20260919080000_research_evidence_page_v2.sql", "utf8");

  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_primary_evidence_outbox_observed/);
  const executableSql = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(executableSql, /CONCURRENTLY/, "committed index statement is transaction-safe");
  assert.match(sql, /ON public\.primary_evidence_outbox \(observed_at, observation_id\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.research_evidence_page_v2\(/);
  assert.doesNotMatch(
    executableSql,
    /(?:CREATE(?: OR REPLACE)? FUNCTION|DROP FUNCTION(?: IF EXISTS)?|ALTER FUNCTION|REVOKE[^;]*ON FUNCTION|GRANT[^;]*ON FUNCTION) public\.research_evidence_page\(/,
    "live v1 must not be created, replaced, dropped, altered or re-granted",
  );

  // Read-only by definition. Scanned against executable SQL only: `--` comment
  // lines legitimately name the statements this migration promises not to use.
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  assert.match(executable, /\bSTABLE\b/);
  assert.match(executable, /SECURITY INVOKER/);
  for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i, /ALTER TABLE/i]) {
    assert.doesNotMatch(executable, forbidden, `migration must not contain ${forbidden}`);
  }
  // Never replaces a money-path function.
  assert.doesNotMatch(sql, /FUNCTION public\.publish_primary_signal_observation/);

  // Bounds actually present in the shipped SQL.
  assert.match(sql, /SET statement_timeout = '5s'/);
  assert.match(sql, /LIMIT LEAST\(GREATEST\(COALESCE\(p_max_envelopes, 20\), 1\), 20\)/);
  assert.match(sql, /RAISE EXCEPTION 'research_evidence_page_v2 requires an explicit p_until upper time bound'/);
  assert.match(sql, /ORDER BY o\.observed_at, o\.observation_id/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.research_evidence_page[\s\S]{0,200}TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.research_evidence_page[\s\S]{0,200}FROM PUBLIC, anon, authenticated/);

  // The whole point: the operational envelope column is never a returned column.
  const returnsBlock = sql.slice(sql.indexOf("RETURNS TABLE ("), sql.indexOf("LANGUAGE plpgsql"));
  assert.ok(returnsBlock.length > 0, "expected a RETURNS TABLE block");
  assert.equal(
    returnsBlock.includes("evidence_rows"),
    false,
    "evidence_rows must never appear among the returned columns",
  );
  assert.match(returnsBlock, /item_observation_id uuid/, "the flattened item identity is returned instead");
});

// ------------------------------------------- current-attribute projection

const SQL = readFileSync(repoRoot + "supabase/migrations/20260919080000_research_evidence_page_v2.sql", "utf8");
const SCRIPT = readFileSync(repoRoot + "scripts/research-clone-daily-sync.ts", "utf8");
const CLONE_SCHEMA = readFileSync(repoRoot + "ops/research-clone/research-evidence-page-schema.sql", "utf8");

test("RPC projection preserves the CURRENT source authorities and falls back only to historical paths", () => {
  // selected outcome / data coverage: current top-level + diagnostics paths.
  assert.match(SQL, /NULLIF\(e\.item->>'selected_outcome', ''\)/);
  assert.match(SQL, /NULLIF\(e\.item->'diagnostics'->>'dataCoverage', ''\)::numeric/);
  // market type: current providerEventContext path FIRST, historical diagnostics.marketType second.
  assert.match(
    SQL,
    /COALESCE\(\s*NULLIF\(e\.item->'diagnostics'->'providerEventContext'->>'marketType', ''\),\s*NULLIF\(e\.item->'diagnostics'->>'marketType', ''\)\s*\)/,
  );
  // volume: current parentEventVolume24hr FIRST, historical volumeUsd second, never re-labelled.
  assert.match(
    SQL,
    /COALESCE\(\s*NULLIF\(e\.item->'diagnostics'->>'parentEventVolume24hr', ''\)::numeric,\s*NULLIF\(e\.item->'diagnostics'->>'volumeUsd', ''\)::numeric\s*\)/,
  );
  assert.match(
    SQL,
    /WHEN NULLIF\(e\.item->'diagnostics'->>'parentEventVolume24hr', ''\) IS NOT NULL\s+THEN 'primary_evidence_outbox\.evidence_rows\[\]\.diagnostics\.parentEventVolume24hr'/,
  );
  assert.match(
    SQL,
    /WHEN NULLIF\(e\.item->'diagnostics'->>'volumeUsd', ''\) IS NOT NULL\s+THEN 'primary_evidence_outbox\.evidence_rows\[\]\.diagnostics\.volumeUsd'\s+ELSE NULL/,
  );
  const returnsBlock = SQL.slice(SQL.indexOf("RETURNS TABLE ("), SQL.indexOf("LANGUAGE plpgsql"));
  for (const col of ["volume_semantic text", "selected_outcome text", "data_coverage numeric", "market_type text", "volume_usd numeric"]) {
    assert.ok(returnsBlock.includes(col), `RETURNS TABLE must include ${col}`);
  }
  assert.equal(returnsBlock.includes("evidence_rows"), false);
  // identity fields keep their source paths
  assert.match(SQL, /NULLIF\(e\.item->>'condition_id', ''\)/);
  assert.match(SQL, /NULLIF\(e\.item->>'selected_token_id', ''\)/);
  assert.match(SQL, /NULLIF\(e\.item->'diagnostics'->>'providerEventId', ''\)/);
  assert.match(SQL, /NULLIF\(e\.item->>'entry_price_num', ''\)::numeric/);
  assert.match(SQL, /NULLIF\(e\.item->'diagnostics'->>'gameStartIso', ''\)/);
});

test("clone schema authority is clone-only, additive, and keeps identity/index semantics", () => {
  assert.match(CLONE_SCHEMA, /RESEARCH CLONE ONLY\. Never apply through the production migration lifecycle/);
  assert.match(CLONE_SCHEMA, /nppznoujvnyjargjkmnv/);
  for (const col of ["selected_outcome text", "data_coverage numeric", "volume_semantic text"]) {
    assert.ok(CLONE_SCHEMA.includes(`add column if not exists ${col}`), col);
  }
  assert.match(CLONE_SCHEMA, /add column if not exists league text/);
  assert.match(CLONE_SCHEMA, /primary key \(observation_id, item_observation_id\)/);
  assert.match(CLONE_SCHEMA, /\(observed_at, observation_id, item_observation_id\)/);
  assert.match(CLONE_SCHEMA, /'PRODUCTION_RESEARCH_EVIDENCE_PAGE'/);
});

test("prepared SQL keeps 20-envelope clamp, 5s timeout, explicit p_until and the composite index", () => {
  assert.match(SQL, /idx_primary_evidence_outbox_observed\s+ON public\.primary_evidence_outbox \(observed_at, observation_id\)/);
  assert.match(SQL, /SET statement_timeout = '5s'/);
  assert.match(SQL, /LIMIT LEAST\(GREATEST\(COALESCE\(p_max_envelopes, 20\), 1\), 20\)/);
  assert.match(SQL, /requires an explicit p_until/);
  assert.equal(/\bOFFSET\b/i.test(SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")), false);
});

test("clone conflict key and source_kind are unchanged", async () => {
  const mod = await import("../../lib/research-clone/researchEvidenceExport");
  assert.equal(mod.CLONE_EVIDENCE_CONFLICT_KEY, "observation_id,item_observation_id");
  assert.equal(mod.CLONE_EVIDENCE_SOURCE_KIND, "PRODUCTION_RESEARCH_EVIDENCE_PAGE");
  assert.equal(mod.CLONE_EVIDENCE_TABLE, "research_evidence_page_rows");
  assert.equal(mod.VOLUME_SEMANTIC_PARENT_EVENT_24H, "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr");
  assert.equal(mod.VOLUME_SEMANTIC_LEGACY_VOLUME_USD, "primary_evidence_outbox.evidence_rows[].diagnostics.volumeUsd");
});

// ------------------------------------------------ runtime consumer wiring

test("production primary_evidence_outbox is no longer a generic raw SYNC_SPECS target; narrow RPC consumer is wired", () => {
  const specs = SCRIPT.slice(SCRIPT.indexOf("const SPECS"), SCRIPT.indexOf("const EMPTY_TABLE_EVIDENCE"));
  assert.equal(specs.includes('table: "primary_evidence_outbox"'), false);
  assert.equal(/\|\s*"primary_evidence_outbox"/.test(SCRIPT), false, "TableName no longer includes primary_evidence_outbox");
  assert.match(SCRIPT, /source\.rpc\("research_evidence_page_v5", args\)/);
  assert.equal(/source\.rpc\("research_evidence_page(?:_v4|_v3|_v2)?",/.test(SCRIPT), false, "runtime only calls v5");
  assert.match(SCRIPT, /syncResearchEvidencePage\(target, source, bootstrapSince\)/);
  assert.match(SCRIPT, /onConflict: CLONE_EVIDENCE_CONFLICT_KEY/);
  assert.match(SCRIPT, /source_kind: CLONE_EVIDENCE_SOURCE_KIND/);
  assert.match(SCRIPT, /const pUntil = new Date\(\)\.toISOString\(\)/);
  assert.match(SCRIPT, /MAX_EVIDENCE_PAGES = 200/);
  assert.match(SCRIPT, /checkpoint:\$\{CLONE_EVIDENCE_TABLE\}/);
  // no raw select("*") against production primary_evidence_outbox anywhere
  assert.equal(/from\("primary_evidence_outbox"\)[\s\S]{0,80}select\("\*"\)/.test(SCRIPT.replace(/probeCloneOutbox[\s\S]*?\n}\n/, "")), false);
});

test("unconditional hard stop is gone and emergency quiesce remains the first runtime guard", () => {
  assert.equal(SCRIPT.includes("RESEARCH_SYNC_HARD_STOPPED"), false);
  assert.equal(SCRIPT.includes("HARD_STOPPED"), false);
  const mainBody = SCRIPT.slice(SCRIPT.indexOf("export async function main()"));
  const quiesceAt = mainBody.indexOf('isEmergencyQuiesceActive("research-clone-sync")');
  const envAt = mainBody.indexOf('requiredEnv("SUPABASE_URL")');
  assert.ok(quiesceAt >= 0 && envAt > quiesceAt, "quiesce check precedes any env/client work");
});

test("main() honours EMERGENCY_QUIESCE_SCOPES=research-clone-sync before touching any credential", async () => {
  const { main } = await import("../../scripts/research-clone-daily-sync");
  const saved = { scopes: process.env.EMERGENCY_QUIESCE_SCOPES, url: process.env.SUPABASE_URL };
  process.env.EMERGENCY_QUIESCE_SCOPES = "research-clone-sync";
  delete process.env.SUPABASE_URL;
  const logs: string[] = [];
  const original = console.log;
  console.log = (m: string) => { logs.push(String(m)); };
  try {
    await main();
  } finally {
    console.log = original;
    if (saved.scopes === undefined) delete process.env.EMERGENCY_QUIESCE_SCOPES; else process.env.EMERGENCY_QUIESCE_SCOPES = saved.scopes;
    if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EMERGENCY_QUIESCED/);
});

test("release contract: v2 migration path/version, index names, no duplicate clone index", () => {
  const migDir = repoRoot + "supabase/migrations/";
  const files = readdirSync(migDir);
  assert.ok(files.includes("20260919080000_research_evidence_page_v2.sql"));
  assert.equal(files.includes("20260916140000_research_evidence_page.sql"), false, "old out-of-order migration removed");
  assert.ok("20260919080000" > "20260918162403", "version is strictly after live migration head");
  assert.match(CLONE_SCHEMA, /create index if not exists research_evidence_page_rows_window_idx/);
  assert.equal(CLONE_SCHEMA.includes("idx_research_evidence_page_rows_window"), false);
});

// ───────────────────────────── v3: item-level cursor ─────────────────────────

import {
  RESEARCH_EVIDENCE_V3_MAX_ROWS,
  buildEvidencePageV3Args,
  bootstrapItemCursor,
  compareItemCursor,
  nextItemCursor,
  itemCursorAdvanced,
  type EvidencePageV3Args,
} from "../../lib/research-clone/researchEvidenceExport";
import { resolveRepairArgs, syncResearchEvidencePage } from "../../scripts/research-clone-daily-sync";

const SQL_V3 = readFileSync(repoRoot + "supabase/migrations/20260919100000_research_evidence_page_v3.sql", "utf8");
const EXEC_V3 = SQL_V3.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const SQL_V4 = readFileSync(repoRoot + "supabase/migrations/20260923090003_research_evidence_page_v4.sql", "utf8");
const EXEC_V4 = SQL_V4.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const SQL_V5 = readFileSync(repoRoot + "supabase/migrations/20260925092016_step3_research_evidence_page_v5.sql", "utf8");
const EXEC_V5 = SQL_V5.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

test("v3 migration: new function, item cursor, 500-row bound, v1/v2 untouched, no new index", () => {
  assert.match(SQL_V3, /CREATE OR REPLACE FUNCTION public\.research_evidence_page_v3\(/);
  assert.match(SQL_V3, /p_after_item_observation_id uuid/);
  assert.match(SQL_V3, /p_max_rows integer DEFAULT 500/);
  assert.match(SQL_V3, /LIMIT LEAST\(GREATEST\(COALESCE\(p_max_rows, 500\), 1\), 500\)/);
  assert.match(SQL_V3, /\(f\.env_at, f\.env_id, f\.item_id\) > \(v_after_at, v_after_env, v_after_item\)/);
  assert.match(SQL_V3, /ORDER BY f\.env_at, f\.env_id, f\.item_id/);
  // envelope lookup starts AT the cursor envelope so a partially returned envelope can resume
  assert.match(SQL_V3, /\(o\.observed_at, o\.observation_id\) >= \(v_after_at, v_after_env\)/);
  assert.match(SQL_V3, /SET statement_timeout = '5s'/);
  assert.match(EXEC_V3, /\bSTABLE\b/);
  assert.match(EXEC_V3, /SECURITY INVOKER/);
  assert.match(EXEC_V3, /SET search_path = public, pg_temp/);
  assert.match(SQL_V3, /requires an explicit p_until/);
  assert.match(SQL_V3, /GRANT EXECUTE ON FUNCTION public\.research_evidence_page_v3[\s\S]{0,200}TO service_role/);
  assert.match(SQL_V3, /REVOKE ALL ON FUNCTION public\.research_evidence_page_v3[\s\S]{0,200}FROM PUBLIC, anon, authenticated/);
  assert.equal(/\bOFFSET\b/i.test(EXEC_V3), false);
  assert.equal(/CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(EXEC_V3), false, "no equivalent index is re-created");
  assert.equal(
    /(?:DROP|ALTER|CREATE(?: OR REPLACE)?)\s+FUNCTION(?: IF EXISTS)?\s+public\.research_evidence_page(?:_v2)?\(/.test(EXEC_V3),
    false,
    "v1/v2 preserved",
  );
  assert.equal(/publish_primary_signal_observation/.test(EXEC_V3), false);
  const returnsBlock = SQL_V3.slice(SQL_V3.indexOf("RETURNS TABLE ("), SQL_V3.indexOf("LANGUAGE plpgsql"));
  assert.equal(returnsBlock.includes("evidence_rows"), false);
  for (const col of ["volume_semantic text", "selected_outcome text", "data_coverage numeric", "market_type text", "volume_usd numeric"]) {
    assert.ok(returnsBlock.includes(col), col);
  }
  assert.match(SQL_V3, /providerEventContext'->>'marketType'/);
  assert.match(SQL_V3, /parentEventVolume24hr/);
});

test("v3 client contract: item cursor args, 500-row bound, explicit until", () => {
  assert.equal(RESEARCH_EVIDENCE_V3_MAX_ROWS, 500);
  const c = bootstrapItemCursor("2026-09-09T00:00:00Z");
  const a = buildEvidencePageV3Args(c, "2026-09-20T00:00:00Z");
  assert.deepEqual(Object.keys(a).sort(), [
    "p_after_item_observation_id", "p_after_observation_id", "p_after_observed_at", "p_max_rows", "p_until",
  ]);
  assert.equal(a.p_max_rows, 500);
  assert.throws(() => buildEvidencePageV3Args(c, "2026-09-20T00:00:00Z", 501), ResearchExportContractError);
  assert.throws(() => buildEvidencePageV3Args(c, ""), /UPPER_TIME_BOUND_REQUIRED/);
  const r = row("2026-09-14T01:00:00.000Z", "env-a", "item-2");
  const n = nextItemCursor([row("2026-09-14T01:00:00.000Z", "env-a", "item-1"), r], c);
  assert.deepEqual(n, { observedAt: r.observed_at, observationId: "env-a", itemObservationId: "item-2" });
  assert.equal(itemCursorAdvanced(c, n), true);
  assert.equal(compareItemCursor(n, n), 0);
});

test("v4 retains v3 cursor/bounds and projects only verbatim tennis identity text", () => {
  assert.match(SQL_V4, /CREATE OR REPLACE FUNCTION public\.research_evidence_page_v4\(/);
  assert.match(SQL_V4, /p_after_item_observation_id uuid/);
  assert.match(SQL_V4, /LIMIT 20/);
  assert.match(SQL_V4, /LIMIT LEAST\(GREATEST\(COALESCE\(p_max_rows, 500\), 1\), 500\)/);
  assert.match(SQL_V4, /SET statement_timeout = '5s'/);
  assert.match(EXEC_V4, /STABLE/);
  assert.match(EXEC_V4, /SECURITY INVOKER/);
  assert.match(SQL_V4, /requires an explicit p_until/);
  assert.match(SQL_V4, /providerEventContext'->>'eventTitle'/);
  assert.match(SQL_V4, /providerEventContext'->>'marketQuestion'/);
  const returnsBlock = SQL_V4.slice(SQL_V4.indexOf("RETURNS TABLE ("), SQL_V4.indexOf("LANGUAGE plpgsql"));
  assert.match(returnsBlock, /event_title text/);
  assert.match(returnsBlock, /market_question text/);
  assert.equal(returnsBlock.includes("evidence_rows"), false);
  assert.equal(/(?:DROP|ALTER|CREATE(?: OR REPLACE)?)\s+FUNCTION(?: IF EXISTS)?\s+public\.research_evidence_page(?:_v3|_v2)?\(/.test(EXEC_V4), false);
});

test("v5 adds only verbatim provider league to the bounded v4 projection contract", () => {
  assert.match(SQL_V5, /CREATE OR REPLACE FUNCTION public\.research_evidence_page_v5\(/);
  assert.match(SQL_V5, /p_after_item_observation_id uuid/);
  assert.match(SQL_V5, /LIMIT 20/);
  assert.match(SQL_V5, /LIMIT LEAST\(GREATEST\(COALESCE\(p_max_rows, 500\), 1\), 500\)/);
  assert.match(SQL_V5, /SET statement_timeout = '5s'/);
  assert.match(EXEC_V5, /STABLE/);
  assert.match(EXEC_V5, /SECURITY INVOKER/);
  assert.match(SQL_V5, /requires an explicit p_until/);
  assert.match(SQL_V5, /NULLIF\(f\.item->'diagnostics'->'providerEventContext'->>'league', ''\)/);
  assert.match(SQL_V5, /GRANT EXECUTE ON FUNCTION public\.research_evidence_page_v5[\s\S]{0,200}TO service_role/);
  assert.match(SQL_V5, /REVOKE ALL ON FUNCTION public\.research_evidence_page_v5[\s\S]{0,200}FROM PUBLIC, anon, authenticated/);
  assert.equal(/\bOFFSET\b/i.test(EXEC_V5), false);
  const returnsBlock = SQL_V5.slice(SQL_V5.indexOf("RETURNS TABLE ("), SQL_V5.indexOf("LANGUAGE plpgsql"));
  assert.match(returnsBlock, /league text/);
  assert.equal(returnsBlock.includes("evidence_rows"), false);
  for (const col of ["observation_id uuid", "market_type text", "event_title text", "market_question text", "data_coverage numeric"]) {
    assert.ok(returnsBlock.includes(col), col);
  }
});

test("STEP3 overlay uses optional exact-decision league evidence without widening the join", () => {
  const overlay = readFileSync(repoRoot + "modeling/sql_registry/datasets/step3_legacy_feature_overlay_v1.sql", "utf8");
  assert.match(overlay, /COALESCE\(\s*NULLIF\(g\.diagnostics->'providerEventContext'->>'league', ''\),\s*e\.league\s*\) AS league/);
  const evidenceJoin = overlay.slice(overlay.indexOf("LEFT JOIN LATERAL (\n  SELECT item_observation_id"), overlay.indexOf("LEFT JOIN LATERAL (\n  SELECT CASE"));
  assert.match(evidenceJoin, /observed_at = r\.decision_at/);
  assert.match(evidenceJoin, /condition_id = r\.condition_id/);
  assert.match(evidenceJoin, /selected_token_id = r\.selected_token_id/);
  assert.equal(/observed_at\s*>\s*r\.decision_at/.test(evidenceJoin), false);
  assert.match(overlay, /LEFT JOIN LATERAL/);
});

test("persisted narrow identity reaches the reader and tennis gate without settlement", async () => {
  const sourceRow = row("2026-09-21T01:00:00.000Z", "env-title", "item-title", {
    provider_sport_family: "tennis",
    market_type: "tennis_completed_match",
    event_title: "ATP Example Open",
    market_question: "Will Player A win?",
  });
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gt: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: [sourceRow], error: null }),
  };
  const { pairs } = await readResearchEvidencePageRows({ from: () => chain } as any, "2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z");
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].eventTitle, "ATP Example Open");
  assert.equal(pairs[0].marketQuestion, "Will Player A win?");
  assert.equal(pairs[0].gammaTerminal, null, "reader does not query or assign settlement");
  assert.deepEqual(resolveTennisMoneyEligibility({
    structuredMarketType: pairs[0].marketTypeRaw,
    eventIdentityText: pairs[0].eventTitle,
    marketText: pairs[0].marketQuestion,
  }), { eligible: true, reasonCode: "TENNIS_MONEY_ELIGIBLE" });
  const nullRow = { ...sourceRow, event_title: null, market_question: null };
  assert.equal(nullRow.event_title, null);
  assert.equal(nullRow.market_question, null);
});

// ---- in-memory simulation of research_evidence_page_v3 SQL semantics --------

type SimEnv = { at: string; id: string; items: string[] };
const UUID0 = "00000000-0000-0000-0000-000000000000";
const pad = (n: number, w = 12) => `00000000-0000-0000-0000-${String(n).padStart(w, "0")}`;

function simV3(envs: SimEnv[], a: Record<string, unknown> | EvidencePageV3Args) {
  const afterAt = Date.parse(a.p_after_observed_at as string);
  const afterEnv = a.p_after_observation_id as string;
  const afterItem = a.p_after_item_observation_id as string;
  const until = Date.parse(a.p_until as string);
  const cmp = (x: [number, string, string], y: [number, string, string]) =>
    x[0] !== y[0] ? x[0] - y[0] : x[1] !== y[1] ? (x[1] < y[1] ? -1 : 1) : x[2] === y[2] ? 0 : x[2] < y[2] ? -1 : 1;
  const window = envs
    .filter((e) => cmp([Date.parse(e.at), e.id, ""], [afterAt, afterEnv, ""]) >= 0 && Date.parse(e.at) < until)
    .sort((x, y) => cmp([Date.parse(x.at), x.id, ""], [Date.parse(y.at), y.id, ""]))
    .slice(0, 20);
  const flat = window.flatMap((e) => e.items.map((i) => ({ e, i })));
  return flat
    .filter((f) => cmp([Date.parse(f.e.at), f.e.id, f.i], [afterAt, afterEnv, afterItem]) > 0)
    .sort((x, y) => cmp([Date.parse(x.e.at), x.e.id, x.i], [Date.parse(y.e.at), y.e.id, y.i]))
    .slice(0, Math.min(Math.max(Number(a.p_max_rows ?? 500), 1), 500))
    .map((f) => row(f.e.at, f.e.id, f.i));
}

function fakeSource(envs: SimEnv[], calls: Array<{ name: string; args: Record<string, any> }> = []) {
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: simV3(envs, args).map((r) => ({ ...r, league: "premier_league" })), error: null };
    },
  };
}

/** Minimal chainable clone fake: job_runs (select/eq/order/limit/insert) + narrow rows (select empty / upsert). */
function fakeTarget(jobRuns: Array<{ source: string; status: string; diagnostics: any }> = []) {
  const rows = new Map<string, Record<string, unknown>>();
  const inserts: Array<{ source: string; diagnostics: any }> = [];
  return {
    rows,
    inserts,
    from(table: string) {
      const q: any = { table, filters: [] as Array<[string, unknown]> };
      q.select = () => q;
      q.eq = (c: string, v: unknown) => (q.filters.push([c, v]), q);
      q.order = () => q;
      q.or = () => q;
      q.limit = () => q;
      q.then = (res: (v: unknown) => unknown) => {
        if (table === "job_runs") {
          const src = q.filters.find((f: [string, unknown]) => f[0] === "source")?.[1];
          const hit = [...jobRuns].reverse().find((j) => j.source === src);
          return res({ data: hit ? [{ diagnostics: hit.diagnostics }] : [], error: null });
        }
        return res({ data: [], error: null });
      };
      q.insert = async (rec: any) => {
        jobRuns.push(rec);
        inserts.push(rec);
        return { error: null };
      };
      q.upsert = async (recs: any[], opts: { onConflict: string }) => {
        assert.equal(opts.onConflict, "observation_id,item_observation_id");
        for (const r of recs) {
          assert.equal(r.source_kind, "PRODUCTION_RESEARCH_EVIDENCE_PAGE");
          rows.set(`${r.observation_id}::${r.item_observation_id}`, r);
        }
        return { error: null };
      };
      return q;
    },
  };
}

const T0 = "2026-09-19T01:00:00.000Z";
const envA: SimEnv = { at: T0, id: pad(1), items: Array.from({ length: 1200 }, (_, i) => pad(i + 1)) };
const envB: SimEnv = { at: "2026-09-19T02:00:00.000Z", id: pad(2), items: Array.from({ length: 300 }, (_, i) => pad(i + 1)) };
const envC: SimEnv = { at: "2026-09-19T03:00:00.000Z", id: pad(3), items: Array.from({ length: 10 }, (_, i) => pad(i + 1)) };
const SRC_TOTAL = 1200 + 300 + 10;

test("REGRESSION: a page that ends INSIDE an envelope resumes at the next item of the SAME envelope (no skipped items)", () => {
  const cursor0 = bootstrapItemCursor(T0);
  const p1 = simV3([envA, envB, envC], buildEvidencePageV3Args(cursor0, "2026-09-20T00:00:00Z"));
  assert.equal(p1.length, 500);
  assert.ok(p1.every((r) => r.observation_id === envA.id), "page 1 lies entirely inside envelope A (1200 items)");
  const c1 = nextItemCursor(p1, cursor0);
  assert.equal(c1.observationId, envA.id);
  assert.equal(c1.itemObservationId, envA.items[499]);
  const p2 = simV3([envA, envB, envC], buildEvidencePageV3Args(c1, "2026-09-20T00:00:00Z"));
  assert.equal(p2[0].observation_id, envA.id, "page 2 continues in the same envelope");
  assert.equal(p2[0].item_observation_id, envA.items[500], "and begins with the NEXT item");
  // the exact defect: an ENVELOPE-level cursor would have skipped A's remaining 700 items
  const envelopeLevel = simV3([envA, envB, envC], {
    ...buildEvidencePageV3Args(c1, "2026-09-20T00:00:00Z"),
    p_after_item_observation_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
  });
  assert.equal(envelopeLevel[0].observation_id, envB.id, "documents what the old cursor did: jumped to envelope B");
});

test("multi-envelope boundary: a boundary that cuts an envelope leaves later envelopes reachable; full union equals source", async () => {
  const source = fakeSource([envA, envB, envC]);
  const target = fakeTarget();
  const r = await syncResearchEvidencePage(target, source, "2026-09-19T00:00:00.000Z");
  assert.equal(target.rows.size, SRC_TOTAL, "two-plus-page union equals the source item count");
  assert.equal(r.ROWS_WRITTEN, SRC_TOTAL);
  assert.ok([...target.rows.values()].every((r) => r.league === "premier_league"), "v5 league value reaches the clone upsert");
  assert.equal(r.APPEND_PENDING, false);
  assert.ok(source.calls.every((c) => c.name === "research_evidence_page_v5"));
  assert.ok(source.calls.every((c) => c.args.p_max_rows === 500 && typeof c.args.p_until === "string"));
  assert.equal(new Set(source.calls.map((c) => c.args.p_until)).size, 1, "one fixed p_until for the whole run");
  assert.deepEqual(r.CURSOR_AFTER, { observedAt: envC.at, observationId: envC.id, itemObservationId: envC.items[9] });
  // idempotent replay writes the same keys, never duplicates
  const again = await syncResearchEvidencePage(target, fakeSource([envA, envB, envC]), "2026-09-19T00:00:00.000Z");
  assert.equal(target.rows.size, SRC_TOTAL);
  assert.equal(again.APPEND_PENDING, false);
});

test("normal daily mode: durable v3 forward cursor (separate checkpoint source), advanced only after writes", async () => {
  const jobRuns = [
    { source: "research-clone-daily-sync-v1:checkpoint:research_evidence_page_rows", status: "success",
      diagnostics: { watermark: { observed_at: envC.at, observation_id: envC.id } } }, // legacy v2 checkpoint: must be ignored
    { source: "research-clone-daily-sync-v1:checkpoint:research_evidence_page_rows:v3", status: "success",
      diagnostics: { watermark: { observed_at: envB.at, observation_id: envB.id, item_observation_id: envB.items[299] } } },
  ];
  const source = fakeSource([envA, envB, envC]);
  const target = fakeTarget(jobRuns);
  await syncResearchEvidencePage(target, source, null);
  assert.equal(source.calls[0].args.p_after_observation_id, envB.id, "starts from the v3 forward cursor");
  assert.equal(source.calls[0].args.p_after_item_observation_id, envB.items[299]);
  assert.equal(target.rows.size, 10, "only envelope C remained");
  assert.ok(target.inserts.every((i) => i.source.endsWith(":checkpoint:research_evidence_page_rows:v3")));
  assert.ok(target.inserts.every((i) => typeof i.diagnostics.watermark.item_observation_id === "string"));
});

test("--repair-since overrides the forward cursor for repair ONLY, and never touches the normal checkpoint", async () => {
  assert.equal(resolveRepairArgs(["node", "s"]), null);
  assert.deepEqual(resolveRepairArgs(["node", "s", "--repair-since", "2026-09-09T00:00:00Z"]), {
    sinceIso: "2026-09-09T00:00:00.000Z", untilIso: null,
  });
  assert.deepEqual(resolveRepairArgs(["node", "s", "--repair-since=2026-09-09T00:00:00Z", "--repair-until=2026-09-19T00:00:00Z"]), {
    sinceIso: "2026-09-09T00:00:00.000Z", untilIso: "2026-09-19T00:00:00.000Z",
  });
  assert.throws(() => resolveRepairArgs(["node", "s", "--repair-until", "2026-09-19T00:00:00Z"]), /REPAIR_UNTIL_REQUIRES_SINCE/);
  assert.throws(() => resolveRepairArgs(["node", "s", "--repair-since", "nope"]), /REPAIR_ARG_INVALID/);
  assert.throws(
    () => resolveRepairArgs(["node", "s", "--repair-since", "2026-09-19T00:00:00Z", "--repair-until", "2026-09-09T00:00:00Z"]),
    /REPAIR_ARG_INVALID/,
  );

  const forward = { source: "research-clone-daily-sync-v1:checkpoint:research_evidence_page_rows:v3", status: "success",
    diagnostics: { watermark: { observed_at: envC.at, observation_id: envC.id, item_observation_id: envC.items[9] } } };
  const jobRuns = [forward];
  const source = fakeSource([envA, envB, envC]);
  const target = fakeTarget(jobRuns);
  const r = await syncResearchEvidencePage(target, source, null, { sinceIso: T0, untilIso: "2026-09-20T00:00:00.000Z" });
  assert.equal(r.MODE, "REPAIR");
  assert.equal(source.calls[0].args.p_after_observed_at, new Date(Date.parse(T0) - 1).toISOString(), "starts at the repair boundary, not the forward cursor");
  assert.equal(target.rows.size, SRC_TOTAL, "repair restored every item although the forward cursor was already at the end");
  assert.ok(source.calls.every((c) => c.name === "research_evidence_page_v5"));
  assert.ok(target.inserts.every((i) => i.source.endsWith(":repair-cursor:research_evidence_page_rows:v3")), "only the repair cursor is written");
  assert.equal(jobRuns.filter((j) => j.source === forward.source).length, 1, "normal checkpoint untouched (no reset, no move)");
  assert.equal(target.inserts.at(-1)!.diagnostics.complete, true);
  assert.equal(r.P_UNTIL, "2026-09-20T00:00:00.000Z");
  // repair upserts are idempotent on the same clone conflict key
  const again = await syncResearchEvidencePage(target, fakeSource([envA, envB, envC]), null, { sinceIso: T0, untilIso: "2026-09-20T00:00:00.000Z" });
  assert.equal(target.rows.size, SRC_TOTAL);
  assert.equal(again.APPEND_PENDING, false);
});

test("repair mode is finitely bounded and resumable; runtime uses v5 only", () => {
  const src = readFileSync(repoRoot + "scripts/research-clone-daily-sync.ts", "utf8");
  assert.match(src, /MAX_REPAIR_EVIDENCE_PAGES = 500/);
  assert.ok(500 * RESEARCH_EVIDENCE_V3_MAX_ROWS >= 194090, "repair page budget covers the measured window");
  assert.match(src, /source\.rpc\("research_evidence_page_v5", args\)/);
  assert.equal(/source\.rpc\("research_evidence_page(?:_v4|_v3|_v2)?",/.test(src), false);
  assert.match(src, /checkpoint:\$\{CLONE_EVIDENCE_TABLE\}:v3/);
  assert.match(src, /repair-cursor:\$\{CLONE_EVIDENCE_TABLE\}:v3/);
});
