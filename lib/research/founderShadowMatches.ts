import type { SupabaseClient } from "@supabase/supabase-js";

// Read-only, bounded server-side aggregate over the existing SAFE physical-event ledger.
// Never returns the ledger wholesale: per-day/per-model aggregates plus per-event rows for the newest days only.
export const SAFE_MODEL_IDS = ["P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE", "TENNIS_P50_52_SAFE"] as const;
export const SHADOW_TABLE = "prospective_selection_shadow_runtime";
const PROJECTION = "model_id,decision_date,physical_event_key,sport_family,event_start,entry_price,selected_token_id,settlement_state,result,settlement_checked_at,first_persisted_at";
const PAGE = 1000, ROW_CAP = 4000, MAX_DAYS = 14, EVENT_DAYS = 2;
const HOUR = 3_600_000;

export type ShadowRow = {
  model_id: string; decision_date: string; physical_event_key: string | null; sport_family: string | null; event_start: string | null;
  entry_price: number | string | null; selected_token_id: string | null; settlement_state: string | null; result: string | null;
  settlement_checked_at: string | null; first_persisted_at: string | null;
};
type Outcome = "WIN" | "LOSS" | "UNRESOLVED";
type Tally = { exposures: number; unique_event_keys: number; win: number; loss: number; unresolved: number; gross_pnl_u: number | null; settled_roi: number | null };

export function outcomeOf(row: Pick<ShadowRow, "result" | "settlement_state">): Outcome {
  const v = row.result ?? row.settlement_state;
  return v === "WIN" || v === "LOSS" ? v : "UNRESOLVED";
}
// Gross 1u paper P&L at the persisted entry price: WIN (1-p)/p, LOSS -1. Null when the price is not a valid probability.
export function grossPnlU(price: number | string | null, outcome: Outcome): number | null {
  if (outcome === "UNRESOLVED") return null;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return outcome === "WIN" ? (1 - p) / p : -1;
}
function tally(rows: ShadowRow[]): Tally {
  let win = 0, loss = 0, unresolved = 0, pnl = 0, priced = 0, settledPriced = 0;
  for (const r of rows) {
    const o = outcomeOf(r);
    if (o === "WIN") win++; else if (o === "LOSS") loss++; else unresolved++;
    const g = grossPnlU(r.entry_price, o);
    if (g !== null) { pnl += g; priced++; }
    if (o !== "UNRESOLVED") settledPriced++;
  }
  // P&L/ROI are claimed only if every settled exposure has a valid persisted price.
  const complete = priced === settledPriced && settledPriced > 0;
  return { exposures: rows.length, unique_event_keys: new Set(rows.map(r => r.physical_event_key).filter(Boolean)).size,
    win, loss, unresolved, gross_pnl_u: complete ? pnl : null, settled_roi: complete ? pnl / settledPriced : null };
}
const group = <T,>(items: T[], key: (t: T) => string) => { const m = new Map<string, T[]>(); for (const i of items) { const k = key(i); (m.get(k) ?? m.set(k, []).get(k)!).push(i); } return m; };

export function aggregateShadowMatches(rows: ShadowRow[]) {
  const byDate = group(rows, r => r.decision_date);
  const dates = [...byDate.keys()].sort().reverse();
  const days = dates.map(date => {
    const dayRows = byDate.get(date)!;
    const keyed = dayRows.filter(r => r.physical_event_key);
    const perKeyModels = new Map<string, Set<string>>();
    for (const r of keyed) (perKeyModels.get(r.physical_event_key!) ?? perKeyModels.set(r.physical_event_key!, new Set()).get(r.physical_event_key!)!).add(r.model_id);
    const overlap: Record<string, number> = {};
    for (const s of perKeyModels.values()) overlap[String(s.size)] = (overlap[String(s.size)] ?? 0) + 1;
    const byModel = group(dayRows, r => r.model_id);
    return { decision_date: date, model_exposures: dayRows.length, unique_event_keys: perKeyModels.size,
      keys_shared_across_models: [...perKeyModels.values()].filter(s => s.size > 1).length,
      rows_without_event_key: dayRows.length - keyed.length, overlap_by_model_count: overlap,
      overall: tally(dayRows),
      models: SAFE_MODEL_IDS.map(model_id => ({ model_id, ...tally(byModel.get(model_id) ?? []) })),
      unexpected_model_ids: [...byModel.keys()].filter(m => !(SAFE_MODEL_IDS as readonly string[]).includes(m)) };
  });
  const events = dates.slice(0, EVENT_DAYS).flatMap(date => {
    const dayRows = byDate.get(date)!.filter(r => r.physical_event_key);
    return [...group(dayRows, r => r.physical_event_key!).entries()].map(([key, rs]) => ({
      decision_date: date, physical_event_key: key, sport: rs[0].sport_family, event_start: rs[0].event_start,
      model_count: new Set(rs.map(r => r.model_id)).size,
      selections: rs.map(r => { const o = outcomeOf(r); return { model_id: r.model_id, selected_token: r.selected_token_id ? r.selected_token_id.slice(-8) : null,
        entry_price: Number.isFinite(Number(r.entry_price)) ? Number(r.entry_price) : null, result: o, gross_pnl_u: grossPnlU(r.entry_price, o) }; }),
    })).sort((a, b) => b.model_count - a.model_count || a.physical_event_key.localeCompare(b.physical_event_key));
  });
  const checks = rows.map(r => r.settlement_checked_at).filter((v): v is string => !!v).sort();
  return { days, events, overall: tally(rows),
    last_settlement_check: checks.at(-1) ?? null,
    rows_first_persistence_unknown: rows.filter(r => !r.first_persisted_at).length };
}

export function minskDate(now: number) { return new Date(now + 3 * HOUR).toISOString().slice(0, 10); }

export async function readFounderShadowMatches(db: SupabaseClient, params: URLSearchParams, now = Date.now()) {
  const requested = Number(params.get("days") ?? "7");
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DAYS) throw Error("INVALID_RANGE");
  const readAt = new Date(now).toISOString();
  const latest = await db.from(SHADOW_TABLE).select("decision_date").eq("row_kind", "LEDGER").order("decision_date", { ascending: false }).limit(1);
  if (latest.error) throw Error("RESEARCH_READ_UNAVAILABLE");
  if (!latest.data?.length) throw Error("NO_SHADOW_ROWS");
  const latestDate = String(latest.data[0].decision_date);
  const from = new Date(Date.parse(`${latestDate}T00:00:00Z`) - (requested - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows: ShadowRow[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await db.from(SHADOW_TABLE).select(PROJECTION).eq("row_kind", "LEDGER").gte("decision_date", from).lte("decision_date", latestDate)
      .order("decision_date").order("row_key").range(start, start + PAGE - 1);
    if (page.error) throw Error("RESEARCH_READ_UNAVAILABLE");
    rows.push(...(page.data ?? []) as unknown as ShadowRow[]);
    if ((page.data?.length ?? 0) < PAGE) break;
    if (rows.length >= ROW_CAP) throw Error("SHADOW_WINDOW_TOO_LARGE");
  }
  const snap = await db.from(SHADOW_TABLE).select("updated_at,snapshot_payload->lastSuccessfulRefresh").eq("row_key", "CURRENT").eq("row_kind", "SNAPSHOT").limit(1);
  if (snap.error) throw Error("RESEARCH_READ_UNAVAILABLE");
  const snapRow = snap.data?.[0] as unknown as { updated_at?: string; lastSuccessfulRefresh?: string } | undefined;
  const refreshedAt = snapRow?.lastSuccessfulRefresh ?? snapRow?.updated_at ?? null;
  const ageMs = refreshedAt && Number.isFinite(Date.parse(refreshedAt)) ? now - Date.parse(refreshedAt) : null;
  const agg = aggregateShadowMatches(rows);
  const today = minskDate(now);
  return { read_at: readAt, window_days: requested, window_from: from, window_to: latestDate, latest_decision_date: latestDate,
    minsk_today: today, behind_today: latestDate < today,
    freshness: ageMs === null || ageMs > 2 * HOUR || latestDate < today ? "STALE" : "CURRENT",
    snapshot_refreshed_at: refreshedAt, snapshot_age_seconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
    model_ids: SAFE_MODEL_IDS, ...agg,
    provenance: "DBClone nppznoujvnyjargjkmnv prospective_selection_shadow_runtime LEDGER rows; SAFE shadow selections, not Production LIVE, not A/B/C paper.",
    identity_caveat: "physical_event_key is the ledger's persisted event grouping key, not a verified provider-root identity." };
}
