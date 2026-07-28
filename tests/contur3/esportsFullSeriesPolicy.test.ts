// eSports main series-winner planning policy — canonical full-series admission.
//   node --import tsx --test tests/contur3/esportsFullSeriesPolicy.test.ts
//
// Production gap #1: canonicalEsportsSeriesCompetitors (lib/executor/nightEventReservations.ts)
// only recognized a BO1/BO3/BO5 series title when it carried one of four
// hardcoded game-name prefixes ("Counter-Strike:", "Dota 2:", "LoL:",
// "Valorant:"). A genuinely valid main series winner with NO game-name prefix
// at all -- "Cloud9 vs LOUD (BO3)", exactly as listed in the approved policy
// -- could never match that regex, so canonicalEsportsSeriesCompetitors
// returned null and fullMatchAnchorDecision rejected it
// (FULLMATCH_TWO_COMPETITORS_MISSING), even though the taxonomy layer's own
// event-scope classification correctly saw it as a full match.
//
// Production gap #2: a main series winner with NO series-length marker at all
// ("Cloud9 vs LOUD") was rejected outright (FULLMATCH_SERIES_MARKER_MISSING)
// even when the provider's own structured event context supplied a stable
// event identity (event key + start time) -- the same strength of evidence
// that already admits a bare baseball matchup via the planning anchor's
// STRUCTURED_FULLMATCH_EVENT path, but eSports was excluded from that path by
// design (PLANNING_EVENT_LEVEL_EXCLUDED_SPORTS). This module fixes it INSIDE
// the existing eSports full-match anchor exception instead, so eSports still
// never flows through planningAnchor.ts.
//
// This suite proves the RED (both gaps, replayed through the real
// buildFireModelCandidates -> taxonomy -> fullMatchAnchorDecision boundary)
// and, after the fix, proves the GREEN: both shapes admit, multi-market
// dedupe collapses to one physical event, and the existing narrow BO-series
// exception (game-name-prefixed titles) is unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan, fullMatchAnchorDecision } from "../../lib/executor/nightEventReservations";

const NOW_MS = Date.parse("2026-07-28T10:00:00.000Z");
const KICKOFF_ISO = "2026-07-28T15:00:00.000Z";

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Provider's own structured event context (the ONLY source of stable identity). */
function providerContext(eventSlug: string, eventTitle: string, marketQuestion: string, game: string) {
  return {
    v: "v1",
    provider: "polymarket",
    eventSlug,
    eventTitle,
    marketQuestion,
    sportFamily: "esport",
    game,
    league: "PRO",
    eventStartIso: KICKOFF_ISO,
  };
}

/**
 * Establishes inferred_sport === "esport" WITHOUT granting a stable provider
 * event identity (no eventSlug/eventId, so providerEventKeyOf returns null).
 */
function sportOnlyContextNoIdentity() {
  return {
    v: "v1",
    provider: "polymarket",
    sportFamily: "esport",
    game: "valorant",
    league: "PRO",
  };
}

function esportsRow(opts: {
  id: string;
  marketTitle: string;
  eventTitle: string;
  eventSlug: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: Record<string, unknown> | null;
  selectedOutcome?: string;
}) {
  return {
    id: opts.id,
    condition_id: `cond-${opts.id}`,
    selected_token_id: `tok-${opts.id}`,
    selected_outcome: opts.selectedOutcome ?? "Cloud9",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.65,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-28T09:30:00.000Z",
    expires_at: KICKOFF_ISO,
    signal_result: null,
    event_slug: opts.eventSlug,
    market_slug: opts.marketTitle,
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      eventTitle: opts.eventTitle,
      marketTitle: opts.marketTitle,
      providerEventContext: opts.ctx,
    },
  };
}

async function buildCandidates(rows: ReturnType<typeof esportsRow>[]) {
  return at(NOW_MS, () => buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1"));
}

async function planWith(candidates: FireModelCandidate[]) {
  return at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: {} as any }),
    })
  );
}

// ── Positive: bare (no game-prefix) BO-series title ─────────────────────────

test("ESPORTS-1: a bare 'Cloud9 vs LOUD (BO3)' series winner (no game-name prefix) is admitted", async () => {
  const ctx = providerContext("cloud9-loud-2026-07-28", "Cloud9 vs LOUD (BO3)", "Cloud9 vs LOUD (BO3)", "valorant");
  const row = esportsRow({
    id: "bare-bo3",
    marketTitle: "Cloud9 vs LOUD (BO3)",
    eventTitle: "Cloud9 vs LOUD (BO3)",
    eventSlug: "esport-bare-bo3",
    ctx,
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  const [c] = built.candidates;
  assert.equal(c.inferred_sport, "esport");
  assert.deepEqual(fullMatchAnchorDecision(c), { allowed: true });
});

test("ESPORTS-2: LoL BO5 series winner, bare title, is admitted", async () => {
  const ctx = providerContext("nova-orion-2026-07-28", "Nova Esports vs Orion Gaming (BO5)", "Nova Esports vs Orion Gaming (BO5)", "lol");
  const row = esportsRow({
    id: "bare-bo5",
    marketTitle: "Nova Esports vs Orion Gaming (BO5)",
    eventTitle: "Nova Esports vs Orion Gaming (BO5)",
    eventSlug: "esport-bare-bo5",
    ctx,
    selectedOutcome: "Nova Esports",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  assert.deepEqual(fullMatchAnchorDecision(built.candidates[0]), { allowed: true });
});

// ── Positive: no series marker at all, admitted ONLY with provider identity ─

test("ESPORTS-3: a bare main series winner with NO BO marker is admitted only with stable provider event identity", async () => {
  const ctx = providerContext("cloud9-loud-nomarker-2026-07-28", "Cloud9 vs LOUD", "Cloud9 vs LOUD", "valorant");
  const withIdentity = esportsRow({
    id: "no-marker-with-identity",
    marketTitle: "Cloud9 vs LOUD",
    eventTitle: "Cloud9 vs LOUD",
    eventSlug: "esport-no-marker-identity",
    ctx,
  });
  const withoutIdentity = esportsRow({
    id: "no-marker-without-identity",
    marketTitle: "Cloud9 vs LOUD",
    eventTitle: "Cloud9 vs LOUD",
    eventSlug: "esport-no-marker-no-identity",
    // Established as inferred_sport === "esport" purely via sportFamily, but
    // WITHOUT a stable provider event key -- proves the gate really is keyed
    // on provider identity, not merely on "is this row esports at all".
    ctx: sportOnlyContextNoIdentity(),
  });

  const builtWith = await buildCandidates([withIdentity]);
  assert.equal(builtWith.candidates.length, 1);
  assert.ok(builtWith.candidates[0].providerEventKey, "precondition: provider identity must be present");
  assert.deepEqual(fullMatchAnchorDecision(builtWith.candidates[0]), { allowed: true });

  const builtWithout = await buildCandidates([withoutIdentity]);
  assert.equal(builtWithout.candidates.length, 1);
  assert.equal(builtWithout.candidates[0].providerEventKey, null, "no provider context supplied");
  assert.deepEqual(fullMatchAnchorDecision(builtWithout.candidates[0]), {
    allowed: false,
    reason: "FULLMATCH_SERIES_MARKER_MISSING",
  });
});

// ── Dedupe ───────────────────────────────────────────────────────────────────

test("ESPORTS-4: multiple main-winner rows for the same provider event dedupe to one physical event", async () => {
  const ctx = providerContext("cloud9-loud-dedupe-2026-07-28", "Cloud9 vs LOUD", "Cloud9 vs LOUD", "valorant");
  const rows = [
    esportsRow({ id: "dedupe-a", marketTitle: "Cloud9 vs LOUD", eventTitle: "Cloud9 vs LOUD", eventSlug: "esport-dedupe-a", ctx }),
    esportsRow({
      id: "dedupe-b",
      marketTitle: "Cloud9 vs LOUD",
      eventTitle: "Cloud9 vs LOUD",
      eventSlug: "esport-dedupe-b",
      ctx,
      selectedOutcome: "LOUD",
    }),
  ];
  const built = await buildCandidates(rows);
  assert.equal(built.candidates.length, 2);
  const keys = new Set(built.candidates.map((c) => c.match_family_key));
  assert.equal(keys.size, 1, "both rows for the same provider event must share one match_family_key");

  const plan = await planWith(built.candidates);
  assert.equal(plan.diagnostics.event_groups, 1);
  assert.equal(plan.reservations.length, 1);
});

test("ESPORTS-5: existing Dota BO3 (game-prefixed) behavior remains admitted, unchanged", async () => {
  const title = "Dota 2: YBN Team vs VooDooSh Team (BO3)";
  const row = esportsRow({
    id: "dota-prefixed",
    marketTitle: title,
    eventTitle: title,
    // event_slug carries the SAME text as market_slug -- the real production
    // shape for a provider slug that embeds the title, and required so
    // anchorTitle()'s fallback chain resolves to the exact text under test
    // when no providerEventContext is present (ctx: null, matching the
    // pre-existing production corpus shape this exception was built for).
    eventSlug: title,
    ctx: null,
    selectedOutcome: "YBN Team",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  assert.deepEqual(fullMatchAnchorDecision(built.candidates[0]), { allowed: true });
});
