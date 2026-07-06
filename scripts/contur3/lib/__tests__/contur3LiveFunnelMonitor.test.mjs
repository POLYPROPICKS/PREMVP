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
  findQueueRowsForReservation,
  queueEntryWindowState,
  classifyQueueLifecycle,
  SKIPPED_NO_EXECUTABLE_MARKET_REASON,
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

// ──────────────────────────────────────────────────────────────────────────
// Queue lifecycle visibility (Contur3 queue observability hotfix)
// ──────────────────────────────────────────────────────────────────────────
const QNOW = Date.parse('2026-07-06T12:00:00Z');

function queuedReservation(overrides = {}) {
  return {
    id: 'res-1',
    match_family_key: 'pair:portugal-vs-spain:2026-07-06',
    event_title: 'Portugal vs. Spain: Both Teams to Score',
    game_start_iso: '2026-07-06T13:00:00Z', // starts in 60m -> entry window open
    status: 'QUEUED',
    ...overrides,
  };
}

function readyQueueRow(overrides = {}) {
  return {
    reservation_id: 'res-1',
    match_family_key: 'pair:portugal-vs-spain:2026-07-06',
    event_title: 'Portugal vs Spain',
    game_start_iso: '2026-07-06T13:00:00Z',
    status: 'READY',
    ...overrides,
  };
}

test('1) READY queue row inside entry window is classified actionable', () => {
  const res = queuedReservation();
  const rows = findQueueRowsForReservation(res, [readyQueueRow()]);
  assert.equal(rows.length, 1);
  assert.equal(classifyQueueLifecycle(res, rows, QNOW), 'QUEUE_READY_ACTIONABLE');

  const fixtures = [baseFixture({
    reservation_status: 'QUEUED',
    due_state: 'DUE_NOW',
    event_execution_queue_rows: 1,
    executor_api_visible: true,
    queue_verdict: 'QUEUE_READY_ACTIONABLE',
  })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(anomalies.some((a) => a.code === 'DUE_RESERVATION_NOT_QUEUED'), false);
  assert.equal(anomalies.some((a) => a.code === 'QUEUED_RESERVATION_QUEUE_ROW_MISSING'), false);
});

test('2) READY queue row after entry window closed is created-but-not-actionable, not missing', () => {
  const res = queuedReservation({ game_start_iso: '2026-07-06T11:00:00Z' }); // kicked off 1h ago
  const row = readyQueueRow({ game_start_iso: '2026-07-06T11:00:00Z' });
  const rows = findQueueRowsForReservation(res, [row]);
  assert.equal(rows.length, 1, 'queue row created earlier must still be found after kickoff');
  assert.equal(queueEntryWindowState(row, res, QNOW), 'CLOSED');
  assert.equal(classifyQueueLifecycle(res, rows, QNOW), 'QUEUE_READY_ENTRY_WINDOW_CLOSED');

  const fixtures = [baseFixture({
    reservation_status: 'QUEUED',
    due_state: 'EXPIRED',
    event_execution_queue_rows: 1,
    executor_api_visible: true,
    queue_verdict: 'QUEUE_READY_ENTRY_WINDOW_CLOSED',
    order_events: 0,
  })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(anomalies.some((a) => a.code === 'QUEUED_RESERVATION_QUEUE_ROW_MISSING'), false);
  assert.equal(anomalies.some((a) => a.code === 'DUE_RESERVATION_NOT_QUEUED'), false);
});

test('3) QUEUED reservation with no queue row is P0 missing queue', () => {
  const res = queuedReservation();
  assert.equal(findQueueRowsForReservation(res, []).length, 0);
  assert.equal(classifyQueueLifecycle(res, [], QNOW), 'QUEUED_RESERVATION_QUEUE_ROW_MISSING');

  const fixtures = [baseFixture({
    reservation_status: 'QUEUED',
    due_state: 'DUE_NOW',
    event_execution_queue_rows: 0,
    queue_verdict: 'QUEUED_RESERVATION_QUEUE_ROW_MISSING',
  })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  const hit = anomalies.find((a) => a.code === 'QUEUED_RESERVATION_QUEUE_ROW_MISSING');
  assert.ok(hit, 'QUEUED reservation without a queue row must raise the missing-queue anomaly');
  assert.equal(hit.severity, 'P0');
});

test('4) Due reservation not queued remains due rebalance required', () => {
  const res = queuedReservation({ status: 'RESERVED' });
  assert.equal(classifyQueueLifecycle(res, [], QNOW), 'NOT_QUEUED_YET');

  const fixtures = [baseFixture({
    reservation_status: 'RESERVED',
    due_state: 'DUE_NOW',
    event_execution_queue_rows: 0,
    queue_verdict: 'NOT_QUEUED_YET',
  })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.ok(anomalies.some((a) => a.code === 'DUE_RESERVATION_NOT_QUEUED' && a.severity === 'P0'));
});

test('5) SKIPPED no executable tier1 market is not queue missing', () => {
  const res = queuedReservation({
    status: 'SKIPPED',
    selection_reason: `${SKIPPED_NO_EXECUTABLE_MARKET_REASON}: no tier1 anchor at rebalance`,
  });
  assert.equal(classifyQueueLifecycle(res, [], QNOW), 'SKIPPED_NO_EXECUTABLE_MARKET');

  const fixtures = [baseFixture({
    reservation_status: 'SKIPPED',
    due_state: 'DUE_NOW',
    event_execution_queue_rows: 0,
    queue_verdict: 'SKIPPED_NO_EXECUTABLE_MARKET',
  })];
  const anomalies = detectAnomalies({ summary: {} }, fixtures, {});
  assert.equal(anomalies.some((a) => a.code === 'QUEUED_RESERVATION_QUEUE_ROW_MISSING'), false);
  assert.equal(anomalies.some((a) => a.code === 'DUE_RESERVATION_NOT_QUEUED'), false);
});

test('6) Stable identifier matching beats title mismatch', () => {
  // reservation_id join wins even when titles differ completely
  const res = queuedReservation({ event_title: 'Portugal vs. Spain: Both Teams to Score' });
  const rowById = readyQueueRow({ event_title: 'Portugal v Spain (BTTS)', match_family_key: null });
  assert.equal(findQueueRowsForReservation(res, [rowById]).length, 1, 'reservation_id must match despite title mismatch');

  // match_family_key join when reservation_id absent on the queue row
  const rowByMfk = readyQueueRow({ reservation_id: null, event_title: 'Totally Different Title' });
  assert.equal(findQueueRowsForReservation(res, [rowByMfk]).length, 1, 'match_family_key must match despite title mismatch');

  // unrelated row must NOT match
  const unrelated = readyQueueRow({ reservation_id: 'res-999', match_family_key: 'pair:brazil-vs-serbia:2026-07-06', event_title: 'Brazil vs Serbia' });
  assert.equal(findQueueRowsForReservation(res, [unrelated]).length, 0);
});

test('queueEntryWindowState prefers latest_entry_iso over derived T-3', () => {
  const res = queuedReservation();
  const openRow = readyQueueRow({ latest_entry_iso: '2026-07-06T12:30:00Z' });
  assert.equal(queueEntryWindowState(openRow, res, QNOW), 'OPEN');
  const closedRow = readyQueueRow({ latest_entry_iso: '2026-07-06T11:30:00Z' });
  assert.equal(queueEntryWindowState(closedRow, res, QNOW), 'CLOSED');
  const noTiming = readyQueueRow({ game_start_iso: null });
  assert.equal(queueEntryWindowState(noTiming, { ...res, game_start_iso: null }, QNOW), 'UNKNOWN');
});
