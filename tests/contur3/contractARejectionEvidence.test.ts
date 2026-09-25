import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContractARejectionEvidence,
  rejectedExactIdentitiesOf,
  deriveNotEvaluatedIdentities,
  type BuildContractARejectionEvidenceInput,
} from "../../lib/executor/contractARejectionEvidence";

function baseInput(
  overrides: Partial<BuildContractARejectionEvidenceInput> = {}
): BuildContractARejectionEvidenceInput {
  return {
    planRunId: "PLAN-R1",
    decidedAtIso: "2026-09-25T14:00:00.000Z",
    results: [],
    ...overrides,
  };
}

function rejectedResult(args: {
  observationId?: string | null;
  generatedSignalPairId?: string | null;
  providerEventId?: string | null;
  providerEventStartIso?: string | null;
  producerSource?: string | null;
  sourceCreatedAt?: string | null;
  physicalEventId?: string | null;
  reasonCode: string;
  detail?: string | null;
  contractAVersion?: string;
  decisionVersion?: string;
}): import("../../lib/executor/contractARejectionEvidence").BuildContractARejectionEvidenceInput["results"][number] {
  return {
    accepted: false as const,
    rejection: {
      decision_version: (args.decisionVersion ?? "CONTRACT_A_DECISION_V1") as "CONTRACT_A_DECISION_V1",
      contract_a_version: (args.contractAVersion ?? "CONTRACT_A_PLANNING_V1") as "CONTRACT_A_PLANNING_V1",
      stage: "PLANNING" as const,
      reason_code: args.reasonCode as import("../../lib/executor/contractADecisions").ContractARejectionReasonCode,
      detail: args.detail ?? null,
      physical_event_id: args.physicalEventId ?? null,
      source_lineage: {
        generated_signal_pair_id: args.generatedSignalPairId ?? null,
        generated_signal_pair_id_is_uuid:
          args.generatedSignalPairId !== null && args.generatedSignalPairId !== undefined,
        observation_id: args.observationId ?? null,
        event_slug: "event-slug",
        provider_event_key: null,
        provider_event_id: args.providerEventId ?? null,
        provider_event_start_iso: args.providerEventStartIso ?? null,
        provider_sport: null,
        producer_source: args.producerSource ?? null,
        source_created_at: args.sourceCreatedAt ?? null,
      },
    },
  };
}

test("one rejected candidate produces exactly one durable rejection row", () => {
  const input = baseInput({
    results: [
      rejectedResult({
        observationId: "0xc1::0xt1",
        generatedSignalPairId: "11111111-1111-1111-1111-111111111111",
        physicalEventId: "provider:polymarket:evt1:2026-09-26",
        reasonCode: "MARKET_POLICY_REJECTED",
        detail: "HALFTIME",
      }),
    ],
  });
  const rows = buildContractARejectionEvidence(input);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.identity_level, "EXACT_CANDIDATE");
  assert.equal(row.condition_id, "0xc1");
  assert.equal(row.selected_token_id, "0xt1");
  assert.equal(row.side, null);
  assert.equal(row.reason_code, "MARKET_POLICY_REJECTED");
  assert.equal(row.reason_detail, "HALFTIME");
  assert.equal(row.plan_run_id, "PLAN-R1");
  assert.ok(!Number.isNaN(Date.parse(row.decision_at)));
  assert.equal(row.generated_signal_pair_id, "11111111-1111-1111-1111-111111111111");
  assert.notEqual(row.rejection_key, "");
});

test("retrying the same planning run does not duplicate rejection rows", () => {
  const input = baseInput({
    results: [
      rejectedResult({ observationId: "0xc1::0xt1", reasonCode: "MARKET_POLICY_REJECTED" }),
      rejectedResult({ observationId: "0xc2::0xt2", reasonCode: "B2_EVENT_POLICY_REJECTED" }),
    ],
  });
  const first = buildContractARejectionEvidence(input);
  const second = buildContractARejectionEvidence(input);
  assert.equal(first.length, 2);
  assert.deepEqual(
    second.map((r) => r.rejection_key),
    first.map((r) => r.rejection_key)
  );
  assert.equal(new Set(second.map((r) => r.rejection_key)).size, 2);
});

test("two different exact candidate identities remain distinct", () => {
  const rows = buildContractARejectionEvidence(
    baseInput({
      results: [
        rejectedResult({ observationId: "0xc1::0xt1", reasonCode: "MARKET_POLICY_REJECTED" }),
        rejectedResult({ observationId: "0xc2::0xt2", reasonCode: "MARKET_POLICY_REJECTED" }),
      ],
    })
  );
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].rejection_key, rows[1].rejection_key);
  assert.ok(rows[0].condition_id !== rows[1].condition_id);
});

test("event-level rejection without exact market identity is persisted honestly", () => {
  const rows = buildContractARejectionEvidence(
    baseInput({
      results: [
        rejectedResult({
          physicalEventId: "provider:polymarket:evt5:2026-09-26",
          reasonCode: "NO_FINAL_IDENTITY_CANDIDATE",
        }),
      ],
    })
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.identity_level, "PHYSICAL_EVENT");
  assert.equal(row.physical_event_id, "provider:polymarket:evt5:2026-09-26");
  assert.equal(row.condition_id, null);
  assert.equal(row.selected_token_id, null);
  assert.equal(row.side, null);
  assert.equal(row.provider_event_start_iso, null);
});

test("UNKNOWN identity rejection carries no fabricated exact market fields", () => {
  const rows = buildContractARejectionEvidence(
    baseInput({
      results: [rejectedResult({ reasonCode: "EXACT_PROVIDER_EVENT_IDENTITY_MISSING" })],
    })
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.identity_level, "UNKNOWN");
  assert.equal(row.condition_id, null);
  assert.equal(row.selected_token_id, null);
  assert.equal(row.side, null);
  assert.ok(row.rejection_key.includes("NO_IDENTITY_UNKNOWN"));
});

test("accepted decisions persisted nothing; rejected shape stays bounded to the trace", () => {
  const rows = buildContractARejectionEvidence(
    baseInput({
      results: [
        { accepted: true as const, decision: null },
        rejectedResult({ observationId: "0xc1::0xt1", reasonCode: "MARKET_POLICY_REJECTED" }),
      ],
    })
  );
  assert.equal(rows.length, 1);
  const symbols = Object.keys(rows[0] as unknown as Record<string, unknown>);
  assert.equal(symbols.includes("outcome"), false);
});

test("NOT_EVALUATED creates no row and stays derivable as a stable-key anti-join", () => {
  const sourceRows = [
    { id: "r1", condition_id: "0xc1", selected_token_id: "0xt1", selected_outcome: "YES" },
    { id: "r2", condition_id: "0xc2", selected_token_id: "0xt2", selected_outcome: "NO" },
    { id: "r3", condition_id: "0xc3", selected_token_id: "0xt3", selected_outcome: "YES" },
  ];
  const rejectionRows = buildContractARejectionEvidence(
    baseInput({
      sourceRows,
      results: [rejectedResult({ observationId: "0xc1::0xt1", reasonCode: "MARKET_POLICY_REJECTED" })],
    })
  );
  const notEvaluated = deriveNotEvaluatedIdentities({ sourceRows, rejectionRows });
  assert.equal(notEvaluated.length, 2);
  assert.ok(notEvaluated.some((r) => r.condition_id === "0xc2" && r.selected_token_id === "0xt2"));
  assert.ok(notEvaluated.some((r) => r.condition_id === "0xc3" && r.selected_token_id === "0xt3"));
});

test("connection to rejectedExactIdentitiesOf stays consistent across both helpers", () => {
  const sourceRows = [
    { id: "r1", condition_id: "0xc1", selected_token_id: "0xt1", selected_outcome: "YES" },
    { id: "r2", condition_id: "0xc4", selected_token_id: "0xt4", selected_outcome: "YES" },
  ];
  const rejectionRows = buildContractARejectionEvidence(
    baseInput({
      sourceRows,
      results: [
        rejectedResult({ observationId: "0xc1::0xt1", reasonCode: "MARKET_POLICY_REJECTED" }),
        rejectedResult({ observationId: "0xc4::0xt4", reasonCode: "B2_EVENT_POLICY_REJECTED" }),
      ],
    })
  );
  const rejected = rejectedExactIdentitiesOf(rejectionRows);
  assert.equal(rejected.has("0xc1::0xt1"), true);
  assert.equal(rejected.has("0xc4::0xt4"), true);
  assert.equal(deriveNotEvaluatedIdentities({ sourceRows, rejectionRows }).length, 0);
});

test("source-row side is carried only when it is genuinely authoritative", () => {
  const rows = buildContractARejectionEvidence(
    baseInput({
      sourceRows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          condition_id: "0xca::0xta".split("::")[0],
          selected_token_id: "0xta",
          selected_outcome: "TeamA",
        },
      ],
      results: [
        rejectedResult({
          observationId: "0xca::0xta",
          generatedSignalPairId: "11111111-1111-1111-1111-111111111111",
          reasonCode: "MARKET_POLICY_REJECTED",
        }),
      ],
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, "TeamA");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "condition_id",
    "contract_a_version",
    "decision_at",
    "decision_version",
    "generated_signal_pair_id",
    "identity_level",
    "observation_id",
    "physical_event_id",
    "plan_run_id",
    "producer_source",
    "provider_event_id",
    "provider_event_start_iso",
    "reason_code",
    "reason_detail",
    "rejection_evidence_version",
    "rejection_key",
    "selected_token_id",
    "side",
    "source_created_at",
    "stage",
  ]);
});
