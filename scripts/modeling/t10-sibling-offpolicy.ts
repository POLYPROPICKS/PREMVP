/**
 * T10_SIBLING_OFFPOLICY_V1 — settled off-policy dataset + frozen C0/C1 evaluation over the EXACT T_MINUS_10 siblings.
 *
 * Source (READ ONLY): research clone `reservation_market_observations` (observation_phase = T_MINUS_10), explicit
 * columns, plus the frozen sport authority `research_evidence_page_rows.provider_sport_family` joined on
 * provider_event_id. Settlement: the EXISTING provider resolver (fetchGammaMarketByConditionId + resolveSignalOutcome),
 * one lookup per condition. Evaluation: the EXISTING frozen engine (lib/modeling/research-engine) — no new model, no
 * threshold, no new event identity. RAW and EXECUTABLE-at-T10 economics are reported separately.
 *
 *   npx tsx scripts/modeling/t10-sibling-offpolicy.ts --start=2026-09-30 --end=2026-10-05 [--materialize]
 *
 * Needs SUPABASE_CLONE_URL / SUPABASE_CLONE_SERVICE_ROLE_KEY (clone ref nppznoujvnyjargjkmnv only). `--materialize`
 * upserts the dataset into public.research_t10_sibling_offpolicy_rows (schema: ops/research-clone/
 * t10-sibling-offpolicy-schema.sql, applied through the registered clone-schema path) and is the ONLY write.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchGammaMarketByConditionId, type GammaMarket } from "../../lib/feed/resolveSignalOutcome";
import {
  OFFPOLICY_ALL_FROZEN_MODELS, T10_OFFPOLICY_VERSION, buildOffPolicyDataset, classifySiblingSettlement, evaluateView,
  summarizeCoverage, isSupportedSibling,
  type EvaluationView, type ModelEvaluation, type OffPolicyCoverage, type OffPolicyDatasetRow, type SiblingObservationRow, type SiblingSettlement,
} from "../../lib/modeling/t10-offpolicy/siblingOffPolicy";
import type { FrozenModelId } from "../../lib/modeling/research-engine";

export const OFFPOLICY_OUT_DIR = "modeling/evidence/t10-sibling-offpolicy-v1";
export const OFFPOLICY_TABLE = "research_t10_sibling_offpolicy_rows";
export const OBSERVATION_COLUMNS =
  "physical_event_id,provider_event_id,event_start_iso,observed_at,condition_id,token_id,side,canonical_market_family,canonical_market_type,provider_market_type_raw,best_bid,best_ask,tick_size,minimum_order_size,orderbook_fetch_status,ask_depth_relevant_usd,executable_telemetry_version,executable_full_stake,executable_full_stake_state,full_stake_executable_vwap,full_stake_shares,taker_fee_state,taker_fee_usd";
const VIEWS: readonly EvaluationView[] = ["RAW", "EXECUTABLE_UPPER_BOUND", "EXECUTABLE_PROVEN"];

/** Everything the pipeline reads from the research clone. Implemented over PostgREST below. */
export interface SiblingSourcePort {
  readSiblings(range: { startIso: string; endExclusiveIso: string }): Promise<SiblingObservationRow[]>;
}

export type OffPolicyReport = {
  version: typeof T10_OFFPOLICY_VERSION;
  generated_at: string;
  source_channel: string;
  range: { start: string; end: string };
  stake_usd: number;
  hard_cap: number;
  coverage: OffPolicyCoverage;
  settlement_lookups: { conditions_n: number; source_unavailable_conditions_n: number };
  evaluations: Record<EvaluationView, ModelEvaluation[]>;
  notes: string[];
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** One bounded lookup per condition (both tokens share the market); one retry; a hung call is SOURCE_UNAVAILABLE. */
export async function settleSiblings(
  rows: readonly SiblingObservationRow[],
  fetchMarket: (conditionId: string) => Promise<GammaMarket | null>,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<{ byKey: Map<string, SiblingSettlement>; conditions_n: number; source_unavailable_conditions_n: number }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const conditions = [...new Set(rows.filter(isSupportedSibling).map((r) => r.condition_id))];
  const withTimeout = (p: Promise<GammaMarket | null>) => new Promise<GammaMarket | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
  const markets = new Map<string, GammaMarket | null>();
  await mapPool(conditions, opts.concurrency ?? 8, async (conditionId) => {
    let market = await withTimeout(fetchMarket(conditionId));
    if (market === null) market = await withTimeout(fetchMarket(conditionId));
    markets.set(conditionId, market);
  });
  const byKey = new Map<string, SiblingSettlement>();
  for (const r of rows) {
    if (!isSupportedSibling(r)) continue;
    byKey.set(`${r.condition_id}|${r.token_id}`, classifySiblingSettlement({ conditionId: r.condition_id, tokenId: r.token_id, market: markets.get(r.condition_id) ?? null }));
  }
  return { byKey, conditions_n: conditions.length, source_unavailable_conditions_n: [...markets.values()].filter((m) => m === null).length };
}

export async function runSiblingOffPolicy(input: {
  port: SiblingSourcePort;
  fetchMarket: (conditionId: string) => Promise<GammaMarket | null>;
  start: string;
  end: string;
  sourceChannel: string;
  models?: readonly FrozenModelId[];
  now?: () => Date;
  concurrency?: number;
}): Promise<{ report: OffPolicyReport; dataset: OffPolicyDatasetRow[] }> {
  const rows = await input.port.readSiblings({
    startIso: `${input.start}T00:00:00.000Z`,
    endExclusiveIso: new Date(Date.parse(`${input.end}T00:00:00.000Z`) + 86_400_000).toISOString(),
  });
  const settled = await settleSiblings(rows, input.fetchMarket, { concurrency: input.concurrency });
  const dataset = buildOffPolicyDataset(rows, settled.byKey);
  const models = input.models ?? OFFPOLICY_ALL_FROZEN_MODELS;
  const evaluations = Object.fromEntries(VIEWS.map((view) => [view, evaluateView(dataset, view, models)])) as Record<EvaluationView, ModelEvaluation[]>;
  const report: OffPolicyReport = {
    version: T10_OFFPOLICY_VERSION,
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
    source_channel: input.sourceChannel,
    range: { start: input.start, end: input.end },
    stake_usd: dataset[0]?.ordinary_stake_usd ?? 2.5,
    hard_cap: dataset[0]?.hard_cap ?? 0.54,
    coverage: summarizeCoverage(dataset),
    settlement_lookups: { conditions_n: settled.conditions_n, source_unavailable_conditions_n: settled.source_unavailable_conditions_n },
    evaluations,
    notes: [
      "Frozen engine unchanged: one selected bet per physical event, chronologically first qualifying candidate; ties on the same T10 capture resolve to the LOWEST entry price.",
      "RAW = every supported sibling priced at its T10 best ask, ignoring the 0.54 cap / min order size / depth. It is NOT an executable return.",
      "EXECUTABLE_UPPER_BOUND = RAW minus siblings conclusively blocked at T10 (best ask above the 0.54 cap; min order size unmet at the best ask). Pre-telemetry rows never persisted the ask ladder, so depth/VWAP/fee are unknown there: this is an upper bound.",
      "EXECUTABLE_PROVEN = only siblings whose T10_EXECUTABLE_SIBLING_TELEMETRY_V1 state is EXECUTABLE (zero before the telemetry release).",
      "Unresolved / void / identity-unproven / source-unavailable siblings are excluded from results and counted; none is converted to a loss.",
      "PnL is gross (fee-excluded); fee is KNOWN only on telemetry rows.",
    ],
  };
  return { report, dataset };
}

// ── markdown + artifact writers ──────────────────────────────────────────────────────────────────────

const fmt = (v: number) => (Number.isFinite(v) ? v.toString() : "n/a");

export function renderMarkdown(report: OffPolicyReport): string {
  const c = report.coverage;
  const lines: string[] = [
    `# T10 sibling off-policy evaluation (${report.version})`,
    "",
    `Range ${report.range.start}..${report.range.end} · generated ${report.generated_at} · source: ${report.source_channel} · ordinary stake $${report.stake_usd} · hard cap ${report.hard_cap}`,
    "",
    "## Coverage / denominators",
    `- supported siblings: **${c.supported_siblings_n}** over **${c.supported_physical_events_n}** physical events (${c.date_range.first_event_date}..${c.date_range.last_event_date})`,
    `- supported siblings by family: ${JSON.stringify(c.supported_siblings_by_family)}`,
    `- priced siblings: ${c.priced_siblings_n} · settled (WIN/LOSS): ${c.settled_siblings_n} · unresolved: ${c.unresolved_siblings_n}`,
    `- settlement states: ${JSON.stringify(c.settlement_state_counts)}`,
    `- **common physical-event denominator (>=1 settled priced sibling): ${c.common_physical_events_n}**`,
    `- executability states: ${JSON.stringify(c.executability_state_counts)} (sources ${JSON.stringify(c.executability_source_counts)})`,
    `- telemetry rows: ${c.telemetry_rows_n} · fee known: ${c.fee_known_n} · fee unknown: ${c.fee_unknown_n}`,
    `- provider lookups: ${report.settlement_lookups.conditions_n} conditions, ${report.settlement_lookups.source_unavailable_conditions_n} unavailable`,
    "",
  ];
  for (const view of VIEWS) {
    lines.push(`## ${view}`, "", "| model | common events N | selected N | W | L | unresolved qualifying | PnL u | ROI % | MaxDD u | events/day | uncollapsed siblings (n / ROI %) |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const e of report.evaluations[view]) {
      lines.push(`| ${e.model} | ${e.common_processed_physical_events_n} | ${e.selected_physical_events_n} | ${e.wins} | ${e.losses} | ${e.unresolved_qualifying_siblings_n} | ${fmt(e.pnl_u)} | ${fmt(e.roi_pct)} | ${fmt(e.max_drawdown_u)} | ${fmt(e.events_per_day)} | ${e.uncollapsed_qualifying_siblings.n} / ${fmt(e.uncollapsed_qualifying_siblings.roi_pct)} |`);
    }
    lines.push("");
    for (const e of report.evaluations[view]) lines.push(`- ${e.model} uncollapsed by family: ${Object.entries(e.uncollapsed_by_family).map(([f, m]) => `${f} n=${m.n} ${m.wins}W/${m.losses}L ROI ${fmt(m.roi_pct)}%`).join(" · ") || "none"}`);
    for (const e of report.evaluations[view]) lines.push(`- ${e.model}: sport mix ${JSON.stringify(e.sport_mix)} · fee known/unknown ${e.selected_fee_known_n}/${e.selected_fee_unknown_n} · executability ${JSON.stringify(e.selected_executability)} · gross $ at ordinary stake ${fmt(e.pnl_usd_gross_at_ordinary_stake)}`);
    lines.push("");
  }
  lines.push("## Notes", ...report.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

export function writeArtifacts(report: OffPolicyReport, dataset: readonly OffPolicyDatasetRow[], outDir = OFFPOLICY_OUT_DIR): string[] {
  mkdirSync(outDir, { recursive: true });
  const stem = `${report.range.start}_${report.range.end}`;
  const paths = [join(outDir, `REPORT_${stem}.json`), join(outDir, `REPORT_${stem}.md`), join(outDir, `DATASET_${stem}.jsonl.gz`)];
  writeFileSync(paths[0], `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(paths[1], renderMarkdown(report));
  writeFileSync(paths[2], gzipSync(Buffer.from(dataset.map((r) => JSON.stringify(r)).join("\n") + "\n")));
  return paths;
}

// ── clone materialization (the only write; explicit flag; clone ref guarded by the caller) ─────────────

export function toMaterializedRow(r: OffPolicyDatasetRow, materializedAt: string): Record<string, unknown> {
  const { lineage, ...rest } = r;
  return { ...rest, lineage, materialized_at: materializedAt };
}

export async function materializeDataset(client: Pick<SupabaseClient, "from">, dataset: readonly OffPolicyDatasetRow[], now = new Date()): Promise<number> {
  const rows = dataset.map((r) => toMaterializedRow(r, now.toISOString()));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await client.from(OFFPOLICY_TABLE)
      .upsert(rows.slice(i, i + 500), { onConflict: "dataset_version,physical_event_id,condition_id,token_id,side,decision_at" });
    if (error) throw new Error(`OFFPOLICY_MATERIALIZE_WRITE:${error.code ?? error.message}`);
  }
  return rows.length;
}

// ── PostgREST (service-role) read port ───────────────────────────────────────────────────────────────

export function createPostgrestSiblingPort(client: SupabaseClient): SiblingSourcePort {
  return {
    async readSiblings({ startIso, endExclusiveIso }) {
      const observations: Array<Record<string, unknown>> = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from("reservation_market_observations").select(OBSERVATION_COLUMNS)
          .eq("observation_phase", "T_MINUS_10").gte("event_start_iso", startIso).lt("event_start_iso", endExclusiveIso)
          .order("observed_at").order("id").range(from, from + 999);
        if (error) throw new Error(`OFFPOLICY_READ_OBSERVATIONS:${error.code ?? error.message}`);
        observations.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
        if ((data?.length ?? 0) < 1000) break;
      }
      const providerIds = [...new Set(observations.map((o) => o.provider_event_id).filter((v): v is string => typeof v === "string"))];
      const families = new Map<string, Set<string>>();
      for (let i = 0; i < providerIds.length; i += 50) {
        for (let from = 0; ; from += 1000) {
          const { data, error } = await client.from("research_evidence_page_rows").select("provider_event_id,provider_sport_family")
            .in("provider_event_id", providerIds.slice(i, i + 50)).range(from, from + 999);
          if (error) throw new Error(`OFFPOLICY_READ_FAMILY:${error.code ?? error.message}`);
          for (const e of (data ?? []) as Array<{ provider_event_id: string; provider_sport_family: string | null }>) {
            if (e.provider_sport_family) (families.get(e.provider_event_id) ?? families.set(e.provider_event_id, new Set()).get(e.provider_event_id)!).add(e.provider_sport_family.trim().toLowerCase());
          }
          if ((data?.length ?? 0) < 1000) break;
        }
      }
      return observations.map((o) => normalizeObservation(o, families));
    },
  };
}

/** Exact DB shape -> typed row. A provider event with more than one distinct family is ambiguous: family stays NULL. */
export function normalizeObservation(o: Record<string, unknown>, families: ReadonlyMap<string, ReadonlySet<string>>): SiblingObservationRow {
  const set = typeof o.provider_event_id === "string" ? families.get(o.provider_event_id) : undefined;
  const iso = (v: unknown) => new Date(String(v)).toISOString();
  return {
    physical_event_id: String(o.physical_event_id),
    provider_event_id: typeof o.provider_event_id === "string" ? o.provider_event_id : null,
    event_start_iso: iso(o.event_start_iso), observed_at: iso(o.observed_at),
    condition_id: String(o.condition_id), token_id: String(o.token_id), side: String(o.side),
    canonical_market_family: (o.canonical_market_family as string | null) ?? null,
    canonical_market_type: (o.canonical_market_type as string | null) ?? null,
    provider_market_type_raw: (o.provider_market_type_raw as string | null) ?? null,
    best_bid: num(o.best_bid), best_ask: num(o.best_ask), tick_size: num(o.tick_size), minimum_order_size: num(o.minimum_order_size),
    orderbook_fetch_status: String(o.orderbook_fetch_status),
    ask_depth_relevant_usd: num(o.ask_depth_relevant_usd),
    sport_family: set && set.size === 1 ? [...set][0] : null,
    executable_telemetry_version: (o.executable_telemetry_version as string | null) ?? null,
    executable_full_stake: (o.executable_full_stake as boolean | null) ?? null,
    executable_full_stake_state: (o.executable_full_stake_state as string | null) ?? null,
    full_stake_executable_vwap: num(o.full_stake_executable_vwap),
    full_stake_shares: num(o.full_stake_shares),
    taker_fee_state: (o.taker_fee_state as string | null) ?? null,
    taker_fee_usd: num(o.taker_fee_usd),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

async function main() {
  const start = arg("--start");
  const end = arg("--end");
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("USAGE: --start=YYYY-MM-DD --end=YYYY-MM-DD [--materialize]");
  const { resolveCloneClient } = await import("./live-d1-research-corpus");
  const { client } = resolveCloneClient();
  const { report, dataset } = await runSiblingOffPolicy({
    port: createPostgrestSiblingPort(client), fetchMarket: fetchGammaMarketByConditionId, start, end, sourceChannel: "research-clone PostgREST (service role, read-only)",
  });
  const paths = writeArtifacts(report, dataset);
  console.log(renderMarkdown(report));
  console.log(`artifacts: ${paths.join(", ")}`);
  if (process.argv.includes("--materialize")) {
    const n = await materializeDataset(client, dataset);
    console.log(`materialized ${n} rows into public.${OFFPOLICY_TABLE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
