import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GET as getDashboardAsset } from "../../app/founder/modeling/assets/[...path]/route";
import { deriveRequiredSelectionDates, persistRuntimeSnapshot, resolveSelectedUnresolved } from "../../scripts/modeling/live-shadow-cycle";

const root = process.cwd();

test("asset route serves both CAPITAL data files with JavaScript content type", async () => {
  for (const file of ["CAPITAL_MODELING_DATA.js", "FORWARD_SHADOW_DATA.js"]) {
    const response = await getDashboardAsset({} as any, { params: Promise.resolve({ path: [file] }) });
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type") ?? "", /application\/javascript/);
    assert((await response.arrayBuffer()).byteLength > 0);
  }
});

test("runtime date window advances from persisted progress and contains no fixed Sep21/Sep22 cutoff", () => {
  assert.deepEqual(deriveRequiredSelectionDates("2026-09-23", null), ["2026-09-22", "2026-09-23"]);
  assert.deepEqual(deriveRequiredSelectionDates("2026-09-23", "2026-09-23"), ["2026-09-23"]);
  assert.deepEqual(deriveRequiredSelectionDates("2026-09-24", "2026-09-23"), ["2026-09-24"]);
  assert.deepEqual(deriveRequiredSelectionDates("2026-09-25", "2026-09-23"), ["2026-09-24", "2026-09-25"]);
  const runtime = readFileSync(join(root, "scripts/modeling/live-shadow-cycle.ts"), "utf8");
  assert.doesNotMatch(runtime, /2026-09-21|2026-09-22|2026-09-20T21:00:00/);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["modeling:shadow-cycle"], /live-shadow-cycle\.ts/);
  assert.match(readFileSync(join(root, "scripts/modeling/prospective-selection-shadow.ts"), "utf8"), /PROSPECTIVE_SELECTION_REGRESSION_ONLY/);
});

test("settlement fetch scope is selected unresolved rows only and dedupes shared conditions", async () => {
  const base = {
    row_kind: "LEDGER",
    model_id: "P50_52_SAFE",
    decision_date: "2026-09-23",
    decisionTimestamp: "2026-09-23T10:00:00.000Z",
    candidateIdentity: "a",
    physicalEventKey: "event-a",
    eventStart: "2026-09-23T14:00:00.000Z",
    entryPrice: 0.5,
    sportFamily: "tennis",
    pre_event_score: 70,
    data_coverage: 80,
    settlementState: "UNQUERIED",
    settlement_checked_at: null,
    settledAt: null,
    result: null,
  };
  const ledger = [
    { ...base, row_key: "one", condition_id: "condition-a", selected_token_id: "token-a" },
    { ...base, row_key: "two", model_id: "QUALITY_FILL_D_SAFE", candidateIdentity: "b", condition_id: "condition-a", selected_token_id: "token-b" },
    { ...base, row_key: "terminal", candidateIdentity: "c", condition_id: "condition-terminal", selected_token_id: "token-c", settlementState: "WIN" },
    { ...base, row_key: "snapshot", row_kind: "SNAPSHOT", condition_id: "not-a-selected-market", selected_token_id: null },
  ] as any[];
  const calls: string[][] = [];
  const resolved = await resolveSelectedUnresolved(ledger, async (conditionIds) => {
    calls.push([...conditionIds]);
    const market = { conditionId: "condition-a", closed: true, outcomes: ["A", "B"], outcomePrices: ["1", "0"], clobTokenIds: ["token-a", "token-b"] };
    return { markets: new Map([["condition-a", market]]), respondedConditionIds: new Set(conditionIds), complete: true };
  }, "2026-09-23T12:00:00.000Z");
  assert.deepEqual(calls, [["condition-a"]]);
  assert.equal(resolved.queriedConditionN, 1);
  assert.equal(resolved.updatedRows.length, 2);
  assert.equal(resolved.updatedRows.find((row) => row.row_key === "one")?.settlementState, "WIN");
  assert.equal(resolved.updatedRows.find((row) => row.row_key === "two")?.settlementState, "LOSS");
  assert(resolved.updatedRows.every((row) => row.settledAt === "2026-09-23T12:00:00.000Z"));
});

test("provider unavailable leaves selected positions UNQUERIED", async () => {
  const row = {
    row_kind: "LEDGER", row_key: "one", condition_id: "condition-a", selected_token_id: "token-a",
    candidateIdentity: "a", decisionTimestamp: "2026-09-23T10:00:00.000Z", entryPrice: 0.5,
    model_id: "P50_52_SAFE", decision_date: "2026-09-23", physicalEventKey: "event-a", eventStart: "2026-09-23T14:00:00Z",
    sportFamily: "tennis", pre_event_score: 70, data_coverage: 80, settlementState: "UNQUERIED", settlement_checked_at: null,
  } as any;
  const result = await resolveSelectedUnresolved([row], async () => ({ markets: new Map(), respondedConditionIds: new Set(), complete: false }));
  assert.equal(result.complete, false);
  assert.equal(result.updatedRows.length, 0);
  assert.equal(row.settlementState, "UNQUERIED");
});

test("runtime snapshot persistence writes one sanitized current row", async () => {
  const calls: any[] = [];
  const client = { from(table: string) { return { async upsert(row: unknown, options: unknown) { calls.push({ table, row, options }); return { error: null }; } }; } };
  const snapshot = { status: "OK", generatedAt: "2026-09-23T12:00:00.000Z", models: [{ model: "P50_52_SAFE" }] };
  await persistRuntimeSnapshot(client as any, snapshot, "2026-09-23T12:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "prospective_selection_shadow_runtime");
  assert.equal(calls[0].row.row_key, "CURRENT");
  assert.equal(calls[0].row.row_kind, "SNAPSHOT");
  assert.deepEqual(calls[0].row.snapshot_payload, snapshot);
});

test("clone snapshot RLS keeps the exact ledger private", () => {
  const schema = readFileSync(join(root, "ops/research-clone/prospective-selection-shadow-runtime-schema.sql"), "utf8");
  assert.match(schema, /enable row level security/i);
  assert.match(schema, /grant select \(row_key, row_kind, snapshot_payload, updated_at\)[\s\S]+to anon/i);
  assert.match(schema, /using \(row_kind = 'SNAPSHOT' and row_key = 'CURRENT'\)/i);
  assert.match(schema, /revoke all on public\.prospective_selection_shadow_runtime from public, anon, authenticated/i);
  assert.match(schema, /grant all on public\.prospective_selection_shadow_runtime to service_role/i);
});

test("CAPITAL dashboard fetches live shadow without cache and labels static data as fallback", () => {
  const html = readFileSync(join(root, "modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html"), "utf8");
  assert.match(html, /fetch\("\/api\/founder\/modeling\/shadow", \{ cache: "no-store" \}\)/);
  assert.match(html, /STATIC FALLBACK ONLY/);
  assert.match(html, /LAST REFRESH/);
  assert.match(html, /SETTLEMENT FRESH THROUGH/);
  assert.match(html, /PNL FRESH THROUGH/);
  assert.match(html, /Selected today/i);
});

test("30-minute job command is defined without scheduling nightly modeling work", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["modeling:shadow-cycle"], "tsx scripts/modeling/live-shadow-cycle.ts");
  assert.doesNotMatch(pkg.scripts["modeling:shadow-cycle"], /model-ready|modeling-dashboard:refresh/);
});
