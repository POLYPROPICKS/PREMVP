import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCeoRows, MIN_FORWARD_GAMES_FOR_VERDICT, renderMarkdown, type LedgerLine } from "../../scripts/modeling/forward-bet-ceo-report";

const line = (over: Partial<LedgerLine>): LedgerLine => ({
  row_key: "k", model_id: "P50_52_SAFE", physical_event_key: "g", settlement_state: "UNQUERIED", first_persisted_at: null,
  contract_version: null, contract_status: null, timing_class: null, executable_buy_price: null, executable_price_authority: null, ...over,
});

test("historical, legacy-forward and contract-forward corpora stay separate; unproven economics are UNPROVEN, not zero", () => {
  const ledger = [
    line({ row_key: "h1", settlement_state: "WIN", physical_event_key: "h1" }),
    line({ row_key: "h2", settlement_state: "LOSS", physical_event_key: "h2" }),
    line({ row_key: "legacy", first_persisted_at: "2026-10-12T12:31:00Z", physical_event_key: "lf" }),
    line({ row_key: "f1", first_persisted_at: "2026-10-13T10:00:00Z", contract_version: "FORWARD_BET_V1", contract_status: "COMPLETE", timing_class: "PRE_START_SCHEDULED_ONLY", physical_event_key: "f1" }),
    line({ row_key: "f2", first_persisted_at: "2026-10-13T10:00:00Z", contract_version: "FORWARD_BET_V1", contract_status: "COMPLETE", timing_class: "HISTORICAL_REPLAY", physical_event_key: "f2" }),
    line({ row_key: "f3", first_persisted_at: "2026-10-13T10:00:00Z", contract_version: "FORWARD_BET_V1", contract_status: "INCOMPLETE:line_value", timing_class: "PRE_START_SCHEDULED_ONLY", physical_event_key: "f3" }),
  ];
  const [row] = buildCeoRows(ledger, [{ bet_row_key: "f1", outcome: "WIN" }]);
  assert.equal(row.historical.bet, 2);
  assert.equal(row.historical.originalWinPct, "50.0%");
  assert.equal(row.historical.semanticallyValidatedWinPct, "UNPROVEN");
  assert.equal(row.legacyForwardWithoutContract.bet, 1);
  assert.equal(row.forward.bet, 3);
  assert.equal(row.forward.independentProvenGames, 1);
  assert.equal(row.forward.wlvu, "1–0–0–0");
  assert.equal(row.forward.netRoi, "UNPROVEN");
  assert.equal(row.forward.furtherGamesNeeded, MIN_FORWARD_GAMES_FOR_VERDICT - 1);
  assert.equal(row.forward.verdict, "NO_VERDICT_INSUFFICIENT_FORWARD_SAMPLE");
  const pending = buildCeoRows([ledger[3]], [])[0];
  assert.equal(pending.forward.verdict, "TERMINAL_OUTCOME_PENDING");
  assert.match(renderMarkdown("t", buildCeoRows(ledger, [])), /Gross \| Fees \| Net ROI/);
});
