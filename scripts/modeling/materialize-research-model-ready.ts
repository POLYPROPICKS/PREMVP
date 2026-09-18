/**
 * DIRECT_MODEL_READY_RESEARCH_PATH_V1 — smallest reusable materialization
 * path: authoritative production evidence (RESEARCH CLONE mirror, READ ONLY)
 * -> bounded per-day extraction -> Gamma-authoritative settlement enrichment
 * -> research_model_ready_rows / research_model_ready_days.
 *
 * Reuses, verbatim, the exact bounded reads and identity/PIT/settlement
 * semantics already proven in scripts/modeling/live-d1-research-corpus.ts
 * (readSignalPairs, readPrimaryEvidenceOutbox, readObservations,
 * resolveGammaTerminal, the frozen buildCompactCorpus materializer) and the
 * exact storage row shape already proven in
 * scripts/modeling/clone-model-ready-pipeline.ts
 * (lib/research-clone/modelReady.ts toStoredModelRow,
 * normalizeMaterializedSportFamily). This is orchestration-only reuse — no
 * parallel research architecture.
 *
 * Unlike clone-model-ready-pipeline.ts this path:
 *   - never requires a prior local corpus/manifest artifact (no
 *     scripts/modeling/live-d1-research-corpus.ts subprocess, no full-envelope
 *     clone-sync prerequisite);
 *   - never computes or writes research_model_economics (C0/C1/C4/C5
 *     economics are explicitly out of scope for this materializer);
 *   - takes an explicit --start/--end (or --dates) range so the same path
 *     later covers 1D/7D/14D/30D without another implementation.
 *
 * Idempotent: research_model_ready_rows is upserted on its full economic
 * identity key (model_date,population_id,condition_id,selected_token_id,
 * decision_at) — a rerun of the same date never creates a duplicate
 * identity, it only refreshes the row content.
 *
 *   npx tsx scripts/modeling/materialize-research-model-ready.ts \
 *     --start 2026-09-01 --end 2026-09-15
 */
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildCompactCorpus,
  type CompactCorpusSlice,
} from "@/lib/modeling/forward-rich/compactCorpus";
import type {
  ForwardRichSignalPair,
  GammaTerminalState,
} from "@/lib/modeling/forward-rich/types";
import { toStoredModelRow } from "../../lib/research-clone/modelReady";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";
import { normalizeMaterializedSportFamily } from "./clone-model-ready-pipeline";
import {
  mapWithConcurrency,
  minskWindow,
  projectRef,
  readObservations,
  readPrimaryEvidenceOutbox,
  readSignalPairs,
  resolveCloneClient,
  resolveGammaTerminal,
} from "./live-d1-research-corpus";

const WRITE_PAGE = 500;
const OBS_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;
const MINSK_OFFSET_HOURS = 3; // Europe/Minsk = UTC+3 year-round (no DST since 2011)
// Bounded default cron window: "missing/recent", never an unbounded backfill.
const DEFAULT_RECENT_WINDOW_DAYS = 7;

function arg(name: string): string | undefined {
  const eq = process.argv.find((v) => v.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Latest fully-closed Europe/Minsk calendar date given a wall clock (defaults to now). */
export function latestClosedMinskDay(now: Date = new Date()): string {
  const minskNow = new Date(now.getTime() + MINSK_OFFSET_HOURS * 3600_000);
  const minskMidnightUtcMs =
    Date.UTC(minskNow.getUTCFullYear(), minskNow.getUTCMonth(), minskNow.getUTCDate()) -
    MINSK_OFFSET_HOURS * 3600_000;
  return new Date(minskMidnightUtcMs - DAY_MS + MINSK_OFFSET_HOURS * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Bounded default source of dates for the unattended cron invocation
 * (no --start/--end/--dates supplied): the last DEFAULT_RECENT_WINDOW_DAYS
 * closed Minsk dates ending at the latest closed day, minus whichever of
 * those are already accepted in research_model_ready_days
 * (MODEL_READY or DEGRADED_EXCLUDED). Never an unbounded historical
 * backfill — "missing/recent" only, mirroring the bounded-window discipline
 * already proven in scripts/modeling/clone-model-ready-pipeline.ts.
 */
export async function resolveMissingRecentDates(
  db: SupabaseClient,
  windowDays: number = DEFAULT_RECENT_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<string[]> {
  const end = latestClosedMinskDay(now);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - (windowDays - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const candidates = datesInRange(start, end);
  const { data, error } = await db
    .from("research_model_ready_days")
    .select("model_date,status")
    .gte("model_date", start)
    .lte("model_date", end);
  if (error) throw new Error(`MATERIALIZE_DAY_READ:${error.code ?? error.message}`);
  const accepted = new Set(
    (data ?? [])
      .filter((r: { status: string }) =>
        (ACCEPTED_DAY_STATUSES as readonly string[]).includes(r.status),
      )
      .map((r: { model_date: string }) => r.model_date),
  );
  return candidates.filter((d) => !accepted.has(d));
}

export function datesInRange(start: string, end: string): string[] {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error("MATERIALIZE_RANGE_INVALID: --start must be a valid date <= --end");
  }
  const out: string[] = [];
  for (let t = startMs; t <= endMs; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface DayMaterializationCounts {
  date: string;
  sourceEvidenceIdentityN: number;
  modelReadyRowN: number;
  terminalRowN: number;
  openRowN: number;
  noMatchN: number;
  ambiguousN: number;
  voidN: number;
  pitFutureLeakN: number;
}

/**
 * Materializes one Minsk calendar date into model-ready rows. Read-only
 * against the research clone; writes nothing. Bounded reads only (keyset
 * pages on the proven (timestamp,id) shape); never a full table scan; never
 * touches production primary.
 */
export async function materializeDayRows(
  db: SupabaseClient,
  d: string,
): Promise<{ rows: ScorecardReadyRow[]; counts: DayMaterializationCounts }> {
  const { startUtc, endUtc } = minskWindow(d);
  // Bounded to "now" for a same-day/in-progress window; never reads beyond
  // the current instant. Fully-closed historical days are unaffected.
  const boundedEndUtc = Date.parse(endUtc) > Date.now() ? new Date().toISOString() : endUtc;

  const gsp = await readSignalPairs(db, startUtc, boundedEndUtc);
  const outbox = await readPrimaryEvidenceOutbox(db, startUtc, boundedEndUtc);
  const pairs = [...gsp.pairs, ...outbox.pairs];

  const conditionIds = Array.from(new Set(pairs.map((p) => p.conditionId).filter(Boolean)));
  const floorUtc = new Date(Date.parse(startUtc) - OBS_LOOKBACK_DAYS * DAY_MS).toISOString();
  const observations = conditionIds.length
    ? await readObservations(db, conditionIds, floorUtc, boundedEndUtc)
    : [];

  const identities = Array.from(
    new Map(
      pairs
        .filter((p) => p.conditionId && p.selectedTokenId)
        .map((p) => [
          `${p.conditionId}::${p.selectedTokenId}`,
          { conditionId: p.conditionId, selectedTokenId: p.selectedTokenId, entryPriceNum: p.entryPriceNum },
        ]),
    ).values(),
  );
  const gammaResults = await mapWithConcurrency(identities, 8, (id) =>
    resolveGammaTerminal(id.conditionId, id.selectedTokenId, id.entryPriceNum),
  );
  const gammaByIdentity = new Map<string, GammaTerminalState | null>();
  identities.forEach((id, i) =>
    gammaByIdentity.set(`${id.conditionId}::${id.selectedTokenId}`, gammaResults[i].terminal),
  );
  for (const p of pairs) {
    p.gammaTerminal = gammaByIdentity.get(`${p.conditionId}::${p.selectedTokenId}`) ?? null;
  }

  const slice: CompactCorpusSlice = {
    sliceDateUtc: d,
    sinceCutoff: startUtc,
    materializedAt: new Date().toISOString(),
    signalPairs: pairs.map((p) => {
      const { _createdAt, _id, _cloneSignalResultRaw, ...clean } = p as typeof p & {
        _createdAt: string;
        _id: string;
        _cloneSignalResultRaw: string | null;
      };
      return clean as ForwardRichSignalPair;
    }),
    observations,
  };
  const corpus = buildCompactCorpus(slice);

  let pitFutureLeakN = 0;
  for (const r of corpus.rows) {
    for (const s of [r.score, r.selectedPrice]) {
      if (s.lastEligibleObservedAt !== null && s.lastEligibleObservedAt > r.decisionAt) pitFutureLeakN++;
    }
  }

  const rows: ScorecardReadyRow[] = corpus.rows.map((r) => ({
    ...(r as unknown as Record<string, unknown>),
    sportFamily: normalizeMaterializedSportFamily(r as { providerSportFamily?: unknown }),
    frozenLabel: r.label,
    labelAsOf: r.label,
  })) as unknown as ScorecardReadyRow[];

  const counts: DayMaterializationCounts = {
    date: d,
    sourceEvidenceIdentityN: identities.length,
    modelReadyRowN: rows.length,
    terminalRowN: rows.filter((r) => r.labelAsOf === "WIN" || r.labelAsOf === "LOSS").length,
    openRowN: rows.filter((r) => r.labelAsOf === "OPEN").length,
    noMatchN: rows.filter((r) => r.labelAsOf === "NO_MATCH").length,
    ambiguousN: rows.filter((r) => (r.labelAsOf as string) === "AMBIGUOUS").length,
    voidN: rows.filter((r) => (r.labelAsOf as string) === "VOID").length,
    pitFutureLeakN,
  };
  return { rows, counts };
}

/**
 * PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 — authoritative emptiness proof.
 *
 * A zero-row day has two completely different meanings and they must never
 * collapse into one status. Either the authoritative source genuinely published
 * nothing that day (SOURCE_EMPTY — a real, accepted fact), or the source was
 * missing, stale or unreachable (SOURCE_UNVERIFIED — not a fact about the day
 * at all). Only the first may be written.
 */
export type DaySourceProof =
  | { kind: "SOURCE_PROVEN"; sourceEnvelopeN: number; sourceEvidenceRowN: number }
  | { kind: "SOURCE_UNVERIFIED" };

/** Error-code prefix for the unproven-zero-day refusal — the one survivable per-date failure. */
export const UNPROVEN_ZERO_DAY_CODE = "MATERIALIZE_SOURCE_UNVERIFIED_REFUSING_ZERO_DAY";

/** Day statuses the automatic cron treats as settled and will not revisit. */
export const ACCEPTED_DAY_STATUSES = ["MODEL_READY", "DEGRADED_EXCLUDED", "SOURCE_EMPTY"] as const;

/**
 * Writes materialized rows + the day marker. No economics side effects.
 *
 * Refuses to record a zero-row day as complete unless `proof` shows the
 * authoritative source was actually read and actually held nothing. Before this
 * guard a broken source silently produced `MODEL_READY, row_n = 0`, which
 * `resolveMissingRecentDates` then treated as accepted — permanently converting
 * a recoverable gap into falsified history that no automatic run would revisit.
 */
export async function writeDayRows(
  db: SupabaseClient,
  d: string,
  rows: ScorecardReadyRow[],
  proof: DaySourceProof = { kind: "SOURCE_UNVERIFIED" },
): Promise<void> {
  if (rows.length === 0) {
    if (proof.kind !== "SOURCE_PROVEN") {
      throw new Error(
        `${UNPROVEN_ZERO_DAY_CODE}:${d}: a zero-row day is only acceptable with an authoritative emptiness proof; refusing to record a missing/stale source as complete`,
      );
    }
    if (proof.sourceEnvelopeN !== 0 || proof.sourceEvidenceRowN !== 0) {
      throw new Error(
        `MATERIALIZE_SOURCE_NONEMPTY_BUT_ZERO_ROWS:${d}: source held ${proof.sourceEnvelopeN} envelopes / ${proof.sourceEvidenceRowN} evidence rows but materialization produced none`,
      );
    }
    const { error: emptyError } = await db.from("research_model_ready_days").upsert({
      model_date: d,
      status: "SOURCE_EMPTY",
      row_n: 0,
      canonical_content_sha256: null,
      source_kind: "RESEARCH_CLONE",
      completed_at: new Date().toISOString(),
    });
    if (emptyError) throw new Error(`MATERIALIZE_DAY_WRITE:${emptyError.code ?? emptyError.message}`);
    return;
  }
  return writeNonEmptyDayRows(db, d, rows);
}

async function writeNonEmptyDayRows(db: SupabaseClient, d: string, rows: ScorecardReadyRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_PAGE) {
    const payload = rows.slice(i, i + WRITE_PAGE).map((r) => toStoredModelRow(d, r));
    const { error } = await db
      .from("research_model_ready_rows")
      .upsert(payload, { onConflict: "model_date,population_id,condition_id,selected_token_id,decision_at" });
    if (error) throw new Error(`MATERIALIZE_ROW_WRITE:${error.code ?? error.message}`);
  }
  const { error: dayError } = await db.from("research_model_ready_days").upsert({
    model_date: d,
    status: "MODEL_READY",
    row_n: rows.length,
    canonical_content_sha256: null,
    source_kind: "RESEARCH_CLONE",
    completed_at: new Date().toISOString(),
  });
  if (dayError) throw new Error(`MATERIALIZE_DAY_WRITE:${dayError.code ?? dayError.message}`);
}

async function main() {
  const explicitDates = arg("--dates")?.split(",").filter(Boolean).sort();
  const start = arg("--start");
  const end = arg("--end");

  const { client: db, url } = resolveCloneClient();
  const sourceProject = projectRef(url);

  // No explicit range: the unattended/cron entry point — bounded
  // "missing/recent" default. An explicit --start/--end/--dates call (the
  // independently-callable path, e.g. a one-off activation for a named
  // historical range) always wins and is never narrowed by this default.
  const dates = explicitDates ?? (start && end ? datesInRange(start, end) : await resolveMissingRecentDates(db));

  const report: DayMaterializationCounts[] = [];
  // A day whose emptiness this path cannot prove. It is deliberately NOT written
  // and NOT accepted, so resolveMissingRecentDates keeps offering it on the next
  // run — the gap stays recoverable instead of being falsified as complete.
  const unprovenZeroDays: string[] = [];
  for (const d of dates) {
    const { rows, counts } = await materializeDayRows(db, d);
    try {
      // No authoritative emptiness proof exists on this path yet: the clone-side
      // narrow export that can supply one lands with the runtime mission. Until
      // then a zero-row day is refused rather than recorded as complete.
      await writeDayRows(db, d, rows, { kind: "SOURCE_UNVERIFIED" });
    } catch (error) {
      // ONLY the unproven-zero-day refusal is survivable, and only for this one
      // date: skipping it leaves the day unrecorded and retryable, which is
      // strictly safer than aborting every remaining date in the run. Every
      // other error — a genuine write failure, a non-empty source that produced
      // no rows — still fails the whole run.
      if (!(error instanceof Error) || !error.message.startsWith(UNPROVEN_ZERO_DAY_CODE)) throw error;
      unprovenZeroDays.push(d);
      continue;
    }
    report.push(counts);
  }

  console.log(
    JSON.stringify(
      {
        STATUS: unprovenZeroDays.length === 0 ? "SUCCESS" : "SUCCESS_WITH_UNPROVEN_ZERO_DAYS",
        MATERIALIZATION_PATH: "DIRECT_MODEL_READY_RESEARCH_PATH_V1",
        SOURCE_PROJECT: sourceProject,
        SOURCE_KIND: "RESEARCH_CLONE",
        DATE_COVERAGE: { start: dates[0], end: dates.at(-1) },
        REPORT: report,
        UNPROVEN_ZERO_DAYS: unprovenZeroDays,
        RESEARCH_MODEL_ECONOMICS_WRITE_N: 0,
        PRODUCTION_MUTATION_N: 0,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
