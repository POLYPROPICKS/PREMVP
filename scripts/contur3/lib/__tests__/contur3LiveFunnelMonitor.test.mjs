import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMarket,
  norm,
  eventIdentityOf,
  groupSignalsByPhysicalMatch,
  findReservationForGroup,
  tableStatus,
} from '../contur3LiveFunnelMonitor.mjs';

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
