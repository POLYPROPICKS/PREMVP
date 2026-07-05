import test from "node:test";
import assert from "node:assert/strict";
import {
  assessSourceFreshness,
  buildDisplayRows,
  filterAlreadyMaterialized,
  normalizeProbability,
  runDisplayMaterializer,
  type GeneratedPairSourceRow,
  type MaterializerDeps,
} from "../../lib/track-record/displayMaterializer";
import { SOURCE_SELECT } from "../../scripts/materialize-track-record-display";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("package.json exposes Railway-safe daily display write script", () => {
  const pkgPath = fileURLToPath(
    new URL("../../package.json", import.meta.url)
  );
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  const dailyDisplay = scripts["track-record:display:daily:write"];
  assert.ok(
    dailyDisplay,
    "track-record:display:daily:write script must exist"
  );
  assert.match(dailyDisplay, /track-record:display:materialize -- --write/);
  assert.match(dailyDisplay, /refresh:track-record:write/);

  // Must NOT use the old resolver path.
  assert.equal(
    dailyDisplay.includes("priority-track-record-display"),
    false,
    "daily display script must not use the old resolver flag"
  );
  const oldDaily = scripts["track-record:daily:write"] ?? "";
  assert.notEqual(
    dailyDisplay,
    oldDaily,
    "daily display script must not equal the old daily:write script"
  );
  assert.equal(
    dailyDisplay.includes("track-record:daily:write"),
    false,
    "daily display script must not call the old daily:write script"
  );
});

const NOW_ISO = "2026-07-05T08:00:00.000Z";

function makeSourceRow(
  overrides: Partial<GeneratedPairSourceRow> = {}
): GeneratedPairSourceRow {
  return {
    id: "row-1",
    created_at: "2026-07-05T02:00:00.000Z",
    expires_at: "2026-07-08T00:00:00.000Z",
    event_slug: "Team A vs Team B",
    market_slug: "Will Team A beat Team B?",
    condition_id: "0xabc",
    selected_outcome: "Team A",
    entry_price_num: 0.5,
    score: 80,
    signal_confidence_num: 62,
    metric_formula_version: "v2-lite-growth-safe",
    premium_signal: {
      eventTitle: "Team A vs Team B",
      position: "Team A",
      profit: "+38%",
      winProbability: 62,
      actionLabel: "ENTER",
    },
    ...overrides,
  };
}

test("builds display rows with correct batch_day/rank/block/slot/source_row_id", () => {
  const rows: GeneratedPairSourceRow[] = Array.from({ length: 12 }, (_, i) =>
    makeSourceRow({ id: `row-${i + 1}`, score: 100 - i })
  );

  const display = buildDisplayRows({ sourceRows: rows, nowIso: NOW_ISO });

  assert.equal(display.length, 12);
  assert.equal(display[0].source_row_id, "row-1");
  assert.equal(display[0].batch_day, "2026-07-05");
  assert.equal(display[0].window_days, 14);
  assert.equal(display[0].score_rank, 1);
  assert.equal(display[0].block_10, 1);
  assert.equal(display[0].slot_in_10, 1);
  // 11th ranked row rolls into the second block of 10.
  assert.equal(display[10].score_rank, 11);
  assert.equal(display[10].block_10, 2);
  assert.equal(display[10].slot_in_10, 1);
  assert.equal(display[0].generated_at, "2026-07-05T02:00:00.000Z");
  assert.equal(display[0].latest_batch_at, NOW_ISO);
  assert.equal(display[0].event_title, "Team A vs Team B");
  assert.equal(display[0].market_question, "Will Team A beat Team B?");
  assert.equal(display[0].selected_outcome, "Team A");
  assert.equal(display[0].market_price, 0.5);
  assert.equal(display[0].decimal_odds, 2);
  assert.equal(display[0].american_odds, 100);
  assert.equal(display[0].odds_source_path, "entry_price_num");
  assert.equal(display[0].stake_usd, 100);
  assert.equal(display[0].projected_pnl_units, 1);
  assert.equal(display[0].projected_return_usd, 100);
  assert.equal(display[0].projected_roi_pct_per_signal, 100);
  assert.equal(display[0].status, "shown");
  assert.equal(display[0].action, "ENTER");
  assert.equal(display[0].return_label, "+38%");
  assert.equal(display[0].match_key, "team a vs team b");
  assert.equal(display[0].signal_key, "team a vs team b|Team A");
});

test("ranking is deterministic and default limit caps at 25", () => {
  const rows: GeneratedPairSourceRow[] = Array.from({ length: 30 }, (_, i) =>
    makeSourceRow({ id: `row-${String(i).padStart(2, "0")}`, score: 50 })
  );
  const a = buildDisplayRows({ sourceRows: rows, nowIso: NOW_ISO });
  const b = buildDisplayRows({
    sourceRows: [...rows].reverse(),
    nowIso: NOW_ISO,
  });
  assert.equal(a.length, 25);
  assert.deepEqual(
    a.map((r) => r.source_row_id),
    b.map((r) => r.source_row_id)
  );
});

test("stale generated pairs produce NO_FRESH_GENERATED_SIGNAL_PAIRS", () => {
  const stale = [makeSourceRow({ created_at: "2026-07-03T00:00:00.000Z" })];
  const verdict = assessSourceFreshness({
    sourceRows: stale,
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(verdict.fresh, false);
  assert.equal(verdict.verdict, "NO_FRESH_GENERATED_SIGNAL_PAIRS");

  const empty = assessSourceFreshness({
    sourceRows: [],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(empty.verdict, "NO_FRESH_GENERATED_SIGNAL_PAIRS");

  const fresh = assessSourceFreshness({
    sourceRows: [makeSourceRow()],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.verdict, "FRESH");
});

test("idempotency: filters existing (batch_day, window_days, source_row_id) rows", () => {
  const display = buildDisplayRows({
    sourceRows: [
      makeSourceRow({ id: "row-1" }),
      makeSourceRow({ id: "row-2", score: 70 }),
    ],
    nowIso: NOW_ISO,
  });
  const remaining = filterAlreadyMaterialized(display, [
    { batch_day: "2026-07-05", window_days: 14, source_row_id: "row-1" },
    // Different window_days must NOT block row-2.
    { batch_day: "2026-07-05", window_days: 7, source_row_id: "row-2" },
  ]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source_row_id, "row-2");
});

function makeDeps(sourceRows: GeneratedPairSourceRow[]): {
  deps: MaterializerDeps;
  insertCalls: number;
} {
  const state = { insertCalls: 0 };
  const deps: MaterializerDeps = {
    fetchFreshSourceRows: async () => sourceRows,
    fetchExistingDisplayKeys: async () => [],
    insertDisplayRows: async (rows) => {
      state.insertCalls += 1;
      return rows.length;
    },
  };
  return {
    deps,
    get insertCalls() {
      return state.insertCalls;
    },
  } as { deps: MaterializerDeps; insertCalls: number };
}

test("default dry-run returns insert count 0 and does not call insert", async () => {
  const harness = makeDeps([makeSourceRow()]);
  const result = await runDisplayMaterializer(harness.deps, {
    nowIso: NOW_ISO,
  });
  assert.equal(result.verdict, "DRY_RUN_OK");
  assert.equal(result.insertedCount, 0);
  assert.equal(result.plannedCount, 1);
  assert.equal(harness.insertCalls, 0);
});

test("stale source fails safe even in write mode without override", async () => {
  const harness = makeDeps([
    makeSourceRow({ created_at: "2026-07-01T00:00:00.000Z" }),
  ]);
  const result = await runDisplayMaterializer(harness.deps, {
    nowIso: NOW_ISO,
    write: true,
  });
  assert.equal(result.verdict, "NO_FRESH_GENERATED_SIGNAL_PAIRS");
  assert.equal(result.insertedCount, 0);
  assert.equal(harness.insertCalls, 0);
});

test("write mode inserts only missing rows (idempotent rerun inserts 0)", async () => {
  const source = [makeSourceRow({ id: "row-1" })];
  const state = { insertCalls: 0, inserted: [] as string[] };
  const deps: MaterializerDeps = {
    fetchFreshSourceRows: async () => source,
    fetchExistingDisplayKeys: async () =>
      state.inserted.map((id) => ({
        batch_day: "2026-07-05",
        window_days: 14,
        source_row_id: id,
      })),
    insertDisplayRows: async (rows) => {
      state.insertCalls += 1;
      state.inserted.push(...rows.map((r) => r.source_row_id));
      return rows.length;
    },
  };

  const first = await runDisplayMaterializer(deps, {
    nowIso: NOW_ISO,
    write: true,
  });
  assert.equal(first.verdict, "WRITE_OK");
  assert.equal(first.insertedCount, 1);

  const second = await runDisplayMaterializer(deps, {
    nowIso: NOW_ISO,
    write: true,
  });
  assert.equal(second.verdict, "WRITE_OK");
  assert.equal(second.insertedCount, 0);
  assert.equal(second.skippedExistingCount, 1);
  assert.equal(state.insertCalls, 1);
});

test("freshness prefers generated_at and falls back to created_at", () => {
  // generated_at fresh, created_at stale → fresh.
  const byGenerated = assessSourceFreshness({
    sourceRows: [
      { generated_at: "2026-07-05T06:00:00.000Z", created_at: "2026-07-01T00:00:00.000Z" },
    ],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(byGenerated.fresh, true);
  assert.equal(byGenerated.latestGeneratedAt, "2026-07-05T06:00:00.000Z");

  // generated_at null → created_at fallback keeps row fresh.
  const byCreated = assessSourceFreshness({
    sourceRows: [{ generated_at: null, created_at: "2026-07-05T02:00:00.000Z" }],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(byCreated.fresh, true);
});

test("normalizeProbability handles pct-style, fraction-style, and junk", () => {
  assert.equal(normalizeProbability(59), 0.59);
  assert.equal(normalizeProbability(0.535), 0.535);
  assert.equal(normalizeProbability(1), 1);
  assert.equal(normalizeProbability(100), 1);
  assert.equal(normalizeProbability(0), null);
  assert.equal(normalizeProbability(101), null);
  assert.equal(normalizeProbability(-5), null);
  assert.equal(normalizeProbability(null), null);
  assert.equal(normalizeProbability(undefined), null);
});

test("projected probabilities are normalized: 0..1 and 0..100", () => {
  const pct = buildDisplayRows({
    sourceRows: [makeSourceRow({ signal_confidence_num: 59 })],
    nowIso: NOW_ISO,
  })[0];
  assert.equal(pct.projected_win_probability, 0.59);
  assert.equal(pct.projected_win_rate_pct, 59);

  const frac = buildDisplayRows({
    sourceRows: [makeSourceRow({ signal_confidence_num: 0.535 })],
    nowIso: NOW_ISO,
  })[0];
  assert.equal(frac.projected_win_probability, 0.535);
  assert.equal(frac.projected_win_rate_pct, 53.5);
});

test("quality guard rejects placeholder 'Live market activity' rows", () => {
  const rows = buildDisplayRows({
    sourceRows: [
      makeSourceRow({
        event_title: null,
        market_question: null,
        event_slug: null,
        market_slug: "Live market activity",
        premium_signal: null,
      }),
    ],
    nowIso: NOW_ISO,
  });
  assert.equal(rows.length, 0);
});

test("quality guard rejects rows without selected_outcome or valid entry price", () => {
  assert.equal(
    buildDisplayRows({
      sourceRows: [makeSourceRow({ selected_outcome: null })],
      nowIso: NOW_ISO,
    }).length,
    0
  );
  for (const bad of [null, 0, 1, 1.2, -0.3]) {
    assert.equal(
      buildDisplayRows({
        sourceRows: [makeSourceRow({ entry_price_num: bad })],
        nowIso: NOW_ISO,
      }).length,
      0,
      `entry_price_num=${bad} must be rejected`
    );
  }
});

test("derives event_title and market_question from readable market_slug", () => {
  const row = buildDisplayRows({
    sourceRows: [
      makeSourceRow({
        event_title: null,
        market_question: null,
        event_slug: null,
        market_slug: "Brazil vs. Norway: O/U 9.5 Total Corners",
        premium_signal: null,
      }),
    ],
    nowIso: NOW_ISO,
  })[0];
  assert.ok(row, "row must be materialized");
  assert.equal(row.event_title, "Brazil vs. Norway");
  assert.equal(row.market_question, "Brazil vs. Norway: O/U 9.5 Total Corners");
});

test("prefers real source event_title/market_question columns when present", () => {
  const row = buildDisplayRows({
    sourceRows: [
      makeSourceRow({
        event_title: "Real Event",
        market_question: "Real question?",
      }),
    ],
    nowIso: NOW_ISO,
  })[0];
  assert.equal(row.event_title, "Real Event");
  assert.equal(row.market_question, "Real question?");
});

test("materializes and stays fresh when generated_at column is absent from source (DB-read shape)", () => {
  // Mirrors production: generated_signal_pairs has no physical generated_at
  // column, so DB-read source rows never carry that field at all.
  const { generated_at, ...dbReadRow } = makeSourceRow();
  assert.equal("generated_at" in dbReadRow, false);

  const freshness = assessSourceFreshness({
    sourceRows: [dbReadRow as GeneratedPairSourceRow],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(freshness.fresh, true);

  const row = buildDisplayRows({
    sourceRows: [dbReadRow as GeneratedPairSourceRow],
    nowIso: NOW_ISO,
  })[0];
  assert.ok(row, "row must be materialized");
  assert.equal(row.generated_at, dbReadRow.created_at);
});

test("every materialized row carries a non-null created_at defaulting to nowIso", () => {
  const rows = buildDisplayRows({
    sourceRows: [makeSourceRow({ id: "row-1" }), makeSourceRow({ id: "row-2" })],
    nowIso: NOW_ISO,
  });
  assert.ok(rows.length > 0, "rows must be materialized");
  for (const row of rows) {
    assert.ok(row.created_at, "created_at must be non-null");
    assert.equal(row.created_at, NOW_ISO);
  }
});

test("created_at equals the injected materialization timestamp when provided", () => {
  const MATERIALIZED_AT = "2026-07-05T09:30:00.000Z";
  const rows = buildDisplayRows({
    sourceRows: [makeSourceRow()],
    nowIso: NOW_ISO,
    materializedAt: MATERIALIZED_AT,
  });
  assert.equal(rows[0].created_at, MATERIALIZED_AT);
  // created_at is materialization time, distinct from source generated_at.
  assert.notEqual(rows[0].created_at, rows[0].generated_at);
});

test("write-path insert payload includes non-null created_at", async () => {
  const MATERIALIZED_AT = "2026-07-05T09:45:00.000Z";
  const source = [makeSourceRow({ id: "row-1" })];
  const captured: Array<{ created_at: string }> = [];
  const deps: MaterializerDeps = {
    fetchFreshSourceRows: async () => source,
    fetchExistingDisplayKeys: async () => [],
    insertDisplayRows: async (rows) => {
      captured.push(...rows);
      return rows.length;
    },
  };
  const result = await runDisplayMaterializer(deps, {
    nowIso: NOW_ISO,
    write: true,
    materializedAt: MATERIALIZED_AT,
  });
  assert.equal(result.verdict, "WRITE_OK");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].created_at, MATERIALIZED_AT);
});

test("odds_source_path matches the production CHECK constraint value", () => {
  // The production track_record_display_signals_odds_source_path_check only
  // permits bare "entry_price_num"; a dotted path violates the constraint.
  const rows = buildDisplayRows({
    sourceRows: [makeSourceRow({ id: "row-1" }), makeSourceRow({ id: "row-2" })],
    nowIso: NOW_ISO,
  });
  assert.ok(rows.length > 0, "rows must be materialized");
  for (const row of rows) {
    assert.equal(row.odds_source_path, "entry_price_num");
  }
});

test("write-path payload carries only the allowed odds_source_path", async () => {
  const source = [makeSourceRow({ id: "row-1" })];
  const captured: Array<{ odds_source_path: string }> = [];
  const deps: MaterializerDeps = {
    fetchFreshSourceRows: async () => source,
    fetchExistingDisplayKeys: async () => [],
    insertDisplayRows: async (rows) => {
      captured.push(...rows);
      return rows.length;
    },
  };
  const result = await runDisplayMaterializer(deps, { nowIso: NOW_ISO, write: true });
  assert.equal(result.verdict, "WRITE_OK");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].odds_source_path, "entry_price_num");
});

test("source select never names optional non-guaranteed display columns", () => {
  // Regression guard: a fixed column list breaks with "column ... does not
  // exist" the moment production generated_signal_pairs lacks one of these
  // optional fields. select("*") avoids that class of failure entirely.
  for (const forbidden of ["generated_at", "event_title", "market_question"]) {
    assert.equal(
      SOURCE_SELECT.includes(forbidden),
      false,
      `SOURCE_SELECT must not name optional column "${forbidden}"`
    );
  }
});

test("materializes from a minimal DB-read row lacking generated_at/event_title/market_question", () => {
  // Mirrors a production select("*") result where only guaranteed columns
  // are present: no generated_at, no event_title, no market_question.
  const minimalRow = {
    id: "row-minimal",
    created_at: "2026-07-05T02:00:00.000Z",
    expires_at: null,
    event_slug: null,
    market_slug: "Brazil vs. Norway: O/U 9.5 Total Corners",
    condition_id: "0xabc",
    selected_outcome: "Over",
    entry_price_num: 0.5,
    score: 80,
    signal_confidence_num: 62,
    metric_formula_version: "v2-lite-growth-safe",
    premium_signal: null,
  } as GeneratedPairSourceRow;
  assert.equal("generated_at" in minimalRow, false);
  assert.equal("event_title" in minimalRow, false);
  assert.equal("market_question" in minimalRow, false);

  const freshness = assessSourceFreshness({
    sourceRows: [minimalRow],
    nowIso: NOW_ISO,
    maxAgeHours: 36,
  });
  assert.equal(freshness.fresh, true);

  const row = buildDisplayRows({ sourceRows: [minimalRow], nowIso: NOW_ISO })[0];
  assert.ok(row, "row must be materialized");
  assert.equal(row.event_title, "Brazil vs. Norway");
  assert.equal(row.market_question, "Brazil vs. Norway: O/U 9.5 Total Corners");
  assert.equal(row.generated_at, minimalRow.created_at);
});
