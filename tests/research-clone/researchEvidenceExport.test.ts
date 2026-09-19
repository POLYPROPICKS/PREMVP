// PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 focused coverage.
//
// Proves, without any production or research-clone credential: the empty-clone
// bootstrap repair, the deterministic cursor, the hard 20-envelope page bound,
// idempotent page replay, and that the prepared migration is additive and
// read-only/service-role-only by definition.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    game_start_iso: "2026-09-14T18:00:00.000Z",
    volume_usd: 1000,
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
  const sql = readFileSync(repoRoot + "supabase/migrations/20260916140000_research_evidence_page.sql", "utf8");

  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_primary_evidence_outbox_observed/);
  assert.match(sql, /ON public\.primary_evidence_outbox \(observed_at, observation_id\)/);
  assert.match(sql, /CREATE FUNCTION public\.research_evidence_page/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.research_evidence_page/);

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
  assert.match(sql, /RAISE EXCEPTION 'research_evidence_page requires an explicit p_until upper time bound'/);
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
