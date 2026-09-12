import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrimaryEvidenceRows } from "../../lib/feed/primaryEvidenceServing";
import type { WritePairsInput } from "../../lib/feed/cacheGeneratedSignals";
import { persistCanonicalPrimarySignalPopulation } from "../../lib/feed/persistPrimarySignalPopulation";

const observationId = "00000000-0000-4000-8000-000000000508";

test("the bounded producer maximum is 254 samples times two eligible outcomes, and all 508 identities remain one envelope", () => {
  const input = {
    pairs: Array.from({ length: 508 }, (_, n) => ({
      id: `pair-${n}`,
      premiumSignal: { eventTitle: `Event ${n}`, winProbability: 65, profit: "+1%", metrics: [] },
      marketSource: { headline: `Market ${n}` },
      marketSources: [],
      diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}`, currentPrice: 0.5 },
    })),
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
  } as unknown as WritePairsInput;
  const rows = buildPrimaryEvidenceRows(observationId, input);
  assert.equal(rows.length, 508);
  assert.equal(new Set(rows.map((r) => `${r.condition_id}::${r.selected_token_id}`)).size, 508);
});

test("a 301-row corrected population is one successful publication below the 508 cap", async () => {
  const qualified = Array.from({ length: 301 }, (_, n) => ({
    id: `pair-${n}`,
    premiumSignal: { eventTitle: `Event ${n}`, winProbability: 65, profit: "+1%", metrics: [] },
    marketSource: { headline: `Market ${n}` },
    marketSources: [],
    diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}`, currentPrice: 0.5 },
  })) as never[];
  let publishedRowCount = -1;
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId,
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: async (args) => {
      publishedRowCount = args.input.pairs.length;
      return { servingProjectedCount: publishedRowCount, primaryEvidenceCapturedCount: publishedRowCount, durationMs: 1 };
    },
  });
  assert.equal(publishedRowCount, 301);
  assert.equal(result.primaryEvidenceCapturedCount, 301);
  assert.equal(result.servingProjectedCount, 301);
  assert.ok(publishedRowCount < 508, "PUBLISH_CAP_HIT=false for the >300 proof population");
});

test("the 508-row migration preserves the outbox-to-serving transaction and rejects row 509", () => {
  const sql = readFileSync("supabase/migrations/20260912041412_primary_evidence_508_row_ceiling.sql", "utf8");
  assert.match(sql, /CHECK \(evidence_row_count BETWEEN 1 AND 508\)/);
  assert.match(sql, /IF row_n < 1 OR row_n > 508 THEN/);
  assert.match(sql, /between 1 and 508/);
  assert.match(sql, /observation id replay payload mismatch/);
  assert.ok(
    sql.indexOf("INSERT INTO public.primary_evidence_outbox") < sql.indexOf("INSERT INTO public.current_signal_pair_serving"),
    "outbox and serving remain in the one RPC transaction",
  );
});
