import assert from "node:assert/strict";
import test from "node:test";
import { buildContractARejectionEvidence } from "../../lib/executor/contractARejectionEvidence";
import { persistContractARejectionEvidenceFailOpen } from "../../lib/executor/contractARejectionEvidenceWriter";

function rejected(overrides: Record<string, unknown> = {}) {
  return {
    accepted: false,
    rejection: {
      decision_version: "CONTRACT_A_DECISION_V1",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      stage: "PLANNING",
      reason_code: "NO_EXECUTABLE_ANCHOR",
      detail: null,
      physical_event_id: null,
      source_lineage: {
        generated_signal_pair_id: "pair-1",
        generated_signal_pair_id_is_uuid: false,
        observation_id: "condition-1::token-1",
        event_slug: null,
        provider_event_key: null,
        provider_event_id: null,
        provider_event_start_iso: null,
        provider_sport: null,
        producer_source: null,
        source_created_at: null,
      },
      ...overrides,
    },
  } as never;
}

test("persists only rejected decisions with exact, partial, or non-fabricated identity", () => {
  const rows = buildContractARejectionEvidence({
    planRunId: "run-1",
    decidedAtIso: "2026-09-29T12:00:00.000Z",
    results: [
      { accepted: true, decision: {} } as never,
      rejected(),
      rejected({ physical_event_id: "physical-1", source_lineage: { observation_id: null } }),
    ],
    sourceRows: [{ id: "pair-1", selected_outcome: "YES" }],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { level: rows[0].identity_level, condition: rows[0].condition_id, token: rows[0].selected_token_id, side: rows[0].side },
    { level: "EXACT_CANDIDATE", condition: "condition-1", token: "token-1", side: "YES" }
  );
  assert.deepEqual(
    { level: rows[1].identity_level, condition: rows[1].condition_id, token: rows[1].selected_token_id, side: rows[1].side },
    { level: "PHYSICAL_EVENT", condition: null, token: null, side: null }
  );
});

test("leaves candidate partial when authoritative side is unavailable", () => {
  const [row] = buildContractARejectionEvidence({
    planRunId: "run-2",
    decidedAtIso: "2026-09-29T12:00:00.000Z",
    results: [rejected()],
  });
  assert.deepEqual(
    { level: row.identity_level, condition: row.condition_id, token: row.selected_token_id, side: row.side },
    { level: "PARTIAL_CANDIDATE", condition: "condition-1", token: "token-1", side: null }
  );
});

test("telemetry write failure is fail-open", async () => {
  const rows = buildContractARejectionEvidence({
    planRunId: "run-3",
    decidedAtIso: "2026-09-29T12:00:00.000Z",
    results: [rejected()],
  });
  const result = await persistContractARejectionEvidenceFailOpen(rows, {
    async upsert() { throw new Error("offline"); },
  });
  assert.equal(result.attempted, true);
  assert.equal(result.written, 0);
  assert.equal(result.errorSafe, "offline");
});
