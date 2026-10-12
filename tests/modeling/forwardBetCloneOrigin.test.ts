import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CLONE_ORIGIN_SOURCE_KIND, evaluateTemporalEligibility } from "../../lib/modeling/forwardBetContract";
import { resolveClients, resolveOrigin } from "../../scripts/modeling/live-shadow-cycle";

const DECISION = "2026-10-12T17:00:00.000Z";
const minus = (seconds: number) => new Date(Date.parse(DECISION) - seconds * 1000).toISOString();
const plus = (seconds: number) => new Date(Date.parse(DECISION) + seconds * 1000).toISOString();
const row = (over: Record<string, unknown> = {}) => ({
  observation_id: "o1", observed_at: minus(600), condition_id: "0xcond", selected_token_id: "tok", entry_price_num: 0.51,
  pre_event_score_num: 72, game_start_iso: plus(3600), source_kind: CLONE_ORIGIN_SOURCE_KIND, ...over,
}) as any;
const reasons = (over: Record<string, unknown>) => {
  const { eligible, rejected } = evaluateTemporalEligibility([row(over)], DECISION);
  return { eligible: eligible.length, reason: Object.entries(rejected).find(([, n]) => n > 0)?.[0] ?? null };
};

test("a fresh, pre-start, correctly sourced row is admitted unchanged and in order", () => {
  const rows = [row({ observation_id: "a" }), row({ observation_id: "b", observed_at: minus(60) })];
  const { eligible } = evaluateTemporalEligibility(rows, DECISION);
  assert.deepEqual(eligible.map((r) => r.observation_id), ["a", "b"]);
  assert.equal(eligible[0], rows[0]);
});

test("each causality violation is rejected with its own reason", () => {
  assert.deepEqual(reasons({ observed_at: plus(1) }), { eligible: 0, reason: "OBSERVED_AFTER_DECISION" });
  assert.deepEqual(reasons({ observed_at: minus(7000) }), { eligible: 0, reason: "OBSERVATION_TOO_OLD" });
  assert.deepEqual(reasons({ source_kind: "SOMETHING_ELSE" }), { eligible: 0, reason: "SOURCE_KIND_MISMATCH" });
  assert.deepEqual(reasons({ source_kind: undefined }), { eligible: 0, reason: "SOURCE_KIND_MISMATCH" });
  assert.deepEqual(reasons({ condition_id: null }), { eligible: 0, reason: "MISSING_IDENTITY" });
  assert.deepEqual(reasons({ selected_token_id: "" }), { eligible: 0, reason: "MISSING_IDENTITY" });
  assert.deepEqual(reasons({ entry_price_num: null }), { eligible: 0, reason: "INVALID_PRICE" });
  assert.deepEqual(reasons({ entry_price_num: 1 }), { eligible: 0, reason: "INVALID_PRICE" });
  assert.deepEqual(reasons({ pre_event_score_num: null }), { eligible: 0, reason: "SCORE_MISSING" });
  assert.deepEqual(reasons({ game_start_iso: null }), { eligible: 0, reason: "START_UNKNOWN" });
  assert.deepEqual(reasons({ game_start_iso: minus(10) }), { eligible: 0, reason: "START_NOT_AFTER_DECISION" });
  assert.deepEqual(reasons({ game_start_iso: plus(120) }), { eligible: 0, reason: "START_NOT_AFTER_DECISION" });
  assert.deepEqual(reasons({ signal_result: "won" }), { eligible: 0, reason: "OUTCOME_FIELD_PRESENT" });
  assert.deepEqual(reasons({ resolved_at: DECISION }), { eligible: 0, reason: "OUTCOME_FIELD_PRESENT" });
});

test("the lag bound keeps a margin below 7,200s so the database cannot reclassify an admitted row as a replay", () => {
  assert.equal(reasons({ observed_at: minus(6900) }).eligible, 1);
  assert.equal(reasons({ observed_at: minus(6901) }).reason, "OBSERVATION_TOO_OLD");
});

test("origin selection is explicit and fails closed", () => {
  assert.equal(resolveOrigin([]), "PRODUCTION_TO_CLONE");
  assert.equal(resolveOrigin(["--origin=clone"]), "CLONE_ORIGIN");
  assert.throws(() => resolveOrigin(["--origin=production"]), /UNKNOWN_SHADOW_ORIGIN/);
  assert.throws(() => resolveOrigin(["--origin"]), /UNKNOWN_SHADOW_ORIGIN/);
  assert.throws(() => resolveOrigin(["--origin=clone", "--origin=clone"]), /UNKNOWN_SHADOW_ORIGIN/);
});

test("clone-origin needs only clone credentials and refuses any other project; production mode is unchanged", () => {
  const cloneEnv = { SUPABASE_CLONE_URL: "https://nppznoujvnyjargjkmnv.supabase.co", SUPABASE_CLONE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv;
  const resolved = resolveClients("CLONE_ORIGIN", cloneEnv);
  assert.equal(resolved.source, null);
  assert.ok(resolved.clone);
  assert.throws(() => resolveClients("CLONE_ORIGIN", { ...cloneEnv, SUPABASE_CLONE_URL: "https://nbnldzfsxffztsfrrxqy.supabase.co" }), /REFUSING_NON_CLONE_TARGET/);
  assert.throws(() => resolveClients("CLONE_ORIGIN", {} as NodeJS.ProcessEnv), /MISSING_CLONE_ORIGIN_CREDENTIALS/);
  assert.throws(() => resolveClients("PRODUCTION_TO_CLONE", cloneEnv), /MISSING_RESEARCH_SHADOW_CREDENTIALS/);
  assert.throws(() => resolveClients("PRODUCTION_TO_CLONE", { ...cloneEnv, SUPABASE_URL: "https://nppznoujvnyjargjkmnv.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv), /REFUSING_NON_PRODUCTION_OR_NON_CLONE_TARGET/);
});

test("the production sync is skipped only inside the explicit clone-origin branch and the legacy Gamma corpus is not touched", () => {
  const source = readFileSync("scripts/modeling/live-shadow-cycle.ts", "utf8");
  assert.match(source, /if \(!cloneOrigin\) \{\s*const sync = await syncResearchEvidencePage\(clone, source!, bootstrapSince\);/);
  assert.equal((source.match(/syncResearchEvidencePage\(/g) ?? []).length, 1);
  assert.match(source, /const settlement = cloneOrigin\s*\?\s*\{ updatedRows: \[\] as RuntimeLedgerRow\[\]/);
  assert.match(source, /readV4DateRows\(clone, date, cloneOrigin \? \{ sourceKind: CLONE_ORIGIN_SOURCE_KIND \} : \{\}\)/);
  assert.match(source, /CLONE_ORIGIN_REQUIRES_FORWARD_CONTRACT_SCHEMA/);
});

test("the selector projection carries no outcome column", () => {
  const source = readFileSync("scripts/modeling/prospective-selection-shadow.ts", "utf8");
  const projection = source.match(/const columns = "([^"]+)"/)?.[1] ?? "";
  for (const forbidden of ["signal_result", "resolved_at", "winning_outcome", "realized_return_pct", "ingested_at"]) assert.ok(!projection.includes(forbidden), forbidden);
});
