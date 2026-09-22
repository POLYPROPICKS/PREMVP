// MONOTONIC_SETTLEMENT_GUARD_V1 focused coverage.
//
// Proves the one invariant this repair mission requires: an explicit
// --start/--end/--dates rematerialization of research_model_ready_rows must
// never let an already-terminal WIN/LOSS settlement_label regress to a
// non-terminal label (OPEN/NO_MATCH/AMBIGUOUS/VOID), while still allowing
// WIN/LOSS -> WIN/LOSS refresh and OPEN/non-terminal -> WIN/LOSS promotion.
// No network, no live clone connection.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyMonotonicSettlementGuard,
  writeDayRows,
} from "../../scripts/modeling/materialize-research-model-ready";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

const D = "2026-09-07";

function row(labelAsOf: string, overrides: Record<string, unknown> = {}): ScorecardReadyRow {
  return {
    populationId: "pop-a",
    conditionId: "0xcond-a",
    selectedTokenId: "token-a",
    decisionAt: "2026-09-07T12:00:00.000Z",
    providerEventId: "polymarket-event-a",
    entryPrice: 0.51,
    eventStart: "2026-09-07T18:00:00.000Z",
    sportFamily: "tennis",
    labelAsOf,
    frozenLabel: labelAsOf,
    ...overrides,
  } as unknown as ScorecardReadyRow;
}

function existingMap(entries: Array<[ScorecardReadyRow]>): Map<string, ScorecardReadyRow> {
  const map = new Map<string, ScorecardReadyRow>();
  for (const [r] of entries) {
    map.set(`${r.populationId}|${r.conditionId}|${r.selectedTokenId}|${r.decisionAt}`, r);
  }
  return map;
}

test("applyMonotonicSettlementGuard: OPEN -> WIN is allowed (promotion)", () => {
  const incoming = [row("WIN")];
  const out = applyMonotonicSettlementGuard(incoming, new Map());
  assert.equal(out[0].labelAsOf, "WIN");
});

test("applyMonotonicSettlementGuard: OPEN -> LOSS is allowed (promotion)", () => {
  const incoming = [row("LOSS")];
  const out = applyMonotonicSettlementGuard(incoming, new Map());
  assert.equal(out[0].labelAsOf, "LOSS");
});

test("applyMonotonicSettlementGuard: WIN -> OPEN is refused; existing terminal row preserved", () => {
  const existingWin = row("WIN");
  const incomingOpen = row("OPEN");
  const out = applyMonotonicSettlementGuard([incomingOpen], existingMap([[existingWin]]));
  assert.equal(out[0].labelAsOf, "WIN", "regression to OPEN refused, existing WIN preserved verbatim");
  assert.equal(out[0], existingWin, "the exact existing canonical row is substituted back, not merely re-labeled");
});

test("applyMonotonicSettlementGuard: LOSS -> OPEN is refused; existing terminal row preserved", () => {
  const existingLoss = row("LOSS");
  const incomingOpen = row("OPEN");
  const out = applyMonotonicSettlementGuard([incomingOpen], existingMap([[existingLoss]]));
  assert.equal(out[0].labelAsOf, "LOSS", "regression to OPEN refused, existing LOSS preserved verbatim");
});

test("applyMonotonicSettlementGuard: LOSS -> NO_MATCH / AMBIGUOUS / VOID regressions are also refused", () => {
  const existingLoss = row("LOSS");
  for (const nonTerminal of ["NO_MATCH", "AMBIGUOUS", "VOID"]) {
    const out = applyMonotonicSettlementGuard([row(nonTerminal)], existingMap([[existingLoss]]));
    assert.equal(out[0].labelAsOf, "LOSS", `${nonTerminal} regression refused`);
  }
});

test("applyMonotonicSettlementGuard: WIN -> WIN is stable (content refresh still allowed)", () => {
  const existingWin = row("WIN", { entryPrice: 0.51 });
  const incomingWin = row("WIN", { entryPrice: 0.5123 }); // refreshed content, same terminal label
  const out = applyMonotonicSettlementGuard([incomingWin], existingMap([[existingWin]]));
  assert.equal(out[0].labelAsOf, "WIN");
  assert.equal(out[0].entryPrice, 0.5123, "terminal -> terminal still refreshes row content, not frozen");
});

test("applyMonotonicSettlementGuard: LOSS -> LOSS is stable (content refresh still allowed)", () => {
  const existingLoss = row("LOSS");
  const incomingLoss = row("LOSS");
  const out = applyMonotonicSettlementGuard([incomingLoss], existingMap([[existingLoss]]));
  assert.equal(out[0].labelAsOf, "LOSS");
});

test("applyMonotonicSettlementGuard: identity not present in existing map passes through untouched", () => {
  const incoming = row("OPEN", { conditionId: "0xcond-brand-new" });
  const out = applyMonotonicSettlementGuard([incoming], new Map());
  assert.equal(out[0].labelAsOf, "OPEN", "no prior terminal row for this identity: nothing to protect");
});

// ── end-to-end via writeDayRows against a fake clone (bounded date read + upsert) ──

function makeFakeCloneWithExistingRows(existingRows: Record<string, unknown>[]) {
  const writes: { table: string; rows: Record<string, unknown>[] }[] = [];
  return {
    writes,
    client: {
      from(table: string) {
        if (table === "research_model_ready_rows") {
          return {
            select() {
              return this;
            },
            eq(field: string, value: unknown) {
              (this as any)._modelDate = field === "model_date" ? value : (this as any)._modelDate;
              return this;
            },
            in(field: string, values: unknown[]) {
              const modelDate = (this as any)._modelDate;
              const filtered = existingRows.filter(
                (r) => r.model_date === modelDate && (values as string[]).includes(r.settlement_label as string),
              );
              return Promise.resolve({ data: filtered, error: null });
            },
            upsert(rows: Record<string, unknown>[]) {
              writes.push({ table, rows });
              return Promise.resolve({ error: null });
            },
          };
        }
        return {
          upsert(rows: Record<string, unknown>[]) {
            writes.push({ table, rows });
            return Promise.resolve({ error: null });
          },
        };
      },
    } as any,
  };
}

test("writeDayRows: end-to-end refuses a WIN->OPEN rematerialization via the bounded date-scoped existing-row read", async () => {
  const existingWinRow = row("WIN");
  const { client, writes } = makeFakeCloneWithExistingRows([
    {
      model_date: D,
      population_id: existingWinRow.populationId,
      condition_id: existingWinRow.conditionId,
      selected_token_id: existingWinRow.selectedTokenId,
      decision_at: existingWinRow.decisionAt,
      settlement_label: "WIN",
      canonical_row: existingWinRow,
    },
  ]);

  const incomingOpenRow = row("OPEN");
  await writeDayRows(client, D, [incomingOpenRow]);

  const rowWrite = writes.find((w) => w.table === "research_model_ready_rows");
  assert.ok(rowWrite, "writes to research_model_ready_rows");
  const written = rowWrite!.rows[0] as unknown as { settlement_label: string; canonical_row: ScorecardReadyRow };
  assert.equal(written.settlement_label, "WIN", "monotonic guard preserved the terminal label through the full write path");
  assert.equal(written.canonical_row.labelAsOf, "WIN");
});
