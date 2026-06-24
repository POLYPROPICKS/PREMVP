#!/usr/bin/env node
/**
 * Contur3 / Blue_model — live market guard regression verifier.
 *
 * Tests deterministic fixtures against the exact regex logic from
 * lib/executor/eventExecutionQueue.ts WITHOUT calling external APIs or DB.
 *
 * Fails with exit 1 if any guard is wrong.
 * Run: npm run contur3:verify-live-market-guards
 */

// ── Mirrors of production constants (keep in sync with eventExecutionQueue.ts) ──

// P0E_BLOCK_HALFTIME_MARKETS_V1
// IMPORTANT: detection must use only market IDENTITY fields, never full JSON.
const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

// Corners block (full-match contract only)
const CORNERS_MARKET_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;

// Prop/exact-score block (player props, goalscorer, exact scorelines, outrights)
const PROP_MARKET_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]shot|\bplayer[\s_-]assist|\boutright\b/i;

// ── Pure detection helpers (mirror production logic) ──

function isHalftime(c) {
  if (HALFTIME_MARKET_RE.test(c.market_slug ?? '')) return true;
  if (HALFTIME_MARKET_RE.test(c.event_slug ?? '')) return true;
  if (HALFTIME_MARKET_RE.test(c.match_family_key ?? '')) return true;
  const diag = c.diagnostics ?? {};
  return (
    HALFTIME_MARKET_RE.test(diag.marketTitle ?? '') ||
    HALFTIME_MARKET_RE.test(diag.marketType ?? '') ||
    HALFTIME_MARKET_RE.test(diag.question ?? '') ||
    HALFTIME_MARKET_RE.test(diag.title ?? '')
  );
}

function isCorners(c) {
  if (CORNERS_MARKET_RE.test(c.market_slug ?? '')) return true;
  if (CORNERS_MARKET_RE.test(c.event_slug ?? '')) return true;
  if (CORNERS_MARKET_RE.test(c.match_family_key ?? '')) return true;
  const diag = c.diagnostics ?? {};
  return (
    CORNERS_MARKET_RE.test(diag.marketTitle ?? '') ||
    CORNERS_MARKET_RE.test(diag.question ?? '')
  );
}

function isProp(c) {
  if (PROP_MARKET_RE.test(c.market_slug ?? '')) return true;
  if (PROP_MARKET_RE.test(c.event_slug ?? '')) return true;
  const diag = c.diagnostics ?? {};
  return (
    PROP_MARKET_RE.test(diag.marketTitle ?? '') ||
    PROP_MARKET_RE.test(diag.question ?? '')
  );
}

function guardResult(c) {
  if (isHalftime(c)) return 'HALFTIME_NOT_LIVE_EXECUTABLE';
  if (isCorners(c)) return 'CORNERS_NOT_LIVE_EXECUTABLE';
  if (isProp(c)) return 'PROP_NOT_LIVE_EXECUTABLE';
  return 'EXECUTABLE';
}

// ── Test fixtures ──

const TESTS = [
  // ── 1. England/Ghana incident: full-match core spread ──────────────────────
  // Diagnostics contain price metric fields (delta1hPp, price1hAgo) that must
  // NOT trigger halftime detection. Event title resolves "vs" pair identity.
  {
    name: 'SPREAD_ENGLAND_GHANA: full-match core spread — must be EXECUTABLE',
    candidate: {
      market_slug: 'spread-england-minus-1-5',
      event_slug: null,
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Spread: England (-1.5)',
        eventTitle: 'England vs Ghana',
        delta1hPp: 2.5,
        price1hAgo: 0.45,
        price6hAgo: 0.41,
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 2. England/Ghana incident: corners — must be blocked ───────────────────
  {
    name: 'CORNERS_ENGLAND_GHANA: O/U corners — must be CORNERS_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-total-corners-8-5',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs. Ghana: O/U 8.5 Total Corners',
      },
    },
    expect: 'CORNERS_NOT_LIVE_EXECUTABLE',
  },

  // ── 3. Halftime market — must be blocked ───────────────────────────────────
  {
    name: 'HALFTIME_RESULT: halftime market — must be HALFTIME_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-halftime-result',
      event_slug: null,
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs. Ghana - Halftime Result',
      },
    },
    expect: 'HALFTIME_NOT_LIVE_EXECUTABLE',
  },

  // ── 4. First-half market — must be blocked ─────────────────────────────────
  {
    name: 'FIRST_HALF: first-half market — must be HALFTIME_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-ghana-first-half-winner',
      event_slug: null,
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: First Half Winner',
      },
    },
    expect: 'HALFTIME_NOT_LIVE_EXECUTABLE',
  },

  // ── 5. 1H variant — must be blocked ───────────────────────────────────────
  {
    name: '1H_RESULT: 1H result variant — must be HALFTIME_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-ghana-1st-half-result',
      event_slug: null,
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: 1st half result',
      },
    },
    expect: 'HALFTIME_NOT_LIVE_EXECUTABLE',
  },

  // ── 6. Exact score — must be blocked ──────────────────────────────────────
  {
    name: 'EXACT_SCORE: England vs Ghana exact score — must be PROP_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-ghana-exact-score',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: Exact Score',
      },
    },
    expect: 'PROP_NOT_LIVE_EXECUTABLE',
  },

  // ── 7. Player props — must be blocked ─────────────────────────────────────
  {
    name: 'PLAYER_PROP: goalscorer market — must be PROP_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-ghana-anytime-goalscorer',
      event_slug: null,
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: Anytime Goalscorer',
      },
    },
    expect: 'PROP_NOT_LIVE_EXECUTABLE',
  },

  // ── 8. Full-match total GOALS (non-corners) — must be EXECUTABLE ───────────
  {
    name: 'TOTAL_GOALS: O/U 2.5 Total Goals (non-corners) — must be EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-ou-2-5-total-goals',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: O/U 2.5 Total Goals',
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 9. Full-match moneyline/winner — must be EXECUTABLE ──────────────────
  {
    name: 'MONEYLINE: full-match match winner — must be EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-match-winner',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: Match Winner',
        delta1hPp: 1.2,
        price1hAgo: 0.6,
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 10. False-positive guard: spread with 1h telemetry must NOT be halftime ─
  {
    name: 'SPREAD_TELEMETRY_FALSE_POSITIVE: price1hAgo in diagnostics — must be EXECUTABLE',
    candidate: {
      market_slug: 'spread-brazil-minus-1-5',
      event_slug: 'brazil-vs-mexico',
      match_family_key: 'pair:brazil-vs-mexico:2026-06-24',
      diagnostics: {
        marketTitle: 'Spread: Brazil (-1.5)',
        eventTitle: 'Brazil vs Mexico',
        delta1hPp: -0.5,
        price1hAgo: 0.55,
        price6hAgo: 0.52,
        delta6hPp: 3.0,
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 11. Corners detected via diagnostics.marketTitle ─────────────────────
  {
    name: 'CORNERS_VIA_DIAG_TITLE: corners in diagnostics title — must be CORNERS_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'brazil-vs-mexico-corners',
      event_slug: null,
      match_family_key: 'pair:brazil-vs-mexico:2026-06-24',
      diagnostics: {
        marketTitle: 'Brazil vs Mexico: Total Corners Over 9.5',
      },
    },
    expect: 'CORNERS_NOT_LIVE_EXECUTABLE',
  },

  // ── 12. Spread with full diagnostic bundle — must be EXECUTABLE ───────────
  {
    name: 'SPREAD_FULL_DIAG: spread with many diagnostic metric fields — must be EXECUTABLE',
    candidate: {
      market_slug: 'spread-brazil-minus-1-5-full',
      event_slug: 'brazil-vs-mexico',
      match_family_key: 'pair:brazil-vs-mexico:2026-06-24',
      diagnostics: {
        marketTitle: 'Spread: Brazil (-1.5)',
        eventTitle: 'Brazil vs Mexico',
        delta1hPp: -0.5,
        price1hAgo: 0.55,
        price6hAgo: 0.52,
        delta6hPp: 3.0,
        volume1h: 1234,
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 13. Switzerland/Canada corners (incident case) — must be blocked ──────
  {
    name: 'CORNERS_SWITZERLAND_CANADA: O/U 9.5 Total Corners — must be CORNERS_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'switzerland-vs-canada-ou-9-5-total-corners',
      event_slug: 'switzerland-vs-canada',
      match_family_key: 'pair:switzerland-vs-canada:2026-06-24',
      diagnostics: {
        marketTitle: 'Switzerland vs Canada: O/U 9.5 Total Corners',
        eventTitle: 'Switzerland vs Canada',
      },
    },
    expect: 'CORNERS_NOT_LIVE_EXECUTABLE',
  },

  // ── 14. England/Ghana corners (via market_slug) — must be blocked ─────────
  {
    name: 'CORNERS_ENGLAND_GHANA_SLUG: corners in market_slug only — must be CORNERS_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-total-corners-8-5',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'England vs Ghana: O/U 8.5 Total Corners',
      },
    },
    expect: 'CORNERS_NOT_LIVE_EXECUTABLE',
  },

  // ── 15. Spread England full-match — must be EXECUTABLE ────────────────────
  {
    name: 'SPREAD_ENGLAND_FULLMATCH: Spread England (-1.5) with eventTitle — must be EXECUTABLE',
    candidate: {
      market_slug: 'spread-england-minus-1-5',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Spread: England (-1.5)',
        eventTitle: 'England vs Ghana',
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 16. Total Goals O/U 2.5 full-match — must be EXECUTABLE ──────────────
  {
    name: 'TOTAL_GOALS_FULLMATCH: O/U 2.5 Total Goals — must be EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-ou-2-5-total-goals',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Total Goals Over 2.5',
        eventTitle: 'England vs Ghana',
      },
    },
    expect: 'EXECUTABLE',
  },

  // ── 17. First Half Result — must be blocked ────────────────────────────────
  {
    name: 'FIRST_HALF_RESULT: first half in marketTitle — must be HALFTIME_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-first-half-result',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'First Half Result',
      },
    },
    expect: 'HALFTIME_NOT_LIVE_EXECUTABLE',
  },

  // ── 18. Exact Score — must be blocked ─────────────────────────────────────
  {
    name: 'EXACT_SCORE_TITLE: exact score in marketTitle — must be PROP_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-score',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Exact Score',
      },
    },
    expect: 'PROP_NOT_LIVE_EXECUTABLE',
  },

  // ── 19. Anytime Goalscorer — must be blocked ──────────────────────────────
  {
    name: 'ANYTIME_GOALSCORER: goalscorer in marketTitle — must be PROP_NOT_LIVE_EXECUTABLE',
    candidate: {
      market_slug: 'england-vs-ghana-scorer',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Anytime Goalscorer',
      },
    },
    expect: 'PROP_NOT_LIVE_EXECUTABLE',
  },

  // ── 20. Telemetry false-positive guard: price1hAgo / delta1hPp must NOT trigger halftime ──
  {
    name: 'TELEMETRY_FALSE_POSITIVE: price1hAgo+delta1hPp in diagnostics — must be EXECUTABLE',
    candidate: {
      market_slug: 'spread-england-minus-1-0',
      event_slug: 'england-vs-ghana',
      match_family_key: 'pair:england-vs-ghana:2026-06-23',
      diagnostics: {
        marketTitle: 'Spread: England (-1.0)',
        eventTitle: 'England vs Ghana',
        price1hAgo: 0.47,
        delta1hPp: 3.2,
        price6hAgo: 0.44,
        delta6hPp: 6.8,
        volume1h: 5000,
      },
    },
    expect: 'EXECUTABLE',
  },
];

// ── Runner ──

let passed = 0;
let failed = 0;
const failures = [];

for (const t of TESTS) {
  const result = guardResult(t.candidate);
  const ok = result === t.expect;
  if (ok) {
    passed++;
    console.log(`  PASS  ${t.name}`);
  } else {
    failed++;
    const msg = `  FAIL  ${t.name}\n        expected=${t.expect}  got=${result}`;
    console.error(msg);
    failures.push({ name: t.name, expected: t.expect, got: result });
  }
}

console.log('');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('');
  console.error('CONTUR3_MARKET_GUARD_REGRESSION_FAIL');
  console.error('Failures:');
  for (const f of failures) {
    console.error(`  ${f.name}: expected=${f.expected} got=${f.got}`);
  }
  process.exit(1);
}

console.log('CONTUR3_MARKET_GUARD_REGRESSION_PASS');
process.exit(0);
