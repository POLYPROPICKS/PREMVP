import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSportFunnelV1, countSportFunnelStage } from "../../lib/diagnostics/sportFunnel";

test("sport funnel preserves unknown buckets and event conservation", () => {
  const diagnostics = buildSportFunnelV1({
    producerRunId: "producer-run-1",
    asOf: "2026-08-05T09:00:00.000Z",
    createdAt: "2026-08-05T09:01:00.000Z",
    sourceGitSha: "abc123",
    officialEvents: [
      { providerEventId: "event-1", sportCode: "nba" },
      { providerEventId: "event-2", sportCode: null },
      { providerEventId: null, sportCode: "nba" },
    ],
    inventoryEvents: [],
    considered: [
      { providerEventId: "event-1", conditionId: "condition-1", sportCode: "nba" },
      { providerEventId: "event-2", conditionId: "condition-2", sportCode: null },
    ],
    materialized: [{ providerEventId: "event-1", conditionId: "condition-1", sportCode: "nba" }],
    firstLosses: [{ providerEventId: "event-2", sportCode: null, reason: "NO_SUPPORTED_FULLMATCH_MARKET" }],
  });

  assert.equal(diagnostics.diagnostics_version, "sport_funnel_v1");
  assert.equal(diagnostics.stages.official_events.by_sport.UNKNOWN_SPORT.provider_events, 1);
  assert.equal(diagnostics.stages.official_events.by_sport.UNKNOWN_IDENTITY.provider_events, 0);
  assert.equal(diagnostics.first_loss_by_sport.UNKNOWN_SPORT.NO_SUPPORTED_FULLMATCH_MARKET, 1);
  assert.equal(diagnostics.conservation.provider_event_conservation_ok, true);
});

test("stage counter distinguishes rows, conditions, and provider events", () => {
  const counts = countSportFunnelStage([
    { providerEventId: "event-1", conditionId: "condition-1", sportCode: "nba" },
    { providerEventId: "event-1", conditionId: "condition-2", sportCode: "nba" },
  ]);
  assert.deepEqual(counts.by_sport.nba, { rows: 2, conditions: 2, provider_events: 1 });
});
