/**
 * operator-actions.mjs
 *
 * Deterministic, dependency-free collection logic for PolyProPicks operator actions.
 *
 * Contract source: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
 * Schemas:         docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json
 *                  docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_SUMMARY.schema.json
 *
 * One Founder message manually submitted to CloudCode or Codex is one execution operator
 * action. Executor-internal work is never counted, and Architect corrections are tracked on
 * their own line so a rise in planning corrections cannot masquerade as manual relay.
 *
 * Nothing here reads the clock, the network or the filesystem — same input, same output.
 */

export const SUMMARY_SCHEMA_VERSION = '1.0';

export const OPERATOR_ACTION_TYPES = Object.freeze([
  'START', 'FOLLOW_UP', 'CORRECTION', 'RETRY', 'HANDOFF', 'APPROVAL',
]);

export const SURFACES = Object.freeze(['CLOUDCODE', 'CODEX', 'UNKNOWN']);
export const ORIGINS = Object.freeze(['FOUNDER_MANUAL', 'EXECUTOR_INTERNAL', 'ARCHITECT']);
export const COVERAGE_VALUES = Object.freeze(['COMPLETE', 'PARTIAL', 'UNKNOWN']);

/** Worst-wins ordering: any UNKNOWN source drags the whole bundle to UNKNOWN. */
const COVERAGE_RANK = Object.freeze({ COMPLETE: 0, PARTIAL: 1, UNKNOWN: 2 });

const EXCLUSION_REASONS = Object.freeze([
  'EXECUTOR_INTERNAL', 'ARCHITECT_CORRECTION', 'DUPLICATE_ACTION_ID', 'OUT_OF_PERIOD',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Validates one raw event against OPERATOR_ACTION_EVENT.schema.json. */
export function validateOperatorActionEvent(event, index = 0) {
  const errors = [];
  const at = (msg) => errors.push(`operator_action_events[${index}]: ${msg}`);

  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: [`operator_action_events[${index}]: must be an object`] };
  }
  if (!isNonEmptyString(event.action_id)) at('action_id must be a non-empty string');
  if (!isNonEmptyString(event.occurred_at)) at('occurred_at must be a non-empty string');
  if (!SURFACES.includes(event.surface)) at(`surface must be one of ${SURFACES.join(', ')}`);
  if (!OPERATOR_ACTION_TYPES.includes(event.type)) at(`type must be one of ${OPERATOR_ACTION_TYPES.join(', ')}`);
  if (!ORIGINS.includes(event.origin)) at(`origin must be one of ${ORIGINS.join(', ')}`);
  if (event.capture_coverage !== undefined && !COVERAGE_VALUES.includes(event.capture_coverage)) {
    at(`capture_coverage must be one of ${COVERAGE_VALUES.join(', ')}`);
  }
  // A COMPLETE claim without a source is exactly the kind of silent over-confidence this
  // whole contract exists to prevent.
  if (event.capture_coverage === 'COMPLETE' && !isNonEmptyString(event.source_ref)) {
    at('capture_coverage COMPLETE requires a non-empty source_ref');
  }
  return { ok: errors.length === 0, errors };
}

/** Per-event coverage, defaulting to UNKNOWN — never to COMPLETE. */
export function eventCoverage(event) {
  return COVERAGE_VALUES.includes(event?.capture_coverage) ? event.capture_coverage : 'UNKNOWN';
}

/**
 * Deterministic order: occurred_at, then action_id, then original input position.
 * Input position is the tiebreaker so two byte-identical bundles never disagree.
 */
function deterministicOrder(events) {
  return events
    .map((event, position) => ({ event, position }))
    .sort((a, b) => {
      if (a.event.occurred_at !== b.event.occurred_at) {
        return a.event.occurred_at < b.event.occurred_at ? -1 : 1;
      }
      if (a.event.action_id !== b.event.action_id) {
        return a.event.action_id < b.event.action_id ? -1 : 1;
      }
      return a.position - b.position;
    })
    .map((x) => x.event);
}

/**
 * Collapses repeated action_id values to their first occurrence in deterministic order.
 * The same relay is routinely reported twice (executor transcript plus Founder log); without
 * this the headline number silently doubles.
 */
export function dedupeOperatorActions(events) {
  const seen = new Set();
  const kept = [];
  const duplicates = [];
  for (const event of deterministicOrder(events)) {
    if (seen.has(event.action_id)) {
      duplicates.push({ action_id: event.action_id, reason: 'DUPLICATE_ACTION_ID' });
      continue;
    }
    seen.add(event.action_id);
    kept.push(event);
  }
  return { kept, duplicates };
}

function inPeriod(event, periodStart, periodEnd) {
  if (!isNonEmptyString(periodStart) || !isNonEmptyString(periodEnd)) return true;
  return event.occurred_at >= periodStart && event.occurred_at < periodEnd;
}

/**
 * Aggregates events into an OPERATOR_ACTION_SUMMARY.
 *
 * @param {object[]} events raw operator action events
 * @param {object} options period bounds, declared bundle coverage, mission/verified-result counts
 */
export function aggregateOperatorActions(events = [], options = {}) {
  const {
    period_start = '',
    period_end = '',
    declared_capture_coverage,
    mission_count,
    verified_result_count,
  } = options;

  const errors = [];
  events.forEach((event, index) => {
    const result = validateOperatorActionEvent(event, index);
    if (!result.ok) errors.push(...result.errors);
  });
  if (errors.length) return { ok: false, errors, summary: null };

  const { kept, duplicates } = dedupeOperatorActions(events);
  const excluded = [...duplicates];

  const byType = Object.fromEntries(OPERATOR_ACTION_TYPES.map((t) => [t, 0]));
  const bySurface = Object.fromEntries(SURFACES.map((s) => [s, 0]));
  let total = 0;
  let architectCorrections = 0;
  const missions = new Set();
  let intermediate = 0;

  // Coverage starts from the declared bundle value (UNKNOWN when undeclared) and can only
  // get worse as events are examined.
  let coverage = COVERAGE_VALUES.includes(declared_capture_coverage) ? declared_capture_coverage : 'UNKNOWN';

  for (const event of kept) {
    if (!inPeriod(event, period_start, period_end)) {
      excluded.push({ action_id: event.action_id, reason: 'OUT_OF_PERIOD' });
      continue;
    }
    if (event.origin === 'EXECUTOR_INTERNAL') {
      excluded.push({ action_id: event.action_id, reason: 'EXECUTOR_INTERNAL' });
      continue;
    }
    if (event.origin === 'ARCHITECT') {
      architectCorrections += 1;
      excluded.push({ action_id: event.action_id, reason: 'ARCHITECT_CORRECTION' });
      continue;
    }

    // Only counted events influence coverage — an unread executor-internal line says nothing
    // about how completely the Founder's own relays were captured.
    const own = eventCoverage(event);
    if (COVERAGE_RANK[own] > COVERAGE_RANK[coverage]) coverage = own;

    byType[event.type] += 1;
    bySurface[event.surface] += 1;
    total += 1;
    if (event.type !== 'START') intermediate += 1;
    if (isNonEmptyString(event.mission_id)) missions.add(event.mission_id);
  }

  const missionCount = Number.isInteger(mission_count) ? mission_count : missions.size;
  const derived = {
    intermediate_actions_per_mission: ratio(intermediate, missionCount, coverage),
    actions_per_verified_result: ratio(total, verified_result_count, coverage),
  };

  const summary = {
    schema_version: SUMMARY_SCHEMA_VERSION,
    period_start,
    period_end,
    capture_coverage: coverage,
    total_operator_actions: total,
    by_type: byType,
    by_surface: bySurface,
    architect_corrections: architectCorrections,
    duplicates_dropped: duplicates.length,
    excluded,
    derived,
  };

  return { ok: true, errors: [], summary };
}

/**
 * A ratio is only reported when the denominator is a real positive count AND coverage is
 * good enough for the numerator to mean anything. Otherwise it stays UNKNOWN rather than
 * becoming a confident-looking number derived from a partial sample.
 */
function ratio(numerator, denominator, coverage) {
  if (coverage !== 'COMPLETE') return 'UNKNOWN';
  if (!Number.isInteger(denominator) || denominator <= 0) return 'UNKNOWN';
  return Math.round((numerator / denominator) * 100) / 100;
}

/** Validates a produced summary against OPERATOR_ACTION_SUMMARY.schema.json invariants. */
export function validateOperatorActionSummary(summary) {
  const errors = [];
  const err = (msg) => errors.push(`operator_actions: ${msg}`);

  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    return { ok: false, errors: ['operator_actions: must be an object'] };
  }
  for (const key of ['schema_version', 'period_start', 'period_end']) {
    if (!isNonEmptyString(summary[key])) err(`${key} must be a non-empty string`);
  }
  if (!COVERAGE_VALUES.includes(summary.capture_coverage)) {
    err(`capture_coverage must be one of ${COVERAGE_VALUES.join(', ')}`);
  }
  if (!Number.isInteger(summary.total_operator_actions) || summary.total_operator_actions < 0) {
    err('total_operator_actions must be a non-negative integer');
  }
  if (!Number.isInteger(summary.architect_corrections) || summary.architect_corrections < 0) {
    err('architect_corrections must be a non-negative integer');
  }
  if (!Number.isInteger(summary.duplicates_dropped) || summary.duplicates_dropped < 0) {
    err('duplicates_dropped must be a non-negative integer');
  }

  const byType = summary.by_type || {};
  const bySurface = summary.by_surface || {};
  for (const t of OPERATOR_ACTION_TYPES) {
    if (!Number.isInteger(byType[t]) || byType[t] < 0) err(`by_type.${t} must be a non-negative integer`);
  }
  for (const s of SURFACES) {
    if (!Number.isInteger(bySurface[s]) || bySurface[s] < 0) err(`by_surface.${s} must be a non-negative integer`);
  }
  if (errors.length) return { ok: false, errors };

  const typeSum = OPERATOR_ACTION_TYPES.reduce((acc, t) => acc + byType[t], 0);
  const surfaceSum = SURFACES.reduce((acc, s) => acc + bySurface[s], 0);
  if (typeSum !== summary.total_operator_actions) {
    err(`by_type sums to ${typeSum} but total_operator_actions is ${summary.total_operator_actions}`);
  }
  if (surfaceSum !== summary.total_operator_actions) {
    err(`by_surface sums to ${surfaceSum} but total_operator_actions is ${summary.total_operator_actions}`);
  }

  if (!Array.isArray(summary.excluded)) {
    err('excluded must be an array');
  } else {
    summary.excluded.forEach((entry, i) => {
      if (!isNonEmptyString(entry?.action_id)) err(`excluded[${i}].action_id must be a non-empty string`);
      if (!EXCLUSION_REASONS.includes(entry?.reason)) {
        err(`excluded[${i}].reason must be one of ${EXCLUSION_REASONS.join(', ')}`);
      }
    });
  }

  const derived = summary.derived || {};
  for (const key of ['intermediate_actions_per_mission', 'actions_per_verified_result']) {
    const v = derived[key];
    const isNumber = typeof v === 'number' && Number.isFinite(v);
    const isUnknown = v === 'UNKNOWN' || v === 'NOT_AVAILABLE';
    if (!isNumber && !isUnknown) err(`derived.${key} must be a number or UNKNOWN/NOT_AVAILABLE`);
    if (isNumber && summary.capture_coverage === 'UNKNOWN') {
      err(`derived.${key} must be UNKNOWN while capture_coverage is UNKNOWN`);
    }
  }

  return { ok: errors.length === 0, errors };
}
