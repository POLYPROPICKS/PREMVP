// Phase B2a — Signal outcome resolver script
// Default: dry-run (no DB writes). Pass --write to commit updates.
// Usage:
//   npm run resolve:signals               # dry-run
//   npm run resolve:signals -- --write    # write mode

import { loadEnvConfig } from "@next/env";
import path from "path";
import {
  fetchGammaMarketByConditionId,
  resolveSignalOutcome,
} from "../lib/feed/resolveSignalOutcome";

// ---- Config ----------------------------------------------------------------

const WRITE_MODE = process.argv.includes("--write");
const ONLY_EXPIRED = process.argv.includes("--only-expired");
const DEDUPE_STRICT = process.argv.includes("--dedupe-strict");
// Permanent pipeline contract: executed live bets are money-truth and must
// resolve before generic backlog. Do not remove or bypass this without an
// equivalent priority queue for executed condition_id::token_id keys.
const PRIORITY_LIVE_LEDGER = process.argv.includes("--priority-live-ledger");
// Targeted mode: prioritize expired unresolved rows currently shown in
// public.track_record_display_signals so trust-record rows resolve without
// waiting behind the full generic backlog (tens of thousands of rows deep).
// Read-only lookup against the display table; never fabricates outcomes —
// eligible rows still go through the same fetchGammaMarketByConditionId /
// resolveSignalOutcome path as the generic and live-priority queues.
const PRIORITY_TRACK_RECORD_DISPLAY = process.argv.includes(
  "--priority-track-record-display",
);

type ResolverOrderMode = "newest" | "oldest";

type ResolverRow = {
  id: string;
  created_at: string | null;
  expires_at: string | null;
  event_slug: string | null;
  condition_id: string;
  selected_outcome: string | null;
  selected_token_id: string | null;
  entry_price_num: number | null;
};

type PriorityLiveTarget = {
  condition_id: string;
  selected_token_id: string;
  event: string;
  market: string;
  side: string;
  execution_type: string;
  order_status: string;
  source_path: string;
};

const orderMode: ResolverOrderMode = (() => {
  const arg = process.argv.find((a) => a.startsWith("--order="));
  if (!arg) return "newest";
  const value = arg.split("=")[1];
  if (value === "oldest" || value === "newest") return value;
  console.error(
    `[resolve-signals] Invalid --order=${value}. Expected --order=oldest or --order=newest.`,
  );
  process.exit(1);
})();

const HAS_EXPLICIT_ORDER = process.argv.some((a) => a.startsWith("--order="));

function strictKey(row: Pick<ResolverRow, "condition_id" | "selected_token_id">): string {
  return `${row.condition_id}::${row.selected_token_id ?? ""}`;
}

// ---- Pending-resolution query spec -----------------------------------------
// Extracted so the eligibility filters + order are unit-testable without a DB
// round-trip, and so logging always reflects exactly what was queried.

export const PENDING_RESOLUTION_SELECT_COLUMNS =
  "id, created_at, expires_at, event_slug, condition_id, selected_outcome, selected_token_id, entry_price_num";

export interface PendingResolutionQuerySpec {
  select: string;
  filters: {
    signalResultIsNull: true;
    conditionIdNotNull: true;
    selectedTokenIdNotNull: true;
    entryPriceNumNotNull: true;
    metricFormulaVersionNotNull: true;
    expiresAtLt: string | null;
    createdAtGte: string | null;
  };
  order: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>;
  limit: number;
}

export function buildPendingResolutionQuerySpec(opts: {
  onlyExpired: boolean;
  expiredCutoff: string;
  createdAfter: string | null;
  orderMode: ResolverOrderMode;
  limit: number;
}): PendingResolutionQuerySpec {
  return {
    select: PENDING_RESOLUTION_SELECT_COLUMNS,
    filters: {
      signalResultIsNull: true,
      conditionIdNotNull: true,
      selectedTokenIdNotNull: true,
      entryPriceNumNotNull: true,
      metricFormulaVersionNotNull: true,
      expiresAtLt: opts.onlyExpired ? opts.expiredCutoff : null,
      createdAtGte: opts.createdAfter,
    },
    order:
      opts.orderMode === "oldest"
        ? [
            { column: "expires_at", ascending: true, nullsFirst: false },
            { column: "created_at", ascending: true },
            { column: "id", ascending: true },
          ]
        : [
            { column: "created_at", ascending: false },
            { column: "id", ascending: false },
          ],
    limit: opts.limit,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPendingResolutionQuerySpec(baseQuery: any, spec: PendingResolutionQuerySpec) {
  let query = baseQuery
    .select(spec.select)
    .is("signal_result", null)
    .not("condition_id", "is", null)
    .not("selected_token_id", "is", null)
    .not("entry_price_num", "is", null)
    .not("metric_formula_version", "is", null);

  if (spec.filters.expiresAtLt) query = query.lt("expires_at", spec.filters.expiresAtLt);
  if (spec.filters.createdAtGte) query = query.gte("created_at", spec.filters.createdAtGte);

  for (const o of spec.order) {
    query = query.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst });
  }

  return query.limit(spec.limit);
}

// ---- Track-record display priority spec -----------------------------------
// track_record_display_signals is not a table this repo owns/migrates — it
// is read-only from the resolver's perspective. source_row_id points at
// generated_signal_pairs.id. This is a two-phase lookup (display rows, then
// eligible pairs by id) rather than a single joined query, because Supabase
// PostgREST embeds require a declared FK relationship this repo cannot
// assume exists for source_row_id.

export const TRACK_RECORD_DISPLAY_SELECT_COLUMNS =
  "source_row_id, window_days, score_rank";

export interface TrackRecordPriorityCandidate {
  id: string;
  window_days: number | null;
  score_rank: number | null;
  expires_at: string | null;
  created_at: string | null;
}

/**
 * Pure sort — testable without a DB round-trip. Matches TASK B ordering:
 * window_days desc, score_rank asc (nulls last), expires_at asc, created_at
 * asc, id asc.
 */
export function sortTrackRecordPriorityCandidates<T extends TrackRecordPriorityCandidate>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const windowDiff = (b.window_days ?? -Infinity) - (a.window_days ?? -Infinity);
    if (windowDiff !== 0) return windowDiff;

    const aRank = a.score_rank ?? Number.POSITIVE_INFINITY;
    const bRank = b.score_rank ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;

    const aExpires = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
    const bExpires = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
    if (aExpires !== bExpires) return aExpires - bExpires;

    const aCreated = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const bCreated = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface TrackRecordEligibilityQuerySpec {
  select: string;
  ids: string[];
  filters: {
    resolvedAtIsNull: true;
    signalResultNotWonLost: true;
    conditionIdNotNull: true;
    selectedTokenIdNotNull: true;
    entryPriceNumNotNull: true;
    metricFormulaVersionNotNull: true;
    expiresAtLte: string;
    createdAtGte: string;
  };
}

/**
 * Eligibility filter for generated_signal_pairs rows referenced by
 * track_record_display_signals.source_row_id. Deliberately narrower than the
 * generic pending-resolution spec: `resolved_at is null` (not just
 * `signal_result is null`) and `signal_result` allows null OR a non-terminal
 * value, per TASK B — never treats an already-settled won/lost row as
 * pending again.
 */
export function buildTrackRecordEligibilityQuerySpec(opts: {
  ids: string[];
  nowIso: string;
  createdAfter: string;
}): TrackRecordEligibilityQuerySpec {
  return {
    select: PENDING_RESOLUTION_SELECT_COLUMNS,
    ids: opts.ids,
    filters: {
      resolvedAtIsNull: true,
      signalResultNotWonLost: true,
      conditionIdNotNull: true,
      selectedTokenIdNotNull: true,
      entryPriceNumNotNull: true,
      metricFormulaVersionNotNull: true,
      expiresAtLte: opts.nowIso,
      createdAtGte: opts.createdAfter,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTrackRecordEligibilityQuerySpec(baseQuery: any, spec: TrackRecordEligibilityQuerySpec) {
  return baseQuery
    .select(spec.select)
    .in("id", spec.ids)
    .is("resolved_at", null)
    .or("signal_result.is.null,signal_result.not.in.(won,lost)")
    .not("condition_id", "is", null)
    .not("selected_token_id", "is", null)
    .not("entry_price_num", "is", null)
    .not("metric_formula_version", "is", null)
    .lte("expires_at", spec.filters.expiresAtLte)
    .gte("created_at", spec.filters.createdAtGte);
}

const rawLimit = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return 25;
  const n = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 25;
})();

// Bounded-scan mitigation for cron statement timeouts. The backlog SELECT
// filters `signal_result is null` and orders by created_at; without a date
// window the planner sorts the entire unresolved history and intermittently
// hits "canceling statement due to statement timeout". Opt-in only — default
// behavior (no window) is unchanged so manual deep sweeps still see all rows.
const maxAgeDays = (() => {
  const arg = process.argv.find((a) => a.startsWith("--max-age-days="));
  if (!arg) return null;
  const n = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const createdAfterArg = (() => {
  const arg = process.argv.find((a) => a.startsWith("--created-after="));
  return arg ? arg.split("=").slice(1).join("=") : null;
})();
function resolveCreatedAfter(): string | null {
  if (createdAfterArg) return createdAfterArg;
  if (maxAgeDays != null) return new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  return null;
}

// In write mode, default maxUpdates = 1 to prevent accidental bulk writes.
// In dry-run mode, this value is logged but has no effect.
const maxUpdates = (() => {
  const arg = process.argv.find((a) => a.startsWith("--max-updates="));
  if (!arg) return WRITE_MODE ? 1 : Infinity;
  const n = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : WRITE_MODE ? 1 : Infinity;
})();

/**
 * Load live-priority resolver targets from executor_order_events (Supabase).
 * Replaces the old filesystem CSV dependency \u2014 Railway filesystem is ephemeral
 * and the old night_execution_detail.csv was a report OUTPUT, not a source of truth.
 *
 * Queries last 24h of non-dry-run order events where live_confirm=true or success=true.
 * Returns [] if no live bets in window (not an error).
 * Throws LIVE_PRIORITY_LEDGER_SUPABASE_QUERY_FAILED on DB error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPriorityLiveTargets(supabase: any): Promise<PriorityLiveTarget[]> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from("executor_order_events")
    .select(
      "id, created_at, order_status, dry_run, live_confirm, success, " +
      "market_slug, selected_side, side, token_id, event_type, " +
      "candidate_snapshot_json, raw_event_json"
    )
    .eq("dry_run", false)
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(`LIVE_PRIORITY_LEDGER_SUPABASE_QUERY_FAILED: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  // Keep only rows that represent actual live execution attempts
  const liveRows = rows.filter((r) => r.live_confirm === true || r.success === true);

  if (liveRows.length === 0) {
    console.log("[resolve-signals] LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H");
    return [];
  }

  function safeStr(obj: unknown, key: string): string {
    if (obj !== null && typeof obj === "object") {
      const v = (obj as Record<string, unknown>)[key];
      return typeof v === "string" && v.length > 0 ? v : "";
    }
    return "";
  }

  const byKey = new Map<string, PriorityLiveTarget>();
  for (const row of liveRows) {
    const snap = row.candidate_snapshot_json as Record<string, unknown> | null;
    const raw = row.raw_event_json as Record<string, unknown> | null;

    const conditionId =
      safeStr(snap, "condition_id") ||
      safeStr(raw, "condition_id");
    const tokenId =
      (typeof row.token_id === "string" && row.token_id ? row.token_id : "") ||
      safeStr(snap, "token_id") ||
      safeStr(snap, "selected_token_id");

    if (!conditionId || !tokenId) continue;

    const key = `${conditionId}::${tokenId}`;
    byKey.set(key, {
      condition_id: conditionId,
      selected_token_id: tokenId,
      event:
        safeStr(snap, "event_slug") ||
        safeStr(raw, "event_slug") ||
        safeStr(snap, "match_family_key") ||
        safeStr(raw, "match_family_key"),
      market:
        (typeof row.market_slug === "string" ? row.market_slug : "") ||
        safeStr(snap, "market_slug"),
      side:
        (typeof row.selected_side === "string" ? row.selected_side : "") ||
        (typeof row.side === "string" ? row.side : "") ||
        safeStr(snap, "selected_outcome"),
      execution_type: typeof row.event_type === "string" ? row.event_type : "live",
      order_status: typeof row.order_status === "string" ? row.order_status : "",
      source_path: "executor_order_events:supabase",
    });
  }

  const targets = [...byKey.values()];
  console.log(`[resolve-signals] LIVE_PRIORITY_LEDGER_SUPABASE_ROWS_LOADED count=${targets.length}`);
  return targets;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  // Load .env.local before any module that reads process.env at import time
  loadEnvConfig(process.cwd());

  const { supabaseAdmin } = await import("../lib/supabase/server");
  // Dynamic import keeps loadEnvConfig ordering: env must be loaded before any
  // module that reads process.env at initialisation time (supabaseAdmin).
  const { writeJobRun } = await import("../lib/feed/cacheGeneratedSignals");
  const supabase = supabaseAdmin;

  const startedAt = new Date().toISOString();
  const expiredCutoff = new Date().toISOString();

  // ── job_runs helper (write-mode only) ────────────────────────────────────
  // source="resolver" distinguishes these rows from cache-cron source="polymarket".
  // formula_version="resolver-v1" is a stable constant (resolver has no formula).
  // generatedCount maps to updatedCount; rejectedCount maps to skippedCount.
  async function tryWriteResolverJobRun(opts: {
    status: "success" | "empty" | "error";
    updatedCount?: number;
    skippedCount?: number;
    finishedAt: string;
    errorMessage?: string;
    extra?: Record<string, unknown>;
  }) {
    const dur =
      new Date(opts.finishedAt).getTime() - new Date(startedAt).getTime();
    try {
      await writeJobRun({
        source: "resolver",
        formulaVersion: "resolver-v1",
        startedAt,
        finishedAt: opts.finishedAt,
        status: opts.status,
        generatedCount: opts.updatedCount ?? 0,
        rejectedCount: opts.skippedCount ?? 0,
        durationMs: dur,
        errorMessage: opts.errorMessage,
        diagnostics: {
          writeMode: true,
          limit: rawLimit,
          maxUpdates,
          orderMode,
          onlyExpired: ONLY_EXPIRED,
          dedupeStrict: DEDUPE_STRICT,
          expiredCutoff: ONLY_EXPIRED ? expiredCutoff : null,
          ...(opts.extra ?? {}),
        },
      });
      console.log(
        `[resolve-signals] Job run recorded (${opts.status}, updated=${opts.updatedCount ?? 0})`,
      );
    } catch (e) {
      console.error(
        "[resolve-signals] Failed to write job run:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  const mode = WRITE_MODE ? "write" : "dry-run";

  const maxUpdatesLabel = WRITE_MODE ? String(maxUpdates) : "n/a";
  console.log(
    `[resolve-signals] === START mode=${mode} limit=${rawLimit} maxUpdates=${maxUpdatesLabel}` +
      ` order=${orderMode} onlyExpired=${ONLY_EXPIRED} dedupeStrict=${DEDUPE_STRICT}` +
      ` priorityLiveLedger=${PRIORITY_LIVE_LEDGER}` +
      ` priorityTrackRecordDisplay=${PRIORITY_TRACK_RECORD_DISPLAY}` +
      `${ONLY_EXPIRED ? ` expiredCutoff=${expiredCutoff}` : ""} ===`,
  );

  let livePriorityTargetsLoaded = 0;
  let livePriorityTargetsMatchedInPairs = 0;
  let livePriorityResolved = 0;
  let livePriorityUnresolved = 0;
  let livePriorityMissingInPairs = 0;
  let livePriorityErrors = 0;
  let livePriorityRowsUpdated = 0;

  if (PRIORITY_LIVE_LEDGER) {
    const targets = await loadPriorityLiveTargets(supabase);
    livePriorityTargetsLoaded = targets.length;
    console.log(
      `[resolve-signals] Live priority targets loaded: ${livePriorityTargetsLoaded}` +
        `${targets[0] ? ` source=${targets[0].source_path}` : ""}`,
    );

    for (const target of targets) {
      if (WRITE_MODE && livePriorityResolved >= maxUpdates) {
        console.log(
          `[resolve-signals] Max live priority updates reached (${maxUpdates}) — stopping priority writes`,
        );
        break;
      }

      const { data: matchingRows, error: matchError } = await supabase
        .from("generated_signal_pairs")
        .select(
          "id, created_at, expires_at, event_slug, condition_id, selected_outcome, selected_token_id, entry_price_num",
        )
        .eq("condition_id", target.condition_id)
        .eq("selected_token_id", target.selected_token_id)
        .is("signal_result", null)
        .not("entry_price_num", "is", null)
        .not("metric_formula_version", "is", null);

      if (matchError) {
        livePriorityErrors++;
        console.error(
          `[resolve-signals] LIVE_PRIORITY_ERROR ${target.event} DB match failed: ${matchError.message}`,
        );
        continue;
      }

      const rowsForTarget = ((matchingRows ?? []) as unknown) as ResolverRow[];
      if (!rowsForTarget.length) {
        livePriorityMissingInPairs++;
        console.log(
          `[resolve-signals] LIVE_PRIORITY_MISSING ${target.event} ${target.condition_id}::${target.selected_token_id}`,
        );
        continue;
      }
      livePriorityTargetsMatchedInPairs++;

      const row = rowsForTarget
        .slice()
        .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""))[0];
      const market = await fetchGammaMarketByConditionId(target.condition_id);
      const outcome = resolveSignalOutcome({
        conditionId: target.condition_id,
        selectedTokenId: target.selected_token_id,
        entryPriceNum: row.entry_price_num,
        market,
      });

      if (outcome.resolverState !== "resolved_candidate") {
        livePriorityUnresolved++;
        console.log(
          `[resolve-signals] LIVE_PRIORITY_SKIP ${target.event}` +
            ` state=${outcome.resolverState} reason=${outcome.skipReason}`,
        );
        continue;
      }

      if (!WRITE_MODE) {
        livePriorityUnresolved++;
        console.log(
          `[resolve-signals] LIVE_PRIORITY_WOULD ${target.event}` +
            ` result=${outcome.signalResult}` +
            ` return=${outcome.realizedReturnPct}%` +
            ` winner=${outcome.candidateWinningOutcome}`,
        );
        continue;
      }

      const resolvedAt = new Date().toISOString();
      const { data: updatedRows, error: updateError } = await supabase
        .from("generated_signal_pairs")
        .update({
          signal_result: outcome.signalResult,
          resolved_at: resolvedAt,
          winning_outcome: outcome.candidateWinningOutcome,
          realized_return_pct: outcome.realizedReturnPct,
        })
        .is("signal_result", null)
        .eq("condition_id", target.condition_id)
        .eq("selected_token_id", target.selected_token_id)
        .select("id");

      if (updateError) {
        livePriorityErrors++;
        console.error(
          `[resolve-signals] LIVE_PRIORITY_ERROR ${target.event} update failed: ${updateError.message}`,
        );
        continue;
      }

      const affectedRows = updatedRows?.length ?? 0;
      livePriorityRowsUpdated += affectedRows;
      livePriorityResolved++;
      console.log(
        `[resolve-signals] LIVE_PRIORITY_WRITE ${target.event}` +
          ` strictKey=${target.condition_id}::${target.selected_token_id}` +
          ` rows=${affectedRows}` +
          ` result=${outcome.signalResult}` +
          ` return=${outcome.realizedReturnPct}%` +
          ` winner=${outcome.candidateWinningOutcome}`,
      );
    }

    console.log(
      `[resolve-signals] LIVE_PRIORITY_SUMMARY` +
        ` loaded=${livePriorityTargetsLoaded}` +
        ` matched=${livePriorityTargetsMatchedInPairs}` +
        ` resolved=${livePriorityResolved}` +
        ` unresolved=${livePriorityUnresolved}` +
        ` missing=${livePriorityMissingInPairs}` +
        ` errors=${livePriorityErrors}` +
        ` rows_updated=${livePriorityRowsUpdated}`,
    );

    if (!ONLY_EXPIRED && !HAS_EXPLICIT_ORDER) {
      const finishedAt = new Date().toISOString();
      if (WRITE_MODE) {
        await tryWriteResolverJobRun({
          status: "success",
          updatedCount: livePriorityRowsUpdated,
          skippedCount: livePriorityUnresolved + livePriorityMissingInPairs + livePriorityErrors,
          finishedAt,
          extra: {
            selected: livePriorityTargetsLoaded,
            rawSelected: livePriorityTargetsLoaded,
            strictSelected: livePriorityTargetsMatchedInPairs,
            rowsUpdatedTotal: livePriorityRowsUpdated,
            strictTokensUpdated: livePriorityResolved,
            updated: livePriorityRowsUpdated,
            skipped: livePriorityUnresolved + livePriorityMissingInPairs + livePriorityErrors,
            orderMode,
            onlyExpired: ONLY_EXPIRED,
            dedupeStrict: DEDUPE_STRICT,
            priorityLiveLedger: PRIORITY_LIVE_LEDGER,
            livePriorityTargetsLoaded,
            livePriorityTargetsMatchedInPairs,
            livePriorityResolved,
            livePriorityUnresolved,
            livePriorityMissingInPairs,
            livePriorityErrors,
            livePriorityRowsUpdated,
          },
        });
      } else {
        console.log("[resolve-signals] Dry-run mode — job_runs not written.");
      }
      return;
    }
  }

  let trackRecordLoaded = 0;
  let trackRecordEligible = 0;
  let trackRecordUpdated = 0;
  let trackRecordUnresolved = 0;
  let trackRecordErrors = 0;
  let trackRecordRowsUpdated = 0;

  if (PRIORITY_TRACK_RECORD_DISPLAY) {
    const nowIso = new Date().toISOString();
    const trackRecordCreatedAfter =
      createdAfterArg ?? new Date(Date.now() - (maxAgeDays ?? 30) * 86_400_000).toISOString();

    const { data: displayRows, error: displayError } = await supabase
      .from("track_record_display_signals")
      .select(TRACK_RECORD_DISPLAY_SELECT_COLUMNS)
      .limit(1000);

    if (displayError) {
      trackRecordErrors++;
      console.error(
        `[resolve-signals] TRACK_RECORD_PRIORITY_QUERY_FAILED: ${displayError.message}`,
      );
      if (WRITE_MODE) {
        await tryWriteResolverJobRun({
          status: "error",
          finishedAt: new Date().toISOString(),
          errorMessage: displayError.message,
          extra: { phase: "track-record-display-select" },
        });
      }
      process.exit(1);
    }

    const displayCandidates = ((displayRows ?? []) as unknown) as Array<{
      source_row_id: string;
      window_days: number | null;
      score_rank: number | null;
    }>;
    trackRecordLoaded = displayCandidates.length;

    const idsToCheck = [...new Set(displayCandidates.map((d) => d.source_row_id))];

    if (idsToCheck.length === 0) {
      console.log("[resolve-signals] TRACK_RECORD_PRIORITY_LOADED count=0");
    } else {
      const eligibilitySpec = buildTrackRecordEligibilityQuerySpec({
        ids: idsToCheck,
        nowIso,
        createdAfter: trackRecordCreatedAfter,
      });

      const { data: eligibleRows, error: eligibleError } = await applyTrackRecordEligibilityQuerySpec(
        supabase.from("generated_signal_pairs"),
        eligibilitySpec,
      );

      if (eligibleError) {
        trackRecordErrors++;
        console.error(
          `[resolve-signals] TRACK_RECORD_PRIORITY_ELIGIBILITY_QUERY_FAILED: ${eligibleError.message}`,
        );
        if (WRITE_MODE) {
          await tryWriteResolverJobRun({
            status: "error",
            finishedAt: new Date().toISOString(),
            errorMessage: eligibleError.message,
            extra: { phase: "track-record-eligibility-select" },
          });
        }
        process.exit(1);
      }

      const eligiblePairs = ((eligibleRows ?? []) as unknown) as ResolverRow[];
      const displayById = new Map(displayCandidates.map((d) => [d.source_row_id, d]));

      const candidates: TrackRecordPriorityCandidate[] = eligiblePairs.map((row) => ({
        id: row.id,
        window_days: displayById.get(row.id)?.window_days ?? null,
        score_rank: displayById.get(row.id)?.score_rank ?? null,
        expires_at: row.expires_at,
        created_at: row.created_at,
      }));

      const sortedCandidates = sortTrackRecordPriorityCandidates(candidates).slice(0, rawLimit);
      const sortedIds = new Set(sortedCandidates.map((c) => c.id));
      const pairsById = new Map(eligiblePairs.map((row) => [row.id, row]));
      const trackRecordRows = sortedCandidates
        .map((c) => pairsById.get(c.id))
        .filter((r): r is ResolverRow => Boolean(r));

      trackRecordEligible = trackRecordRows.length;

      console.log(
        `[resolve-signals] TRACK_RECORD_PRIORITY_LOADED count=${trackRecordLoaded}` +
          ` eligible=${trackRecordEligible}` +
          ` first_score_rank=${sortedCandidates[0]?.score_rank ?? "n/a"}` +
          ` last_score_rank=${sortedCandidates[sortedCandidates.length - 1]?.score_rank ?? "n/a"}` +
          ` first_expires_at=${sortedCandidates[0]?.expires_at ?? "n/a"}` +
          ` last_expires_at=${sortedCandidates[sortedCandidates.length - 1]?.expires_at ?? "n/a"}`,
      );

      const trackRecordStrictRows = DEDUPE_STRICT
        ? Array.from(
            trackRecordRows
              .reduce<Map<string, ResolverRow>>((acc, row) => {
                const key = strictKey(row);
                if (!acc.has(key)) acc.set(key, row);
                return acc;
              }, new Map())
              .values(),
          )
        : trackRecordRows;

      for (const row of trackRecordStrictRows) {
        if (WRITE_MODE && trackRecordUpdated >= maxUpdates) {
          console.log(
            `[resolve-signals] TRACK_RECORD_PRIORITY max updates reached (${maxUpdates}) — stopping priority writes`,
          );
          break;
        }

        const conditionId = row.condition_id as string;
        const selectedTokenId = row.selected_token_id as string | null;
        const entryPriceNum = row.entry_price_num as number | null;
        const rowLabel = `[${row.id}] ${row.event_slug ?? conditionId}`;

        const market = await fetchGammaMarketByConditionId(conditionId);
        const outcome = resolveSignalOutcome({
          conditionId,
          selectedTokenId,
          entryPriceNum,
          market,
        });

        if (outcome.resolverState !== "resolved_candidate") {
          trackRecordUnresolved++;
          console.log(
            `[resolve-signals] TRACK_RECORD_PRIORITY_SKIP ${rowLabel}` +
              ` state=${outcome.resolverState} reason=${outcome.skipReason}`,
          );
          continue;
        }

        if (!WRITE_MODE) {
          trackRecordUnresolved++;
          console.log(
            `[resolve-signals] TRACK_RECORD_PRIORITY_WOULD ${rowLabel}` +
              ` result=${outcome.signalResult}` +
              ` return=${outcome.realizedReturnPct}%` +
              ` winner=${outcome.candidateWinningOutcome}`,
          );
          continue;
        }

        const resolvedAt = new Date().toISOString();
        let updateQuery = supabase
          .from("generated_signal_pairs")
          .update({
            signal_result: outcome.signalResult,
            resolved_at: resolvedAt,
            winning_outcome: outcome.candidateWinningOutcome,
            realized_return_pct: outcome.realizedReturnPct,
          })
          .is("signal_result", null);

        if (DEDUPE_STRICT) {
          updateQuery = updateQuery
            .eq("condition_id", conditionId)
            .eq("selected_token_id", selectedTokenId as string);
        } else {
          updateQuery = updateQuery.eq("id", row.id as string);
        }

        const { data: updatedRows, error: updateError } = await updateQuery.select("id");

        if (updateError) {
          trackRecordErrors++;
          console.error(
            `[resolve-signals] TRACK_RECORD_PRIORITY_ERROR ${rowLabel} update failed: ${updateError.message}`,
          );
          continue;
        }

        const affectedRows = updatedRows?.length ?? 0;
        if (affectedRows > 0) {
          trackRecordRowsUpdated += affectedRows;
          trackRecordUpdated++;
          console.log(
            `[resolve-signals] TRACK_RECORD_PRIORITY_WRITE ${rowLabel}` +
              ` rows=${affectedRows}` +
              ` result=${outcome.signalResult}` +
              ` return=${outcome.realizedReturnPct}%` +
              ` winner=${outcome.candidateWinningOutcome}`,
          );
        } else {
          trackRecordUnresolved++;
          console.log(
            `[resolve-signals] TRACK_RECORD_PRIORITY_NOOP ${rowLabel} reason=Already resolved or update matched 0 rows`,
          );
        }
      }

      console.log(
        `[resolve-signals] TRACK_RECORD_PRIORITY_SUMMARY` +
          ` loaded=${trackRecordLoaded}` +
          ` eligible=${trackRecordEligible}` +
          ` selected=${sortedIds.size}` +
          ` updated=${trackRecordUpdated}` +
          ` unresolved=${trackRecordUnresolved}` +
          ` errors=${trackRecordErrors}` +
          ` rows_updated=${trackRecordRowsUpdated}`,
      );
    }

    if (!ONLY_EXPIRED && !HAS_EXPLICIT_ORDER) {
      const finishedAt = new Date().toISOString();
      if (WRITE_MODE) {
        await tryWriteResolverJobRun({
          status: "success",
          updatedCount: trackRecordRowsUpdated,
          skippedCount: trackRecordUnresolved + trackRecordErrors,
          finishedAt,
          extra: {
            priorityTrackRecordDisplay: PRIORITY_TRACK_RECORD_DISPLAY,
            trackRecordLoaded,
            trackRecordEligible,
            trackRecordUpdated,
            trackRecordUnresolved,
            trackRecordErrors,
            trackRecordRowsUpdated,
          },
        });
      } else {
        console.log("[resolve-signals] Dry-run mode — job_runs not written.");
      }
      return;
    }
  }

  // Select unresolved rows with required snapshot fields. Filters/order are
  // built from the same spec used by the regression test and by the partial
  // index (see supabase/migrations/20260702_generated_signal_pairs_pending_resolution_index.sql)
  // so the query plan, the test, and the index all describe one contract.
  const createdAfter = resolveCreatedAfter();
  const querySpec = buildPendingResolutionQuerySpec({
    onlyExpired: ONLY_EXPIRED,
    expiredCutoff,
    createdAfter,
    orderMode,
    limit: rawLimit,
  });

  console.log(
    `[resolve-signals] SELECT_MODE onlyExpired=${ONLY_EXPIRED} order=${orderMode}` +
      ` maxAgeDays=${maxAgeDays ?? "none"} limit=${rawLimit} maxUpdates=${maxUpdatesLabel}` +
      ` dedupeStrict=${DEDUPE_STRICT}`,
  );
  console.log(
    `[resolve-signals] created_after=${createdAfter ?? "none"}` +
      ` expired_cutoff=${querySpec.filters.expiresAtLt ?? "none"}`,
  );

  const selectStartedAt = Date.now();
  const { data: rows, error: selectError } = await applyPendingResolutionQuerySpec(
    supabase.from("generated_signal_pairs"),
    querySpec,
  );
  const selectElapsedMs = Date.now() - selectStartedAt;

  if (selectError) {
    console.error(
      `[resolve-signals] DB select failed after ${selectElapsedMs}ms: ${selectError.message}` +
        ` filters=${JSON.stringify(querySpec.filters)} order=${JSON.stringify(querySpec.order)}` +
        ` limit=${querySpec.limit}`,
    );
    if (WRITE_MODE) {
      await tryWriteResolverJobRun({
        status: "error",
        finishedAt: new Date().toISOString(),
        errorMessage: selectError.message,
        extra: {
          phase: "db-select",
          selectElapsedMs,
          filters: querySpec.filters,
          order: querySpec.order,
          limit: querySpec.limit,
        },
      });
    }
    process.exit(1);
  }

  const selectedRows = ((rows ?? []) as unknown) as ResolverRow[];
  const selectedCount = selectedRows.length;
  console.log(
    `[resolve-signals] SELECT_OK count=${selectedCount} elapsed_ms=${selectElapsedMs}` +
      ` first_expires_at=${selectedRows[0]?.expires_at ?? "n/a"}` +
      ` last_expires_at=${selectedRows[selectedRows.length - 1]?.expires_at ?? "n/a"}`,
  );
  const strictRows = DEDUPE_STRICT
    ? Array.from(
        selectedRows
          .reduce<Map<string, ResolverRow>>((acc, row) => {
            const key = strictKey(row);
            if (!acc.has(key)) acc.set(key, row);
            return acc;
          }, new Map())
          .values(),
      )
    : selectedRows;
  const strictSelectedCount = strictRows.length;
  const duplicateRowsSkippedByStrictDedupe = selectedCount - strictSelectedCount;

  console.log(`[resolve-signals] Selected ${selectedCount} unresolved rows`);
  if (DEDUPE_STRICT) {
    console.log(
      `[resolve-signals] Strict dedupe selected ${strictSelectedCount} strict tokens` +
        ` (skipped ${duplicateRowsSkippedByStrictDedupe} duplicate raw rows)`,
    );
  }

  if (selectedCount === 0) {
    console.log("[resolve-signals] Nothing to process. Done.");
    if (WRITE_MODE) {
      await tryWriteResolverJobRun({
        status: "empty",
        finishedAt: new Date().toISOString(),
        extra: {
          selected: 0,
          rawSelected: 0,
          strictSelected: 0,
          duplicateRowsSkippedByStrictDedupe: 0,
          rowsUpdatedTotal: 0,
          strictTokensUpdated: 0,
          dedupeStrict: DEDUPE_STRICT,
        },
      });
    }
    return;
  }

  // Per-row counters
  const stateCounts: Record<string, number> = {};
  const resultCounts: Record<string, number> = {};
  let rowsUpdatedTotal = 0;
  let strictTokensUpdated = 0;
  let skippedCount = 0;

  for (const row of strictRows) {
    const conditionId = row.condition_id as string;
    const selectedTokenId = row.selected_token_id as string | null;
    const entryPriceNum = row.entry_price_num as number | null;

    const market = await fetchGammaMarketByConditionId(conditionId);
    const outcome = resolveSignalOutcome({
      conditionId,
      selectedTokenId,
      entryPriceNum,
      market,
    });

    stateCounts[outcome.resolverState] =
      (stateCounts[outcome.resolverState] ?? 0) + 1;

    const resultKey = outcome.signalResult ?? "null";
    resultCounts[resultKey] = (resultCounts[resultKey] ?? 0) + 1;

    const rowLabel = `[${row.id}] ${row.event_slug ?? conditionId}`;

    if (outcome.resolverState !== "resolved_candidate") {
      console.log(
        `  SKIP ${rowLabel} state=${outcome.resolverState} reason=${outcome.skipReason}`
      );
      skippedCount++;
      continue;
    }

    // resolved_candidate — dry-run: log and continue
    if (!WRITE_MODE) {
      console.log(
        `  WOULD ${rowLabel}` +
          ` result=${outcome.signalResult}` +
          ` return=${outcome.realizedReturnPct}%` +
          ` winner=${outcome.candidateWinningOutcome}`
      );
      skippedCount++;
      continue;
    }

    // Write mode: enforce max-updates guard before each write
    if (strictTokensUpdated >= maxUpdates) {
      console.log(
        `[resolve-signals] Max updates reached (${maxUpdates}) — stopping write updates`
      );
      skippedCount++;
      break;
    }

    // Write mode: update with idempotency guard — select("id") to confirm actual rows affected
    const resolvedAt = new Date().toISOString();
    let updateQuery = supabase
      .from("generated_signal_pairs")
      .update({
        signal_result: outcome.signalResult,
        resolved_at: resolvedAt,
        winning_outcome: outcome.candidateWinningOutcome,
        realized_return_pct: outcome.realizedReturnPct,
      })
      .is("signal_result", null) // idempotency guard — never overwrite already-resolved rows
      ;

    if (DEDUPE_STRICT) {
      updateQuery = updateQuery
        .eq("condition_id", conditionId)
        .eq("selected_token_id", selectedTokenId as string);
    } else {
      updateQuery = updateQuery.eq("id", row.id as string);
    }

    const { data: updatedRows, error: updateError } = await updateQuery.select("id");

    if (updateError) {
      console.error(
        `  ERROR ${rowLabel} update failed: ${updateError.message}`
      );
      skippedCount++;
    } else {
      const affectedRows = updatedRows?.length ?? 0;
      if (affectedRows > 0) {
        rowsUpdatedTotal += affectedRows;
        strictTokensUpdated++;
        console.log(
          `  ${DEDUPE_STRICT ? "WRITE_STRICT" : "WRITE"} ${rowLabel}` +
            `${DEDUPE_STRICT ? ` strictKey=${conditionId}::${selectedTokenId} rows=${affectedRows}` : ""}` +
            ` result=${outcome.signalResult}` +
            ` return=${outcome.realizedReturnPct}%` +
            ` winner=${outcome.candidateWinningOutcome}`
        );
      } else {
        console.log(
          `  NOOP  ${rowLabel} reason=Already resolved or update matched 0 rows`
        );
        skippedCount++;
      }
    }
  }

  // Summary
  const finishedAt = new Date().toISOString();
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  console.log(`[resolve-signals] === SUMMARY ===`);
  console.log(`  mode:          ${mode}`);
  console.log(`  order:         ${orderMode}`);
  console.log(`  only_expired:  ${ONLY_EXPIRED}`);
  console.log(`  dedupe_strict: ${DEDUPE_STRICT}`);
  console.log(`  expired_cutoff:${ONLY_EXPIRED ? ` ${expiredCutoff}` : " n/a"}`);
  console.log(`  raw_selected:  ${selectedCount}`);
  console.log(`  strict_selected:${DEDUPE_STRICT ? ` ${strictSelectedCount}` : " n/a"}`);
  console.log(`  strict_dupes:  ${duplicateRowsSkippedByStrictDedupe}`);
  console.log(`  rows_updated:  ${rowsUpdatedTotal}`);
  console.log(`  strict_updated:${strictTokensUpdated}`);
  console.log(`  skipped:       ${skippedCount}`);
  console.log(`  duration_ms:   ${durationMs}`);
  console.log(`  by_state:      ${JSON.stringify(stateCounts)}`);
  console.log(`  by_result:     ${JSON.stringify(resultCounts)}`);

  if (WRITE_MODE && rowsUpdatedTotal === 0 && selectedCount > 0) {
    console.log(
      `[resolve-signals] No rows updated — all were active, unknown, or already resolved.`
    );
  }

  // ── Write job_runs (write-mode only) ─────────────────────────────────────
  if (WRITE_MODE) {
    await tryWriteResolverJobRun({
      status: "success",
      updatedCount: rowsUpdatedTotal,
      skippedCount,
      finishedAt,
      extra: {
        selected: selectedCount,
        rawSelected: selectedCount,
        strictSelected: strictSelectedCount,
        duplicateRowsSkippedByStrictDedupe,
        rowsUpdatedTotal,
        strictTokensUpdated,
        updated: rowsUpdatedTotal,
        skipped: skippedCount,
        orderMode,
        onlyExpired: ONLY_EXPIRED,
        dedupeStrict: DEDUPE_STRICT,
        priorityLiveLedger: PRIORITY_LIVE_LEDGER,
        livePriorityTargetsLoaded,
        livePriorityTargetsMatchedInPairs,
        livePriorityResolved,
        livePriorityUnresolved,
        livePriorityMissingInPairs,
        livePriorityErrors,
        livePriorityRowsUpdated,
        expiredCutoff: ONLY_EXPIRED ? expiredCutoff : null,
        by_state: stateCounts,
        by_result: resultCounts,
      },
    });
  } else {
    console.log(
      "[resolve-signals] Dry-run mode — job_runs not written.",
    );
  }
}

// Guard so `tests/signals/*` can import the query-spec helpers above without
// triggering the CLI entrypoint (main() reads live env vars / hits Supabase).
if (require.main === module) {
  main().catch(async (err) => {
    console.error("[resolve-signals] Fatal error:", err);
    // Best-effort job_runs write on fatal throw (write-mode only)
    if (WRITE_MODE) {
      try {
        const { writeJobRun: wjr } = await import(
          "../lib/feed/cacheGeneratedSignals"
        );
        const tFatal = new Date().toISOString();
        await wjr({
          source: "resolver",
          formulaVersion: "resolver-v1",
          startedAt: tFatal, // startedAt inaccessible here — use current time as sentinel
          finishedAt: tFatal,
          status: "error",
          generatedCount: 0,
          rejectedCount: 0,
          durationMs: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
          diagnostics: { writeMode: true, fatal: true },
        });
      } catch {
        // non-fatal: never let job_runs failure mask the real error
      }
    }
    process.exit(1);
  });
}
