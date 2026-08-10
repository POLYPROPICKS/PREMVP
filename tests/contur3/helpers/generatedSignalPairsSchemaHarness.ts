// tests/contur3/helpers/generatedSignalPairsSchemaHarness.ts
//
// Schema-enforcing test persistence harness for `generated_signal_pairs`.
//
// WHY THIS EXISTS
// ---------------
// The C1 balancing contour previously shipped a selector whose completeness gate
// required three field names -- `signal_score`, `stake_usd`, `max_entry_price` --
// that have never existed as columns on `generated_signal_pairs`. Every selector
// test stayed green because its fixtures hand-wrote those properties onto plain
// object literals and injected them straight into the selector, bypassing both
// the real sibling loader and any persistence boundary. The fixture was strictly
// stronger than any row production could ever produce.
//
// This harness makes that class of false green impossible: a fixture row is
// rejected at write time if it carries any key the real production table cannot
// carry. The allowlist below is the verbatim live production column set.
//
// It also emulates the serialization boundary (structuredClone-equivalent JSON
// round trip), so a fixture cannot smuggle a non-serializable value, a getter,
// a class instance, or `undefined` past the consumer.

/**
 * Verbatim live production column set of `generated_signal_pairs`, captured from
 * an authenticated PostgREST read. Deliberately a literal, not a derived value:
 * if production gains or loses a column, this list must be updated consciously
 * and the diff reviewed, because the selector contract depends on it.
 *
 * NOTE: `signal_score`, `stake_usd` and `max_entry_price` are intentionally and
 * provably ABSENT. See assertNoPhantomExecutionColumns() below.
 */
export const GENERATED_SIGNAL_PAIRS_COLUMNS: ReadonlySet<string> = new Set([
  "condition_id",
  "created_at",
  "diagnostics",
  "entry_price_num",
  "event_slug",
  "expected_return_pct_num",
  "expires_at",
  "formula_version",
  "id",
  "market_slug",
  "market_source",
  "market_sources",
  "metric_formula_version",
  "pre_event_score_num",
  "premium_signal",
  "realized_return_pct",
  "resolved_at",
  "score",
  "selected_outcome",
  "selected_token_id",
  "signal_confidence_num",
  "signal_result",
  "smart_money_score_num",
  "source",
  "trust_metrics",
  "whale_public_score_num",
  "winning_outcome",
]);

/**
 * The exact field names the pre-fix selector demanded. None is a real column.
 * A regression that reintroduces a read of any of these must fail loudly.
 */
export const PHANTOM_EXECUTION_COLUMNS: readonly string[] = [
  "signal_score",
  "stake_usd",
  "max_entry_price",
  "accepted_stake_usd",
  "accepted_max_entry_price",
];

export function assertNoPhantomExecutionColumns(assert: {
  ok(value: unknown, message?: string): void;
}): void {
  for (const name of PHANTOM_EXECUTION_COLUMNS) {
    assert.ok(
      !GENERATED_SIGNAL_PAIRS_COLUMNS.has(name),
      `${name} must not be a generated_signal_pairs column -- the selector may never read it`,
    );
  }
}

export class SchemaViolationError extends Error {
  constructor(public readonly offendingKeys: readonly string[]) {
    super(
      `fixture row carries ${offendingKeys.length} key(s) that production ` +
        `generated_signal_pairs cannot store: ${offendingKeys.join(", ")}. ` +
        `A test fixture must never be stronger than a real producer row.`,
    );
    this.name = "SchemaViolationError";
  }
}

export type StoredRow = Record<string, unknown>;

/**
 * In-memory stand-in for the `generated_signal_pairs` table that enforces the
 * real column contract on write and the real serialization contract on read.
 */
export class GeneratedSignalPairsTable {
  private readonly rows: StoredRow[] = [];

  /** Rejects any key production cannot carry, then stores a serialized copy. */
  insert(row: Record<string, unknown>): void {
    const offending = Object.keys(row).filter((k) => !GENERATED_SIGNAL_PAIRS_COLUMNS.has(k));
    if (offending.length > 0) throw new SchemaViolationError(offending);
    // Emulate the DB/PostgREST serialization boundary: JSONB round trip, so
    // `undefined` disappears exactly as it would in production.
    this.rows.push(JSON.parse(JSON.stringify(row)) as StoredRow);
  }

  insertAll(rows: readonly Record<string, unknown>[]): void {
    for (const r of rows) this.insert(r);
  }

  /** Mirrors `.from(...).select("*").eq("id", id).limit(1)`. */
  async queryById(id: string): Promise<StoredRow[]> {
    return this.rows.filter((r) => r.id === id).slice(0, 1).map(clone);
  }

  /** Mirrors `.from(...).select("*").eq("condition_id", conditionId)`. */
  async queryByConditionId(conditionId: string): Promise<StoredRow[]> {
    return this.rows.filter((r) => r.condition_id === conditionId).map(clone);
  }

  /** Mirrors the production JSONB event-identity + score-domain sibling read. */
  async queryByProviderEvent(identity: {
    eventId: string;
    eventStartIso: string;
    scoreContractVersion: string;
  }): Promise<StoredRow[]> {
    const expectedStart = Date.parse(identity.eventStartIso);
    return this.rows.filter((row) => {
      const diagnostics = row.diagnostics as Record<string, unknown> | undefined;
      const context = diagnostics?.providerEventContext as Record<string, unknown> | undefined;
      return context?.v === "v1" && context.provider === "polymarket" &&
        context.eventId === identity.eventId &&
        typeof context.eventStartIso === "string" &&
        Date.parse(context.eventStartIso) === expectedStart &&
        row.metric_formula_version === identity.scoreContractVersion;
    }).map(clone);
  }

  get size(): number {
    return this.rows.length;
  }
}

function clone(row: StoredRow): StoredRow {
  return JSON.parse(JSON.stringify(row)) as StoredRow;
}

/**
 * Builds a row in the shape the real producer writes. Only columns the producer
 * actually populates are settable; `score` is hardcoded null because every
 * production writer path in lib/feed/cacheGeneratedSignals.ts writes it null.
 */
export function producerShapedRow(input: {
  id: string;
  conditionId: string;
  selectedTokenId: string;
  selectedOutcome: string;
  /** The authoritative model score carrier. null = intentionally-unscored shadow row. */
  signalConfidenceNum: number | null;
  /** The accepted pre-Reservation snapshot price. */
  entryPriceNum: number | null;
  metricFormulaVersion: string;
  providerEventId: string;
  providerEventStartIso: string;
  marketSlug?: string;
  /** Escape hatch for negative tests that need a malformed provider context. */
  providerEventContextOverride?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const context =
    input.providerEventContextOverride === undefined
      ? {
          v: "v1",
          provider: "polymarket",
          eventId: input.providerEventId,
          eventStartIso: input.providerEventStartIso,
        }
      : input.providerEventContextOverride;

  return {
    id: input.id,
    source: "polymarket",
    formula_version: input.metricFormulaVersion,
    metric_formula_version: input.metricFormulaVersion,
    event_slug: `event-${input.providerEventId}`,
    market_slug: input.marketSlug ?? `market-${input.conditionId}`,
    condition_id: input.conditionId,
    selected_outcome: input.selectedOutcome,
    selected_token_id: input.selectedTokenId,
    signal_confidence_num: input.signalConfidenceNum,
    entry_price_num: input.entryPriceNum,
    // Every production writer path writes score: null. Never a live carrier.
    score: null,
    created_at: "2026-08-09T02:36:45.795039+00:00",
    expires_at: "2026-09-08T02:36:45.345+00:00",
    diagnostics: context === null ? {} : { providerEventContext: context },
  };
}
