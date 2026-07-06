import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMarket,
  norm,
  eventIdentityOf,
  groupSignalsByPhysicalMatch,
  findReservationForGroup,
  tableStatus,
  teamPairSigFromText,
  detectAnomalies,
  nextActions,
  classifyReservationTiming,
  RAILWAY_SAFE_COMMANDS,
  TIER_PROBE_RUNNER_NOTE,
} from '../contur3LiveFunnelMonitor.mjs';

function baseFixture(overrides = {}) {
  return {
    display_match: 'Test Match',
    raw_allowed_fullmatch_rows: 1,
    builder_forbidden_candidates: 0,
    reservation_status: 'NONE',
    reservation_timing: 'ACTIONABLE',
    due_state: 'NO_RESERVATION',
    event_execution_queue_rows: 0,
    executor_api_visible: null,
    ...overrides,
  };
}

test('event-level grouping merges child-market rows into ONE physical match, not pseudo-groups', () => {
  const signals = [
    {
      event_slug: 'portugal-vs-croatia',
      event_title: 'Portugal vs Croatia',
      market_slug: 'portugal-vs-croatia-moneyline',
      selected_outcome: 'Portugal',
    },
    {
      event_slug: 'portugal-vs-croatia',
      event_title: 'Portugal vs Croatia',
      market_slug: 'portugal-vs-croatia-second-half-result',
      selected_outcome: 'Draw',
    },
  ];

  const groups = groupSignalsByPhysicalMatch(signals);
  assert.equal(groups.size, 1, 'both rows must fall under one physical-match group');

  const [group] = groups.values();
  assert.equal(group.raw_rows, 2);
});

test('forbidden child-market rows (halftime/second-half/corners) do not spawn independent RESERVED_OK physical matches', () => {
  const signals = [
    {
      event_slug: 'portugal-vs-croatia',
      event_title: 'Portugal vs Croatia',
      market_slug: 'portugal-vs-croatia-moneyline',
      selected_outcome: 'Portugal',
    },
    {
      event_slug: 'portugal-vs-croatia',
      event_title: 'Portugal vs Croatia',
      market_slug: 'portugal-vs-croatia-corners-total',
      selected_outcome: 'Over',
    },
  ];
  const groups = groupSignalsByPhysicalMatch(signals);
  // Must still be exactly one group — the corners row cannot create its own
  // pseudo physical-match that would separately resolve to RESERVED_OK.
  assert.equal(groups.size, 1);
  const [group] = groups.values();
  assert.equal(group.builder_forbidden_candidates, 1);
  assert.equal(group.raw_allowed_fullmatch_rows, 1);
});

test('reservation matching is exact/event-level — no fuzzy 12-char prefix joins across events', () => {
  // Two different events whose first 12 normalized chars collide
  // ("alphateamone").
  const groupA = eventIdentityOf({ event_title: 'AlphaTeamOne vs BetaTeamOne' });
  const reservations = [
    {
      event_title: 'AlphaTeamOne vs GammaTeamTwo', // different event, same 12-char normalized prefix
      game_start_iso: '2026-07-03T20:00:00Z',
      status: 'RESERVED',
    },
  ];

  const match = findReservationForGroup(groupA, reservations);
  assert.equal(match, undefined, 'must not join event B by a shared 12-char prefix');
});

test('reservation matching still finds an exact event-level match', () => {
  const groupA = eventIdentityOf({ event_title: 'AlphaTeamOne vs BetaTeamOne' });
  const reservations = [
    {
      event_title: 'AlphaTeamOne vs BetaTeamOne',
      game_start_iso: '2026-07-03T20:00:00Z',
      status: 'RESERVED',
    },
  ];
  const match = findReservationForGroup(groupA, reservations);
  assert.ok(match, 'exact event-level match must be found');
});

test('reservation with match_family_key pair:argentina-vs-caboverde matches the Argentina vs Cabo Verde physical group', () => {
  const signals = [
    {
      event_slug: 'argentina-vs-cabo-verde',
      event_title: 'Argentina vs Cabo Verde',
      market_slug: 'argentina-vs-cabo-verde-moneyline',
      selected_outcome: 'Argentina',
    },
  ];
  const groups = groupSignalsByPhysicalMatch(signals);
  const [group] = groups.values();
  const reservations = [
    {
      match_family_key: 'pair:argentina-vs-caboverde:2026-07-03',
      event_title: null,
      game_start_iso: '2026-07-03T18:00:00Z',
      status: 'RESERVED',
    },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.ok(match, 'must resolve the reservation via match_family_key team-pair identity, not report NONE');
});

test('reservation with match_family_key pair:colombia-vs-ghana matches the Colombia vs Ghana physical group', () => {
  const signals = [
    {
      event_slug: 'colombia-vs-ghana',
      event_title: 'Colombia vs Ghana',
      market_slug: 'colombia-vs-ghana-total-goals',
      selected_outcome: 'Over',
    },
  ];
  const groups = groupSignalsByPhysicalMatch(signals);
  const [group] = groups.values();
  const reservations = [
    {
      match_family_key: 'pair:colombia-vs-ghana:2026-07-04',
      event_title: null,
      game_start_iso: '2026-07-04T18:00:00Z',
      status: 'RESERVED',
    },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.ok(match, 'must resolve the reservation via match_family_key team-pair identity, not report NONE');
});

test('two distinct pair:* reservations both resolve to distinct groups (no cross-match, no undercount)', () => {
  const signals = [
    { event_slug: 'argentina-vs-cabo-verde', event_title: 'Argentina vs Cabo Verde', market_slug: 'argentina-vs-cabo-verde-moneyline', selected_outcome: 'Argentina' },
    { event_slug: 'colombia-vs-ghana', event_title: 'Colombia vs Ghana', market_slug: 'colombia-vs-ghana-total-goals', selected_outcome: 'Over' },
  ];
  const groups = [...groupSignalsByPhysicalMatch(signals).values()];
  assert.equal(groups.length, 2);
  const reservations = [
    { match_family_key: 'pair:argentina-vs-caboverde:2026-07-03', game_start_iso: '2026-07-03T18:00:00Z', status: 'RESERVED' },
    { match_family_key: 'pair:colombia-vs-ghana:2026-07-04', game_start_iso: '2026-07-04T18:00:00Z', status: 'RESERVED' },
  ];
  const matches = groups.map((g) => findReservationForGroup(g, reservations));
  assert.ok(matches[0] && matches[1], 'both groups must find a reservation');
  assert.notEqual(matches[0], matches[1], 'each group must match its own reservation, not the same one');
});

test('reservation matching via match_family_key still rejects an unrelated pair (no fuzzy join)', () => {
  const signals = [
    { event_slug: 'argentina-vs-cabo-verde', event_title: 'Argentina vs Cabo Verde', market_slug: 'argentina-vs-cabo-verde-moneyline', selected_outcome: 'Argentina' },
  ];
  const [group] = [...groupSignalsByPhysicalMatch(signals).values()];
  const reservations = [
    { match_family_key: 'pair:brazil-vs-serbia:2026-07-03', game_start_iso: '2026-07-03T18:00:00Z', status: 'RESERVED' },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.equal(match, undefined, 'must not match an unrelated pair: reservation');
});

test('futures/outright "MSI 2026 Winner" style markets are not classified as allowed full-match moneyline', () => {
  const cls = classifyMarket(norm('MSI 2026 Winner'));
  assert.notEqual(cls, 'allowed_fullmatch_moneyline');
  assert.equal(cls, 'forbidden_futures');
});

test('a real match-winner market is still allowed full-match moneyline', () => {
  const cls = classifyMarket(norm('Portugal vs Croatia Match Winner'));
  assert.equal(cls, 'allowed_fullmatch_moneyline');
});

test('job_runs column/table shape mismatch degrades to a safe status, not a hard runtime failure', () => {
  const badResult = { ok: false, rows: [], error: 'column job_runs.created_at does not exist' };
  const status = tableStatus('job_runs', badResult);
  assert.notEqual(status.status, 'ERROR');
  assert.ok(['MEASUREMENT_MISSING', 'TABLE_SHAPE_MISMATCH'].includes(status.status));
});

test('a genuinely healthy table read reports OK status', () => {
  const okResult = { ok: true, rows: [{ id: 1 }], error: null };
  const status = tableStatus('night_event_reservations', okResult);
  assert.equal(status.status, 'OK');
  assert.equal(status.rows, 1);
});

test('"- More Markets" suffix group title still resolves its pair:* reservation (Argentina vs. Cabo Verde)', () => {
  const signals = [
    {
      event_slug: 'argentina-vs-cabo-verde',
      event_title: 'Argentina vs. Cabo Verde - More Markets',
      market_slug: 'argentina-vs-cabo-verde-total-goals',
      selected_outcome: 'Over',
    },
  ];
  const [group] = [...groupSignalsByPhysicalMatch(signals).values()];
  const reservations = [
    { match_family_key: 'pair:argentina-vs-cabo-verde:2026-07-03', game_start_iso: '2026-07-03T18:00:00Z', status: 'RESERVED' },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.ok(match, 'must resolve the reservation for a "- More Markets" suffixed group title, not report NONE');
});

test('"- More Markets" suffix group title still resolves its pair:* reservation (Colombia vs. Ghana)', () => {
  const signals = [
    {
      event_slug: 'colombia-vs-ghana',
      event_title: 'Colombia vs. Ghana - More Markets',
      market_slug: 'colombia-vs-ghana-spread',
      selected_outcome: 'Colombia -1',
    },
  ];
  const [group] = [...groupSignalsByPhysicalMatch(signals).values()];
  const reservations = [
    { match_family_key: 'pair:colombia-vs-ghana:2026-07-04', game_start_iso: '2026-07-04T18:00:00Z', status: 'RESERVED' },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.ok(match, 'must resolve the reservation for a "- More Markets" suffixed group title, not report NONE');
});

test('halftime/second-half suffix and punctuation/dot variants normalize to the same team-pair signature', () => {
  assert.equal(teamPairSigFromText('Argentina vs. Cabo Verde - More Markets'), teamPairSigFromText('Argentina vs Cabo Verde'));
  assert.equal(teamPairSigFromText('Colombia vs. Ghana - Second Half'), teamPairSigFromText('Colombia vs Ghana'));
  assert.equal(teamPairSigFromText('Colombia vs. Ghana - Halftime Result'), teamPairSigFromText('Colombia vs Ghana'));
});

test('A) expired allowed full-match underfill is not P0', () => {
  const fixtures = [baseFixture({ reservation_timing: 'EXPIRED' })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(
    anomalies.some((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION' && a.severity === 'P0'),
    false,
    'an expired match must never raise a P0 reservation-underfill anomaly',
  );
});

test('B) out-of-horizon allowed full-match underfill is not P0', () => {
  const fixtures = [baseFixture({ reservation_timing: 'OUT_OF_HORIZON' })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(
    anomalies.some((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION' && a.severity === 'P0'),
    false,
    'a future out-of-horizon match must never raise a P0 reservation-underfill anomaly',
  );
});

test('C) actionable allowed full-match underfill is P0', () => {
  const fixtures = [baseFixture({ reservation_timing: 'ACTIONABLE' })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(
    anomalies.some((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION' && a.severity === 'P0'),
    true,
    'a currently actionable missing reservation must still raise P0',
  );
});

test('D) unknown-timing allowed full-match underfill downgrades to P1, not silently dropped', () => {
  const fixtures = [baseFixture({ reservation_timing: 'UNKNOWN_TIMING' })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  const hit = anomalies.find((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION_UNKNOWN_TIMING');
  assert.ok(hit, 'unknown timing must still be reported, not dropped');
  assert.equal(hit.severity, 'P1');
  assert.equal(
    anomalies.some((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION' && a.severity === 'P0'),
    false,
    'unknown timing must not also raise the P0 variant',
  );
});

test('classifyReservationTiming resolves EXPIRED / OUT_OF_HORIZON / ACTIONABLE / UNKNOWN_TIMING correctly', () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  assert.equal(classifyReservationTiming(null, now), 'UNKNOWN_TIMING');
  assert.equal(classifyReservationTiming('not-a-date', now), 'UNKNOWN_TIMING');
  assert.equal(classifyReservationTiming('2026-07-06T12:01:00Z', now), 'EXPIRED');
  assert.equal(classifyReservationTiming('2026-07-08T12:00:00Z', now, 12), 'OUT_OF_HORIZON');
  assert.equal(classifyReservationTiming('2026-07-06T18:00:00Z', now, 12), 'ACTIONABLE');
});

test('E) RESERVATION_UNDERFILL next_action includes a direct node Railway-safe command for the .mjs runner', () => {
  const actions = nextActions({ summary: { machine_verdict: 'RESERVATION_UNDERFILL' } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].command, RAILWAY_SAFE_COMMANDS.nightReservations);
  assert.match(actions[0].command, /^node scripts\/contur3\/.*\.mjs$/, 'must be a direct node invocation, not npm run');
});

test('F) compound RESERVATION_UNDERFILL guidance keeps the tier-probe (non-.mjs) step separate from the direct node step', () => {
  const actions = nextActions({ summary: { machine_verdict: 'RESERVATION_UNDERFILL' } });
  assert.equal(actions[0].command, RAILWAY_SAFE_COMMANDS.nightReservations, 'the primary command must be the direct-node form');
  assert.match(actions[0].why, /reservation-tier-probe/, 'the tier-probe follow-up must still be surfaced in guidance');
  assert.match(actions[0].why, /tsx/, 'the tier-probe caveat (tsx runner, not a node script) must be disclosed');
});

test('G) TS tier-probe guidance does not claim npx alone is Railway-safe', () => {
  assert.match(TIER_PROBE_RUNNER_NOTE, /tsx/);
  assert.doesNotMatch(
    TIER_PROBE_RUNNER_NOTE.replace(/only Railway-safe if tsx is confirmed present.*?assume it is\./, ''),
    /npx.*Railway-safe/i,
    'must not assert npx is unconditionally Railway-safe',
  );
  assert.match(TIER_PROBE_RUNNER_NOTE, /only Railway-safe if tsx is confirmed present/i);
});

test('"- More Markets" suffix does not cause a cross-match with an unrelated pair reservation', () => {
  const signals = [
    {
      event_slug: 'argentina-vs-cabo-verde',
      event_title: 'Argentina vs. Cabo Verde - More Markets',
      market_slug: 'argentina-vs-cabo-verde-moneyline',
      selected_outcome: 'Argentina',
    },
  ];
  const [group] = [...groupSignalsByPhysicalMatch(signals).values()];
  const reservations = [
    { match_family_key: 'pair:brazil-vs-serbia:2026-07-03', game_start_iso: '2026-07-03T18:00:00Z', status: 'RESERVED' },
  ];
  const match = findReservationForGroup(group, reservations);
  assert.equal(match, undefined, 'must not match an unrelated pair: reservation');
});
