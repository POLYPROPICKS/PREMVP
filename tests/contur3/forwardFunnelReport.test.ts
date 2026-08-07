import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReservationSets, rowsForEventWindow, summarizeForwardFunnel } from "../../lib/executor/forwardFunnelReport";

const start = Date.parse("2026-08-06T21:00:00.000Z");
const end = Date.parse("2026-08-07T21:00:00.000Z");
const row = (gameStartIso: string | null, eventId = "event-a") => ({ condition_id: "c", selected_token_id: "t", entry_price_num: 0.4, signal_confidence_num: 70, diagnostics: gameStartIso === null ? {} : { gameStartIso, providerEventContext: { eventId, sportFamily: "soccer" } } });

test("forward funnel honors the Europe/Minsk authoritative event-start boundary and counts missing starts", () => {
  const result = rowsForEventWindow([row("2026-08-06T21:00:00.000Z"), row("2026-08-07T21:00:00.000Z"), row(null)], start, end);
  assert.equal(result.datedRows.length, 1);
  assert.equal(result.missingCanonicalEventStart, 1);
});

test("forward funnel preserves Contract A conservation and deterministic reservation comparison", () => {
  const accepted = { accepted: true as const, decision: { physical_event_id: "provider:event-a:2026-08-06T21:00:00.000Z" } } as any;
  const rejected = { accepted: false as const, rejection: { reason_code: "EXACT_PROVIDER_EVENT_IDENTITY_MISSING" } } as any;
  const report = summarizeForwardFunnel({ rows: [row("2026-08-06T21:00:00.000Z")], decisions: [accepted, rejected], contractAFunctionInput: 3, preContractEligible: 2, reservationPhysicalEventIds: ["event-a"], planningSelected: 1, startMs: start, endMs: end });
  assert.equal(report.pre_contract_a_eligible, report.contract_a_accepted + report.contract_a_rejected);
  assert.equal(report.contract_a_input, 3, "formal Contract A function input remains visible separately");
  assert.deepEqual(compareReservationSets(["a", "b"], ["b", "c"]), { same: ["b"], added_by_compare: ["c"], lost_by_compare: ["a"] });
});
