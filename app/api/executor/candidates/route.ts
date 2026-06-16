import { NextRequest, NextResponse } from "next/server";
import {
  buildFireModelCandidates,
  type FireModelCandidate,
} from "@/lib/executor/buildFireModelCandidates";
import { supabaseAdmin } from "@/lib/supabase/server";

const VALID_SCOPES = new Set(["all", "wc", "soccer", "mlb", "esport"]);

// Internal pool fetched from the model BEFORE event-dedupe + user limit.
// Must be wide enough that suppressing same-event duplicates does not starve
// the returned list of unique events. Helper caps its own DB read at 200.
const EVENT_DEDUPE_POOL = 200;

const EVENT_GUARD_RULE = "ONE_LIVE_POSITION_PER_EVENT";

// Preferred event-level identity fields, in priority order. Each entry maps a
// candidate field name to the reported event_key_source.
// Deliberately EXCLUDED: token_id, idempotency_key, condition_id, market_slug.
// token_id / idempotency_key are outcome/signal-level. condition_id and
// market_slug are MARKET-level: two correlated markets in the same match carry
// different values, so using them would defeat the one-position-per-event guard.
//
// match_family_key is checked first: it is the stable event-level key derived in
// buildFireModelCandidates (event_slug when available, else WEAK_MARKET_LEVEL_KEY:…).
// Keys starting with "WEAK_MARKET_LEVEL_KEY:" are excluded below (see isUsableString).
const EVENT_KEY_FIELDS: Array<{ field: string; source: string }> = [
  { field: "match_family_key", source: "match_family_key" },
  { field: "event_id", source: "event_id" },
  { field: "game_id", source: "game_id" },
  { field: "event_slug", source: "event_slug" },
  { field: "eventSlug", source: "event_slug" },
  { field: "event_title", source: "event_title" },
  { field: "eventTitle", source: "event_title" },
  { field: "title", source: "title" },
  { field: "question", source: "question" },
];

// Default lookback for prior-live event guard.
const DEFAULT_PRIOR_LIVE_LOOKBACK_HOURS = 12;

function normalizeEventKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

// Volume-label patterns that are not reliable event identifiers.
// These appear as market titles like "$15K matched activity" or "matched activity".
const WEAK_KEY_RE = /^\$\d+k?\s+matched|^matched\s+activity|^weak_market_level_key:/i;

function isUsableString(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const t = val.trim();
  if (t.length === 0 || t.toLowerCase() === "null" || t.toLowerCase() === "undefined") return false;
  // Reject volume-label event keys and explicit WEAK fallback keys.
  if (WEAK_KEY_RE.test(t)) return false;
  return true;
}

/**
 * Derive a stable EVENT-level identity for a candidate. Returns the normalized
 * key and which source field it came from, or { null, null } when no reliable
 * event identity exists (in which case the candidate is executor-unsafe).
 */
function deriveExecutorEventKey(
  candidate: Record<string, unknown>
): { eventKey: string | null; source: string | null } {
  for (const { field, source } of EVENT_KEY_FIELDS) {
    const val = candidate[field];
    if (isUsableString(val)) {
      return { eventKey: normalizeEventKey(val), source };
    }
    if (typeof val === "number" && Number.isFinite(val)) {
      return { eventKey: String(val), source };
    }
  }
  return { eventKey: null, source: null };
}

/**
 * Extract event key from a prior executor_order_events row's JSON blobs.
 * Checks candidate_snapshot_json then raw_event_json, looking for event_key
 * or eventKey at each level. Does NOT use token_id / idempotency_key /
 * condition_id. Returns null if no reliable event identity found.
 */
function extractPriorEventKey(row: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    // match_family_key is the preferred stable key (event-slug-level, added 2026-06-16).
    safeGet(row.candidate_snapshot_json, "match_family_key"),
    safeGet(safeGet(row.raw_event_json, "candidate_snapshot_json"), "match_family_key"),
    safeGet(row.raw_event_json, "match_family_key"),
    // Legacy: event_key / eventKey fields from older snapshots.
    safeGet(row.candidate_snapshot_json, "event_key"),
    safeGet(row.candidate_snapshot_json, "eventKey"),
    safeGet(safeGet(row.raw_event_json, "candidate_snapshot_json"), "event_key"),
    safeGet(safeGet(row.raw_event_json, "candidate_snapshot_json"), "eventKey"),
    safeGet(row.raw_event_json, "event_key"),
    safeGet(row.raw_event_json, "eventKey"),
    // event_slug from snapshot (used as match_family_key before this field was added).
    safeGet(row.candidate_snapshot_json, "event_slug"),
    safeGet(safeGet(row.raw_event_json, "candidate_snapshot_json"), "event_slug"),
  ];

  for (const val of candidates) {
    if (isUsableString(val)) {
      return normalizeEventKey(val);
    }
  }
  return null;
}

function safeGet(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Query executor_order_events for live (non-dry-run) rows within the lookback
 * window. Returns the set of event keys already traded, or throws on DB error.
 * The caller must treat a thrown error as a hard guard failure (no unguarded trading).
 */
async function fetchPriorLiveEventKeys(
  lookbackHours: number
): Promise<{ eventKeys: Set<string>; rowsChecked: number }> {
  const since = new Date(
    Date.now() - lookbackHours * 3_600_000
  ).toISOString();

  // Conservative filter: dry_run=false AND (live_confirm=true OR clob_order_id
  // not null OR success=true). This avoids treating paper/dry rows as blockers.
  // We select all three sentinel columns and both JSON blobs to maximise event
  // key recovery. Limit 500 — far above any realistic overnight order count.
  const { data, error } = await supabaseAdmin
    .from("executor_order_events")
    .select(
      "id, created_at, dry_run, live_confirm, clob_order_id, success, " +
      "candidate_snapshot_json, raw_event_json"
    )
    .eq("dry_run", false)
    .gt("created_at", since)
    .limit(500);

  if (error) {
    throw new Error(`prior_live_guard DB error: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const eventKeys = new Set<string>();

  for (const row of rows) {
    // Apply the live-confirmation filter in-process (Supabase JS client does
    // not support OR over columns natively without .or(), but the set is small
    // enough to filter here without risk).
    // Defense-in-depth: DB query already filters dry_run=false, but double-check.
    if (row.dry_run === true) continue;

    const isLiveConfirm = row.live_confirm === true;
    const hasClobId = typeof row.clob_order_id === "string" && (row.clob_order_id as string).length > 0;
    const isSuccess = row.success === true;

    if (!isLiveConfirm && !hasClobId && !isSuccess) continue;

    const key = extractPriorEventKey(row);
    if (key) eventKeys.add(key);
  }

  return { eventKeys, rowsChecked: rows.length };
}

interface SafeCandidate extends FireModelCandidate {
  event_key: string;
  event_key_source: string | null;
  event_one_position_guard: true;
  // Mirrors live_eligible: true when the candidate is live-safe, false for paper/shadow rows
  // that pass event-dedupe but are surfaced only in diagnostics.
  executor_safe: boolean;
  same_event_guard_rule: typeof EVENT_GUARD_RULE;
  original_rank_before_event_dedupe: number;
  candidate_rank_after_event_dedupe: number;
  // match_family_key_is_weak is inherited from FireModelCandidate (set in buildFireModelCandidates).
}

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "25", 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);
  const rawScope = (searchParams.get("scope") ?? "all").toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : "all";

  const rawLookback = parseFloat(
    process.env.EXECUTOR_EVENT_GUARD_LOOKBACK_HOURS ?? ""
  );
  const priorLiveLookbackHours =
    isNaN(rawLookback) || rawLookback <= 0
      ? DEFAULT_PRIOR_LIVE_LOOKBACK_HOURS
      : rawLookback;

  // --- Step 1: Fetch prior live event keys (hard guard: fail safe on error) ---
  let priorLiveEventKeys: Set<string>;
  let priorLiveRowsChecked: number;
  try {
    const result = await fetchPriorLiveEventKeys(priorLiveLookbackHours);
    priorLiveEventKeys = result.eventKeys;
    priorLiveRowsChecked = result.rowsChecked;
  } catch (guardError) {
    const msg =
      guardError instanceof Error ? guardError.message : "Unknown guard error";
    console.error("[executor/candidates] prior_live_guard FAILED:", msg);
    // Fail safe: return 503 rather than expose unguarded candidates.
    return NextResponse.json(
      {
        success: false,
        count: 0,
        candidates: [],
        diagnostics: {
          prior_live_event_guard_error: true,
          prior_live_event_guard_error_message: msg,
          event_guard_enabled: true,
          event_guard_rule: EVENT_GUARD_RULE,
          prior_live_event_guard_enabled: true,
          prior_live_lookback_hours: priorLiveLookbackHours,
        },
        error: "prior_live_event_guard_failed: cannot safely serve candidates",
      },
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }
    );
  }

  try {
    // --- Step 2: Fetch model-ranked candidate pool ---
    const { candidates: pool } = await buildFireModelCandidates(EVENT_DEDUPE_POOL, scope);

    const candidatesBeforeEventDedupe = pool.length;
    let sameEventCandidatesSuppressed = 0;
    let unsafeNoEventKeySuppressed = 0;
    let priorLiveEventCandidatesSuppressed = 0;
    // Candidates that passed event-dedupe guards but are live_eligible=false (paper/shadow only).
    let liveBlockedCount = 0;
    const liveBlockedByReason: Record<string, number> = {};

    const seenEventKeys = new Set<string>();
    const safeCandidates: SafeCandidate[] = [];

    // --- Step 3: Apply guards in order, preserve model rank ---
    for (const c of pool) {
      const { eventKey, source } = deriveExecutorEventKey(
        c as unknown as Record<string, unknown>
      );

      // Guard 1: no reliable event identity → unsafe, exclude entirely (not even paper).
      if (!eventKey) {
        unsafeNoEventKeySuppressed += 1;
        continue;
      }

      // Guard 2: event already live-traded in lookback window → suppress entirely.
      if (priorLiveEventKeys.has(eventKey)) {
        priorLiveEventCandidatesSuppressed += 1;
        continue;
      }

      // Guard 3: same event already in this batch → suppress correlated duplicate entirely.
      if (seenEventKeys.has(eventKey)) {
        sameEventCandidatesSuppressed += 1;
        continue;
      }

      seenEventKeys.add(eventKey);

      // Track live_eligible=false candidates in diagnostics before discarding from live list.
      if (!c.live_eligible) {
        liveBlockedCount += 1;
        const reason = c.live_rejection_reason ?? "UNKNOWN_REJECTION";
        liveBlockedByReason[reason] = (liveBlockedByReason[reason] ?? 0) + 1;
        // Paper/shadow candidates: still pass through to safeCandidates so the route can
        // surface them in diagnostics; they are stripped from the returned live list below.
      }

      safeCandidates.push({
        ...c,
        event_key: eventKey,
        event_key_source: source,
        event_one_position_guard: true,
        executor_safe: c.live_eligible,
        same_event_guard_rule: EVENT_GUARD_RULE,
        original_rank_before_event_dedupe: c.rank,
        candidate_rank_after_event_dedupe: safeCandidates.length + 1,
      });
    }

    const candidatesAfterPriorLiveGuard =
      candidatesBeforeEventDedupe -
      unsafeNoEventKeySuppressed -
      priorLiveEventCandidatesSuppressed;
    const candidatesAfterEventDedupe = safeCandidates.length;

    // Split into live-eligible and paper-only pools.
    // Route returns only live_eligible=true candidates in the main list.
    // Paper-only candidates appear only in diagnostics.paper_only_candidates (not served to executor).
    const liveCandidates = safeCandidates.filter((c) => c.live_eligible);
    const paperOnlyCandidates = safeCandidates.filter((c) => !c.live_eligible);

    // Scope counts over the live pool only (what executor will actually see).
    const scopeCounts: Record<string, number> = {};
    for (const c of liveCandidates) {
      const k = c.strategic_scope ?? "UNKNOWN";
      scopeCounts[k] = (scopeCounts[k] ?? 0) + 1;
    }
    const wcCount = scopeCounts["WC"] ?? 0;
    const soccerCount = (scopeCounts["WC"] ?? 0) + (scopeCounts["SOCCER"] ?? 0);

    // Timing bucket distribution over live candidates.
    const timingBuckets: Record<string, number> = {};
    for (const c of liveCandidates) {
      const b = c.timing_bucket ?? "UNKNOWN";
      timingBuckets[b] = (timingBuckets[b] ?? 0) + 1;
    }

    const pilotMaxRaw = parseInt(process.env.PILOT_MAX_LIVE_EVENTS ?? "", 10);
    const pilotMaxLiveEvents =
      !isNaN(pilotMaxRaw) && pilotMaxRaw > 0 ? pilotMaxRaw : null;
    const returned = liveCandidates.slice(
      0,
      pilotMaxLiveEvents !== null ? Math.min(limit, pilotMaxLiveEvents) : limit
    );
    const generatedAt = new Date().toISOString();

    return NextResponse.json(
      {
        success: true,
        source: "FireModel1_private_executor",
        policy_version: "battle-sm-guard-v1-20260615",
        live_policy_version: "live-risk-guard-v1",
        scope,
        count: returned.length,
        limit,
        candidates: returned,
        diagnostics: {
          event_guard_enabled: true,
          event_guard_rule: EVENT_GUARD_RULE,
          // Night-planner integration (read-only signalling for ops/monitoring).
          // Same-event correlated markets are suppressed above (Guard 3); the
          // suppressed count is the number of lower-ranked markets blocked.
          same_event_lower_ranked_markets_blocked: sameEventCandidatesSuppressed,
          event_rebalance_minutes_before_start: 45,
          planned_portfolio_mode_supported: true,
          prior_live_event_guard_enabled: true,
          prior_live_lookback_hours: priorLiveLookbackHours,
          prior_live_rows_checked: priorLiveRowsChecked,
          prior_live_event_keys_found: priorLiveEventKeys.size,
          prior_live_event_candidates_suppressed: priorLiveEventCandidatesSuppressed,
          candidates_before_event_dedupe: candidatesBeforeEventDedupe,
          candidates_after_prior_live_guard: candidatesAfterPriorLiveGuard,
          candidates_after_event_dedupe: candidatesAfterEventDedupe,
          same_event_candidates_suppressed: sameEventCandidatesSuppressed,
          unsafe_no_event_key_suppressed: unsafeNoEventKeySuppressed,
          live_eligible_count: liveCandidates.length,
          live_blocked_count: liveBlockedCount,
          live_blocked_by_reason: liveBlockedByReason,
          paper_only_count: paperOnlyCandidates.length,
          // Truncated list of paper-only candidates for monitoring; not served to executor.
          paper_only_candidates: paperOnlyCandidates.slice(0, 10).map((c) => ({
            signal_id: c.signal_id,
            strategic_scope: c.strategic_scope,
            strategy: c.strategy,
            timing_bucket: c.timing_bucket,
            live_rejection_reason: c.live_rejection_reason,
            match_family_key: c.match_family_key,
            match_family_key_is_weak: c.match_family_key_is_weak,
            hours_to_start: c.diagnostics.hours_to_start_now,
          })),
          scope_requested: scope,
          scope_counts: scopeCounts,
          timing_bucket_counts: timingBuckets,
          soccer_count: soccerCount,
          wc_count: wcCount,
          all_live_count: liveCandidates.length,
          returned_count: returned.length,
          pilot_max_live_events: pilotMaxLiveEvents,
          generated_at: generatedAt,
        },
        generated_at: generatedAt,
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[executor/candidates] Error:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
