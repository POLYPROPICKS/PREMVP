// COMMIT A — AUTHORITATIVE CONTRACT A DECISION CONTRACTS
//   node --import tsx --test tests/contur3/contractADecisions.test.ts
//
// R1 finding: Contract A has no explicit lifecycle artifact. The planning
// selector (CONTRACT_A_PLANNING_V1) only stamps two diagnostics keys onto a
// FireModelCandidate, and the final adapter (CONTRACT_A_V1) hardcodes
// inferred_sport="unknown" / strategic_scope="OTHER", arithmetically
// reconstructs event_start_iso from createdAt + minutesUntilStart, and exposes
// rejection evidence only as loose strings.
//
// This suite pins the two authoritative artifacts Commit A introduces:
//   1. Contract A Planning Decision
//   2. Contract A Final Identity Decision
// Both are ADDITIVE. Reservation, Rebalance, Queue and routes are untouched,
// and the existing candidate shape must stay byte-compatible (see BC-1/BC-2).
//
// Every fixture uses fixed timestamps; no test reads the wall clock.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import {
  CONTRACT_A_DECISION_VERSION,
  produceContractAPlanningDecisions,
  produceContractAFinalIdentityDecision,
  resolveContractASourceLineage,
  resolveContractAEventStartIso,
  resolveContractAPhysicalEventId,
  buildContractAPlanningDecision,
  buildContractAFinalIdentityDecision,
} from "../../lib/executor/contractADecisions";

const KICKOFF_ISO = "2026-07-27T21:00:00.000Z";
const PLANNING_NOW_MS = Date.parse("2026-07-27T17:30:33.404Z");
const FINAL_NOW_MS = Date.parse("2026-07-27T19:45:00.000Z");

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// Production-shaped generated_signal_pairs row: real UUID id, real upstream
// sport metadata (diagnostics.shadowScope), canonical diagnostics.gameStartIso.
const SOURCE_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  condition_id: "cond-nyy-phi",
  selected_token_id: "tok-nyy-phi-yankees",
  token_id: "tok-nyy-phi-yankees",
  selected_outcome: "New York Yankees",
  score: 80,
  signal_confidence_num: 70,
  smart_money_score_num: null,
  entry_price_num: 0.42,
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-27T19:30:00.000Z", // exact T-90 snapshot for a 21:00Z kickoff
  expires_at: KICKOFF_ISO,
  signal_result: null,
  event_slug: "mlb-nyy-phi-2026-07-27",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  diagnostics: {
    gameStartIso: KICKOFF_ISO,
    dataCoverage: 60,
    shadowScope: "baseball",
    eventTitle: "New York Yankees vs Philadelphia Phillies",
    marketTitle: "Yankees vs Phillies moneyline",
  },
};

// Same event, non-UUID row id. Lineage must survive as lineage data.
const NON_UUID_SOURCE_ROW = {
  ...SOURCE_ROW,
  id: "legacy-import:nyy-phi-2026-07-27",
};

async function planningOf(rows: readonly Record<string, unknown>[] = [SOURCE_ROW]) {
  return at(PLANNING_NOW_MS, () => produceContractAPlanningDecisions(rows));
}

// ── Planning Decision ─────────────────────────────────────────────────────

test("CA-P1: a production-shaped upstream row entering the real Contract A planning producer yields exactly one accepted Planning Decision", async () => {
  const results = await planningOf();
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  assert.equal(r.decision.decision_version, CONTRACT_A_DECISION_VERSION);
  assert.equal(r.decision.contract_a_version, "CONTRACT_A_PLANNING_V1");
  assert.equal(r.decision.status, "ACCEPTED");
  assert.equal(r.decision.rejection_trace, null);
});

test("CA-P2: the Planning Decision preserves the exact physical_event_id produced by the real producer", async () => {
  const [r] = await planningOf();
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  // The producer's OWN keys disagree across the two Contract A stages for the
  // same physical event (planning derives `pair:...`, the final adapter
  // derives `slug:...`). The decision contract therefore owns ONE canonical
  // identity, built from the event slug + the EXACT canonical event start
  // instant -- never the calendar date alone, which collided two kickoffs of a
  // same-day doubleheader into a single physical event.
  assert.equal(r.decision.physical_event_id, "event:mlb-nyy-phi-2026-07-27:2026-07-27T21:00:00.000Z");
  const { candidates } = await at(PLANNING_NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.equal(
    resolveContractAPhysicalEventId(candidates[0], KICKOFF_ISO),
    r.decision.physical_event_id,
    "the decision identity must be exactly what the Contract A resolver derives from the real producer's candidate"
  );
});

test("CA-P3: the Planning Decision carries real normalized sport and scope metadata resolved from upstream provider fields", async () => {
  const [r] = await planningOf();
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  assert.equal(r.decision.strategic_scope, "MLB");
  assert.equal(r.decision.sport_metadata_source, "upstream");
  assert.notEqual(r.decision.inferred_sport, "unknown");
});

test("CA-P4: the Planning Decision never hardcodes unknown/OTHER while real upstream sport metadata exists on the source row", async () => {
  const [r] = await planningOf();
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  assert.notEqual(r.decision.strategic_scope, "OTHER");
  assert.notEqual(r.decision.strategic_scope, "UNKNOWN");
});

test("CA-P5: a non-UUID source signal id is preserved as lineage data and is never silently nulled", async () => {
  const [r] = await planningOf([NON_UUID_SOURCE_ROW]);
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  const lineage = r.decision.source_lineage;
  assert.equal(lineage.generated_signal_pair_id, "legacy-import:nyy-phi-2026-07-27");
  assert.equal(lineage.generated_signal_pair_id_is_uuid, false);
  assert.notEqual(lineage.generated_signal_pair_id, null);
  // and the UUID case still reports itself as a UUID
  const [uuidResult] = await planningOf();
  assert.equal(uuidResult.accepted, true);
  if (!uuidResult.accepted) return;
  assert.equal(uuidResult.decision.source_lineage.generated_signal_pair_id_is_uuid, true);
});

test("CA-P6: canonical event_start_iso is carried from the source row, never re-derived arithmetically", async () => {
  const [r] = await planningOf();
  assert.equal(r.accepted, true);
  if (!r.accepted) return;
  assert.equal(r.decision.event_start_iso, KICKOFF_ISO);
  assert.equal(r.decision.event_start_iso_source, "source_row_game_start_iso");
  // the pure resolver rejects a reconstructed/absent value instead of guessing
  assert.equal(resolveContractAEventStartIso({ gameStartIso: KICKOFF_ISO }).ok, true);
  assert.equal(resolveContractAEventStartIso({}).ok, false);
  assert.equal(resolveContractAEventStartIso({ gameStartIso: "not-a-date" }).ok, false);
});

test("CA-P7: an accepted Planning Decision carries deterministic score/tier/rank and the upstream market-policy verdict", async () => {
  const first = await planningOf();
  const second = await planningOf();
  assert.equal(first[0].accepted, true);
  assert.equal(second[0].accepted, true);
  if (!first[0].accepted || !second[0].accepted) return;
  const a = first[0].decision;
  const b = second[0].decision;
  assert.equal(typeof a.planning_score, "number");
  assert.equal(typeof a.planning_rank, "number");
  assert.equal(typeof a.planning_tier, "string");
  assert.notEqual(a.planning_policy_verdict, null);
  assert.deepEqual(a, b, "the same fixture at the same frozen clock must produce an identical decision");
});

test("CA-P8: a rejected Planning Decision exposes one deterministic typed rejection trace", async () => {
  // The candidate comes from the REAL producer; only the canonical event start
  // is absent from its source row. Planning cannot assert an execution window,
  // so the decision must fail closed with one exact, repeatable reason.
  const { candidates } = await at(PLANNING_NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.equal(candidates.length, 1);
  const startless = { ...SOURCE_ROW.diagnostics, gameStartIso: undefined } as Record<string, unknown>;
  const r = buildContractAPlanningDecision(candidates[0], startless);
  assert.equal(r.accepted, false);
  if (r.accepted) return;
  assert.equal(r.rejection.stage, "PLANNING");
  assert.equal(r.rejection.reason_code, "MISSING_CANONICAL_EVENT_START_ISO");
  assert.equal(r.rejection.decision_version, CONTRACT_A_DECISION_VERSION);
  assert.equal(r.rejection.contract_a_version, "CONTRACT_A_PLANNING_V1");
  // lineage survives into the rejection trace, so the reject is persistable
  assert.equal(r.rejection.source_lineage?.generated_signal_pair_id, SOURCE_ROW.id);
  assert.deepEqual(
    buildContractAPlanningDecision(candidates[0], startless),
    r,
    "the rejection trace must be deterministic"
  );
  // a malformed (rather than absent) value is a DIFFERENT exact reason
  const malformed = buildContractAPlanningDecision(candidates[0], { gameStartIso: "not-a-date" });
  assert.equal(malformed.accepted, false);
  if (malformed.accepted) return;
  assert.equal(malformed.rejection.reason_code, "MALFORMED_CANONICAL_EVENT_START_ISO");
});

// ── Final Identity Decision ───────────────────────────────────────────────

async function finalOf(rows: readonly Record<string, unknown>[] = [SOURCE_ROW]) {
  const [planning] = await planningOf(rows);
  assert.equal(planning.accepted, true);
  if (!planning.accepted) throw new Error("precondition: planning must accept");
  return {
    planning: planning.decision,
    result: await at(FINAL_NOW_MS, () => produceContractAFinalIdentityDecision(planning.decision, rows)),
  };
}

test("CA-F1: the Final Identity Decision preserves exact physical_event_id, condition_id, token_id, side and event_start_iso", async () => {
  const { planning, result } = await finalOf();
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const d = result.decision;
  assert.equal(d.decision_version, CONTRACT_A_DECISION_VERSION);
  assert.equal(d.contract_a_version, "CONTRACT_A_V1");
  assert.equal(d.physical_event_id, planning.physical_event_id);
  assert.equal(d.event_start_iso, KICKOFF_ISO);
  assert.equal(d.condition_id, "cond-nyy-phi");
  assert.equal(d.token_id, "tok-nyy-phi-yankees");
  assert.equal(d.side, "New York Yankees");
  assert.equal(d.selected_market.canonical_market_key, "cond-nyy-phi");
  assert.equal(d.planning_lineage.physical_event_id, planning.physical_event_id);
});

test("CA-F2: the Final Identity Decision fails closed on missing exact identity instead of reconstructing it", async () => {
  const [planning] = await planningOf();
  assert.equal(planning.accepted, true);
  if (!planning.accepted) return;
  const { candidates } = await at(FINAL_NOW_MS, () =>
    buildFireModelCandidates(10, "all", true, [SOURCE_ROW], "CONTRACT_A_V1")
  );
  assert.equal(candidates.length, 1);
  const diag = SOURCE_ROW.diagnostics as Record<string, unknown>;

  const noToken = buildContractAFinalIdentityDecision(
    planning.decision,
    { ...candidates[0], token_id: "" },
    diag
  );
  assert.equal(noToken.accepted, false);
  if (noToken.accepted) return;
  assert.equal(noToken.rejection.stage, "FINAL_IDENTITY");
  assert.equal(noToken.rejection.contract_a_version, "CONTRACT_A_V1");
  assert.equal(noToken.rejection.reason_code, "MISSING_TOKEN_ID");

  const noCondition = buildContractAFinalIdentityDecision(
    planning.decision,
    { ...candidates[0], condition_id: "" },
    diag
  );
  assert.equal(noCondition.accepted, false);
  if (noCondition.accepted) return;
  assert.equal(noCondition.rejection.reason_code, "MISSING_CONDITION_ID");

  // an event start that disagrees with the Planning Decision can never be
  // silently accepted -- the queue would otherwise carry two different times
  const drifted = buildContractAFinalIdentityDecision(planning.decision, candidates[0], {
    ...diag,
    gameStartIso: "2026-07-27T21:00:00.001Z",
  });
  assert.equal(drifted.accepted, false);
  if (drifted.accepted) return;
  assert.equal(drifted.rejection.reason_code, "EVENT_START_ISO_MISMATCH");
});

test("CA-F3: the Final Identity Decision can never change the physical event supplied by the Planning Decision", async () => {
  const [planning] = await planningOf();
  assert.equal(planning.accepted, true);
  if (!planning.accepted) return;
  const otherEventRow = {
    ...SOURCE_ROW,
    id: "00000000-0000-4000-8000-000000000002",
    condition_id: "cond-other-event",
    selected_token_id: "tok-other-event",
    token_id: "tok-other-event",
    event_slug: "mlb-bos-tor-2026-07-27",
    market_slug: "Boston Red Sox vs. Toronto Blue Jays - Moneyline",
  };
  const result = await at(FINAL_NOW_MS, () =>
    produceContractAFinalIdentityDecision(planning.decision, [otherEventRow])
  );
  assert.equal(result.accepted, false);
  if (result.accepted) return;
  assert.equal(result.rejection.reason_code, "NO_FINAL_IDENTITY_CANDIDATE");
  assert.equal(result.rejection.physical_event_id, planning.decision.physical_event_id);
});

test("CA-F4: the Final Identity Decision carries real sport metadata and full source lineage, not the adapter's unknown/OTHER placeholders", async () => {
  const { result } = await finalOf();
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.decision.strategic_scope, "MLB");
  assert.notEqual(result.decision.inferred_sport, "unknown");
  assert.equal(result.decision.source_lineage.generated_signal_pair_id, SOURCE_ROW.id);
});

// ── Additivity / backward compatibility ───────────────────────────────────

test("BC-1: the existing CONTRACT_A_V1 candidate shape is unchanged by Commit A (no Reservation/Queue wiring yet)", async () => {
  const { candidates } = await at(FINAL_NOW_MS, () =>
    buildFireModelCandidates(10, "all", true, [SOURCE_ROW], "CONTRACT_A_V1")
  );
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.inferred_sport, "unknown");
  assert.equal(c.strategic_scope, "OTHER");
  assert.equal(c.diagnostics.contract_a_stage, "FINAL_AUTHORITATIVE");
  assert.equal(c.generated_signal_pair_id, SOURCE_ROW.id);
});

test("BC-2: the existing CONTRACT_A_PLANNING_V1 candidate stamp is unchanged by Commit A", async () => {
  const { candidates } = await at(PLANNING_NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].diagnostics.selector_id, "CONTRACT_A_PLANNING_V1");
  assert.equal(candidates[0].diagnostics.contract_a_stage, "PLANNING");
});

test("BC-3: resolveContractASourceLineage is pure and never nulls a present non-UUID lineage id", () => {
  const a = resolveContractASourceLineage({
    generated_signal_pair_id: "legacy-import:1",
    signal_id: "cond::tok",
    event_slug: "evt",
  });
  assert.equal(a.generated_signal_pair_id, "legacy-import:1");
  assert.equal(a.generated_signal_pair_id_is_uuid, false);
  assert.equal(a.observation_id, "cond::tok");
  const b = resolveContractASourceLineage({
    generated_signal_pair_id: null,
    signal_id: "cond::tok",
    event_slug: null,
  });
  assert.equal(b.generated_signal_pair_id, null);
  assert.equal(b.generated_signal_pair_id_is_uuid, false);
});
