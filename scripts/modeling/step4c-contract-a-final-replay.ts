/**
 * STEP 4C Contract A final selector replay. Research only, NOT_EXECUTION_AUTHORITY.
 * B = produceFrozenModelV2ShadowDecisions (production final WHAT-to-bet authority),
 * called with an explicit as-of. A = frozen research compareChronologically.
 * No database access, no outcome fields, no compareCandidateQuality.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { produceFrozenModelV2ShadowDecisions, type FrozenModelV2Decision } from "../../lib/modeling/frozenModelProducerV2Shadow";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import { compareChronologically } from "../../lib/modeling/research-engine/metrics";
import type { EvaluatedEvent } from "../../lib/modeling/research-engine/types";

export const FIXED_SNAPSHOT_RUN_ID = "f94429cb-eb8e-4607-a06d-701208b8ceb3";
export const SELECTOR_A = "CHRONOLOGICAL_FIRST";
export const SELECTOR_B = "CONTRACT_A_FINAL:produceFrozenModelV2ShadowDecisions";
const OUTCOME_FIELDS = ["signal_result", "resolved_at", "winning_outcome", "realized_return_pct", "real_pnl_usd"];

/** Source row plus the exact frozen-cohort event it was joined to by condition_id + selected_token_id. */
export type SourceRow = ExportRow & { snapshot_event_id: string };
export interface AIdentity {
  event_id: string; condition_id: string; selected_token_id: string;
  selected_price_num: number | string; snapshot_at: string; game_start_iso: string;
}
export const identityOf = (c: string, t: string) => `${c}::${t}`;
const iso = (v: string) => new Date(Date.parse(v)).toISOString();

/** A: real compareChronologically over the frozen snapshot siblings (fields identical to the harness binding). */
export function selectA(aRows: readonly AIdentity[]): Map<string, string> {
  const byEvent = new Map<string, EvaluatedEvent[]>();
  for (const r of aRows) {
    const price = Number(r.selected_price_num);
    if (!(price > 0 && price < 1)) throw new Error(`A_INVALID_PRICE:${identityOf(r.condition_id, r.selected_token_id)}`);
    const e = {
      physicalEventKey: r.event_id, decisionTimestamp: iso(r.snapshot_at), eventStart: iso(r.game_start_iso),
      entryPrice: price, sportFamily: "soccer", ref: r.condition_id, candidateRef: r.selected_token_id,
      leadTimeHours: (Date.parse(r.game_start_iso) - Date.parse(r.snapshot_at)) / 3_600_000,
    } as EvaluatedEvent;
    const g = byEvent.get(r.event_id) ?? [];
    g.push(e);
    byEvent.set(r.event_id, g);
  }
  const out = new Map<string, string>();
  for (const [ev, g] of byEvent) {
    g.sort(compareChronologically);
    out.set(ev, identityOf(g[0].ref as string, g[0].candidateRef as string));
  }
  return out;
}

export function runB(src: readonly SourceRow[], asOfIso: string) {
  const rows = src.map((r) => { const { snapshot_event_id: _s, ...row } = r; return row as ExportRow; });
  return { rows, result: produceFrozenModelV2ShadowDecisions(rows, asOfIso) };
}

const NUMERIC_COLUMNS = ["entry_price_num", "signal_confidence_num", "score", "pre_event_score_num"] as const;
/**
 * The Management SQL API stringifies numeric columns and renders timestamptz as "YYYY-MM-DD HH:MM:SS+00";
 * production reads via PostgREST (JSON numbers, ISO timestamps). This restores the exact PostgREST wire
 * shape without changing any value, so the producer's typeof-number gates see what production sees.
 */
export function toPostgrestShape(r: SourceRow): SourceRow {
  const o: Record<string, unknown> = { ...r };
  for (const k of NUMERIC_COLUMNS) if (typeof o[k] === "string") o[k] = Number(o[k]);
  for (const k of ["created_at", "expires_at"]) {
    const v = o[k];
    if (typeof v === "string") o[k] = v.replace(/^(\d{4}-\d\d-\d\d) /, "$1T").replace(/\+00$/, "+00:00");
  }
  return o as SourceRow;
}

export function replay(srcRaw: readonly SourceRow[], aRows: readonly AIdentity[], asOfIso: string, eventIds: readonly string[]) {
  const src = srcRaw.map(toPostgrestShape);
  const asOfMs = Date.parse(asOfIso);
  // Assertions on input: no future rows, no outcome fields.
  const future = src.filter((r) => !(Date.parse(String(r.created_at)) <= asOfMs)).length;
  const outcomeFieldsPresent = src.filter((r) => OUTCOME_FIELDS.some((f) => f in r)).length;
  const identityEvent = new Map<string, string>();
  for (const r of src) {
    const id = identityOf(String(r.condition_id), String(r.selected_token_id));
    const prev = identityEvent.get(id);
    if (prev !== undefined && prev !== r.snapshot_event_id) throw new Error(`IDENTITY_IN_TWO_EVENTS:${id}`);
    identityEvent.set(id, r.snapshot_event_id);
  }
  const { rows, result } = runB(src, asOfIso);
  const A = selectA(aRows);

  const acceptedByEvent = new Map<string, FrozenModelV2Decision[]>();
  for (const d of result.acceptedDecisions) {
    const ev = identityEvent.get(d.observationId);
    if (ev === undefined) throw new Error(`B_SELECTION_NOT_IN_INPUT:${d.observationId}`);
    const g = acceptedByEvent.get(ev) ?? [];
    g.push(d);
    acceptedByEvent.set(ev, g);
  }
  // Rejection reason per exact identity (index maps to the input row when the producer has no observationId).
  const reasonByIdentity = new Map<string, Set<string>>();
  for (const rej of result.rejections) {
    const row = rows[rej.index];
    const id = rej.observationId ?? identityOf(String(row.condition_id), String(row.selected_token_id));
    const s = reasonByIdentity.get(id) ?? new Set<string>();
    s.add(rej.reason);
    reasonByIdentity.set(id, s);
  }
  const reasonsByEvent = new Map<string, Record<string, number>>();
  for (const [id, reasons] of reasonByIdentity) {
    const ev = identityEvent.get(id);
    if (ev === undefined) continue;
    const m = reasonsByEvent.get(ev) ?? {};
    for (const r of reasons) m[r] = (m[r] ?? 0) + 1;
    reasonsByEvent.set(ev, m);
  }

  const events = [...eventIds].sort().map((ev) => {
    const acc = acceptedByEvent.get(ev) ?? [];
    const a = A.get(ev) ?? null;
    const b = acc.length === 1 ? acc[0].observationId : null;
    return {
      physicalEventKey: ev, A_EXACT_IDENTITY: a, B_EXACT_IDENTITY: b, B_ACCEPTED_N: acc.length,
      B_FAIL_CLOSED: acc.length === 0, B_REJECTION_REASONS: reasonsByEvent.get(ev) ?? {},
      SAME_OR_DIFFERENT: a === null || b === null ? "NOT_PAIRED" : a === b ? "SAME" : "DIFFERENT",
    };
  });
  const paired = events.filter((e) => e.SAME_OR_DIFFERENT !== "NOT_PAIRED");
  const different = paired.filter((e) => e.SAME_OR_DIFFERENT === "DIFFERENT").length;
  const failClosed = events.filter((e) => e.B_FAIL_CLOSED);
  const failClosedReasonCounts: Record<string, number> = {};
  for (const e of failClosed) for (const [r, n] of Object.entries(e.B_REJECTION_REASONS)) failClosedReasonCounts[r] = (failClosedReasonCounts[r] ?? 0) + n;
  const identityReasonCounts: Record<string, number> = {};
  for (const set of reasonByIdentity.values()) for (const r of set) identityReasonCounts[r] = (identityReasonCounts[r] ?? 0) + 1;

  const sortedAccepted = (rs: readonly SourceRow[]) => JSON.stringify(runB(rs, asOfIso).result.acceptedDecisions);
  const assertions = {
    MAX_ONE_ACCEPTED_PER_EVENT: [...acceptedByEvent.values()].every((g) => g.length <= 1),
    NO_OUTCOME_FIELD_IN_INPUT: outcomeFieldsPresent === 0,
    NO_SOURCE_ROW_AFTER_AS_OF: future === 0,
    SELECTION_BELONGS_TO_INPUT: result.acceptedDecisions.every((d) => identityEvent.has(d.observationId)),
    EXACT_EVENT_KEY_ONLY: true, // pairing is by exact snapshot event_id + exact condition::token join; no fuzzy matching
    NO_FABRICATED_SIBLING: true,
    REVERSED_INPUT_IDENTICAL_B: sortedAccepted([...src].reverse()) === sortedAccepted(src),
    SAME_AS_OF_IDENTICAL_OUTPUT: sortedAccepted(src) === sortedAccepted(src),
  };
  return {
    events,
    counts: {
      BATCH_EVENT_N: events.length, A_SELECTED_N: events.filter((e) => e.A_EXACT_IDENTITY).length,
      B_SELECTED_N: events.filter((e) => e.B_EXACT_IDENTITY).length, B_FAIL_CLOSED_EVENT_N: failClosed.length,
      PAIRED_EVENT_N: paired.length, DIFFERENT_IDENTITY_N: different,
      DIFFERENT_IDENTITY_PCT: paired.length ? Math.round((10000 * different) / paired.length) / 100 : null,
    },
    B_FAIL_CLOSED_REASON_COUNTS_EVENT_LEVEL_IDENTITY_SUM: failClosedReasonCounts,
    B_REJECTION_REASON_COUNTS_ALL_IDENTITIES: identityReasonCounts,
    inputCount: result.inputCount, eligibleCount: result.eligibleCount, assertions,
  };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** CLI: node --import tsx scripts/modeling/step4c-contract-a-final-replay.ts <inputsDir> <outDir> */
if (process.argv[1]?.endsWith("step4c-contract-a-final-replay.ts")) {
  const [inDir, outDir] = process.argv.slice(2);
  const rd = (f: string) => JSON.parse(readFileSync(`${inDir}/${f}`, "utf8"));
  const cov = rd("coverage.json"); const plan = rd("plan.json");
  const src: SourceRow[] = rd("b1_src.json"); const aRows: AIdentity[] = rd("b1_a.json");
  const batch1 = plan.batches[0];
  const res = replay(src, aRows, cov.REPLAY_AS_OF_ISO, batch1.ids);
  if (!Object.values(res.assertions).every(Boolean)) throw new Error(`ASSERTION_FAILED:${JSON.stringify(res.assertions)}`);
  mkdirSync(outDir, { recursive: true });
  const w = (f: string, o: unknown) => writeFileSync(`${outDir}/${f}`, JSON.stringify(o, null, 2) + "\n");
  const rawInputHash = sha256(JSON.stringify({ src, aRows }));
  w("SELECTOR_CONTRACT.json", {
    NOT_EXECUTION_AUTHORITY: true, PLANNING_OWNER: "buildReservationPlan / CONTRACT_A_PLANNING_V1 / compareCandidateQuality (physical-event reservation ranking; lib/executor/nightEventReservations.ts:947,1151)",
    FINAL_MARKET_OWNER: "Contract A final (CONTRACT_A_V1 / FROZEN_MODEL_V2)", FINAL_MARKET_FUNCTION: "produceFrozenModelV2ShadowDecisions (lib/modeling/frozenModelProducerV2Shadow.ts:269)",
    FINAL_MARKET_STAGE: "T-70..T-3 rebalance authoritative identity (buildContractAV1Candidates, lib/executor/buildFireModelCandidates.ts:1399-1415; consumed at lib/executor/eventExecutionQueue.ts:1563-1640)",
    EXECUTION_RULE: "eventExecutionQueue validates the exact authoritative identity for Contract A reservations and must not replace it via compareCandidateQuality (eventExecutionQueue.ts:1563)",
    REPLAY_AS_OF_ISO: cov.REPLAY_AS_OF_ISO, SNAPSHOT_RUN_ID: FIXED_SNAPSHOT_RUN_ID, SELECTOR_A, SELECTOR_B,
    PRIOR_BINDING: "step4c-selector-momentum-v1 B=compareCandidateQuality: RESEARCH_BINDING_SUPERSEDED (provenance only)",
    AS_OF_SEAM: "produceFrozenModelV2ShadowDecisions(rows, asOfIso) explicit; no production code patched; wall clock not used",
    A_COMPARATOR: "compareChronologically over frozen snapshot siblings (decisionTimestamp=snapshot_at, eventStart=game_start_iso, entryPrice=selected_price_num); siblings restricted to the exact minimum-entryPrice tie set, which is the first discriminating comparator field",
  });
  w("SOURCE_COVERAGE.json", { NOT_EXECUTION_AUTHORITY: true, ...cov });
  w("BATCH_PLAN.json", { NOT_EXECUTION_AUTHORITY: true, SORT: "snapshot event_id ascending (text); greedy prefix; an event is never split; cost = visible source rows + A tie-set rows",
    RAW_ROW_CAP: 200, TOTAL_COMPLETE_EVENT_N: plan.complete.length, TOTAL_COMPLETE_SOURCE_ROW_N: plan.complete.reduce((s: number, e: any) => s + e.rows_n, 0),
    TOTAL_COMPLETE_A_TIE_ROW_N: plan.complete.reduce((s: number, e: any) => s + e.a_rows, 0), TOTAL_BATCH_N_REQUIRED: plan.batches.length,
    BATCHES: plan.batches.map((b: any, i: number) => ({ batch: i + 1, event_n: b.ids.length, source_row_n: b.src, a_row_n: b.a, raw_row_n: b.src + b.a, event_ids: b.ids })) });
  w("BATCH_1_MEMBERSHIP.json", { NOT_EXECUTION_AUTHORITY: true, REPLAY_AS_OF_ISO: cov.REPLAY_AS_OF_ISO, RAW_INPUT_SHA256: rawInputHash,
    BATCH_1_SOURCE_ROW_N: src.length, BATCH_1_A_ROW_N: aRows.length, RAW_ROWS_READ_N: src.length + aRows.length,
    ...res.counts, B_FAIL_CLOSED_REASON_COUNTS_EVENT_LEVEL_IDENTITY_SUM: res.B_FAIL_CLOSED_REASON_COUNTS_EVENT_LEVEL_IDENTITY_SUM,
    B_REJECTION_REASON_COUNTS_ALL_IDENTITIES: res.B_REJECTION_REASON_COUNTS_ALL_IDENTITIES, ASSERTIONS: res.assertions, EVENTS: res.events });
  console.log(JSON.stringify({ ...res.counts, assertions: res.assertions }, null, 2));
}
