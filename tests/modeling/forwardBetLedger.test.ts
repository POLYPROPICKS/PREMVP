import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildForwardBetColumns,
  canonicalGame,
  extractTeamPair,
  classifyForwardTiming,
  classifyMarketFamily,
  classifyPeriodScope,
  excludeExistingEconomicUnits,
  hasExecutableAuthority,
  isForwardPreMatch,
  parseSelectedLine,
} from "../../lib/modeling/forwardBetContract";
import { insertChoices, probeForwardContractSchema, runtimeRow, toDatabaseLedger } from "../../scripts/modeling/live-shadow-cycle";
import { selectedByModel, type V4EvidenceRow } from "../../scripts/modeling/prospective-selection-shadow";

const evidence = (i: number, price: number, extra: Record<string, unknown> = {}): V4EvidenceRow & Record<string, unknown> => ({
  observation_id: `o${i}`, observed_at: `2026-10-12T10:0${i}:00.000Z`, item_observation_id: `i${i}`,
  condition_id: `0xcond${i}`, selected_token_id: `tok${i}`, entry_price_num: price, pre_event_score_num: 64,
  provider_event_id: `EV${i}`, provider_sport_family: "tennis", market_type: "moneyline",
  event_title: `Player A${i} vs Player B${i}`, market_question: `Open: Player A${i} vs Player B${i}`,
  game_start_iso: "2026-10-12T17:00:00.000Z", data_coverage: 80, selected_outcome: `Player A${i}`, ...extra,
});

test("selection invariance: a future outcome in the evidence rows cannot change the original BET set", () => {
  const baseline = selectedByModel([evidence(1, 0.505), evidence(2, 0.51), evidence(3, 0.7)], "2026-10-12");
  const withFuture = selectedByModel([
    evidence(1, 0.505, { signal_result: "lost", settled_at: "2026-10-13T00:00:00Z", winner_token_id: "tok-x" }),
    evidence(2, 0.51, { signal_result: "won", result: "WIN" }),
    evidence(3, 0.7, { signal_result: "won" }),
  ], "2026-10-12");
  for (const [model, bets] of baseline.capped) assert.deepEqual(withFuture.capped.get(model)!.map((b) => b.candidateIdentity), bets.map((b) => b.candidateIdentity), model);
  assert.equal(baseline.capped.get("P50_52_SAFE")!.length, 2);
  const reader = readFileSync(join(process.cwd(), "scripts/modeling/prospective-selection-shadow.ts"), "utf8");
  const projection = /const columns = "([^"]+)"/.exec(reader)![1];
  assert.doesNotMatch(projection, /signal_result|settle|winner|result/);
  // the selected side is a pre-decision fact and must be read, or every row would be INCOMPLETE:selected_outcome
  assert.match(projection, /selected_outcome/);
});

test("one model x canonical physical game: cross-date reselection is the same economic unit", () => {
  const chosen = [{ physicalEventKey: "EV1" }, { physicalEventKey: "EV2" }, { physicalEventKey: "EV2" }];
  const existing = [{ model_id: "P50_52_SAFE", physicalEventKey: "EV1" }, { model_id: "OTHER_SAFE", physicalEventKey: "EV2" }];
  const result = excludeExistingEconomicUnits("P50_52_SAFE", chosen, existing);
  assert.deepEqual(result.fresh, [{ physicalEventKey: "EV2" }]);
  assert.equal(result.blockedDuplicateUnitN, 2);
  const shard = (providerEventId: string, title: string) => canonicalGame({ sportFamily: "soccer", providerEventId, eventTitle: title, marketQuestion: null, scheduledStartIso: "2026-10-12T19:15:00Z" });
  // soccer "more markets" shards carry their own provider event id but are the same fixture
  assert.equal(shard("1104527", "FC Famalicão vs. FC Alverca").key, shard("1107765", "Fc Alverca vs FC Famalicao - More Markets").key);
  assert.equal(shard("1104527", "FC Famalicão vs. FC Alverca").basis, "TEAM_PAIR_START_TEXT");
  // another fixture with the same team pair at another time is another game
  assert.notEqual(shard("1", "A vs B").key, canonicalGame({ sportFamily: "soccer", providerEventId: "1", eventTitle: "A vs B", scheduledStartIso: "2026-10-19T19:15:00Z" }).key);
  // unparsed or start-less shards fall back to the provider event and are flagged unverified
  const fallback = canonicalGame({ sportFamily: "Tennis", providerEventId: "1174651", eventTitle: "Spread: Stal (-4.5)", scheduledStartIso: "2026-10-12T17:00:00Z" });
  assert.deepEqual([fallback.key, fallback.basis], ["tennis:pe:1174651", "PROVIDER_EVENT_ONLY"]);
  assert.equal(canonicalGame({ sportFamily: "tennis", providerEventId: null }).key, null);
  assert.deepEqual(extractTeamPair("W100 Edmond, OK: Chloe Noel vs Valeriya Strakhova"), ["chloe noel", "valeriya strakhova"]);
  assert.deepEqual(extractTeamPair("Counter-Strike: HOTU vs fnatic (BO3) - Stake Pulse Beat III Group C"), ["fnatic", "hotu"]);
  assert.deepEqual(extractTeamPair("Honor of Kings: JD Gaming vs Rogue Warriors - Game 1 Winner"), ["jd gaming", "rogue warriors"]);
  assert.equal(extractTeamPair("Games Total: O/U 4.5"), null);
  // an existing bet through another shard of the same fixture blocks a new one
  const viaShard = excludeExistingEconomicUnits("P50_52_SAFE", [{ physicalEventKey: "E-2", g: "k1" }, { physicalEventKey: "E-3", g: "k2" }],
    [{ model_id: "P50_52_SAFE", physicalEventKey: "E-1", canonical_game_key: "k1" }], (c) => c.g);
  assert.deepEqual(viaShard.fresh.map((c) => c.physicalEventKey), ["E-3"]);
});

test("forward columns carry identity, times, numeric reference price and no fabricated executable price or actual kickoff", () => {
  const source = evidence(1, 0.505);
  const [candidate] = selectedByModel([source], "2026-10-12").capped.get("P50_52_SAFE")!;
  const columns = buildForwardBetColumns({ model: "P50_52_SAFE", source, candidate, decisionGeneratedAt: "2026-10-12T10:02:00.000Z" });
  assert.equal(columns.contract_version, "FORWARD_BET_V1");
  assert.equal(columns.canonical_game_key, "tennis:player a1|player b1@2026-10-12T17:00:00.000Z");
  assert.equal(columns.economic_unit_key, columns.canonical_game_key);
  assert.equal(columns.game_identity_basis, "TEAM_PAIR_START_TEXT");
  assert.equal(columns.scope_basis, "STRUCTURED_MONEYLINE");
  assert.equal(columns.reference_price, 0.505);
  assert.equal(columns.reference_price_type, "EVIDENCE_REFERENCE_NOT_EXECUTABLE");
  assert.equal(columns.observed_at, source.observed_at);
  assert.equal(columns.decision_generated_at, "2026-10-12T10:02:00.000Z");
  assert.equal(columns.scheduled_start_at, source.game_start_iso);
  assert.equal(columns.authoritative_start_at, null);
  assert.equal(columns.executable_buy_price, null);
  assert.equal(columns.executable_price_authority, null);
  assert.equal(columns.selection_reason.length > 10, true);
  assert.equal(hasExecutableAuthority(columns), false);
  assert.equal(hasExecutableAuthority({ executable_buy_price: 0.52, executable_price_authority: "CLOB_BEST_ASK" }), true);
  // database payload: legacy columns unchanged, contract columns added, DB-computed columns never client-supplied
  const row = runtimeRow("P50_52_SAFE", "2026-10-12", candidate, source, { scoreLevel: 64, dataCoverage: 80 }, "2026-10-12T10:02:00.000Z");
  const payload = toDatabaseLedger(row);
  assert.equal(payload.contract_version, "FORWARD_BET_V1");
  assert.equal(payload.entry_price, 0.505);
  for (const computed of ["first_persisted_at", "timing_class", "contract_status", "lead_time_scheduled_seconds", "observation_lag_seconds"]) assert.equal(computed in payload, false, computed);
  const legacy = toDatabaseLedger(runtimeRow("P50_52_SAFE", "2026-10-12", candidate, source, { scoreLevel: 64, dataCoverage: 80 }));
  assert.equal("contract_version" in legacy, false);
});

test("timing classes never present scheduled-only, rescheduled or replayed rows as proven pre-kickoff", () => {
  const base = { observedAt: "2026-10-12T12:02:00Z", firstPersistedAt: "2026-10-12T12:31:00Z" };
  const scheduledOnly = classifyForwardTiming({ ...base, scheduledStartAt: "2026-10-12T17:00:00Z", authoritativeStartAt: null });
  assert.equal(scheduledOnly.timingClass, "PRE_START_SCHEDULED_ONLY");
  assert.equal(scheduledOnly.leadTimeScheduledSeconds, 16140);
  assert.equal(scheduledOnly.leadTimeAuthoritativeSeconds, null);
  assert.equal(classifyForwardTiming({ ...base, scheduledStartAt: null, authoritativeStartAt: null }).timingClass, "START_UNKNOWN");
  assert.equal(classifyForwardTiming({ ...base, scheduledStartAt: "2026-10-12T12:00:00Z", authoritativeStartAt: null }).timingClass, "LATE_SCHEDULED");
  assert.equal(classifyForwardTiming({ ...base, scheduledStartAt: "2026-10-12T12:00:00Z", authoritativeStartAt: "2026-10-12T14:00:00Z" }).timingClass, "PRE_START_AUTHORITATIVE");
  assert.equal(classifyForwardTiming({ ...base, scheduledStartAt: "2026-10-12T17:00:00Z", authoritativeStartAt: "2026-10-12T12:10:00Z" }).timingClass, "LATE_AUTHORITATIVE");
  const replay = classifyForwardTiming({ observedAt: "2026-10-12T05:00:00Z", firstPersistedAt: "2026-10-12T12:31:00Z", scheduledStartAt: "2026-10-12T17:00:00Z", authoritativeStartAt: null });
  assert.equal(replay.timingClass, "HISTORICAL_REPLAY");
  assert.equal(isForwardPreMatch(replay.timingClass), false);
  assert.equal(isForwardPreMatch("PRE_START_SCHEDULED_ONLY"), true);
  assert.equal(isForwardPreMatch("LATE_SCHEDULED"), false);
});

test("market scope parsing: family, period and signed selected line", () => {
  assert.equal(classifyMarketFamily("totals", "CA Lanús vs. CA Vélez Sarsfield: O/U 2.5"), "TOTAL");
  assert.equal(classifyMarketFamily("spreads", "Spread: Sivasspor (-4.5)"), "SPREAD");
  assert.equal(classifyMarketFamily("map_handicap", "Map Handicap: GLS (-1.5) vs Bounty Hunters Esports (+1.5)"), "HANDICAP");
  assert.equal(classifyMarketFamily("moneyline", "A vs B"), "MONEYLINE");
  assert.equal(classifyMarketFamily("tennis_completed_match", "Jinan: Completed Match: A vs B"), "COMPLETED_MATCH");
  assert.equal(classifyPeriodScope("first_half_moneyline", "Nets vs. Wizards: 1H Moneyline"), "FIRST_HALF");
  assert.equal(classifyPeriodScope("tennis_first_set_winner", "Set 1 Winner: A vs B"), "SET_1");
  assert.equal(classifyPeriodScope("moneyline", "A vs B"), "FULL_MATCH");
  assert.equal(parseSelectedLine("TOTAL", "CA Lanús vs. CA Vélez Sarsfield: O/U 2.5", "Over"), 2.5);
  assert.equal(parseSelectedLine("SPREAD", "Spread: Sivasspor (-4.5)", "Sivasspor"), -4.5);
  assert.equal(parseSelectedLine("SPREAD", "Spread: Sivasspor (-4.5)", "Bandirmaspor"), 4.5);
  assert.equal(parseSelectedLine("HANDICAP", "Map Handicap: GLS (-1.5) vs Bounty Hunters Esports (+1.5)", "Bounty Hunters Esports"), 1.5);
  assert.equal(parseSelectedLine("MONEYLINE", "A vs B", "A"), null);
  assert.equal(parseSelectedLine("SPREAD", "Spread: Sivasspor (-4.5)", null), null);
  assert.equal(parseSelectedLine("SPREAD", "Spread: Sivasspor (-4.5)", "Yes"), null);
});

type Call = { table: string; op: string; payload?: any; options?: any };
function fakeDb(handler: (call: Call) => { error: null | { code?: string; message?: string } }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      return {
        upsert(payload: any, options: any) { const call = { table, op: "upsert", payload, options }; calls.push(call); return Promise.resolve(handler(call)); },
        select(columns: string) { return { limit: () => { const call = { table, op: "select", payload: columns }; calls.push(call); return Promise.resolve(handler(call)); } }; },
      };
    },
  };
  return { db: db as any, calls };
}

test("contract rows are inserted one by one; a duplicate economic unit is counted, not fatal; other errors throw", async () => {
  const rows = [{ row_key: "a", contract_version: "FORWARD_BET_V1" }, { row_key: "b", contract_version: "FORWARD_BET_V1" }, { row_key: "c" }];
  const dup = fakeDb((call) => Array.isArray(call.payload) ? { error: null } : call.payload.row_key === "a" ? { error: { code: "23505", message: "DUPLICATE_ECONOMIC_UNIT" } } : { error: null });
  const result = await insertChoices(dup.db, rows);
  assert.deepEqual(result, { insertedContractN: 1, duplicateEconomicUnitN: 1 });
  assert.equal(dup.calls.filter((c) => Array.isArray(c.payload)).length, 1);
  assert.equal(dup.calls.every((c) => c.options.ignoreDuplicates === true && c.options.onConflict === "row_key"), true);
  const broken = fakeDb(() => ({ error: { code: "XX000", message: "boom" } }));
  await assert.rejects(insertChoices(broken.db, [{ row_key: "a", contract_version: "FORWARD_BET_V1" }]), /SHADOW_LEDGER_WRITE:XX000/);
});

test("schema probe: cycle degrades to legacy mode before the DBClone migration instead of failing", async () => {
  assert.equal(await probeForwardContractSchema(fakeDb(() => ({ error: null })).db), true);
  assert.equal(await probeForwardContractSchema(fakeDb(() => ({ error: { code: "42703", message: "column contract_version does not exist" } })).db), false);
  await assert.rejects(probeForwardContractSchema(fakeDb(() => ({ error: { code: "57014", message: "timeout" } })).db), /SHADOW_FORWARD_SCHEMA_PROBE/);
});
