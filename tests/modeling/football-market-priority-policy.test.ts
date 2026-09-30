import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChoiceSets, choosePolicy, chooseBaseline, type PolicyRow, type Policy } from "../../scripts/modeling/football-market-priority-policy";

const row = (ev: string, type: string, cond: string, ts = "2026-09-01T10:00:00Z", price = 0.5): PolicyRow => ({
  physicalEventKey: ev, decisionTimestamp: ts, eventStart: "2026-09-01T18:00:00Z", entryPrice: price,
  marketTypeRaw: type, conditionId: cond, tokenId: `${cond}-t`, candidateIdentity: `${cond}::${cond}-t::${ts}`,
});
const spreadsFirst: Policy = { id: "S", priority: ["spreads", "moneyline", "totals", "total_corners", "other_structured"] };
const rows = [row("E1", "totals", "c3"), row("E1", "moneyline", "c2"), row("E1", "spreads", "c1"), row("E1", "spreads", "c0", "2026-09-01T11:00:00Z"),
  row("E1", "soccer_exact_score", "cx"), row("E2", "moneyline", "d1")];

test("one economic bet per physical event, exact-score excluded, later rows outside T0 set", () => {
  const sets = buildChoiceSets(rows);
  assert.equal(sets.size, 2);
  assert.equal(sets.get("E1")!.length, 3);
  const picks = [...sets.values()].map((s) => choosePolicy(s, spreadsFirst)!);
  assert.deepEqual(picks.map((p) => p.conditionId).sort(), ["c1", "d1"]);
});

test("input order reversal does not change chosen identity", () => {
  const a = [...buildChoiceSets(rows).values()].map((s) => choosePolicy(s, spreadsFirst)!.candidateIdentity).sort();
  const b = [...buildChoiceSets([...rows].reverse()).values()].map((s) => choosePolicy(s, spreadsFirst)!.candidateIdentity).sort();
  assert.deepEqual(a, b);
});

test("selection is settlement-blind: rows carry no outcome field and policy ignores extra fields", () => {
  const tainted = rows.map((r, i) => ({ ...r, outcome: i % 2 ? "WIN" : "LOSS", pnlU: i }));
  const a = choosePolicy(buildChoiceSets(rows).get("E1")!, spreadsFirst)!.candidateIdentity;
  const b = choosePolicy(buildChoiceSets(tainted).get("E1")!, spreadsFirst)!.candidateIdentity;
  assert.equal(a, b);
});

test("pair policy fails closed when required family missing; baseline picks first by tie-break", () => {
  const pair: Policy = { id: "P", priority: ["spreads", "moneyline"], requireAll: ["spreads", "moneyline"] };
  assert.equal(choosePolicy(buildChoiceSets(rows).get("E2")!, pair), null);
  assert.equal(choosePolicy(buildChoiceSets(rows).get("E1")!, pair)!.conditionId, "c1");
  assert.equal(chooseBaseline(buildChoiceSets(rows).get("E1")!)!.conditionId, "c1"); // equal ts/price -> conditionId asc
});
