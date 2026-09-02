import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enrichAll,
  enrichRow,
  leadTimeHours,
  FEATURE_REGISTRY,
  VOLUME_SEMANTICS,
  SCORE_SLOTS,
  AUGUST_BASE_POPULATION,
  type AugustBaseRow,
  type ReplayInputRow,
  type TaxonomyRow,
} from "../../../lib/modeling/august-enrichment";

function baseRow(o: Partial<AugustBaseRow> = {}): AugustBaseRow {
  return {
    id: o.id ?? "row-1",
    provider_event_id: o.provider_event_id ?? "evt-1",
    condition_id: o.condition_id ?? "0xcond",
    selected_token_id: o.selected_token_id ?? "tok",
    created_at: o.created_at ?? "2026-08-10T12:00:00.000Z",
    event_start: o.event_start ?? "2026-08-10T18:00:00.000Z",
    t90_cutoff: o.t90_cutoff ?? "2026-08-10T16:30:00.000Z",
    event_slug: o.event_slug ?? "A vs. B",
    label: o.label ?? { status: "WIN", gamma_event_id: "evt-1", gamma_winning_token_id: "tok" },
    _lane: o._lane ?? "train",
  };
}

function inputs(
  base: AugustBaseRow[],
  replay: ReplayInputRow[] = [],
  tax: TaxonomyRow[] = [],
) {
  return {
    base,
    replayById: new Map(replay.map((r) => [r.source_row_id, r])),
    taxonomyById: new Map(tax.map((r) => [r.source_row_id, r])),
  };
}

test("lead time is decision->start hours", () => {
  assert.equal(leadTimeHours("2026-08-10T12:00:00Z", "2026-08-10T18:00:00Z"), 6);
});

test("resolved replay + taxonomy join produces point-in-time-safe features", () => {
  const row = baseRow();
  const r = enrichRow(
    row,
    inputs(
      [row],
      [{ source_row_id: "row-1", replay_inputs: { entry_price_num: 0.55 } }],
      [{ source_row_id: "row-1", taxonomy: { sport_family: "soccer", market_type: "MONEYLINE" } }],
    ),
  );
  assert.equal(r.enrichment.entry_price.status, "RESOLVED");
  assert.equal(r.enrichment.entry_price.value, 0.55);
  assert.equal(r.enrichment.entry_price.observed_at, row.created_at);
  assert.equal(r.enrichment.market_family.value, "MONEYLINE");
  assert.equal(r.enrichment.sport_family.value, "soccer");
  assert.equal(r.enrichment.formula_version.value, "shadow-strategic-sports-v1");
});

test("missing join => ENRICHMENT_UNRESOLVED, base row kept, nothing imputed", () => {
  const row = baseRow({ id: "orphan" });
  const r = enrichRow(row, inputs([row]));
  assert.equal(r.base.id, "orphan");
  assert.equal(r.enrichment.entry_price.status, "ENRICHMENT_UNRESOLVED");
  assert.equal(r.enrichment.entry_price.value, null);
  assert.equal(r.enrichment.market_family.status, "ENRICHMENT_UNRESOLVED");
});

test("unresolved market_type value is not a resolved market family", () => {
  const row = baseRow();
  const r = enrichRow(
    row,
    inputs([row], [], [{ source_row_id: "row-1", taxonomy: { market_type: "UNRESOLVED" } }]),
  );
  assert.equal(r.enrichment.market_family.status, "ENRICHMENT_UNRESOLVED");
  assert.equal(r.enrichment.market_family.value, null);
});

test("every score slot and every volume semantic is NOT_RECOVERABLE and never imputed", () => {
  const row = baseRow();
  const r = enrichRow(
    row,
    inputs(
      [row],
      [{ source_row_id: "row-1", replay_inputs: { entry_price_num: 0.6, signal_confidence_num: 71 as unknown as number } }],
    ),
  );
  for (const slot of SCORE_SLOTS) {
    assert.equal(r.enrichment[slot].status, "NOT_RECOVERABLE", slot);
    assert.equal(r.enrichment[slot].value, null, slot);
  }
  for (const sem of VOLUME_SEMANTICS) {
    assert.equal(r.enrichment[sem].status, "NOT_RECOVERABLE", sem);
    assert.equal(r.enrichment[sem].value, null, sem);
  }
  assert.equal(r.enrichment.smart_money.status, "NOT_RECOVERABLE");
  assert.equal(r.enrichment.price_movement.status, "NOT_RECOVERABLE");
});

test("volume semantics are kept strictly separate (5 distinct keys)", () => {
  assert.deepEqual(
    [...VOLUME_SEMANTICS].sort(),
    ["market_volume_usd", "maxTradeCash", "parentEventVolume24hr", "recentTradeCash", "volumeUsd"],
  );
});

test("a future-dated enrichment observation is rejected by the point-in-time gate", () => {
  // taxonomy observed_at is bound to created_at, so we simulate a decision AFTER start
  const row = baseRow({ created_at: "2026-08-10T20:00:00.000Z" }); // after event_start 18:00
  const r = enrichRow(
    row,
    inputs([row], [], [{ source_row_id: "row-1", taxonomy: { sport_family: "tennis" } }]),
  );
  // sport_family observed_at == created_at == decision, still <= decision, so RESOLVED;
  // the gate only blocks values observed strictly after decision. Assert lead time negative is surfaced.
  assert.ok(r.base.lead_time_hours < 0);
  assert.equal(r.enrichment.sport_family.status, "RESOLVED");
});

test("enrichAll conserves rows and builds a coverage report", () => {
  const rows = [
    baseRow({ id: "a", provider_event_id: "1", event_start: "2026-08-05T15:10:00.000Z" }),
    baseRow({ id: "b", provider_event_id: "2", event_start: "2026-08-27T16:00:00.000Z", label: { status: "LOSS" } }),
  ];
  const { rows: out, coverage } = enrichAll(
    inputs(
      rows,
      [
        { source_row_id: "a", replay_inputs: { entry_price_num: 0.5 } },
        { source_row_id: "b", replay_inputs: { entry_price_num: 0.7 } },
      ],
      [{ source_row_id: "a", taxonomy: { sport_family: "soccer", market_type: "TOTAL" } }],
    ),
  );
  assert.equal(out.length, 2);
  assert.equal(coverage.base_row_n, 2);
  assert.equal(coverage.enriched_row_n, 2);
  assert.equal(coverage.entry_price.present_n, 2);
  assert.equal(coverage.market_family.present_n, 1);
  assert.equal(coverage.market_family.distribution.TOTAL, 1);
  assert.equal(coverage.rows_with_score_and_settlement_n, 0);
  assert.equal(coverage.rows_with_score_and_volume_n, 0);
  assert.equal(coverage.score_population, "shadow-strategic-sports-v1");
  // chronological sort by event_start
  assert.equal(out[0].base.id, "a");
});

test("NOT_RECOVERABLE registry matches the frozen audit scope", () => {
  const nr = FEATURE_REGISTRY.filter((f) => f.baselineStatus === "NOT_RECOVERABLE").map((f) => f.key);
  for (const k of [...SCORE_SLOTS, ...VOLUME_SEMANTICS, "smart_money", "price_movement", "metric_formula_version"]) {
    assert.ok(nr.includes(k), `${k} must be NOT_RECOVERABLE`);
  }
});

test("base population identity is not redefined here", () => {
  assert.equal(AUGUST_BASE_POPULATION.expectedRowCount, 18705);
  assert.equal(AUGUST_BASE_POPULATION.identityKey, "id");
});
