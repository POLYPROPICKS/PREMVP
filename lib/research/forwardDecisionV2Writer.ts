/**
 * Research-only persistence adapter for FORWARD_DECISION_V2 (Research DBClone nppznoujvnyjargjkmnv only; the caller must already hold a
 * clone-guarded client). It performs no model logic and no timing logic: the database trigger is the authority for first_persisted_at,
 * timing class, lags and T-90 lead. The adapter only (1) reads the DB clock, (2) reads prior claims, (3) inserts one reviewed row per
 * decision, (4) reads the rows back independently. It never updates, upserts or deletes.
 */
import { FORWARD_DECISION_V2, isIdempotentConflict, type PriorClaims, type V2BetRow, type V2SkipRow, type SkipEvidence } from "./forwardDecisionV2";
import type { ModelEvaluation, ModelEventDecision } from "./forwardModelDecisionsT90";
import { tokenKey } from "./forwardModelDecisionsT90";
import { createHash } from "node:crypto";
import { fetchPolymarketEventStartsByIds, GAMMA_EVENTS_BATCH_LIMIT } from "../feed/polymarketClient";

/** Exact-ID receipts only. Missing, duplicate, foreign and rootless events remain unresolved. */
export async function acquireIdentityWitnesses(ids: readonly string[]) {
  const requested = [...new Set(ids)].sort();
  if (!requested.every((id) => /^\d+$/.test(id))) throw new Error("IDENTITY_EVENT_ID_INVALID");
  const witnesses: Array<Record<string, unknown>> = [];
  const batches: Array<Record<string, unknown>> = [];
  const unresolved: string[] = [];
  const contradictions: string[] = [];
  for (let offset = 0; offset < requested.length; offset += GAMMA_EVENTS_BATCH_LIMIT) {
    const batch = requested.slice(offset, offset + GAMMA_EVENTS_BATCH_LIMIT);
    const result = await fetchPolymarketEventStartsByIds(batch);
    if (!result) { unresolved.push(...batch); continue; }
    const digest = createHash("sha256").update(JSON.stringify({ batch, result })).digest("hex");
    batches.push({ batch, result, digest });
    if (result.events.some((e) => !batch.includes(e.id))) { contradictions.push(...batch); continue; }
    for (const id of batch) {
      const rows = result.events.filter((e) => e.id === id);
      if (rows.length > 1) { contradictions.push(id); continue; }
      const row = rows[0];
      if (!row?.gameId || !/^\d+$/.test(row.gameId)) { unresolved.push(id); continue; }
      witnesses.push({ provider_event_id: id, provider_root_game_id: row.gameId, identity_source: "POLYMARKET_GAMMA_EXACT_ID",
        acquired_at: new Date(result.acquiredAtMs).toISOString(), receipt_digest: digest, evidence: row });
    }
  }
  return { identity_source: "POLYMARKET_GAMMA_EXACT_ID", requested_n: requested.length, witnessed_n: witnesses.length,
    unresolved, contradictions, witnesses, batches, digest: createHash("sha256").update(JSON.stringify(witnesses)).digest("hex") };
}

export async function persistIdentityWitnesses(client: WriterClient, witnesses: readonly Record<string, unknown>[]) {
  for (const witness of witnesses) {
    const { error } = await client.from("forward_decision_v2_identity_witness").insert(witness);
    if (error && error.code !== "23505") throw new Error(`IDENTITY_WITNESS_INSERT:${error.code ?? "FAILED"}`);
  }
}

/** The subset of the Supabase client used here (kept structural so tests can inject a recording double). */
export type WriterClient = {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args?: Record<string, string>): PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;
};

/** Floor of the DB clock in epoch ms (never rounds up past the instant the trigger will later observe). */
export async function dbClockMs(client: WriterClient): Promise<number> {
  const { data, error } = await client.rpc(FORWARD_DECISION_V2.clockRpc);
  if (error || typeof data !== "string") throw new Error(`FORWARD_V2_CLOCK_UNAVAILABLE:${error?.code ?? error?.message ?? "NO_DATA"}`);
  const truncated = data.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(truncated);
  if (!Number.isFinite(ms)) throw new Error("FORWARD_V2_CLOCK_UNPARSEABLE");
  return ms;
}

export type LedgerCounts = { legacy_n: number | null; v1_n: number | null; v2_bet_n: number | null; skip_n: number | null };

export async function ledgerCounts(client: WriterClient): Promise<LedgerCounts> {
  const head = (q: any) => q.then((r: { count: number | null }) => r.count ?? null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = FORWARD_DECISION_V2.ledgerTable;
  const base = () => client.from(t).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER");
  const [legacy_n, v1_n, v2_bet_n, skip_n] = await Promise.all([
    head(base().is("contract_version", null)), head(base().eq("contract_version", "FORWARD_BET_V1")),
    head(base().eq("contract_version", FORWARD_DECISION_V2.version)),
    head(client.from(FORWARD_DECISION_V2.skipTable).select("row_key", { count: "exact", head: true })),
  ]);
  return { legacy_n, v1_n, v2_bet_n, skip_n };
}

/** BET claims held by ANY legacy / V1 / V2 ledger row, and the V2 SKIPs already persisted, for the given (model, event) keys. */
export async function readPriorClaims(client: WriterClient, keysByModel: ReadonlyMap<string, ReadonlySet<string>>): Promise<PriorClaims> {
  const betClaims = new Map<string, Set<string>>();
  const skips = new Set<string>();
  for (const [modelId, keys] of keysByModel) {
    const list = [...keys];
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      const claims = await client.from(FORWARD_DECISION_V2.ledgerTable).select("physical_event_key").eq("row_kind", "LEDGER").eq("model_id", modelId).in("physical_event_key", batch);
      if (claims.error) throw new Error(`FORWARD_V2_CLAIMS_READ:${claims.error.code ?? "FAILED"}`);
      const set = betClaims.get(modelId) ?? betClaims.set(modelId, new Set()).get(modelId)!;
      for (const r of (claims.data ?? []) as Array<{ physical_event_key: string }>) set.add(r.physical_event_key);
      const sk = await client.from(FORWARD_DECISION_V2.skipTable).select("model_version,physical_event_key").eq("model_id", modelId).in("physical_event_key", batch);
      if (sk.error) throw new Error(`FORWARD_V2_SKIPS_READ:${sk.error.code ?? "FAILED"}`);
      for (const r of (sk.data ?? []) as Array<{ model_version: string; physical_event_key: string }>) skips.add(`${modelId}|${r.model_version}|${r.physical_event_key}`);
    }
  }
  return { betClaims, skips };
}

export type PersistResult =
  | { status: "PERSISTED" }
  | { status: "IDEMPOTENT_CONFLICT"; code: string | null; message: string }
  | { status: "REJECTED"; code: string | null; message: string };

/** Insert-only. A unique violation means "already decided" (never overwritten); any trigger/CHECK rejection is reported verbatim. */
export async function persistRow(client: WriterClient, kind: "BET" | "SKIP", row: V2BetRow | V2SkipRow): Promise<PersistResult> {
  if (kind === "BET") {
    const { data, error } = await client.rpc("forward_decision_v2_admission", { p_model: String(row.model_id), p_root: String(row.provider_root_game_id) });
    if (error || data !== "ADMISSIBLE") return { status: data === "DUPLICATE_ECONOMIC_UNIT" ? "IDEMPOTENT_CONFLICT" : "REJECTED",
      code: error?.code ?? null, message: typeof data === "string" ? data : "ADMISSION_PREFLIGHT_UNAVAILABLE" };
  }
  const table = kind === "BET" ? FORWARD_DECISION_V2.ledgerTable : FORWARD_DECISION_V2.skipTable;
  const { error } = await client.from(table).insert(row);
  if (!error) return { status: "PERSISTED" };
  const message = (error.message ?? "").slice(0, 200);
  return isIdempotentConflict(error) ? { status: "IDEMPOTENT_CONFLICT", code: error.code ?? null, message } : { status: "REJECTED", code: error.code ?? null, message };
}

const BET_READBACK = "row_key,model_id,model_version,definition_digest,source_sha,physical_event_key,condition_id,selected_token_id,observed_at,source_ingested_at,decision_generated_at,first_persisted_at,scheduled_start_at,authoritative_start_at,t90_cutoff_at,minutes_to_start,t90_lead_seconds,timing_class,start_verification_state,verification_status,contract_status,virtual_shares,virtual_fill_vwap,virtual_gross_cost_usd,fee_state,net_state,source_observation_id,source_item_observation_id";
const SKIP_READBACK = "row_key,model_id,model_version,definition_digest,source_sha,physical_event_key,skip_reason,observed_at,source_ingested_at,decision_generated_at,first_persisted_at,scheduled_start_at,authoritative_start_at,t90_cutoff_at,minutes_to_start,t90_lead_seconds,timing_class,start_verification_state,fee_state,net_state";

export type ReadBackRow = Record<string, string | number | null>;
/** Independent read-back by row_key (never the insert response). */
export async function readBack(client: WriterClient, kind: "BET" | "SKIP", rowKeys: readonly string[]): Promise<ReadBackRow[]> {
  const out: ReadBackRow[] = [];
  const table = kind === "BET" ? FORWARD_DECISION_V2.ledgerTable : FORWARD_DECISION_V2.skipTable;
  for (let i = 0; i < rowKeys.length; i += 50) {
    const { data, error } = await client.from(table).select(kind === "BET" ? BET_READBACK : SKIP_READBACK).in("row_key", rowKeys.slice(i, i + 50));
    if (error) throw new Error(`FORWARD_V2_READBACK:${error.code ?? "FAILED"}`);
    out.push(...((data ?? []) as ReadBackRow[]));
  }
  return out;
}

/** Pure. Proof obligations on a read-back row: DB-owned instant ordering, positive T-90 lead, provisional-vs-verified start, no fees. */
export function readBackProof(row: ReadBackRow): { ok: boolean; failed: string[] } {
  const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
  const failed: string[] = [];
  if (!(ms(row.observed_at) <= ms(row.source_ingested_at))) failed.push("OBSERVED_LE_INGESTED");
  if (!(ms(row.source_ingested_at) <= ms(row.decision_generated_at))) failed.push("INGESTED_LE_GENERATED");
  if (!(ms(row.decision_generated_at) <= ms(row.first_persisted_at))) failed.push("GENERATED_LE_FIRST_PERSISTED");
  if (!(ms(row.first_persisted_at) < ms(row.t90_cutoff_at))) failed.push("FIRST_PERSISTED_BEFORE_T90");
  if (!(ms(row.t90_cutoff_at) <= ms(row.scheduled_start_at) - 90 * 60_000)) failed.push("CUTOFF_NOT_SCHEDULED_MINUS_90");
  if (!(typeof row.minutes_to_start === "number" && row.minutes_to_start > 0) && !(typeof row.minutes_to_start === "string" && Number(row.minutes_to_start) > 0)) failed.push("MINUTES_TO_START_POSITIVE");
  if (!(Number(row.t90_lead_seconds) > 0)) failed.push("T90_LEAD_POSITIVE");
  if (row.fee_state !== "NOT_EVALUATED" || row.net_state !== "NOT_EVALUATED") failed.push("FEES_NOT_NOT_EVALUATED");
  if (row.authoritative_start_at == null && row.start_verification_state !== "PROVISIONAL_SCHEDULED_ONLY") failed.push("SCHEDULE_ONLY_MUST_BE_PROVISIONAL");
  if (row.authoritative_start_at != null && row.start_verification_state !== "VERIFIED_ACTUAL_START") failed.push("AUTHORITATIVE_START_STATE");
  if ("virtual_shares" in row && Number(row.virtual_shares) !== FORWARD_DECISION_V2.virtualShares) failed.push("VIRTUAL_SHARES_NOT_5");
  return { ok: failed.length === 0, failed };
}

// ── SKIP evidence from the model's OWN evaluation ────────────────────────────────────────────────────────────────────

export type EventToken = { conditionId: string; tokenId: string; providerEventId: string };

/** Pure. The first (deterministic order) token of the event that the model itself evaluated for this SKIP reason, with its cited source row. */
export function skipEvidenceFor(
  decision: Pick<ModelEventDecision, "outcome" | "reason">,
  tokens: readonly EventToken[],
  evaluation: ModelEvaluation | undefined,
  sourceOf: (conditionId: string, tokenId: string) => SkipEvidence["source"] | null,
): SkipEvidence | null {
  if (decision.outcome !== "SKIP" || !evaluation || evaluation.status !== "EVALUATED") return null;
  const set = decision.reason === "MODEL_SELECTED_DAILY_CAP_SPENT" ? evaluation.capSpentTokenKeys
    : decision.reason === "MODEL_PREDICATE_EVALUATED_NOT_SELECTED" ? evaluation.predicateEvaluatedTokenKeys
      : decision.reason === "MODEL_GATE_EVALUATED_REJECTED" ? evaluation.gateRejectedTokenKeys : undefined;
  if (!set) return null;
  const evaluated = [...tokens].sort((a, b) => (tokenKey(a.conditionId, a.tokenId) < tokenKey(b.conditionId, b.tokenId) ? -1 : 1)).filter((t) => set.has(tokenKey(t.conditionId, t.tokenId)));
  for (const t of evaluated) {
    const source = sourceOf(t.conditionId, t.tokenId);
    if (source && t.providerEventId) {
      return { reason: decision.reason as SkipEvidence["reason"], physicalEventKey: t.providerEventId, source, evaluatedTokenKeys: evaluated.map((e) => tokenKey(e.conditionId, e.tokenId)) };
    }
  }
  return null;
}
