/**
 * ROLLING_RESEARCH_CORPUS_7D14D30D_V1 — focused verification.
 *
 * Proves:
 *  - exactly 7 / 14 / 30 completed Europe/Minsk days are resolved, ending at D-1;
 *  - the rolling manifest references partition hashes, never duplicating payloads;
 *  - a selection identity repeated across partitions collapses to ONE bet
 *    (earliest DECISION_AT) — no double-betting across dates;
 *  - physical-event, pre-collapse and unique-selection counts stay distinct;
 *  - populations are never pooled;
 *  - PIT_FUTURE_LEAK_N is recomputed from frozen rows and stays 0;
 *  - a window with any missing closed-day partition is NOT reported complete;
 *  - the real committed immutable D-1 partition loads + hash-verifies.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  buildRollingManifest,
  buildScorecardRowView,
  latestClosedMinskDay,
  resolveWindowDates,
  type DerivedSeries,
  type LoadedPartition,
  type RollingCompactRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";

const NULL_SERIES: DerivedSeries = {
  observationCount: 0,
  firstEligibleValue: null,
  firstEligibleObservedAt: null,
  lastEligibleValue: null,
  lastEligibleObservedAt: null,
  delta: null,
};

function row(p: Partial<RollingCompactRow> & Pick<RollingCompactRow, "populationId" | "conditionId" | "selectedTokenId" | "decisionAt">): RollingCompactRow {
  return {
    providerEventId: null,
    entryPrice: null,
    eventStart: null,
    sportFamily: null,
    label: "OPEN",
    score: NULL_SERIES,
    selectedPrice: NULL_SERIES,
    volumeUsd: null,
    leadTimeHours: null,
    ...p,
  };
}

function partition(date: string, rows: RollingCompactRow[]): LoadedPartition {
  return {
    partitionDate: date,
    canonicalHash: `hash-${date}`,
    labelEvidenceAsOf: `${date}T12:00:00.000Z`,
    sourceWindowStart: null,
    sourceWindowEnd: null,
    rows,
  };
}

test("resolveWindowDates returns exactly N completed Minsk days ending at D-1", () => {
  const now = "2026-09-03T09:00:00.000Z"; // Minsk 12:00 on 2026-09-03 → D-1 = 2026-09-02
  assert.equal(latestClosedMinskDay(now), "2026-09-02");
  for (const w of [7, 14, 30] as const) {
    const { dates, windowEnd, windowStart } = resolveWindowDates(w, now);
    assert.equal(dates.length, w);
    assert.equal(windowEnd, "2026-09-02");
    assert.equal(dates[dates.length - 1], "2026-09-02");
    assert.equal(windowStart, dates[0]);
    // strictly ascending, 1-day spacing
    for (let i = 1; i < dates.length; i++) {
      const gap = Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`);
      assert.equal(gap, 86_400_000);
    }
  }
});

test("early-Minsk-morning wall clock still resolves D-1 as the last closed day", () => {
  // 2026-09-03T00:30 Minsk = 2026-09-02T21:30Z
  assert.equal(latestClosedMinskDay("2026-09-02T21:30:00.000Z"), "2026-09-02");
});

test("manifest references partition hashes and never inlines payloads", () => {
  const now = "2026-09-03T09:00:00.000Z";
  const { dates } = resolveWindowDates(7, now);
  const partitions = dates.map((d) =>
    partition(d, [row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t1", decisionAt: `${d}T06:00:00Z` })]),
  );
  const m = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions }, "2026-09-03T09:00:00.000Z");
  assert.equal(m.PARTITION_HASH_REFERENCES_ONLY, true);
  assert.equal(m.AVAILABLE_PARTITION_N, 7);
  assert.equal(m.MISSING_PARTITION_N, 0);
  assert.equal(m.WINDOW_COMPLETE, true);
  for (const p of m.PARTITIONS) assert.equal(p.PARTITION_CANONICAL_HASH, `hash-${p.PARTITION_DATE}`);
  const serialized = JSON.stringify(m);
  assert.ok(!serialized.includes('"score"'), "manifest must not carry per-row feature payloads");
});

test("a selection repeated across partitions collapses to one bet (earliest DECISION_AT)", () => {
  const now = "2026-09-03T09:00:00.000Z";
  const { dates } = resolveWindowDates(7, now);
  const repeated = { populationId: "SEP_PUBLIC_RICH_V1" as const, conditionId: "c-shared", selectedTokenId: "t-shared" };
  // same identity appears on 3 different partition dates
  const partitions = dates.map((d, i) =>
    partition(d, [
      row({ ...repeated, decisionAt: `${d}T0${i}:00:00Z`, providerEventId: "evt-1", label: i === 0 ? "OPEN" : "WIN" }),
      row({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: `s-${d}`, selectedTokenId: "t2", decisionAt: `${d}T05:00:00Z` }),
    ]),
  );
  const m = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions }, now);

  assert.equal(m.CROSS_PARTITION_IDENTITY.WINDOW_PRE_COLLAPSE_ROW_N.value, 14);
  // 1 shared selection + 7 distinct strategic selections
  assert.equal(m.CROSS_PARTITION_IDENTITY.WINDOW_UNIQUE_SELECTION_N.value, 8);

  const rich = m.POPULATIONS.find((p) => p.population_id === "SEP_PUBLIC_RICH_V1")!;
  assert.equal(rich.INPUT_ROWS.value, 7); // pre-collapse
  assert.equal(rich.UNIQUE_SELECTION_N.value, 1); // collapsed → one bet
  assert.equal(rich.UNIQUE_PHYSICAL_EVENT_SELECTION_N.value, 1);
  // frozen label = earliest decision row's label (OPEN on the first date)
  assert.equal(rich.LABEL_COUNTS_FROZEN["OPEN"], 1);
  // fresher overlay promotes it to the latest partition's terminal label
  const overlayRich = m.LABEL_AS_OF_OVERLAY.POPULATIONS.find((p) => p.population_id === "SEP_PUBLIC_RICH_V1")!;
  assert.equal(overlayRich.SETTLED_N, 1);
  assert.equal(overlayRich.changed_from_frozen_n, 1);

  // populations reported separately, never summed
  assert.equal(m.POPULATION_POOLING.startsWith("FORBIDDEN"), true);
});

test("PIT_FUTURE_LEAK_N counts post-decision eligible observations and is 0 for clean rows", () => {
  const now = "2026-09-03T09:00:00.000Z";
  const d = latestClosedMinskDay(now);
  const clean = row({
    populationId: "SEP_PUBLIC_RICH_V1",
    conditionId: "c1",
    selectedTokenId: "t1",
    decisionAt: `${d}T12:00:00Z`,
    selectedPrice: { ...NULL_SERIES, observationCount: 1, lastEligibleObservedAt: `${d}T10:00:00Z`, lastEligibleValue: 0.4 },
  });
  const leaky = row({
    populationId: "SEP_PUBLIC_RICH_V1",
    conditionId: "c2",
    selectedTokenId: "t2",
    decisionAt: `${d}T12:00:00Z`,
    score: { ...NULL_SERIES, observationCount: 1, lastEligibleObservedAt: `${d}T18:00:00Z`, lastEligibleValue: 2 },
  });
  const okManifest = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions: [partition(d, [clean])] }, now);
  assert.equal(okManifest.PIT_FUTURE_LEAK_N.value, 0);
  const leakManifest = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions: [partition(d, [leaky])] }, now);
  assert.equal(leakManifest.PIT_FUTURE_LEAK_N.value, 1);
});

test("a window missing any closed-day partition is not reported complete", () => {
  const now = "2026-09-03T09:00:00.000Z";
  const { dates } = resolveWindowDates(7, now);
  const partitions = dates.slice(0, 3).map((d) =>
    partition(d, [row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t1", decisionAt: `${d}T06:00:00Z` })]),
  );
  const m = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions }, now);
  assert.equal(m.WINDOW_COMPLETE, false);
  assert.equal(m.AVAILABLE_PARTITION_N, 3);
  assert.equal(m.MISSING_PARTITION_N, 4);
  assert.equal(m.MISSING_DAYS.length, 4);
});

// ── ROLLING_SCORECARD_ROW_VIEW_V1 ────────────────────────────────────────
const SC_NOW = "2026-09-03T09:00:00.000Z";

test("scorecard row view: duplicate identity across partitions collapses to the earliest feature row, entryPrice verbatim", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const id = { populationId: "SEP_PUBLIC_RICH_V1" as const, conditionId: "c-dup", selectedTokenId: "t-dup" };
  const partitions = dates.map((d, i) =>
    partition(d, [
      row({
        ...id,
        decisionAt: `${d}T0${i}:00:00Z`,
        entryPrice: i === 0 ? 0.41 : 0.99, // only the earliest (i=0) must survive
        scoreLevel: i === 0 ? 67 : 12,
        leadTimeHours: i === 0 ? 5 : 99,
        label: i === 0 ? "OPEN" : "WIN",
      }),
    ]),
  );
  const view = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions });
  assert.equal(view.ROW_N, 1);
  assert.equal(view.PRE_COLLAPSE_ROW_N, 7);
  const r = view.rows[0];
  assert.equal(r.decisionAt, `${dates[0]}T00:00:00Z`);
  assert.equal(r.entryPrice, 0.41);
  assert.equal(r.scoreLevel, 67);
  assert.equal(r.leadTimeHours, 5);
});

test("scorecard row view: frozenLabel is the earliest row's label; labelAsOf takes a later terminal label without mutating features", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const id = { populationId: "SEP_PUBLIC_RICH_V1" as const, conditionId: "c-settle", selectedTokenId: "t-settle" };
  const partitions = [
    partition(dates[0], [row({ ...id, decisionAt: `${dates[0]}T06:00:00Z`, entryPrice: 0.55, scoreLevel: 70, label: "OPEN" })]),
    partition(dates[3], [row({ ...id, decisionAt: `${dates[3]}T06:00:00Z`, entryPrice: 0.10, scoreLevel: 5, label: "LOSS" })]),
  ];
  const view = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions });
  assert.equal(view.ROW_N, 1);
  const r = view.rows[0];
  assert.equal(r.frozenLabel, "OPEN");
  assert.equal(r.labelAsOf, "LOSS");
  // decision-time features stay the EARLIEST row's values
  assert.equal(r.decisionAt, `${dates[0]}T06:00:00Z`);
  assert.equal(r.entryPrice, 0.55);
  assert.equal(r.scoreLevel, 70);
  assert.equal(view.AS_OF_LABEL_CHANGED_N["SEP_PUBLIC_RICH_V1"], 1);
});

test("scorecard row view: a later terminal label never reverts once terminal; OPEN-after-WIN keeps WIN", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const id = { populationId: "SEP_PUBLIC_RICH_V1" as const, conditionId: "c-x", selectedTokenId: "t-x" };
  const partitions = [
    partition(dates[0], [row({ ...id, decisionAt: `${dates[0]}T06:00:00Z`, label: "WIN" })]),
    partition(dates[2], [row({ ...id, decisionAt: `${dates[2]}T06:00:00Z`, label: "OPEN" })]),
  ];
  const r = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions }).rows[0];
  assert.equal(r.frozenLabel, "WIN");
  assert.equal(r.labelAsOf, "WIN");
});

test("scorecard row view: populations stay isolated and are never pooled", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const partitions = dates.map((d) =>
    partition(d, [
      row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `pr-${d}`, selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, scoreLevel: 60 }),
      row({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: `ss-${d}`, selectedTokenId: "t", decisionAt: `${d}T07:00:00Z`, scoreLevel: null }),
    ]),
  );
  const view = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions });
  assert.equal(view.POPULATION_ROW_N["SEP_PUBLIC_RICH_V1"], 7);
  assert.equal(view.POPULATION_ROW_N["SEP_SHADOW_STRATEGIC_V1"], 7);
  assert.equal(view.ROW_N, 14);
  // structural null score LEVEL is carried as null, never synthesized
  const shadow = view.rows.filter((r) => r.populationId === "SEP_SHADOW_STRATEGIC_V1");
  assert.ok(shadow.every((r) => r.scoreLevel === null));
});

test("scorecard row view: deterministic and independent of partition input order", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const build = () =>
    dates.map((d, i) =>
      partition(d, [
        row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t1", decisionAt: `${d}T0${i}:00:00Z`, entryPrice: 0.3 + i / 100 }),
        row({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: `s-${d}`, selectedTokenId: "t2", decisionAt: `${d}T1${i}:00:00Z` }),
      ]),
    );
  const a = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions: build() });
  const b = buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions: [...build()].reverse() });
  assert.deepEqual(a.rows, b.rows);
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test("scorecard row view: PIT_FUTURE_LEAK_N matches manifest semantics (0 clean, 1 leaky)", () => {
  const d = latestClosedMinskDay(SC_NOW);
  const clean = row({
    populationId: "SEP_PUBLIC_RICH_V1", conditionId: "c1", selectedTokenId: "t1", decisionAt: `${d}T12:00:00Z`,
    selectedPrice: { ...NULL_SERIES, observationCount: 1, lastEligibleObservedAt: `${d}T10:00:00Z`, lastEligibleValue: 0.4 },
  });
  const leaky = row({
    populationId: "SEP_PUBLIC_RICH_V1", conditionId: "c2", selectedTokenId: "t2", decisionAt: `${d}T12:00:00Z`,
    score: { ...NULL_SERIES, observationCount: 1, lastEligibleObservedAt: `${d}T18:00:00Z`, lastEligibleValue: 2 },
  });
  assert.equal(buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions: [partition(d, [clean])] }).PIT_FUTURE_LEAK_N, 0);
  assert.equal(buildScorecardRowView({ windowDays: 7, nowUtc: SC_NOW, partitions: [partition(d, [leaky])] }).PIT_FUTURE_LEAK_N, 1);
});

test("buildRollingManifest output is unchanged for identical inputs after the shared-collapse refactor", () => {
  const { dates } = resolveWindowDates(7, SC_NOW);
  const mk = () =>
    dates.map((d, i) =>
      partition(d, [
        row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "c-shared", selectedTokenId: "t", decisionAt: `${d}T0${i}:00:00Z`, providerEventId: "e1", label: i === 0 ? "OPEN" : "WIN", scoreLevel: 65 }),
        row({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: `s-${d}`, selectedTokenId: "t", decisionAt: `${d}T09:00:00Z` }),
      ]),
    );
  const m1 = buildRollingManifest({ windowDays: 7, nowUtc: SC_NOW, partitions: mk() }, "2026-09-03T09:00:00.000Z");
  const m2 = buildRollingManifest({ windowDays: 7, nowUtc: SC_NOW, partitions: [...mk()].reverse() }, "2026-09-03T09:00:00.000Z");
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
  const rich = m1.POPULATIONS.find((p) => p.population_id === "SEP_PUBLIC_RICH_V1")!;
  assert.equal(rich.UNIQUE_SELECTION_N.value, 1);
  assert.equal(rich.LABEL_COUNTS_FROZEN["OPEN"], 1);
  assert.equal(m1.LABEL_AS_OF_OVERLAY.POPULATIONS.find((p) => p.population_id === "SEP_PUBLIC_RICH_V1")!.changed_from_frozen_n, 1);
});

test("the committed immutable D-1 partition (2026-09-02) loads and hash-verifies", () => {
  const dir = "modeling/evidence/research-corpus-factory-live-v1";
  const gz = readFileSync(`${dir}/CORPUS_2026-09-02.jsonl.gz`);
  const jsonl = gunzipSync(gz).toString("utf8");
  const hash = createHash("sha256").update(jsonl, "utf8").digest("hex");
  const manifest = JSON.parse(readFileSync(`${dir}/MANIFEST_2026-09-02.json`, "utf8"));
  assert.equal(hash, manifest.CANONICAL_CONTENT_SHA256);
  assert.equal(hash, "0e06fd869462118b79138cf6741c188f2d58c551f3f8023eadbc6b18eb2d7287");

  const rows: RollingCompactRow[] = jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const p: LoadedPartition = {
    partitionDate: "2026-09-02",
    canonicalHash: hash,
    labelEvidenceAsOf: manifest.LABEL_EVIDENCE_AS_OF.value,
    sourceWindowStart: manifest.SOURCE_WINDOW_START.value,
    sourceWindowEnd: manifest.SOURCE_WINDOW_END.value,
    rows,
  };
  const m = buildRollingManifest({ windowDays: 7, nowUtc: "2026-09-03T09:00:00.000Z", partitions: [p] }, "2026-09-03T09:00:00.000Z");
  assert.equal(m.AVAILABLE_PARTITION_N, 1);
  assert.equal(m.PIT_FUTURE_LEAK_N.value, 0);
  // per-population compact row counts match the frozen manifest
  const rich = m.PARTITIONS[0].PARTITION_COMPACT_ROW_N_BY_POPULATION["SEP_PUBLIC_RICH_V1"];
  const shadow = m.PARTITIONS[0].PARTITION_COMPACT_ROW_N_BY_POPULATION["SEP_SHADOW_STRATEGIC_V1"];
  assert.equal(rich, 501);
  assert.equal(shadow, 636);
});
