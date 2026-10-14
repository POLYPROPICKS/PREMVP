/**
 * FORWARD_DECISION_V2: pure builders (always run) + the V2 migration proven against a throwaway local PostgreSQL that replays the
 * DEPLOYED history: base table -> first-persistence -> FORWARD_BET_V1 (verbatim copy) -> V2. The DB part is skipped (loudly) when no
 * local PostgreSQL is reachable via the standard PG* environment variables; it never touches Supabase.
 */
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORWARD_DECISION_V2, betRowKey, buildV2BetRow, buildV2SkipRow, definitionDigestOf, fillVirtualShares, isIdempotentConflict, skipRowKey, writeVerdict,
  type BuildContext, type SkipEvidence, type VirtualFill,
} from "../../lib/research/forwardDecisionV2";
import type { ModelEventDecision } from "../../lib/research/forwardModelDecisionsT90";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SHA = "c".repeat(40);
const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const book = (over: Partial<NonNullable<FetchOrderBookResult["book"]>> = {}, res: Partial<FetchOrderBookResult> = {}): FetchOrderBookResult => ({
  ok: true, tokenId: "tok-1", latencyMs: 10, responseCompletedAtMs: T0 - 30,
  book: { tokenId: "tok-1", bids: [], asks: [{ price: 0.51, size: 3 }, { price: 0.52, size: 10 }], tickSize: 0.01, minimumOrderSize: 5, providerTimestampMs: T0 - 40, ...over },
  ...res,
});

function decision(over: Partial<ModelEventDecision> = {}, betOver: Record<string, unknown> = {}, eventStartMs = T0 + 4 * 3_600_000): ModelEventDecision {
  return {
    physicalEventId: "pe-1", sportFamily: "tennis", eventStartIso: iso(eventStartMs), t90CutoffIso: iso(eventStartMs - 90 * 60_000),
    modelId: "P50_52_SAFE", modelVersion: `def-sha256:${DIGEST_A}`, versionAuthority: "DEFINITION_DIGEST", family: "SAFE_PREMATCH",
    decisionGeneratedAt: iso(T0), outcome: "BET", reason: "MODEL_ELIGIBLE",
    bet: {
      candidateIdentity: `cond-1::tok-1::${iso(T0 - 600_000)}`, conditionId: "cond-1", tokenId: "tok-1", observedAt: iso(T0 - 600_000), eventStart: iso(eventStartMs),
      entryPrice: 0.51, modelPhysicalEventKey: "prov-evt-1", sourceIngestedAt: iso(T0 - 590_000),
      sourceRow: { observationId: "obs-1", itemObservationId: "item-1", ingestedAt: iso(T0 - 590_000), identityRowN: 1, selectorColumnsAgree: true },
      claimInstant: iso(T0 - 590_000), outcomeLabel: "Player A", oppositeTokenId: "tok-2", providerMarketType: "moneyline", providerEventId: "prov-evt-1", providerGameId: "game-1",
      cohortSource: { score: 0.7, entryPrice: 0.51, observedAt: iso(T0 - 600_000), ingestedAt: iso(T0 - 590_000), itemObservationId: "item-1" },
      isCohortAnchor: true, minutesToStartAtDecision: 240, ...betOver,
    },
    ...over,
  } as ModelEventDecision;
}
const priceSource = (d: ModelEventDecision = decision()) => ({ observation_id: d.bet!.sourceRow!.observationId, item_observation_id: d.bet!.sourceRow!.itemObservationId,
  observed_at: d.bet!.observedAt, condition_id: d.bet!.conditionId, selected_token_id: d.bet!.tokenId, entry_price_num: d.bet!.entryPrice,
  pre_event_score_num: 90, provider_event_id: d.bet!.providerEventId, provider_sport_family: d.sportFamily, market_type: "moneyline", event_title: "Player A vs Player B", market_question: "Player A vs Player B", game_start_iso: d.eventStartIso, data_coverage: 1 });
const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({ decisionGeneratedAtMs: T0, sourceSha: SHA, cohortDigest: "cd", authoritativeStart: null, priceSource: priceSource(), ...over });
const filled = (over: Partial<Extract<VirtualFill, { state: "FILLED" }>> = {}) => ({ ...(fillVirtualShares("tok-1", book()) as Extract<VirtualFill, { state: "FILLED" }>), worstAsk: 0.519, vwap: 0.5136, grossCostUsd: 2.568, ...over });

describe("5-share virtual fill on the exact token's own asks", () => {
  test("fills exactly 5 shares across levels at real asks and reports the gross cost; no fee is computed", () => {
    const f = fillVirtualShares("tok-1", book());
    assert.equal(f.state, "FILLED");
    if (f.state !== "FILLED") return;
    assert.equal(f.shares, 5);
    assert.equal(f.grossCostUsd, Math.round((3 * 0.51 + 2 * 0.52) * 1e9) / 1e9);
    assert.equal(f.vwap, Math.round(((3 * 0.51 + 2 * 0.52) / 5) * 1e9) / 1e9);
    assert.equal(f.bestAsk, 0.51);
    assert.equal(f.worstAsk, 0.52);
    assert.ok(!("feeUsd" in f));
  });
  test("measures a 0.60 ask independently; depth measurement alone never grants model-price authority", () => {
    const f = fillVirtualShares("tok-1", book({ asks: [{ price: 0.6, size: 50 }] }));
    assert.equal(f.state, "FILLED");
    if (f.state === "FILLED") assert.equal(f.grossCostUsd, 3);
  });
  test("depth below 5 shares is BLOCKED (no escalation, no partial fill)", () => {
    const f = fillVirtualShares("tok-1", book({ asks: [{ price: 0.5, size: 4.99 }] }));
    assert.deepEqual(f, { state: "BLOCKED", reason: "DEPTH_BELOW_VIRTUAL_SIZE" });
  });
  test("the venue's real minimum order size is honored: above 5 is BLOCKED, unknown is BLOCKED, exactly 5 is allowed", () => {
    assert.deepEqual(fillVirtualShares("tok-1", book({ minimumOrderSize: 5.01 })), { state: "BLOCKED", reason: "VENUE_MIN_ORDER_ABOVE_VIRTUAL_SIZE" });
    assert.deepEqual(fillVirtualShares("tok-1", book({ minimumOrderSize: null })), { state: "BLOCKED", reason: "VENUE_MIN_ORDER_UNKNOWN" });
    assert.equal(fillVirtualShares("tok-1", book({ minimumOrderSize: 5 })).state, "FILLED");
  });
  test("only the exact selected token's book is used; a foreign book, a missing timestamp and an invalid ask level are BLOCKED", () => {
    assert.deepEqual(fillVirtualShares("tok-2", book()), { state: "BLOCKED", reason: "BOOK_TOKEN_MISMATCH" });
    assert.deepEqual(fillVirtualShares("tok-1", null), { state: "BLOCKED", reason: "BOOK_MISSING" });
    assert.deepEqual(fillVirtualShares("tok-1", book({ providerTimestampMs: null })), { state: "BLOCKED", reason: "BOOK_TIMESTAMP_UNKNOWN" });
    assert.deepEqual(fillVirtualShares("tok-1", book({ asks: [{ price: 1.2, size: 9 }] })), { state: "BLOCKED", reason: "BOOK_ASK_LEVEL_INVALID" });
  });
  test("an unsorted book is walked best ask first", () => {
    const f = fillVirtualShares("tok-1", book({ asks: [{ price: 0.9, size: 9 }, { price: 0.4, size: 9 }] }));
    assert.equal(f.state === "FILLED" && f.grossCostUsd, 2);
  });
});

describe("V2 BET row builder", () => {
  test("NEW PASS: provider aliases keep one root identity across model definitions; missing roots refuse admission", () => {
    const first = buildV2BetRow(decision(), filled(), ctx());
    const alias = decision({ modelVersion: `def-sha256:${DIGEST_B}` }, { providerEventId: "alias-b", modelPhysicalEventKey: "alias-b" });
    const second = buildV2BetRow(alias, filled(), ctx({ priceSource: priceSource(alias) }));
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) { assert.equal(first.row.row_key, second.row.row_key); assert.equal(second.row.provider_event_id, "alias-b"); }
    assert.deepEqual(buildV2BetRow(decision({}, { providerGameId: null }), filled(), ctx()), { ok: false, reason: "PROVIDER_ROOT_GAME_ID_UNPROVEN" });
  });
  test("NEW PASS: source 0.51 never licenses five-share worst ask 0.60; upper bound is exclusive and VWAP cannot hide a bad tail", () => {
    for (const modelId of ["P50_52_SAFE", "TENNIS_P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE"]) {
      const d = decision({ modelId });
      assert.ok(buildV2BetRow(d, filled({ worstAsk: 0.519 }), ctx()).ok);
      for (const worstAsk of [0.52, 0.60]) assert.deepEqual(buildV2BetRow(d, filled({ worstAsk, vwap: 0.51 }), ctx()), { ok: false, reason: "QUOTE_OUTSIDE_SELECTED_FROZEN_TIER" });
    }
    assert.deepEqual(buildV2BetRow(decision(), filled(), ctx({ priceSource: null })), { ok: false, reason: "QUOTE_EXECUTION_PRICE_AUTHORITY_UNPROVEN" });
  });


  test("portfolio execution keeps its picked tier, including football fill tiers and exclusive ceilings", () => {
    for (const [modelId, sportFamily, entryPrice, good, bad] of [
      ["PORTFOLIO_BROAD_SAFE", "tennis", 0.53, 0.539, 0.54],
      ["QUALITY_FILL_A_SAFE", "soccer", 0.51, 0.539, 0.54],
      ["QUALITY_FILL_D_SAFE", "soccer", 0.55, 0.599, 0.60],
    ] as const) {
      const d = decision({ modelId, sportFamily }, { entryPrice });
      const c = ctx({ priceSource: priceSource(d) });
      assert.ok(buildV2BetRow(d, filled({ worstAsk: good, vwap: good, grossCostUsd: good * 5 }), c).ok);
      assert.deepEqual(buildV2BetRow(d, filled({ worstAsk: bad, vwap: good, grossCostUsd: good * 5 }), c), { ok: false, reason: "QUOTE_OUTSIDE_SELECTED_FROZEN_TIER" });
    }
  });

  test("carries model_id, definition digest, source SHA, exact token/source-row evidence, 5 shares and NOT_EVALUATED fees", () => {
    const r = buildV2BetRow(decision(), filled(), ctx());
    assert.ok(r.ok);
    if (!r.ok) return;
    const row = r.row;
    assert.equal(row.contract_version, "FORWARD_DECISION_V2");
    assert.equal(row.model_id, "P50_52_SAFE");
    assert.equal(row.definition_digest, DIGEST_A);
    assert.equal(row.model_version, `def-sha256:${DIGEST_A}`);
    assert.equal(row.source_sha, SHA);
    assert.equal(row.selected_token_id, "tok-1");
    assert.equal(row.condition_id, "cond-1");
    assert.equal(row.source_observation_id, "obs-1");
    assert.equal(row.virtual_shares, 5);
    assert.equal(row.fee_state, "NOT_EVALUATED");
    assert.equal(row.net_state, "NOT_EVALUATED");
    assert.equal(row.executable_price_authority, "CLOB_DEPTH_VWAP");
    assert.equal(row.economic_unit_key, "PE:tennis:root:game-1");
    assert.equal(row.entry_price, 0.51, "the model's own frozen price is preserved, never replaced by a global cap");
    assert.equal("first_persisted_at" in row, false, "the client never supplies first_persisted_at");
    assert.equal("minutes_to_start" in row, false);
    assert.equal("timing_class" in row, false);
  });
  test("the BET row key depends on model_id and event only: a new definition of the same model re-derives the SAME key", () => {
    const a = buildV2BetRow(decision(), filled(), ctx());
    const b = buildV2BetRow(decision({ modelVersion: `def-sha256:${DIGEST_B}` }), filled(), ctx());
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.row.row_key, b.row.row_key);
    assert.equal(betRowKey("P50_52_SAFE", "e"), betRowKey("P50_52_SAFE", "e"));
    assert.notEqual(betRowKey("P50_52_SAFE", "e"), betRowKey("TENNIS_P50_52_SAFE", "e"));
  });
  test("identity not independently proven stays blocked rather than fabricated", () => {
    assert.deepEqual(buildV2BetRow(decision({ versionAuthority: "UNPROVEN", modelVersion: "VERSION_AUTHORITY_UNPROVEN" }), filled(), ctx()), { ok: false, reason: "MODEL_DEFINITION_DIGEST_UNPROVEN" });
    assert.deepEqual(buildV2BetRow(decision(), filled(), ctx({ sourceSha: null })), { ok: false, reason: "SOURCE_SHA_UNPROVEN" });
    assert.deepEqual(buildV2BetRow(decision(), filled(), ctx({ sourceSha: "abc" })), { ok: false, reason: "SOURCE_SHA_UNPROVEN" });
  });
  test("a blocked fill, a quote after the decision and a pick at/after T-90 are never rows", () => {
    assert.deepEqual(buildV2BetRow(decision(), { state: "BLOCKED", reason: "DEPTH_BELOW_VIRTUAL_SIZE" }, ctx()), { ok: false, reason: "VIRTUAL_FILL_DEPTH_BELOW_VIRTUAL_SIZE" });
    assert.deepEqual(buildV2BetRow(decision(), filled({ providerQuoteAtMs: T0 + 1 }), ctx()), { ok: false, reason: "QUOTE_AFTER_DECISION_GENERATION" });
    assert.deepEqual(buildV2BetRow(decision({}, {}, T0 + 90 * 60_000), filled(), ctx()), { ok: false, reason: "DECISION_GENERATED_AT_OR_AFTER_T90" });
  });
  test("an asserted actual start is never accepted at insert (the DB cannot verify it): the row is always PROVISIONAL scheduled-only", () => {
    const asserted = ctx({ authoritativeStart: { atIso: iso(T0 + 60 * 60_000), source: "OFFICIAL_SOURCE_CONFIRMED_START" } });
    assert.deepEqual(buildV2BetRow(decision(), filled(), asserted), { ok: false, reason: "AUTHORITATIVE_START_NOT_ACCEPTED_BY_V2_INSERT" });
    const r = buildV2BetRow(decision(), filled(), ctx());
    assert.ok(r.ok && r.row.authoritative_start_at === null && r.row.authoritative_start_source === null && r.row.event_start === r.row.scheduled_start_at);
  });
  test("a duplicate source row that disagrees, or a source row not matching the cited ingest, is blocked", () => {
    const bad = decision({}, { sourceRow: { observationId: "o", itemObservationId: "i", ingestedAt: iso(T0 - 590_000), identityRowN: 2, selectorColumnsAgree: false } });
    assert.deepEqual(buildV2BetRow(bad, filled(), ctx()), { ok: false, reason: "MODEL_SOURCE_ROW_AMBIGUOUS" });
  });
});

describe("V2 SKIP row builder", () => {
  const evidence = (over: Partial<SkipEvidence> = {}): SkipEvidence => ({
    reason: "MODEL_PREDICATE_EVALUATED_NOT_SELECTED", physicalEventKey: "prov-evt-1",
    source: { observedAt: iso(T0 - 600_000), ingestedAt: iso(T0 - 590_000), observationId: "obs-9", itemObservationId: "item-9", conditionId: "cond-1", tokenId: "tok-1" },
    evaluatedTokenKeys: ["cond-1|tok-2", "cond-1|tok-1"], ...over,
  });
  const skip = (over: Partial<ModelEventDecision> = {}) => decision({ outcome: "SKIP", reason: "MODEL_PREDICATE_EVALUATED_NOT_SELECTED", bet: null, ...over });
  test("a SKIP needs the model's own evaluation evidence and one key per (model, digest, event)", () => {
    const r = buildV2SkipRow(skip(), evidence(), ctx());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.row.row_key, skipRowKey("P50_52_SAFE", DIGEST_A, "prov-evt-1"));
    assert.notEqual(r.row.row_key, skipRowKey("P50_52_SAFE", DIGEST_B, "prov-evt-1"), "another definition's SKIP is distinct evidence");
    assert.equal(r.row.skip_reason, "MODEL_PREDICATE_EVALUATED_NOT_SELECTED");
    assert.deepEqual((r.row.evaluation_evidence as { evaluation: { evaluated_token_keys: string[] } }).evaluation.evaluated_token_keys, ["cond-1|tok-1", "cond-1|tok-2"]);
    assert.equal(r.row.fee_state, "NOT_EVALUATED");
  });
  test("BLOCKED and NOT_APPLICABLE are never valid model decisions; evidence must match the decision's reason", () => {
    assert.deepEqual(buildV2SkipRow(skip({ outcome: "BLOCKED", reason: "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT" }), evidence(), ctx()), { ok: false, reason: "NOT_A_SKIP" });
    assert.deepEqual(buildV2SkipRow(skip({ outcome: "NOT_APPLICABLE", reason: "SPORT_SCOPE:tennis" }), evidence(), ctx()), { ok: false, reason: "NOT_A_SKIP" });
    assert.deepEqual(buildV2SkipRow(skip(), null, ctx()), { ok: false, reason: "SKIP_EVIDENCE_MISSING" });
    assert.deepEqual(buildV2SkipRow(skip(), evidence({ reason: "MODEL_GATE_EVALUATED_REJECTED" }), ctx()), { ok: false, reason: "SKIP_EVIDENCE_MISSING" });
  });
  test("source evidence that is not causal or a decision at/after T-90 is blocked", () => {
    assert.deepEqual(buildV2SkipRow(skip(), evidence({ source: { ...evidence().source, ingestedAt: iso(T0 + 1) } }), ctx()), { ok: false, reason: "DECISION_BEFORE_SOURCE_INGEST" });
    assert.deepEqual(buildV2SkipRow(skip({ eventStartIso: iso(T0 + 60 * 60_000) }), evidence(), ctx()), { ok: false, reason: "DECISION_AT_OR_AFTER_T90" });
  });
});

describe("writer-level idempotency", () => {
  const prior = { betClaims: new Map([["P50_52_SAFE", new Set(["prov-evt-1"])]]), skips: new Set([`P50_52_SAFE|def-sha256:${DIGEST_A}|prov-evt-2`]) };
  test("a model_id that already claimed the event never BETs again, whatever its definition", () => {
    assert.equal(writeVerdict("BET", "P50_52_SAFE", `def-sha256:${DIGEST_A}`, "prov-evt-1", prior), "ALREADY_CLAIMED_BET");
    assert.equal(writeVerdict("BET", "P50_52_SAFE", `def-sha256:${DIGEST_B}`, "prov-evt-1", prior), "ALREADY_CLAIMED_BET");
    assert.equal(writeVerdict("BET", "TENNIS_P50_52_SAFE", `def-sha256:${DIGEST_A}`, "prov-evt-1", prior), "WRITE");
  });
  test("a SKIP is once per (model, digest, event); another digest's SKIP is distinct evidence; a SKIP after a claim is refused", () => {
    assert.equal(writeVerdict("SKIP", "P50_52_SAFE", `def-sha256:${DIGEST_A}`, "prov-evt-2", prior), "ALREADY_PERSISTED_SKIP");
    assert.equal(writeVerdict("SKIP", "P50_52_SAFE", `def-sha256:${DIGEST_B}`, "prov-evt-2", prior), "WRITE");
    assert.equal(writeVerdict("SKIP", "P50_52_SAFE", `def-sha256:${DIGEST_B}`, "prov-evt-1", prior), "SKIP_AFTER_BET_CLAIM");
  });
  test("a unique violation is an idempotent no-op signal, any other error is not", () => {
    assert.ok(isIdempotentConflict({ code: "23505", message: "dup" }));
    assert.ok(isIdempotentConflict({ code: "P0001", message: "DUPLICATE_ECONOMIC_UNIT" }));
    assert.ok(!isIdempotentConflict({ code: "P0001", message: "FORWARD_V2_NOT_BEFORE_T90" }));
    assert.equal(definitionDigestOf("def-sha256:xyz"), null);
    assert.equal(FORWARD_DECISION_V2.virtualShares, 5);
  });
});

// ── the migration, proven on a throwaway local PostgreSQL ─────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const BASE = read("ops/research-clone/prospective-selection-shadow-runtime-schema.sql");
const FIRST = read("ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql");
const V1 = read("tests/research-clone/fixtures/deployed_v1_forward_bet_contract.sql");
const V2 = read("ops/research-clone/migrations/20261014120000_forward_decision_v2_contract.sql");
const ROLLBACK = read("ops/research-clone/migrations/rollback_20261014120000_forward_decision_v2_contract.sql");
const TIMEOUTS = "set lock_timeout='5s'; set statement_timeout='45s';\n";
const T = "public.prospective_selection_shadow_runtime";

const psql = (db: string, sql: string) => {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-d", db], { input: sql, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const available = psql("postgres", "select 1").ok;
const skipReason = available ? undefined : "no local PostgreSQL reachable via PG* env (migration proof not run here)";
const q = (db: string, sql: string) => { const r = psql(db, sql); assert.ok(r.ok, `${r.err}\n${sql.slice(0, 200)}`); return r.out; };
const fails = (db: string, sql: string, pattern: RegExp) => { const r = psql(db, sql); assert.ok(!r.ok, `expected failure: ${sql.slice(0, 160)}`); assert.match(r.err, pattern); };

const dbNew = `fdv2_new_${process.pid}`;
const dbOld = `fdv2_old_${process.pid}`;
const dbBare = `fdv2_bare_${process.pid}`;
let startMs = 0;

function legacySeed(rowKey: string, model: string, event: string) {
  return `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state)
    values ('${rowKey}','LEDGER','${model}','2026-10-01','cid-${rowKey}','${event}','2026-10-01T10:00:00Z','2026-10-01T18:00:00Z',0.51,'tennis','c-${rowKey}','t-${rowKey}','UNQUERIED');`;
}
function v1Seed(rowKey: string, model: string, event: string, game: string) {
  return `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state,
      contract_version,decision_kind,canonical_game_key,game_identity_basis,scope_basis,provider_event_id,market_family,market_type,period_scope,selected_outcome,observed_at,decision_generated_at,scheduled_start_at,
      reference_price,reference_price_source,reference_price_type,reference_price_acquired_at,model_version,selection_reason,economic_unit_key)
    values ('${rowKey}','LEDGER','${model}','2026-10-14','cid-${rowKey}','${event}',now(),now() + interval '5 hours',0.51,'tennis','c-${rowKey}','t-${rowKey}','UNQUERIED',
      'FORWARD_BET_V1','BET','${game}','PROVIDER_EVENT_ONLY','TEXT_HEURISTIC','pe','MONEYLINE','moneyline','FULL_GAME','A',now() - interval '10 minutes',now(),now() + interval '5 hours',
      0.51,'test','MID',now(),'v1','test','${game}');`;
}

before(() => {
  if (!available) return;
  for (const db of [dbNew, dbOld, dbBare]) { psql("postgres", `drop database if exists ${db}`); q("postgres", `create database ${db}`); }
  q("postgres", `do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;`);
  for (const db of [dbNew, dbOld]) {
    q(db, BASE); q(db, TIMEOUTS + FIRST); q(db, TIMEOUTS + V1);
    q(db, legacySeed("legacy-1", "P50_52_SAFE", "evt-legacy") + legacySeed("legacy-2", "HIST_TENNIS_SAFE", "evt-legacy-2")
      + v1Seed("v1-1", "QUALITY_FILL_A_SAFE", "evt-v1", "game-v1"));
  }
  startMs = Number(q(dbNew, "select (extract(epoch from now())*1000)::bigint"));
});
after(() => {
  if (!available) return;
  for (const db of [dbNew, dbOld, dbBare]) psql("postgres", `drop database if exists ${db}`);
});

const dbNowMs = (db: string) => Number(q(db, "select floor(extract(epoch from clock_timestamp())*1000)::bigint"));
const cols = (obj: Record<string, unknown>) => Object.keys(obj);
function insertJson(db: string, table: string, row: Record<string, unknown>, extraSql = "") {
  const names = cols(row).join(",");
  return psql(db, `insert into ${table} (${names}) select ${names} from jsonb_populate_record(null::${table}, $json$${JSON.stringify(row)}$json$::jsonb);${extraSql}`);
}
/** A BET built by the production builder against the DB's own clock. */
function dbBet(db: string, o: { model?: string; digest?: string; event?: string; startOffsetMin?: number; observedAgoMin?: number; mutate?: (row: Record<string, unknown>) => void } = {}) {
  const now = dbNowMs(db);
  const start = now + (o.startOffsetMin ?? 240) * 60_000;
  const observed = now - (o.observedAgoMin ?? 10) * 60_000;
  const d = decision({ physicalEventId: `root:${o.event ?? "evt-fresh"}`, modelId: o.model ?? "PORTFOLIO_BROAD_SAFE", modelVersion: `def-sha256:${o.digest ?? DIGEST_A}` }, {
    observedAt: iso(observed), sourceIngestedAt: iso(observed + 1000), claimInstant: iso(observed + 1000), eventStart: iso(start), modelPhysicalEventKey: o.event ?? "evt-fresh", providerGameId: o.event ?? "evt-fresh",
    candidateIdentity: `cond-1::tok-1::${iso(observed)}`,
    sourceRow: { observationId: "obs-1", itemObservationId: "item-1", ingestedAt: iso(observed + 1000), identityRowN: 1, selectorColumnsAgree: true },
  }, start);
  const f = filled({ providerQuoteAtMs: now - 5000 });
  const r = buildV2BetRow(d, f, ctx({ decisionGeneratedAtMs: now, priceSource: priceSource(d) }));
  assert.ok(r.ok, JSON.stringify(r));
  const row = { ...(r.ok ? r.row : {}) } as Record<string, unknown>;
  o.mutate?.(row);
  return row;
}
function dbSkip(db: string, o: { model?: string; digest?: string; event?: string; startOffsetMin?: number; mutate?: (row: Record<string, unknown>) => void } = {}) {
  const now = dbNowMs(db);
  const start = now + (o.startOffsetMin ?? 240) * 60_000;
  const observed = now - 600_000;
  const d = decision({ physicalEventId: `root:${o.event ?? "evt-skip"}`, outcome: "SKIP", reason: "MODEL_PREDICATE_EVALUATED_NOT_SELECTED", bet: null, modelId: o.model ?? "PORTFOLIO_BROAD_SAFE", modelVersion: `def-sha256:${o.digest ?? DIGEST_A}` }, {}, start);
  const ev: SkipEvidence = {
    reason: "MODEL_PREDICATE_EVALUATED_NOT_SELECTED", physicalEventKey: o.event ?? "evt-skip",
    source: { observedAt: iso(observed), ingestedAt: iso(observed + 1000), observationId: "obs-s", itemObservationId: "item-s", conditionId: "cond-s", tokenId: "tok-s" }, evaluatedTokenKeys: ["cond-s|tok-s"],
  };
  const r = buildV2SkipRow(d, ev, ctx({ decisionGeneratedAtMs: now }));
  assert.ok(r.ok, JSON.stringify(r));
  const row = { ...(r.ok ? r.row : {}) } as Record<string, unknown>;
  o.mutate?.(row);
  return row;
}
const SKIP_T = "public.forward_decision_v2_skip";
/** Rewrites the scheduled start to `minutes` from the DB clock AFTER the builder ran (the DB must still refuse a late row). */
function startAt(row: Record<string, unknown>, minutes: number) {
  const at = iso(dbNowMs(dbNew) + minutes * 60_000);
  row.scheduled_start_at = at;
  if ("event_start" in row) row.event_start = at;
}

describe("migration 20261014120000_forward_decision_v2_contract (local PostgreSQL, deployed history replayed)", { skip: skipReason }, () => {
  test("OLD: the deployed V1 contract cannot persist a V2 BET or a SKIP", () => {
    const r = insertJson(dbOld, T, dbBet(dbOld, {}));
    assert.ok(!r.ok);
    assert.match(r.err, /column .* does not exist|forward_contract_ck|violates check/);
    const v1skip = psql(dbOld, `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,decision_timestamp,entry_price,settlement_state,contract_version,decision_kind,observed_at,decision_generated_at)
      values ('x','LEDGER','m','2026-10-14','c',now(),0.5,'UNQUERIED','FORWARD_BET_V1','SKIP',now(),now())`);
    assert.ok(!v1skip.ok && /prospective_shadow_forward_contract_ck/.test(v1skip.err));
  });

  let before_hash = "";
  const preCols = () => q(dbNew, `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='prospective_selection_shadow_runtime'`);
  const rowHash = (db: string, columns: string) => q(db, `select count(*) || ':' || md5(string_agg(row_to_json(x)::text, '|' order by row_key)) from (select ${columns} from ${T}) x`);
  let existingColumns = "";

  test("NEW: applying the migration preserves every existing legacy and V1 row byte-for-byte", () => {
    existingColumns = preCols();
    before_hash = rowHash(dbNew, existingColumns);
    assert.match(before_hash, /^3:/);
    q(dbNew, TIMEOUTS + V2);
    assert.equal(rowHash(dbNew, existingColumns), before_hash);
    assert.equal(q(dbNew, `select count(*) from ${T} where contract_version = 'FORWARD_DECISION_V2'`), "0");
    q(dbNew, `update public.forward_decision_v2_cutover set writer_mode='V2'`);
  });


  test("OLD FAIL / NEW PASS: exact base migration accepts unresolved historical alias and 0.60 quote; repaired trigger refuses both", () => {
    const old = spawnSync("git", ["show", "cae51d3eb42dfb419803b47ce8654b4b61dd76b1:ops/research-clone/migrations/20261014120000_forward_decision_v2_contract.sql"], { encoding: "utf8" });
    assert.equal(old.status, 0, old.stderr);
    q(dbOld, TIMEOUTS + old.stdout);
    const alias = dbBet(dbOld, { model: "QUALITY_FILL_A_SAFE", event: "unresolved-alias" });
    assert.ok(insertJson(dbOld, T, alias).ok, "OLD FAIL: unresolved alias admitted alongside historical V1 claim");
    const reject = insertJson(dbNew, T, dbBet(dbNew, { model: "QUALITY_FILL_A_SAFE", event: "unresolved-alias" }));
    assert.ok(!reject.ok); assert.match(reject.err, /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/);
    const expensive = dbBet(dbOld, { event: "price-unsafe", mutate: (r) => { r.virtual_fill_vwap = 0.60; r.executable_buy_price = 0.60; r.virtual_gross_cost_usd = 3; (r.evaluation_evidence as {fill: {worst_ask:number}}).fill.worst_ask = 0.60; } });
    assert.ok(insertJson(dbOld, T, expensive).ok, "OLD FAIL: source 0.51 followed by ask 0.60 persisted");
    const newQuote = insertJson(dbNew, T, expensive); assert.ok(!newQuote.ok); assert.match(newQuote.err, /QUOTE_OUTSIDE_SELECTED_FROZEN_TIER/);
  });

  test("the migration is idempotent and re-applying it changes nothing", () => {
    q(dbNew, TIMEOUTS + V2);
    assert.equal(rowHash(dbNew, existingColumns), before_hash);
  });

  test("V1 behavior is unchanged: a V1 SKIP is still refused, a legacy row still settles, a duplicate V1 BET is still refused", () => {
    assert.ok(!psql(dbNew, `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,decision_timestamp,entry_price,settlement_state,contract_version,decision_kind)
      values ('x','LEDGER','m','2026-10-14','c',now(),0.5,'UNQUERIED','FORWARD_BET_V1','SKIP')`).ok);
    q(dbNew, `update ${T} set settlement_state='WIN', result='WIN', settled_at=now() where row_key='legacy-1'`);
    fails(dbNew, v1Seed("v1-dup", "QUALITY_FILL_A_SAFE", "evt-v1", "game-other"), /FORWARD_V2_LEGACY_CONTRACT_PAUSED/);
    fails(dbNew, `update ${T} set entry_price=0.9 where row_key='legacy-1'`, /IMMUTABLE_SHADOW_CHOICE/);
    fails(dbNew, `delete from ${T} where row_key='legacy-1'`, /IMMUTABLE_SHADOW_CHOICE/);
    fails(dbNew, `truncate ${T} cascade`, /IMMUTABLE_SHADOW_LEDGER_TRUNCATE/);
    q(dbNew, `update ${T} set settlement_state='UNQUERIED', result=null, settled_at=null where row_key='legacy-1'`);
  });

  test("a V2 BET persists; the DB owns first_persisted_at and every timing derivative (a backdated client value is overwritten)", () => {
    const row = dbBet(dbNew, { event: "evt-ok", mutate: (r) => { r.first_persisted_at = "2020-01-01T00:00:00Z"; r.minutes_to_start = 99999; r.timing_class = "PRE_START_AUTHORITATIVE"; r.start_verification_state = "VERIFIED_ACTUAL_START"; r.verification_status = "VERIFIED"; r.t90_lead_seconds = 1; } });
    const ins = insertJson(dbNew, T, row);
    assert.ok(ins.ok, ins.err);
    const out = q(dbNew, `select (first_persisted_at > now() - interval '60 seconds')::text || '|' || (first_persisted_at >= decision_generated_at)::text || '|' || (observed_at <= source_ingested_at and source_ingested_at <= decision_generated_at and decision_generated_at <= first_persisted_at)::text
      || '|' || (first_persisted_at < t90_cutoff_at - interval '0 seconds' + interval '0')::text || '|' || (minutes_to_start between 235 and 241)::text || '|' || (t90_lead_seconds > 0)::text || '|' || timing_class || '|' || start_verification_state || '|' || verification_status || '|' || contract_status
      || '|' || virtual_shares::text || '|' || fee_state || '|' || net_state from ${T} where row_key = '${row.row_key}'`);
    assert.equal(out, "true|true|true|true|true|true|PRE_START_SCHEDULED_ONLY|PROVISIONAL_SCHEDULED_ONLY|UNVERIFIED:timing_scheduled_only|COMPLETE|5|NOT_EVALUATED|NOT_EVALUATED");
    assert.equal(q(dbNew, `select (first_persisted_at - decision_generated_at < interval '300 seconds')::text from ${T} where row_key='${row.row_key}'`), "true");
  });

  test("a persisted V2 BET is immutable: no edit of any decision field, no delete, no truncate, no backdating of first_persisted_at", () => {
    const k = betRowKey("PORTFOLIO_BROAD_SAFE", "prov-evt-1");
    const row = dbBet(dbNew, { event: "evt-imm" });
    assert.ok(insertJson(dbNew, T, row).ok);
    for (const set of ["virtual_gross_cost_usd = 0.1", "virtual_shares = 6", "fee_state = 'ZERO'", "first_persisted_at = now() - interval '1 day'", "selected_token_id = 'other'", "model_version = 'x'", "evaluation_evidence = '{}'::jsonb", "source_sha = repeat('d',40)", "minutes_to_start = 1", "t90_cutoff_at = now()"]) {
      fails(dbNew, `update ${T} set ${set} where row_key='${row.row_key}'`, /IMMUTABLE_SHADOW_CHOICE/);
    }
    fails(dbNew, `delete from ${T} where row_key='${row.row_key}'`, /IMMUTABLE_SHADOW_CHOICE/);
    fails(dbNew, `truncate ${T} cascade`, /IMMUTABLE_SHADOW_LEDGER_TRUNCATE/);
    assert.ok(k.length > 0);
  });

  test("late or contradictory cases fail closed: T-90 reached, start in the past, decision in the future, stale decision/observation, ingest after decision", () => {
    const cases: Array<[string, Parameters<typeof dbBet>[1], RegExp]> = [
      ["inside T-90", { event: "e-t90", mutate: (r) => startAt(r, 80) }, /FORWARD_V2_NOT_BEFORE_T90/],
      ["exactly at T-90 or later", { event: "e-t90b", mutate: (r) => startAt(r, 90) }, /FORWARD_V2_NOT_BEFORE_T90/],
      ["event already started", { event: "e-past", mutate: (r) => startAt(r, -5) }, /FORWARD_V2_NOT_BEFORE_T90/],
      ["decision after persistence", { event: "e-fut", mutate: (r) => { r.decision_generated_at = iso(Date.now() + 3_600_000); } }, /FORWARD_V2_DECISION_AFTER_PERSIST/],
      ["decision stale", { event: "e-stale", mutate: (r) => { r.decision_generated_at = iso(dbNowMs(dbNew) - 400_000); r.source_ingested_at = iso(dbNowMs(dbNew) - 410_000); r.observed_at = iso(dbNowMs(dbNew) - 420_000); r.executable_quote_at = iso(dbNowMs(dbNew) - 405_000); } }, /FORWARD_V2_DECISION_STALE/],
      ["observation older than the replay guard", { event: "e-old", observedAgoMin: 130, mutate: (r) => { r.source_ingested_at = iso(dbNowMs(dbNew) - 3_000_000); } }, /FORWARD_V2_OBSERVATION_STALE/],
      ["ingest after decision generation", { event: "e-ing", mutate: (r) => { r.source_ingested_at = iso(dbNowMs(dbNew) + 60_000); r.observed_at = iso(dbNowMs(dbNew) + 59_000); } }, /FORWARD_V2_DECISION_BEFORE_SOURCE_INGEST/],
      ["observed after ingest", { event: "e-obs", mutate: (r) => { r.observed_at = iso(dbNowMs(dbNew) - 1000); r.source_ingested_at = iso(dbNowMs(dbNew) - 5000); } }, /FORWARD_V2_OBSERVED_AFTER_INGEST/],
      ["quote from the future", { event: "e-q", mutate: (r) => { r.executable_quote_at = iso(dbNowMs(dbNew) + 600_000); } }, /FORWARD_V2_QUOTE_AFTER_PERSIST/],
      ["asserted actual start is not accepted (unverifiable provenance)", { event: "e-auth", mutate: (r) => { r.authoritative_start_at = iso(dbNowMs(dbNew) + 600 * 60_000); r.authoritative_start_source = "OFFICIAL_SOURCE_CONFIRMED_START"; } }, /prospective_shadow_forward_v2_ck/],
      ["legacy event_start contradicting the scheduled start", { event: "e-evs", mutate: (r) => { r.event_start = iso(dbNowMs(dbNew) + 5 * 60_000); } }, /prospective_shadow_forward_v2_ck/],
      ["evidence without the required keys", { event: "e-ev", mutate: (r) => { r.evaluation_evidence = {}; } }, /QUOTE_EXECUTION_PRICE_AUTHORITY_UNPROVEN/],
    ];
    for (const [name, o, pattern] of cases) {
      const r = insertJson(dbNew, T, dbBet(dbNew, o));
      assert.ok(!r.ok, `${name} must fail`);
      assert.match(r.err, pattern, name);
    }
    assert.equal(q(dbNew, `select count(*) from ${T} where physical_event_key in ('e-t90','e-t90b','e-past','e-fut','e-stale','e-old','e-ing','e-obs','e-q','e-auth','e-evs','e-ev')`), "0");
  });

  test("economics and identity are enforced by the DB: shares must be exactly 5, cost = vwap*5, fees stay NOT_EVALUATED, digest must match", () => {
    const bad: Array<[string, (r: Record<string, unknown>) => void]> = [
      ["shares 4", (r) => { r.virtual_shares = 4; }],
      ["shares 10", (r) => { r.virtual_shares = 10; }],
      ["cost mismatch", (r) => { r.virtual_gross_cost_usd = 1; }],
      ["fee assumed zero", (r) => { r.fee_state = "ZERO"; }],
      ["net evaluated", (r) => { r.net_state = "EVALUATED"; }],
      ["venue min above size", (r) => { r.venue_min_order_size = 6; }],
      ["digest mismatch", (r) => { r.definition_digest = DIGEST_B; }],
      ["version not a digest", (r) => { r.model_version = "v1.2.3"; }],
      ["bad source sha", (r) => { r.source_sha = "abc"; }],
      ["missing evidence", (r) => { r.evaluation_evidence = null; }],
      ["blocked is not a decision kind", (r) => { r.decision_kind = "BLOCKED"; }],
      ["skip is not a ledger decision kind", (r) => { r.decision_kind = "SKIP"; }],
      ["unregistered start source", (r) => { r.authoritative_start_at = iso(startMs + 86_400_000); r.authoritative_start_source = "SCHEDULE"; }],
      ["unknown contract", (r) => { r.contract_version = "FORWARD_DECISION_V3"; }],
    ];
    bad.forEach(([name, mutate], i) => {
      const r = insertJson(dbNew, T, dbBet(dbNew, { event: `e-bad-${i}`, mutate }));
      assert.ok(!r.ok, `${name} must be refused`);
    });
    assert.equal(q(dbNew, `select count(*) from ${T} where physical_event_key like 'e-bad-%'`), "0");
  });

  test("NO repeated BET for a model_id: legacy, V1 and V2 claims all block another BET, whatever the definition", () => {
    fails(dbNew, `select 1`.replace("select 1", "select 1/0"), /division by zero/); // harness sanity
    let r = insertJson(dbNew, T, dbBet(dbNew, { model: "P50_52_SAFE", event: "evt-legacy" }));
    assert.ok(!r.ok && /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/.test(r.err), "unresolved legacy claim must block a V2 BET");
    r = insertJson(dbNew, T, dbBet(dbNew, { model: "QUALITY_FILL_A_SAFE", event: "evt-v1" }));
    assert.ok(!r.ok && /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/.test(r.err), "V1 claim must block a V2 BET");
    r = insertJson(dbNew, T, dbBet(dbNew, { event: "evt-ok", digest: DIGEST_B }));
    assert.ok(!r.ok && /DUPLICATE_ECONOMIC_UNIT|duplicate key/.test(r.err), "a new definition of the same model_id cannot re-claim a V2-claimed event");
    r = insertJson(dbNew, T, dbBet(dbNew, { event: "evt-ok" }));
    assert.ok(!r.ok && /duplicate key|DUPLICATE_ECONOMIC_UNIT/.test(r.err), "an identical replay is refused (idempotent)");
    r = insertJson(dbNew, T, dbBet(dbNew, { model: "TENNIS_P50_52_SAFE", event: "evt-ok" }));
    assert.ok(r.ok, `a different model_id may claim the same event: ${r.err}`);
  });

  test("a V1 BET cannot re-claim an event a V2 BET already holds either", () => {
    fails(dbNew, v1Seed("v1-after-v2", "PORTFOLIO_BROAD_SAFE", "evt-ok", "game-after"), /FORWARD_V2_LEGACY_CONTRACT_PAUSED/);
  });

  test("a LEGACY-shaped insert after a V2 BET is dropped row-wise (no repeated BET, the legacy batch survives); unresolved same-model aliases are dropped; another model still inserts", () => {
    const count = (key: string) => q(dbNew, `select count(*) from ${T} where row_key='${key}'`);
    q(dbNew, legacySeed("legacy-after-v2", "PORTFOLIO_BROAD_SAFE", "evt-ok"));
    assert.equal(count("legacy-after-v2"), "0", "the repeated BET is not stored");
    // A batch of unresolved aliases is dropped row-wise and does not abort; another model below remains admissible.
    q(dbNew, `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state)
      values ('batch-a','LEDGER','PORTFOLIO_BROAD_SAFE','2026-10-01','ca','evt-ok','2026-10-01T10:00:00Z','2026-10-01T18:00:00Z',0.5,'tennis','c1','t1','UNQUERIED'),
             ('batch-b','LEDGER','PORTFOLIO_BROAD_SAFE','2026-10-01','cb','evt-batch-free','2026-10-01T10:00:00Z','2026-10-01T18:00:00Z',0.5,'tennis','c2','t2','UNQUERIED')
      on conflict (row_key) do nothing`);
    assert.equal(count("batch-a"), "0");
    assert.equal(count("batch-b"), "0", "unproven legacy alias is dropped without aborting the batch");
    q(dbNew, legacySeed("legacy-other-event", "PORTFOLIO_BROAD_SAFE", "evt-legacy-fresh"));
    q(dbNew, legacySeed("legacy-other-model", "HIST_OTHER_SAFE", "evt-ok"));
    assert.equal(count("legacy-other-event"), "0");
    assert.equal(count("legacy-other-model"), "1");
  });

  test("V2 SKIP: persisted once per (model, digest, event); another digest is distinct evidence; DB-owned timing; immutable", () => {
    const s1 = dbSkip(dbNew, { event: "evt-skip-1" });
    const r1 = insertJson(dbNew, SKIP_T, s1);
    assert.ok(r1.ok, r1.err);
    const out = q(dbNew, `select (first_persisted_at >= decision_generated_at and decision_generated_at >= source_ingested_at and source_ingested_at >= observed_at)::text || '|' || (t90_lead_seconds > 0)::text || '|' || (minutes_to_start > 90)::text || '|' || start_verification_state from ${SKIP_T} where row_key='${s1.row_key}'`);
    assert.equal(out, "true|true|true|PROVISIONAL_SCHEDULED_ONLY");
    const dup = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { event: "evt-skip-1" }));
    assert.ok(!dup.ok && /duplicate key/.test(dup.err));
    const other = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { event: "evt-skip-1", digest: DIGEST_B }));
    assert.ok(other.ok, other.err);
    fails(dbNew, `update ${SKIP_T} set skip_reason='MODEL_GATE_EVALUATED_REJECTED' where row_key='${s1.row_key}'`, /IMMUTABLE_FORWARD_SKIP/);
    fails(dbNew, `delete from ${SKIP_T} where row_key='${s1.row_key}'`, /IMMUTABLE_FORWARD_SKIP/);
    fails(dbNew, `truncate ${SKIP_T}`, /IMMUTABLE_FORWARD_SKIP/);
    const late = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { event: "evt-skip-late", mutate: (r) => startAt(r, 60) }));
    assert.ok(!late.ok && /FORWARD_V2_NOT_BEFORE_T90/.test(late.err));
    const bad = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { event: "evt-skip-bad", mutate: (r) => { r.skip_reason = "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT"; } }));
    assert.ok(!bad.ok, "BLOCKED-style reasons are not SKIP evidence");
  });

  test("a SKIP does not claim the event (a later BET is allowed) but a SKIP after a claim is refused", () => {
    assert.ok(insertJson(dbNew, T, dbBet(dbNew, { event: "evt-skip-1" })).ok, "BET after another SKIP");
    const after = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { event: "evt-skip-1", digest: "d".repeat(64) }));
    assert.ok(!after.ok && /SKIP_AFTER_BET_CLAIM/.test(after.err));
    const legacy = insertJson(dbNew, SKIP_T, dbSkip(dbNew, { model: "P50_52_SAFE", event: "evt-legacy" }));
    assert.ok(!legacy.ok && /SKIP_AFTER_BET_CLAIM/.test(legacy.err), "a legacy claim blocks a SKIP too");
  });

  test("legacy readers never see evidence-only SKIPs: they are not in the ledger table", () => {
    assert.equal(q(dbNew, `select count(*) from ${T} where decision_kind = 'SKIP'`), "0");
  });

  test("race: a concurrent V1 BET and V2 BET for the same model_id and event commit exactly one row", async () => {
    const v2 = dbBet(dbNew, { model: "TENNIS_P50_52_SAFE", event: "evt-race" });
    const names = cols(v2).join(",");
    const v2Sql = `begin; insert into ${T} (${names}) select ${names} from jsonb_populate_record(null::${T}, $json$${JSON.stringify(v2)}$json$::jsonb); select pg_sleep(1.5); commit;`;
    const v1Sql = `begin; ${v1Seed("v1-race", "TENNIS_P50_52_SAFE", "provider-alias-a", "tennis:root:evt-race").replace("\'PROVIDER_EVENT_ONLY\'", "\'PROVIDER_ROOT_CONFIRMED\'").replace("provider_event_id,market_family", "provider_root_game_id,provider_root_game_source,provider_event_id,market_family").replace("\'pe\',\'MONEYLINE\'", "\'evt-race\',\'POLYMARKET_GAMMA_GAME_ID\',\'pe\',\'MONEYLINE\'")} select pg_sleep(1.5); commit;`;
    const run = (sql: string) => new Promise<{ ok: boolean; err: string }>((resolve) => {
      const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", dbNew]);
      let err = "";
      p.stderr.on("data", (c) => { err += c; });
      p.on("close", (code) => resolve({ ok: code === 0, err }));
      p.stdin.end(sql);
    });
    const [a, b] = await Promise.all([run(v2Sql), run(v1Sql)]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, `exactly one wins: ${a.err}${b.err}`);
    assert.equal(q(dbNew, `select count(*) from ${T} where model_id='TENNIS_P50_52_SAFE' and provider_root_game_id='evt-race' and row_kind='LEDGER'`), "1");
  });

  test("race: two concurrent V2 BETs of different definitions commit exactly one row; two identical SKIPs commit exactly one row", async () => {
    const mk = (digest: string) => { const row = dbBet(dbNew, { model: "QUALITY_FILL_D_SAFE", event: "evt-race2", digest }); const n = cols(row).join(","); return `begin; insert into ${T} (${n}) select ${n} from jsonb_populate_record(null::${T}, $json$${JSON.stringify(row)}$json$::jsonb); select pg_sleep(1.2); commit;`; };
    const mkSkip = () => { const row = dbSkip(dbNew, { model: "QUALITY_FILL_D_SAFE", event: "evt-race3" }); const n = cols(row).join(","); return `begin; insert into ${SKIP_T} (${n}) select ${n} from jsonb_populate_record(null::${SKIP_T}, $json$${JSON.stringify(row)}$json$::jsonb); select pg_sleep(1.2); commit;`; };
    const run = (sql: string) => new Promise<boolean>((resolve) => { const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", dbNew]); p.on("close", (c) => resolve(c === 0)); p.stdin.end(sql); });
    const bets = await Promise.all([run(mk(DIGEST_A)), run(mk(DIGEST_B))]);
    assert.equal(bets.filter(Boolean).length, 1);
    const skips = await Promise.all([run(mkSkip()), run(mkSkip())]);
    assert.equal(skips.filter(Boolean).length, 1);
    assert.equal(q(dbNew, `select count(*) from ${SKIP_T} where physical_event_key='evt-race3'`), "1");
  });


  test("race: concurrent legacy alias and V2 root cannot both claim; legacy dropping preserves its transaction", async () => {
    const row = dbBet(dbNew, { model: "QUALITY_FILL_D_SAFE", event: "evt-legacy-race" });
    const names = cols(row).join(",");
    const bet = `begin; insert into ${T} (${names}) select ${names} from jsonb_populate_record(null::${T}, $json$${JSON.stringify(row)}$json$::jsonb); select pg_sleep(0.5); commit;`;
    const legacy = `begin; ${legacySeed("legacy-race-alias", "QUALITY_FILL_D_SAFE", "provider-alias-legacy")} select pg_sleep(0.5); commit;`;
    const run = (sql: string) => new Promise<boolean>((resolve) => { const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", dbNew]); p.on("close", (c) => resolve(c === 0)); p.stdin.end(sql); });
    assert.deepEqual(await Promise.all([run(bet), run(legacy)]), [true, true], "both transactions survive; ambiguous legacy row alone is dropped");
    assert.equal(q(dbNew, `select count(*) from ${T} where row_key='legacy-race-alias' or provider_root_game_id='evt-legacy-race'`), "1");
  });

  test("legacy and V1 rows are still byte-identical after all V2 activity", () => {
    const stable = q(dbNew, `select count(*) || ':' || md5(string_agg(row_to_json(x)::text, '|' order by row_key)) from (select ${existingColumns} from ${T} where row_key in ('legacy-1','legacy-2','v1-1')) x`);
    const baseline = q(dbOld, `select count(*) || ':' || md5(string_agg(row_to_json(x)::text, '|' order by row_key)) from (select ${existingColumns} from ${T} where row_key in ('legacy-1','legacy-2','v1-1')) x`);
    // first_persisted_at is DB-generated per database, so compare everything else.
    const strip = (db: string) => q(db, `select md5(string_agg((to_jsonb(x) - 'first_persisted_at' - 'decision_timestamp' - 'decision_generated_at' - 'observed_at' - 'reference_price_acquired_at' - 'event_start' - 'scheduled_start_at' - 'updated_at' - 'observation_lag_seconds' - 'lead_time_scheduled_seconds')::text, '|' order by row_key)) from (select ${existingColumns} from ${T} where row_key in ('legacy-1','legacy-2','v1-1')) x`);
    assert.equal(strip(dbNew), strip(dbOld));
    assert.equal(stable.split(":")[0], baseline.split(":")[0]);
  });

  test("settlement authority table and ACLs are untouched; SKIP table is service_role-only", () => {
    assert.equal(q(dbNew, `select count(*) from information_schema.tables where table_name='virtual_bet_settlement_authority'`), "1");
    assert.equal(q(dbNew, `select has_table_privilege('anon','${SKIP_T}','select')::text || has_table_privilege('authenticated','${SKIP_T}','insert')::text || has_table_privilege('service_role','${SKIP_T}','insert')::text || has_table_privilege('service_role','${SKIP_T}','delete')::text || has_table_privilege('service_role','${SKIP_T}','update')::text`), "falsefalsetruefalsefalse");
    assert.equal(q(dbNew, `select has_function_privilege('anon','public.forward_decision_v2_clock()','execute')::text || has_function_privilege('service_role','public.forward_decision_v2_clock()','execute')::text`), "falsetrue");
  });

  test("ABORT: a failing precondition adds nothing; a failure mid-migration rolls the whole migration back", () => {
    q(dbBare, "create table public.prospective_selection_shadow_runtime (row_key text primary key)");
    const r = psql(dbBare, TIMEOUTS + V2);
    assert.ok(!r.ok && /FORWARD_DECISION_V2_REQUIRES_FORWARD_BET_V1_CHECK/.test(r.err));
    assert.equal(q(dbBare, `select count(*) from information_schema.columns where table_name='prospective_selection_shadow_runtime' and column_name in ('definition_digest','virtual_shares')`), "0");
    // atomic: the same migration plus a deliberately failing statement, in ONE transaction, leaves the schema as it was
    const fresh = `fdv2_abort_${process.pid}`;
    psql("postgres", `drop database if exists ${fresh}`); q("postgres", `create database ${fresh}`);
    try {
      q(fresh, BASE); q(fresh, TIMEOUTS + FIRST); q(fresh, TIMEOUTS + V1);
      const before = q(fresh, `select count(*) from information_schema.columns where table_name='prospective_selection_shadow_runtime'`);
      const triggerBefore = q(fresh, `select md5(pg_get_functiondef('public.prospective_selection_shadow_guard'::regproc))`);
      const bad = psql(fresh, `begin; ${TIMEOUTS.replace(/set /g, "set local ")} ${V2}\nselect 1/0;\ncommit;`);
      assert.ok(!bad.ok);
      assert.equal(q(fresh, `select count(*) from information_schema.columns where table_name='prospective_selection_shadow_runtime'`), before);
      assert.equal(q(fresh, `select md5(pg_get_functiondef('public.prospective_selection_shadow_guard'::regproc))`), triggerBefore);
      assert.equal(q(fresh, `select (to_regclass('public.forward_decision_v2_skip') is null)::text`), "true");
    } finally { psql("postgres", `drop database if exists ${fresh}`); }
  });

  test("ROLLBACK: refused while any V2 decision exists; with none, V2 objects are removed and re-applying the deployed V1 restores V1 exactly", () => {
    const r = psql(dbNew, TIMEOUTS + "begin;\n" + ROLLBACK + "\ncommit;");
    assert.ok(!r.ok && /FORWARD_DECISION_V2_ROLLBACK_REFUSED/.test(r.err));
    const fresh = `fdv2_rb_${process.pid}`;
    psql("postgres", `drop database if exists ${fresh}`); q("postgres", `create database ${fresh}`);
    try {
      q(fresh, BASE); q(fresh, TIMEOUTS + FIRST); q(fresh, TIMEOUTS + V1);
      const v1Def = q(fresh, `select md5(pg_get_functiondef('public.prospective_selection_shadow_guard'::regproc))`);
      q(fresh, TIMEOUTS + V2);
      assert.notEqual(q(fresh, `select md5(pg_get_functiondef('public.prospective_selection_shadow_guard'::regproc))`), v1Def);
      q(fresh, TIMEOUTS + "begin;\n" + ROLLBACK + "\ncommit;");
      // no window: between rollback and the V1 re-apply a V2-labelled row is already refused by the restored V1 CHECK
      assert.ok(!insertJson(fresh, T, dbBet(dbNew, { event: "evt-window" })).ok, "no V2 row can be inserted between rollback and V1 re-apply");
      q(fresh, TIMEOUTS + V1);
      assert.equal(q(fresh, `select md5(pg_get_functiondef('public.prospective_selection_shadow_guard'::regproc))`), v1Def);
      assert.equal(q(fresh, `select (to_regclass('public.forward_decision_v2_skip') is null)::text`), "true");
      assert.ok(!insertJson(fresh, T, dbBet(dbNew, { event: "evt-rb" })).ok, "V2 rows are refused again after rollback");
    } finally { psql("postgres", `drop database if exists ${fresh}`); }
  });

  test("OLD FAIL / NEW PASS: all five models have rootless history; legacy 500-row batches survive before cutover; proven distinct roots admit prospectively", () => {
    const fresh = `fdv2_shape_${process.pid}`;
    q("postgres", `create database ${fresh}`);
    const models = ["P50_52_SAFE", "TENNIS_P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE"];
    try {
      q(fresh, BASE); q(fresh, TIMEOUTS + FIRST); q(fresh, TIMEOUTS + V1);
      models.forEach((model, i) => q(fresh, legacySeed(`shape-${i}`, model, String(1000 + i))));
      const old = spawnSync("git", ["show", "e04bb49cb7bb3ab001fedc8a5b5d6faaac50cc22:ops/research-clone/migrations/20261014120000_forward_decision_v2_contract.sql"], { encoding: "utf8" });
      assert.equal(old.status, 0);
      q(fresh, TIMEOUTS + old.stdout);
      q(fresh, legacySeed("old-dropped", "PORTFOLIO_BROAD_SAFE", "2000"));
      assert.equal(q(fresh, `select count(*) from ${T} where row_key='old-dropped'`), "0", "OLD FAIL: unrelated valid legacy insert disappears");
      const blocked = insertJson(fresh, T, dbBet(fresh, { event: "9000" }));
      assert.ok(!blocked.ok && /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/.test(blocked.err), "OLD FAIL: unrelated rootless history globally rejects V2");
      const hash = q(fresh, `select md5(string_agg(to_jsonb(r)::text,'|' order by row_key)) from ${T} r`);
      q(fresh, TIMEOUTS + V2);
      assert.equal(q(fresh, `select md5(string_agg(to_jsonb(r)::text,'|' order by row_key)) from ${T} r`), hash);
      const beforeCutover = insertJson(fresh, T, dbBet(fresh, { event: "9000" }));
      assert.ok(!beforeCutover.ok && /FORWARD_V2_CUTOVER_NOT_ACTIVE/.test(beforeCutover.err));
      q(fresh, `insert into ${T} (row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state)
        select 'batch-'||i,'LEDGER','PORTFOLIO_BROAD_SAFE','2026-10-01','cid-'||i,(2000+i)::text,'2026-10-01T10:00:00Z','2026-10-01T18:00:00Z',0.51,'tennis','c-'||i,'t-'||i,'UNQUERIED' from generate_series(1,500) i`);
      assert.equal(q(fresh, `select count(*) from ${T} where row_key like 'batch-%'`), "500");
      // Exact provider receipts are test fixtures, never claimed as runtime witnesses.
      q(fresh, `insert into public.forward_decision_v2_identity_witness
        (provider_event_id,provider_root_game_id,identity_source,acquired_at,receipt_digest,evidence)
        select physical_event_key, '7'||physical_event_key,'POLYMARKET_GAMMA_EXACT_ID',now()-interval '1 minute',repeat('a',64),
          jsonb_build_object('id',physical_event_key,'gameId','7'||physical_event_key)
        from ${T} where model_id='PORTFOLIO_BROAD_SAFE'`);
      q(fresh, `update public.forward_decision_v2_cutover set writer_mode='V2'`);
      const independent = dbBet(fresh, { event: "9000" });
      const admitted = insertJson(fresh, T, independent);
      assert.ok(admitted.ok, admitted.err);
      const alias = dbBet(fresh, { event: "9000", digest: DIGEST_B, mutate: r => { r.row_key='alias-second'; r.provider_event_id='3000'; } });
      const repeated = insertJson(fresh, T, alias);
      assert.ok(!repeated.ok && /DUPLICATE_ECONOMIC_UNIT/.test(repeated.err));
      const unresolved = insertJson(fresh, T, dbBet(fresh, { model:"P50_52_SAFE", event:"9001" }));
      assert.ok(!unresolved.ok && /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/.test(unresolved.err));
      const historicalAlias = insertJson(fresh, T, dbBet(fresh, { event:"71002" }));
      assert.ok(!historicalAlias.ok && /DUPLICATE_ECONOMIC_UNIT/.test(historicalAlias.err));
      q(fresh, legacySeed("paused-legacy", "PORTFOLIO_BROAD_SAFE", "3001"));
      assert.equal(q(fresh, `select count(*) from ${T} where row_key='paused-legacy'`), "0");
      fails(fresh, `update public.forward_decision_v2_identity_witness set provider_root_game_id='1'`, /IMMUTABLE_FORWARD_IDENTITY_WITNESS/);
      q(fresh, `insert into public.forward_decision_v2_identity_witness values ('1002','8000','POLYMARKET_GAMMA_EXACT_ID',now()-interval '1 minute',repeat('b',64),'{"id":"1002","gameId":"8000"}')`);
      const contradictory = insertJson(fresh, T, dbBet(fresh, { event:"9002" }));
      assert.ok(!contradictory.ok && /HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN/.test(contradictory.err));
    } finally { psql("postgres", `drop database if exists ${fresh}`); }
  });
});
