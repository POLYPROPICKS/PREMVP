// Materializer logic for public.track_record_display_signals.
//
// Pure, DB-free row building from fresh public.generated_signal_pairs rows.
// The DB-facing runner (runDisplayMaterializer) takes injected deps so tests
// can prove dry-run never touches insert, and so idempotency is enforced by
// read-existing-then-insert-missing instead of relying on a DB unique
// constraint (the table has none for this key).

export interface GeneratedPairPremiumSignalSubset {
  eventTitle?: string | null;
  position?: string | null;
  profit?: string | null;
  winProbability?: number | null;
  actionLabel?: string | null;
}

// Subset of generated_signal_pairs columns the materializer needs. Field
// names match the real table columns written by writeGeneratedSignalPairs()
// in lib/feed/cacheGeneratedSignals.ts.
export interface GeneratedPairSourceRow {
  id: string;
  created_at: string;
  expires_at: string | null;
  event_slug: string | null;
  market_slug: string | null;
  condition_id: string | null;
  selected_outcome: string | null;
  entry_price_num: number | null;
  score: number | null;
  signal_confidence_num: number | null;
  metric_formula_version: string | null;
  premium_signal: GeneratedPairPremiumSignalSubset | null;
}

// Row shape for public.track_record_display_signals (existing columns only).
export interface TrackRecordDisplayRow {
  generated_at: string;
  window_days: number;
  source_model: string | null;
  source_row_id: string;
  batch_day: string;
  latest_batch_at: string;
  score_rank: number;
  block_10: number;
  slot_in_10: number;
  event_title: string | null;
  market_question: string | null;
  position: string | null;
  selected_outcome: string | null;
  signal_key: string | null;
  match_key: string | null;
  projected_win_probability: number | null;
  projected_win_rate_pct: number | null;
  market_price: number | null;
  decimal_odds: number | null;
  american_odds: number | null;
  odds_source_path: string;
  stake_usd: number;
  projected_pnl_units: number | null;
  projected_return_usd: number | null;
  projected_roi_pct_per_signal: number | null;
  status: string;
  action: string | null;
  return_label: string | null;
}

export interface ExistingDisplayKey {
  batch_day: string;
  window_days: number;
  source_row_id: string;
}

export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_LIMIT = 25;
export const DEFAULT_MAX_SOURCE_AGE_HOURS = 36;
export const DEFAULT_STAKE_USD = 100;
export const ODDS_SOURCE_PATH = "generated_signal_pairs.entry_price_num";

export type FreshnessVerdict = "FRESH" | "NO_FRESH_GENERATED_SIGNAL_PAIRS";

// Mirrors public.track_record_normalize_match_key(): lowercase, strip
// non-alphanumerics to spaces, collapse whitespace.
export function normalizeMatchKey(rawTitle: string | null): string | null {
  if (!rawTitle) return null;
  const normalized = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export function assessSourceFreshness(input: {
  sourceRows: Array<Pick<GeneratedPairSourceRow, "created_at">>;
  nowIso: string;
  maxAgeHours?: number;
}): { fresh: boolean; verdict: FreshnessVerdict; latestGeneratedAt: string | null } {
  const maxAgeHours = input.maxAgeHours ?? DEFAULT_MAX_SOURCE_AGE_HOURS;
  let latest: string | null = null;
  for (const row of input.sourceRows) {
    if (!row.created_at) continue;
    if (latest === null || row.created_at > latest) latest = row.created_at;
  }
  if (latest === null) {
    return { fresh: false, verdict: "NO_FRESH_GENERATED_SIGNAL_PAIRS", latestGeneratedAt: null };
  }
  const ageMs = new Date(input.nowIso).getTime() - new Date(latest).getTime();
  const fresh = ageMs <= maxAgeHours * 3600 * 1000;
  return {
    fresh,
    verdict: fresh ? "FRESH" : "NO_FRESH_GENERATED_SIGNAL_PAIRS",
    latestGeneratedAt: latest,
  };
}

function toDecimalOdds(marketPrice: number | null): number | null {
  if (marketPrice === null || !(marketPrice > 0) || marketPrice > 1) return null;
  return 1 / marketPrice;
}

function toAmericanOdds(decimalOdds: number | null): number | null {
  if (decimalOdds === null || decimalOdds <= 1) return null;
  return decimalOdds >= 2
    ? Math.round((decimalOdds - 1) * 100)
    : Math.round(-100 / (decimalOdds - 1));
}

function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

// Deterministic ranking: score desc (nulls last), then created_at desc,
// then id asc as the total tiebreaker.
function compareSourceRows(a: GeneratedPairSourceRow, b: GeneratedPairSourceRow): number {
  const aScore = a.score ?? Number.NEGATIVE_INFINITY;
  const bScore = b.score ?? Number.NEGATIVE_INFINITY;
  if (aScore !== bScore) return bScore - aScore;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildDisplayRows(input: {
  sourceRows: GeneratedPairSourceRow[];
  nowIso: string;
  windowDays?: number;
  limit?: number;
  stakeUsd?: number;
}): TrackRecordDisplayRow[] {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const stakeUsd = input.stakeUsd ?? DEFAULT_STAKE_USD;
  const batchDay = input.nowIso.slice(0, 10);

  const ranked = [...input.sourceRows].sort(compareSourceRows).slice(0, limit);

  return ranked.map((row, index) => {
    const scoreRank = index + 1;
    const eventTitle = row.premium_signal?.eventTitle ?? row.event_slug ?? null;
    const matchKey = normalizeMatchKey(eventTitle);
    const selectedOutcome = row.selected_outcome ?? null;
    const marketPrice = row.entry_price_num;
    const decimalOdds = toDecimalOdds(marketPrice);
    const projectedPnlUnits = decimalOdds === null ? null : round2(decimalOdds - 1);
    const winProbability =
      row.signal_confidence_num ?? row.premium_signal?.winProbability ?? null;

    return {
      generated_at: row.created_at,
      window_days: windowDays,
      source_model: row.metric_formula_version,
      source_row_id: row.id,
      batch_day: batchDay,
      latest_batch_at: input.nowIso,
      score_rank: scoreRank,
      block_10: Math.ceil(scoreRank / 10),
      slot_in_10: ((scoreRank - 1) % 10) + 1,
      event_title: eventTitle,
      market_question: row.market_slug ?? null,
      position: row.premium_signal?.position ?? selectedOutcome,
      selected_outcome: selectedOutcome,
      signal_key:
        matchKey !== null ? `${matchKey}|${selectedOutcome ?? ""}` : null,
      match_key: matchKey,
      projected_win_probability: winProbability,
      projected_win_rate_pct: winProbability,
      market_price: marketPrice,
      decimal_odds: round2(decimalOdds),
      american_odds: toAmericanOdds(decimalOdds),
      odds_source_path: ODDS_SOURCE_PATH,
      stake_usd: stakeUsd,
      projected_pnl_units: projectedPnlUnits,
      projected_return_usd:
        projectedPnlUnits === null ? null : round2(projectedPnlUnits * stakeUsd),
      projected_roi_pct_per_signal:
        projectedPnlUnits === null ? null : round2(projectedPnlUnits * 100),
      status: "shown",
      action: row.premium_signal?.actionLabel ?? "ENTER",
      return_label: row.premium_signal?.profit ?? null,
    };
  });
}

function displayKey(k: ExistingDisplayKey): string {
  return `${k.batch_day}|${k.window_days}|${k.source_row_id}`;
}

export function filterAlreadyMaterialized(
  candidates: TrackRecordDisplayRow[],
  existing: ExistingDisplayKey[]
): TrackRecordDisplayRow[] {
  const existingKeys = new Set(existing.map(displayKey));
  return candidates.filter((row) => !existingKeys.has(displayKey(row)));
}

export interface MaterializerDeps {
  fetchFreshSourceRows: () => Promise<GeneratedPairSourceRow[]>;
  fetchExistingDisplayKeys: (
    batchDay: string,
    windowDays: number
  ) => Promise<ExistingDisplayKey[]>;
  insertDisplayRows: (rows: TrackRecordDisplayRow[]) => Promise<number>;
}

export interface MaterializerOptions {
  nowIso?: string;
  write?: boolean;
  allowStale?: boolean;
  windowDays?: number;
  limit?: number;
  maxAgeHours?: number;
}

export type MaterializerVerdict =
  | "DRY_RUN_OK"
  | "WRITE_OK"
  | "NO_FRESH_GENERATED_SIGNAL_PAIRS";

export interface MaterializerResult {
  verdict: MaterializerVerdict;
  batchDay: string;
  windowDays: number;
  sourceRowCount: number;
  latestGeneratedAt: string | null;
  plannedCount: number;
  skippedExistingCount: number;
  insertedCount: number;
  dryRun: boolean;
}

export async function runDisplayMaterializer(
  deps: MaterializerDeps,
  options: MaterializerOptions = {}
): Promise<MaterializerResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const write = options.write === true;
  const batchDay = nowIso.slice(0, 10);

  const sourceRows = await deps.fetchFreshSourceRows();
  const freshness = assessSourceFreshness({
    sourceRows,
    nowIso,
    maxAgeHours: options.maxAgeHours,
  });

  if (!freshness.fresh && options.allowStale !== true) {
    return {
      verdict: "NO_FRESH_GENERATED_SIGNAL_PAIRS",
      batchDay,
      windowDays,
      sourceRowCount: sourceRows.length,
      latestGeneratedAt: freshness.latestGeneratedAt,
      plannedCount: 0,
      skippedExistingCount: 0,
      insertedCount: 0,
      dryRun: !write,
    };
  }

  const candidates = buildDisplayRows({
    sourceRows,
    nowIso,
    windowDays,
    limit: options.limit,
  });
  const existing = await deps.fetchExistingDisplayKeys(batchDay, windowDays);
  const toInsert = filterAlreadyMaterialized(candidates, existing);

  let insertedCount = 0;
  if (write && toInsert.length > 0) {
    insertedCount = await deps.insertDisplayRows(toInsert);
  }

  return {
    verdict: write ? "WRITE_OK" : "DRY_RUN_OK",
    batchDay,
    windowDays,
    sourceRowCount: sourceRows.length,
    latestGeneratedAt: freshness.latestGeneratedAt,
    plannedCount: toInsert.length,
    skippedExistingCount: candidates.length - toInsert.length,
    insertedCount,
    dryRun: !write,
  };
}
