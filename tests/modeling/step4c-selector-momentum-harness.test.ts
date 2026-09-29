import test from "node:test";
import assert from "node:assert/strict";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { compareSiblingSelectors, settlePairedChoices, type Opportunity } from "../../scripts/modeling/step4c-selector-momentum-harness";

function opportunity(token: string, time: string, score: number): Opportunity {
  const conditionId = "condition";
  return {
    physicalEventKey: "event", conditionId, selectedTokenId: token,
    decisionTimestamp: time, eventStart: "2026-09-29T18:00:00Z",
    entryPrice: token === "a" ? 0.5 : 0.6, marketFamily: "moneyline",
    liveCandidate: {
      condition_id: conditionId, token_id: token, live_eligible: true,
      strategy: "TIER1_CORE_STRICT_72_COV50", match_family_key_source: "event_slug",
      diagnostics: { score, coverage: 75, smart_money: 0, hours_to_start_now: 1 },
    } as FireModelCandidate,
  };
}

test("actual live comparator and research chronology choose exact different identities, independent of input order", () => {
  const a = opportunity("a", "2026-09-28T10:00:00Z", 75);
  const b = opportunity("b", "2026-09-28T11:00:00Z", 85);
  const forward = compareSiblingSelectors([a, b]);
  const reverse = compareSiblingSelectors([b, a]);
  assert.equal(forward.eventN, 1);
  assert.equal(forward.differentIdentityN, 1);
  assert.equal(forward.paired[0].A.exactIdentity, "condition::a");
  assert.equal(forward.paired[0].B.exactIdentity, "condition::b");
  assert.deepEqual(forward, reverse);
});

test("settlement joins only after both choices and preserves OPEN slots", () => {
  const compared = compareSiblingSelectors([
    opportunity("a", "2026-09-28T10:00:00Z", 75),
    opportunity("b", "2026-09-28T11:00:00Z", 85),
  ]);
  const open = settlePairedChoices(compared, new Map([["condition::a", "OPEN"], ["condition::b", "OPEN"]]));
  assert.equal(open.A.openN, 1);
  assert.equal(open.B.openN, 1);
  const unlabeled = settlePairedChoices(compared, new Map());
  assert.equal(unlabeled.A.unlabeledN, 1);
  assert.equal(unlabeled.A.openN, 0);
  const settled = settlePairedChoices(compared, new Map([["condition::a", "WIN"], ["condition::b", "LOSS"]]));
  assert.equal(settled.aWinBLoss, 1);
  assert.equal(settled.aLossBWin, 0);
  assert.equal(settled.A.settledN, 1);
  assert.equal(settled.B.settledN, 1);
});

test("missing live ranking inputs fail closed", () => {
  const a = opportunity("a", "2026-09-28T10:00:00Z", 75);
  a.liveCandidate = { condition_id: "condition", token_id: "a" } as FireModelCandidate;
  assert.throws(() => compareSiblingSelectors([a]), /LIVE_COMPARATOR_INPUT_UNAVAILABLE/);
});
