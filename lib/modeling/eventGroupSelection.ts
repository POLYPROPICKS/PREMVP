// Pure, side-effect-free event-group dedup key helper (Phase 3D.2B).
//
// This is a standalone extraction of the fallback-chain logic found in
// lib/modeling/onePerMatchBacktest.ts's internal (unexported) eventGroup()
// function (lines 194-207 at time of extraction), re-implemented here as a
// reusable module with no dependency on that file. It is NOT wired into
// onePerMatchBacktest.ts in this phase and does not change any existing
// runtime behavior.
//
// No Supabase, no filesystem, no Date.now, no process.env, no logging.
// All functions are pure: same input always produces the same output, and
// input row objects/arrays are never mutated.

export type EventGroupRow = Record<string, unknown>;

export interface EventGroupKeyResult {
  key: string;
  source: string;
}

export const EVENT_GROUP_KEY_FIELD_PRIORITY: readonly string[] = [
  "match_family_key",
  "canonical_event_key",
  "parent_event_key",
  "event_slug",
  "event_title",
  "market_slug",
  "condition_id",
];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getPath(row: EventGroupRow, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  const raw = row.raw_json;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
  }
  return null;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isWeakKey(value: string): boolean {
  return /^weak_|^WEAK_|condition_id|matched-activity|\$\d+/i.test(value);
}

/**
 * Computes the canonical event-group dedup key for a single row, following
 * the same 7-field priority fallback chain as
 * lib/modeling/onePerMatchBacktest.ts's eventGroup(): match_family_key ->
 * canonical_event_key -> parent_event_key -> event_slug -> event_title ->
 * market_slug -> condition_id.
 */
export function buildEventGroupKey(row: EventGroupRow): EventGroupKeyResult {
  const matchFamily = str(getPath(row, ["match_family_key", "matchFamilyKey"]));
  if (matchFamily && !isWeakKey(matchFamily)) {
    return { key: `match:${normalizeText(matchFamily)}`, source: "match_family_key" };
  }

  const canonical = str(getPath(row, ["canonical_event_key", "canonicalEventKey"]));
  if (canonical) {
    return { key: `canonical:${normalizeText(canonical)}`, source: "canonical_event_key" };
  }

  const parent = str(getPath(row, ["parent_event_key", "parentEventKey"]));
  if (parent) {
    return { key: `parent:${normalizeText(parent)}`, source: "parent_event_key" };
  }

  const eventSlug = str(getPath(row, ["event_slug", "event_key", "eventSlug", "eventKey"]));
  if (eventSlug && !/^\$\d+k?\s+matched/i.test(eventSlug)) {
    return { key: `slug:${normalizeText(eventSlug)}`, source: "event_slug" };
  }

  const eventTitle = str(getPath(row, ["event_title", "eventTitle", "title", "question"]));
  if (eventTitle) {
    return { key: `title:${normalizeText(eventTitle)}`, source: "event_title" };
  }

  const market = str(getPath(row, ["market_slug", "marketSlug"]));
  if (market && !/^\$\d+k?\s+matched/i.test(market)) {
    return { key: `market:${normalizeText(market)}`, source: "market_slug_fallback" };
  }

  return {
    key: `condition:${str(getPath(row, ["condition_id", "conditionId"]))}`,
    source: "condition_fallback",
  };
}

/**
 * Groups rows by their computed event-group key, preserving insertion order
 * within each group and across groups. Input rows are not mutated; row
 * object references are preserved in the returned groups.
 */
export function groupRowsByEventGroup<T extends EventGroupRow>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const { key } = buildEventGroupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

/**
 * Selects one row per event group, ranked by the caller-supplied
 * comparator (ascending order; the first row after sorting is selected).
 * This helper carries no strategy-specific score/coverage/ranking logic
 * itself -- the comparator is entirely the caller's responsibility. Input
 * rows/arrays are not mutated, and selected rows preserve their original
 * object references.
 */
export function selectFirstPerEventGroup<T extends EventGroupRow>(
  rows: readonly T[],
  compareRows: (a: T, b: T) => number,
): T[] {
  const groups = groupRowsByEventGroup(rows);
  const selected: T[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort(compareRows);
    selected.push(ranked[0]);
  }
  return selected;
}
