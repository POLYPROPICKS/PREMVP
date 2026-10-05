// T10_SIBLING_OFFPOLICY_V1 runner: bounded settlement lookups, end-to-end evaluation, artifacts, clone materialization + schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  OFFPOLICY_TABLE, materializeDataset, normalizeObservation, renderMarkdown, runSiblingOffPolicy, settleSiblings, toMaterializedRow, writeArtifacts,
  type SiblingSourcePort,
} from "../../scripts/modeling/t10-sibling-offpolicy";
import type { SiblingObservationRow } from "../../lib/modeling/t10-offpolicy/siblingOffPolicy";
import type { GammaMarket } from "../../lib/feed/resolveSignalOutcome";

const mkt = (conditionId: string, winner: 0 | 1 | null, tokens: [string, string]): GammaMarket => ({
  conditionId, closed: winner !== null, active: winner === null,
  outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(tokens),
  outcomePrices: JSON.stringify(winner === null ? ["0.5", "0.5"] : winner === 0 ? ["1", "0"] : ["0", "1"]),
});
const obs = (over: Partial<SiblingObservationRow>): SiblingObservationRow => ({
  physical_event_id: "ev1", provider_event_id: "1", event_start_iso: "2026-10-03T16:00:00.000Z", observed_at: "2026-10-03T15:50:00.000Z",
  condition_id: "c1", token_id: "t1", side: "Yes", canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", provider_market_type_raw: "moneyline",
  best_bid: 0.48, best_ask: 0.5, tick_size: 0.01, minimum_order_size: 5, orderbook_fetch_status: "SUCCESS", ask_depth_relevant_usd: null, sport_family: "soccer", ...over,
});

test("settlement lookups: one call per condition, both tokens settle from it, a dead provider is typed (never a loss, never a throw)", async () => {
  const calls: string[] = [];
  const rows = [obs({}), obs({ token_id: "t2", side: "No" }), obs({ condition_id: "dead", token_id: "d1" }), obs({ condition_id: "x", token_id: "x1", canonical_market_family: "OTHER_STRUCTURED" })];
  const out = await settleSiblings(rows, async (c) => { calls.push(c); if (c === "dead") throw new Error("boom"); return mkt(c, 0, ["t1", "t2"]); }, { timeoutMs: 50 });
  assert.deepEqual(calls.filter((c) => c === "c1"), ["c1"], "one lookup for the shared market");
  assert.equal(out.byKey.get("c1|t1")?.state, "SETTLED_WIN");
  assert.equal(out.byKey.get("c1|t2")?.state, "SETTLED_LOSS");
  assert.equal(out.byKey.get("dead|d1")?.state, "SOURCE_UNAVAILABLE");
  assert.equal(calls.filter((c) => c === "dead").length, 2, "one retry");
  assert.equal(out.conditions_n, 2, "unsupported family is not looked up");
  assert.equal(out.source_unavailable_conditions_n, 1);
});

test("a hung provider call is bounded by the timeout", async () => {
  const started = Date.now();
  const out = await settleSiblings([obs({})], () => new Promise(() => {}), { timeoutMs: 30 });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(out.byKey.get("c1|t1")?.state, "SOURCE_UNAVAILABLE");
});

const port = (rows: SiblingObservationRow[]): SiblingSourcePort => ({ readSiblings: async () => rows });

async function fixtureRun() {
  const rows = [
    obs({ physical_event_id: "ev1", condition_id: "a", token_id: "a1", best_ask: 0.55 }),
    obs({ physical_event_id: "ev1", condition_id: "b", token_id: "b1", best_ask: 0.5, canonical_market_family: "SPREADS" }),
    obs({ physical_event_id: "ev2", condition_id: "c", token_id: "c1", best_ask: 0.52, sport_family: "tennis", event_start_iso: "2026-10-04T12:00:00.000Z", observed_at: "2026-10-04T11:50:00.000Z" }),
    obs({ physical_event_id: "ev3", condition_id: "d", token_id: "d1", best_ask: 0.58, event_start_iso: "2026-10-05T12:00:00.000Z", observed_at: "2026-10-05T11:50:00.000Z" }),
  ];
  const markets: Record<string, GammaMarket> = {
    a: mkt("a", 0, ["a1", "a2"]), b: mkt("b", 1, ["b0", "b1"]), c: mkt("c", 0, ["c1", "c2"]), d: mkt("d", null, ["d1", "d2"]),
  };
  return runSiblingOffPolicy({
    port: port(rows), fetchMarket: async (c) => markets[c] ?? null, start: "2026-10-03", end: "2026-10-05",
    sourceChannel: "test", now: () => new Date("2026-10-06T00:00:00.000Z"),
  });
}

test("end to end: coverage, one common denominator, three separate views, unresolved counted not lost", async () => {
  const { report, dataset } = await fixtureRun();
  assert.equal(dataset.length, 4);
  assert.equal(report.coverage.supported_siblings_n, 4);
  assert.equal(report.coverage.settled_siblings_n, 3);
  assert.equal(report.coverage.unresolved_siblings_n, 1);
  assert.equal(report.coverage.common_physical_events_n, 2);
  assert.deepEqual(Object.keys(report.evaluations).sort(), ["EXECUTABLE_PROVEN", "EXECUTABLE_UPPER_BOUND", "RAW"]);
  for (const view of Object.values(report.evaluations)) {
    assert.deepEqual(view.map((e) => e.model), ["C0", "C1", "C4", "C5"]);
    assert.ok(view.every((e) => e.common_processed_physical_events_n === 2), "same denominator everywhere");
  }
  const rawC0 = report.evaluations.RAW[0];
  assert.equal(rawC0.unresolved_qualifying_siblings_n, 1);
  assert.equal(report.evaluations.EXECUTABLE_PROVEN[0].selected_physical_events_n, 0);
  assert.match(report.notes.join(" "), /NOT an executable return/);
});

test("artifacts: markdown names the denominators and views; the dataset is a faithful gz JSONL", async () => {
  const { report, dataset } = await fixtureRun();
  const md = renderMarkdown(report);
  assert.match(md, /common physical-event denominator/);
  for (const view of ["## RAW", "## EXECUTABLE_UPPER_BOUND", "## EXECUTABLE_PROVEN"]) assert.ok(md.includes(view), view);
  const dir = mkdtempSync(join(tmpdir(), "t10-offpolicy-"));
  const [json, mdPath, gz] = writeArtifacts(report, dataset, dir);
  assert.equal(JSON.parse(readFileSync(json, "utf8")).coverage.supported_siblings_n, 4);
  assert.ok(readFileSync(mdPath, "utf8").length > 100);
  const lines = gunzipSync(readFileSync(gz)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], JSON.parse(JSON.stringify(dataset[0])));
});

test("normalizeObservation: numeric strings become numbers; an ambiguous provider family stays NULL", () => {
  const raw = { physical_event_id: "e", provider_event_id: "9", event_start_iso: "2026-10-03 16:00:00+00", observed_at: "2026-10-03 15:50:00+00", condition_id: "c", token_id: "t", side: "Yes",
    canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", provider_market_type_raw: "moneyline", best_bid: "0.48", best_ask: "0.5", tick_size: null, minimum_order_size: "5",
    orderbook_fetch_status: "SUCCESS", ask_depth_relevant_usd: null, taker_fee_usd: "0.0375" };
  const one = normalizeObservation(raw, new Map([["9", new Set(["soccer"])]]));
  assert.deepEqual([one.best_ask, one.minimum_order_size, one.tick_size, one.sport_family, one.taker_fee_usd], [0.5, 5, null, "soccer", 0.0375]);
  assert.equal(one.event_start_iso, "2026-10-03T16:00:00.000Z");
  assert.equal(normalizeObservation(raw, new Map([["9", new Set(["soccer", "tennis"])]])).sport_family, null);
  assert.equal(normalizeObservation(raw, new Map()).sport_family, null);
});

test("materialization: upserts on the identity key in batches; a write error fails loudly", async () => {
  const { dataset } = await fixtureRun();
  const calls: Array<{ table: string; n: number; onConflict: string }> = [];
  const client = { from: (table: string) => ({ upsert: async (rows: unknown[], o: { onConflict: string }) => { calls.push({ table, n: rows.length, onConflict: o.onConflict }); return { error: null }; } }) };
  assert.equal(await materializeDataset(client as never, dataset, new Date("2026-10-06T00:00:00Z")), 4);
  assert.deepEqual(calls, [{ table: OFFPOLICY_TABLE, n: 4, onConflict: "dataset_version,physical_event_id,condition_id,token_id,side,decision_at" }]);
  const failing = { from: () => ({ upsert: async () => ({ error: { code: "42P01", message: "x" } }) }) };
  await assert.rejects(materializeDataset(failing as never, dataset), /OFFPOLICY_MATERIALIZE_WRITE:42P01/);
});

test("clone schema: every materialized column exists, the primary key is the upsert key, and the registered clone-schema allowlist accepts the file", async () => {
  const { dataset } = await fixtureRun();
  const sql = readFileSync("ops/research-clone/t10-sibling-offpolicy-schema.sql", "utf8");
  const cols = Object.keys(toMaterializedRow(dataset[0], "2026-10-06T00:00:00.000Z"));
  for (const c of cols) assert.match(sql, new RegExp(`\\n  ${c} `), `schema column: ${c}`);
  assert.match(sql, /PRIMARY KEY \(dataset_version, physical_event_id, condition_id, token_id, side, decision_at\)/);
  const transport = await import("../../scripts/control-plane/lib/premvp-migration-https-transport.mjs");
  const safe = transport.assertCloneSqlSafe(sql);
  assert.deepEqual(safe.statement_kinds, { create_table_if_not_exists: 1, create_index_if_not_exists: 1, enable_row_level_security: 1, revoke: 1, grant_to_service_role: 1 });
  assert.equal(transport.validateCloneSchemaDeclaration({ mode: transport.CLONE_SCHEMA_MODE, schema_file: "ops/research-clone/t10-sibling-offpolicy-schema.sql", target_sha256: "0".repeat(64), project_ref: "nppznoujvnyjargjkmnv", idempotent: true, direct_raw_mutation: false, verify_columns: [{ schema: "public", table: OFFPOLICY_TABLE, columns: ["dataset_version"] }] }).ok, true);
});
