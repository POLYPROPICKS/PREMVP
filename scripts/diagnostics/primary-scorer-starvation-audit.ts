/**
 * PRIMARY_SCORER_STARVATION_AUDIT_V1 — read-only diagnostic.
 *
 * Proves or falsifies the hypothesis that large per-event identity fanout,
 * combined with the current sequential candidate ordering, causes the 360s
 * primary scorer budget to be consumed by a very small number of physical
 * events. Runs ONE fresh discoverSportsMarkets() call, then reuses the exact
 * existing production functions (boundPrimaryScorerPopulation,
 * sampleToCandidateMarkets, sortCandidatesForProductRanking,
 * computeCandidateProviderEventKey) to reproduce today's real candidate
 * population and ordering. Never scores, never enriches, never persists,
 * never touches Supabase/Railway. A pure, in-memory, non-exported
 * "event-fair" round-robin counterfactual is computed for comparison ONLY —
 * it never runs in and never alters production.
 *
 *   npx tsx scripts/diagnostics/primary-scorer-starvation-audit.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverSportsMarkets } from "@/lib/feed/discoverSportsMarkets";
import {
  boundPrimaryScorerPopulation,
  sampleToCandidateMarkets,
  sortCandidatesForProductRanking,
  computeCandidateProviderEventKey,
  type CandidateMarket,
  type ParentEventMeta,
} from "@/lib/feed/buildLandingCards";
import { MINIMUM_MODEL_EVENT_VOLUME_USD } from "@/lib/feed/eventLiquidityGate";

export const AUDIT_OUT_DIR = "modeling/evidence/primary-scorer-starvation-audit-v1";
const PREFIX_SIZES = [100, 250, 500, 608, 1000] as const;

function parentMetaOf(c: CandidateMarket): ParentEventMeta | undefined {
  return (c.market as unknown as Record<string, unknown>)._parentMeta as ParentEventMeta | undefined;
}
function sportFamilyOf(c: CandidateMarket): string | null {
  return parentMetaOf(c)?.providerSportFamily ?? null;
}
function sportCodeOf(c: CandidateMarket): string | null {
  const code = parentMetaOf(c)?.providerSportCode;
  return typeof code === "string" && code.trim() !== "" ? code.trim().toLowerCase() : null;
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export interface KeyedCandidate {
  candidate: CandidateMarket;
  key: string | null;
}

function keyAll(candidates: CandidateMarket[]): KeyedCandidate[] {
  return candidates.map((candidate) => ({ candidate, key: computeCandidateProviderEventKey(candidate) }));
}

/**
 * PURE DIAGNOSTIC ONLY — never imported by production, never alters candidate
 * membership. Preserves first physical-event appearance order and each
 * event's existing internal identity order; round-robins identity depth
 * across events (breadth-first); canonical keyed events first; unkeyed
 * candidates last, in their original relative order.
 */
export function buildEventFairOrder(keyed: KeyedCandidate[]): KeyedCandidate[] {
  const groups = new Map<string, KeyedCandidate[]>();
  const eventOrder: string[] = [];
  const unkeyed: KeyedCandidate[] = [];
  for (const item of keyed) {
    if (item.key === null) {
      unkeyed.push(item);
      continue;
    }
    const group = groups.get(item.key);
    if (group) group.push(item);
    else {
      groups.set(item.key, [item]);
      eventOrder.push(item.key);
    }
  }
  const maxDepth = Math.max(0, ...[...groups.values()].map((g) => g.length));
  const roundRobin: KeyedCandidate[] = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const key of eventOrder) {
      const group = groups.get(key)!;
      if (depth < group.length) roundRobin.push(group[depth]);
    }
  }
  return [...roundRobin, ...unkeyed];
}

function uniqueEventKeysIn(prefix: KeyedCandidate[]): Set<string> {
  const set = new Set<string>();
  for (const item of prefix) if (item.key !== null) set.add(item.key);
  return set;
}

function topSportFamilies(prefix: KeyedCandidate[], topN = 5): Array<{ family: string; n: number }> {
  const counts = new Map<string, number>();
  for (const item of prefix) {
    const family = sportFamilyOf(item.candidate) ?? "MISSING";
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([family, n]) => ({ family, n }));
}

interface PrefixReport {
  attempt_n: number;
  unique_physical_event_n: number;
  coverage_pct_of_all_keyed_events: number;
  top_sport_families: Array<{ family: string; n: number }>;
  missing_family_attempt_n: number;
  cfb_attempt_n: number;
}

function reportPrefix(ordered: KeyedCandidate[], size: number, canonicalEventN: number): PrefixReport {
  const n = Math.min(size, ordered.length);
  const prefix = ordered.slice(0, n);
  const unique = uniqueEventKeysIn(prefix);
  return {
    attempt_n: n,
    unique_physical_event_n: unique.size,
    coverage_pct_of_all_keyed_events: canonicalEventN > 0 ? round((unique.size / canonicalEventN) * 100, 2) : 0,
    top_sport_families: topSportFamilies(prefix),
    missing_family_attempt_n: prefix.filter((item) => sportFamilyOf(item.candidate) === null).length,
    cfb_attempt_n: prefix.filter((item) => sportCodeOf(item.candidate) === "cfb").length,
  };
}

async function runDiscoveryOnce() {
  return discoverSportsMarkets({
    windowHours: 24,
    fallbackWindowHours: 48,
    fetchVolumeMinUsd: 50000,
    finalEventVolumeMinUsd: MINIMUM_MODEL_EVENT_VOLUME_USD,
    targetCards: Number.POSITIVE_INFINITY,
  });
}

export async function buildAudit() {
  let discovery;
  try {
    discovery = await runDiscoveryOnce();
  } catch (firstError) {
    try {
      discovery = await runDiscoveryOnce();
    } catch (secondError) {
      return {
        OUTCOME: "INCONCLUSIVE" as const,
        REASON: `LIVE_DISCOVERY_FAILED_TWICE: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
      };
    }
  }

  const discoverySamples = boundPrimaryScorerPopulation(discovery.finalCandidates, discovery.fallback48hCandidates);
  let candidates: CandidateMarket[] = [];
  for (const sample of discoverySamples) candidates.push(...sampleToCandidateMarkets(sample));
  candidates = sortCandidatesForProductRanking(candidates);

  const currentKeyed = keyAll(candidates);
  const canonicalKeys = new Set(currentKeyed.filter((i) => i.key !== null).map((i) => i.key as string));
  const unkeyed = currentKeyed.filter((i) => i.key === null);

  const DISCOVERY = {
    groupedGames: discovery.counts.groupedGames,
    within24hGroups: discovery.counts.within24hGroups,
    within48hGroups: discovery.counts.within48hGroups,
    volumeEligibleGroups: discovery.counts.volumeEligibleGroups,
    finalPairs: discovery.counts.finalPairs,
    finalCandidates_n: discovery.finalCandidates.length,
    fallback48hCandidates_n: discovery.fallback48hCandidates.length,
  };

  const FANOUT = {
    candidate_identity_n: currentKeyed.length,
    canonical_physical_event_n: canonicalKeys.size,
    unkeyed_candidate_n: unkeyed.length,
    unkeyed_share_pct: currentKeyed.length > 0 ? round((unkeyed.length / currentKeyed.length) * 100, 2) : 0,
  };

  // identities-per-physical-event distribution + first-appearance index (for H2)
  const perEventCount = new Map<string, number>();
  const perEventFirstIndex = new Map<string, number>();
  currentKeyed.forEach((item, index) => {
    if (item.key === null) return;
    perEventCount.set(item.key, (perEventCount.get(item.key) ?? 0) + 1);
    if (!perEventFirstIndex.has(item.key)) perEventFirstIndex.set(item.key, index);
  });
  const counts = [...perEventCount.values()].sort((a, b) => a - b);
  const IDENTITIES_PER_EVENT = {
    min: counts.length ? counts[0] : 0,
    p25: round(percentile(counts, 0.25), 2),
    median: round(percentile(counts, 0.5), 2),
    p75: round(percentile(counts, 0.75), 2),
    p90: round(percentile(counts, 0.9), 2),
    p95: round(percentile(counts, 0.95), 2),
    p99: round(percentile(counts, 0.99), 2),
    max: counts.length ? counts[counts.length - 1] : 0,
    mean: counts.length ? round(counts.reduce((s, n) => s + n, 0) / counts.length, 2) : 0,
  };

  const TOP_FANOUT_EVENTS = [...perEventCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, identity_n]) => {
      const first = currentKeyed.find((i) => i.key === key)!;
      return {
        physical_event_key: key,
        providerSportFamily: sportFamilyOf(first.candidate),
        providerSportCode: sportCodeOf(first.candidate),
        identity_n,
        identity_share_pct: round((identity_n / currentKeyed.length) * 100, 3),
      };
    });

  const eventFairKeyed = buildEventFairOrder(currentKeyed);

  const CURRENT_ORDER: Record<string, PrefixReport> = {};
  const EVENT_FAIR_ORDER: Record<string, PrefixReport> = {};
  const PREFIX_DELTAS: Record<string, { additional_unique_events_vs_current: number; coverage_multiplier_vs_current: number }> = {};
  for (const size of PREFIX_SIZES) {
    const cur = reportPrefix(currentKeyed, size, canonicalKeys.size);
    const fair = reportPrefix(eventFairKeyed, size, canonicalKeys.size);
    CURRENT_ORDER[String(size)] = cur;
    EVENT_FAIR_ORDER[String(size)] = fair;
    PREFIX_DELTAS[String(size)] = {
      additional_unique_events_vs_current: fair.unique_physical_event_n - cur.unique_physical_event_n,
      coverage_multiplier_vs_current: cur.unique_physical_event_n > 0 ? round(fair.unique_physical_event_n / cur.unique_physical_event_n, 3) : fair.unique_physical_event_n > 0 ? Infinity : 1,
    };
  }
  const PREFIX_608 = {
    current_unique_events: CURRENT_ORDER["608"].unique_physical_event_n,
    event_fair_unique_events: EVENT_FAIR_ORDER["608"].unique_physical_event_n,
    absolute_gain: PREFIX_DELTAS["608"].additional_unique_events_vs_current,
    coverage_multiplier: PREFIX_DELTAS["608"].coverage_multiplier_vs_current,
  };

  // SPORT_FANOUT over ALL keyed candidates (not just a prefix)
  const sportGroups = new Map<string, { key: string; events: Set<string>; identities: number }>();
  const sportKeyOf = (family: string | null, code: string | null) => `${family ?? "MISSING"}::${code ?? "NULL"}`;
  for (const item of currentKeyed) {
    if (item.key === null) continue;
    const family = sportFamilyOf(item.candidate);
    const code = sportCodeOf(item.candidate);
    const sk = sportKeyOf(family, code);
    const group = sportGroups.get(sk) ?? { key: sk, events: new Set<string>(), identities: 0 };
    group.events.add(item.key);
    group.identities += 1;
    sportGroups.set(sk, group);
  }
  const SPORT_FANOUT = [...sportGroups.values()]
    .map((g) => {
      const [family, code] = g.key.split("::");
      return {
        providerSportFamily: family === "MISSING" ? null : family,
        providerSportCode: code === "NULL" ? null : code,
        unique_physical_events: g.events.size,
        candidate_identities: g.identities,
        identities_per_event: round(g.identities / g.events.size, 2),
        share_of_all_identities_pct: round((g.identities / currentKeyed.length) * 100, 2),
      };
    })
    .sort((a, b) => b.candidate_identities - a.candidate_identities);

  // Aggregates rows matching a predicate across every code/family split, since
  // e.g. "soccer" spans dozens of distinct providerSportCode leagues.
  const aggregate = (predicate: (s: (typeof SPORT_FANOUT)[number]) => boolean) => {
    const matches = SPORT_FANOUT.filter(predicate);
    if (matches.length === 0) return null;
    const events = matches.reduce((s, m) => s + m.unique_physical_events, 0);
    const identities = matches.reduce((s, m) => s + m.candidate_identities, 0);
    return {
      unique_physical_events: events,
      candidate_identities: identities,
      identities_per_event: round(identities / events, 2),
      share_of_all_identities_pct: round((identities / currentKeyed.length) * 100, 2),
      distinct_code_or_family_rows: matches.length,
    };
  };
  const SPORT_FANOUT_ISOLATED = {
    missing_family: aggregate((s) => s.providerSportFamily === null),
    cfb: aggregate((s) => s.providerSportCode === "cfb"),
    esports: aggregate((s) => s.providerSportFamily === "esports"),
    soccer: aggregate((s) => s.providerSportFamily === "soccer"),
    tennis: aggregate((s) => s.providerSportFamily === "tennis"),
    baseball: aggregate((s) => s.providerSportFamily === "baseball"),
    basketball: aggregate((s) => s.providerSportFamily === "basketball"),
    hockey: aggregate((s) => s.providerSportFamily === "hockey"),
    cricket: aggregate((s) => s.providerSportFamily === "cricket"),
    mma: aggregate((s) => s.providerSportFamily === "mma"),
  };

  // ── Hypothesis verdicts (mechanical thresholds over the real, computed numbers) ──
  const canonicalN = canonicalKeys.size;
  const H1_IDENTITY_FANOUT_STARVATION =
    canonicalN === 0
      ? "INCONCLUSIVE"
      : CURRENT_ORDER["608"].unique_physical_event_n / canonicalN < 0.5
        ? "SUPPORTED"
        : "NOT_SUPPORTED";

  // H2: does the current volume-DESC ranking place high-fanout events earlier
  // than the rest (compounding fanout with early positional dominance)?
  const top20Keys = new Set(TOP_FANOUT_EVENTS.map((t) => t.physical_event_key));
  const top20FirstIdx = [...top20Keys].map((k) => perEventFirstIndex.get(k)!).filter((v) => v !== undefined);
  const restFirstIdx = [...perEventFirstIndex.entries()].filter(([k]) => !top20Keys.has(k)).map(([, v]) => v);
  const meanIdx = (arr: number[]) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : NaN);
  const top20MeanIdx = meanIdx(top20FirstIdx);
  const restMeanIdx = meanIdx(restFirstIdx);
  const H2_PRODUCT_RANKING_VOLUME_CONCENTRATION =
    top20FirstIdx.length === 0 || restFirstIdx.length === 0
      ? "INCONCLUSIVE"
      : top20MeanIdx < restMeanIdx * 0.5
        ? "SUPPORTED"
        : "NOT_SUPPORTED";

  const missingShareAt608 = CURRENT_ORDER["608"].attempt_n > 0 ? (CURRENT_ORDER["608"].missing_family_attempt_n / CURRENT_ORDER["608"].attempt_n) * 100 : 0;
  const H3_MISSING_SPORT_METADATA_CONSUMES_SCORER_BUDGET = CURRENT_ORDER["608"].attempt_n === 0 ? "INCONCLUSIVE" : missingShareAt608 > 15 ? "SUPPORTED" : "NOT_SUPPORTED";

  const H4_EVENT_FAIR_IMPROVES_EQUAL_ATTEMPT_COVERAGE =
    PREFIX_608.current_unique_events === 0 && PREFIX_608.event_fair_unique_events === 0
      ? "INCONCLUSIVE"
      : PREFIX_608.coverage_multiplier >= 1.2
        ? "SUPPORTED"
        : "NOT_SUPPORTED";

  const H5_NULL_KEYS_MATERIAL = currentKeyed.length === 0 ? "INCONCLUSIVE" : FANOUT.unkeyed_share_pct > 5 ? "SUPPORTED" : "NOT_SUPPORTED";

  return {
    OUTCOME: "PASS" as const,
    RANGE_GENERATED_AT: discovery.generatedAt,
    DISCOVERY,
    FANOUT,
    IDENTITIES_PER_EVENT,
    TOP_FANOUT_EVENTS,
    CURRENT_ORDER,
    EVENT_FAIR_ORDER,
    PREFIX_DELTAS,
    PREFIX_608,
    SPORT_FANOUT,
    SPORT_FANOUT_ISOLATED,
    HYPOTHESES: {
      H1_IDENTITY_FANOUT_STARVATION,
      H2_PRODUCT_RANKING_VOLUME_CONCENTRATION,
      H3_MISSING_SPORT_METADATA_CONSUMES_SCORER_BUDGET,
      H4_EVENT_FAIR_IMPROVES_EQUAL_ATTEMPT_COVERAGE,
      H5_NULL_KEYS_MATERIAL,
    },
  };
}

function renderMarkdown(audit: Awaited<ReturnType<typeof buildAudit>>): string {
  if (audit.OUTCOME !== "PASS") {
    return `# PRIMARY_SCORER_STARVATION_AUDIT_V1\n\nOUTCOME: ${audit.OUTCOME}\n\n${"REASON" in audit ? audit.REASON : ""}\n`;
  }
  const a = audit;
  const fmt = (n: number) => (Number.isFinite(n) ? n : "∞");
  return `# PRIMARY_SCORER_STARVATION_AUDIT_V1

Generated from a fresh discovery snapshot at ${a.RANGE_GENERATED_AT}.

## CURRENT ORDER

Canonical physical events (keyed): **${a.FANOUT.canonical_physical_event_n}**. Candidate identities: **${a.FANOUT.candidate_identity_n}**. Unkeyed candidates: **${a.FANOUT.unkeyed_candidate_n}** (${a.FANOUT.unkeyed_share_pct}%).

| attempts | unique events | coverage % | missing-family attempts | cfb attempts |
|---:|---:|---:|---:|---:|
${PREFIX_SIZES.map((s) => {
  const r = a.CURRENT_ORDER[String(s)];
  return `| ${r.attempt_n} | ${r.unique_physical_event_n} | ${r.coverage_pct_of_all_keyed_events}% | ${r.missing_family_attempt_n} | ${r.cfb_attempt_n} |`;
}).join("\n")}

## EVENT-FAIR COUNTERFACTUAL

Diagnostic-only, in-memory round-robin over the SAME candidate population — never wired into production.

| attempts | unique events | coverage % | additional vs current | coverage multiplier |
|---:|---:|---:|---:|---:|
${PREFIX_SIZES.map((s) => {
  const r = a.EVENT_FAIR_ORDER[String(s)];
  const d = a.PREFIX_DELTAS[String(s)];
  return `| ${r.attempt_n} | ${r.unique_physical_event_n} | ${r.coverage_pct_of_all_keyed_events}% | +${d.additional_unique_events_vs_current} | ${fmt(d.coverage_multiplier_vs_current)}x |`;
}).join("\n")}

At prefix 608: current=${a.PREFIX_608.current_unique_events} unique events vs event-fair=${a.PREFIX_608.event_fair_unique_events} (gain +${a.PREFIX_608.absolute_gain}, ${fmt(a.PREFIX_608.coverage_multiplier)}x).

## SPORT/FANOUT CONCENTRATION

Identities-per-event: min=${a.IDENTITIES_PER_EVENT.min} median=${a.IDENTITIES_PER_EVENT.median} p90=${a.IDENTITIES_PER_EVENT.p90} p99=${a.IDENTITIES_PER_EVENT.p99} max=${a.IDENTITIES_PER_EVENT.max} mean=${a.IDENTITIES_PER_EVENT.mean}.

Top fanout events (up to 20):

| physical_event_key | sportFamily | sportCode | identities | share % |
|---|---|---|---:|---:|
${a.TOP_FANOUT_EVENTS.map((t) => `| ${t.physical_event_key} | ${t.providerSportFamily ?? "MISSING"} | ${t.providerSportCode ?? "-"} | ${t.identity_n} | ${t.identity_share_pct}% |`).join("\n")}

Sport fanout (top 10 by identities):

| sportFamily | sportCode | events | identities | identities/event | share % |
|---|---|---:|---:|---:|---:|
${a.SPORT_FANOUT.slice(0, 10).map((s) => `| ${s.providerSportFamily ?? "MISSING"} | ${s.providerSportCode ?? "-"} | ${s.unique_physical_events} | ${s.candidate_identities} | ${s.identities_per_event} | ${s.share_of_all_identities_pct}% |`).join("\n")}

## HYPOTHESIS VERDICTS

- H1 IDENTITY_FANOUT_STARVATION: **${a.HYPOTHESES.H1_IDENTITY_FANOUT_STARVATION}**
- H2 PRODUCT_RANKING_VOLUME_CONCENTRATION: **${a.HYPOTHESES.H2_PRODUCT_RANKING_VOLUME_CONCENTRATION}**
- H3 MISSING_SPORT_METADATA_CONSUMES_SCORER_BUDGET: **${a.HYPOTHESES.H3_MISSING_SPORT_METADATA_CONSUMES_SCORER_BUDGET}**
- H4 EVENT_FAIR_ORDER_WOULD_MATERIALLY_INCREASE_PHYSICAL_EVENT_COVERAGE_AT_EQUAL_ATTEMPT_COUNT: **${a.HYPOTHESES.H4_EVENT_FAIR_IMPROVES_EQUAL_ATTEMPT_COVERAGE}**
- H5 NULL_PHYSICAL_KEYS_ARE_MATERIAL: **${a.HYPOTHESES.H5_NULL_KEYS_MATERIAL}**

## SAFE FIX OPTIONS (descriptive only — no implementation, no recommendation to increase load)

| option | physical-event coverage effect | candidate membership impact | DB/network-load impact | semantic risk |
|---|---|---|---|---|
| A. Event-fair round-robin ordering under the unchanged 360s budget | Directly increases distinct physical events opened per attempt count (see EVENT-FAIR table above) | None — same candidate set, only order changes | None — same number of attempts, same per-attempt work | Low: changes WHICH events are opened first, not what qualifies; volume-priority signal is deprioritized within the attempt budget |
| B. Per-event identity cap before the scorer (e.g. cap identities/event) | Increases coverage only if fanout, not raw event count, is the bottleneck | Reduces candidate membership for high-fanout events (fewer sibling/outcome identities attempted per event) | None | Medium: silently drops some already-authorized sibling/outcome identities before they are ever attempted |
| C. Increasing the scorer budget (>360s) | Increases coverage roughly linearly with more wall-clock, without touching order | None | Increases: more enrichment calls, more provider/network load, longer producer runtime | Low semantic risk, but directly increases load — not preferred |
| D. Concurrent scorer enrichment | Could increase coverage without extending wall-clock | None | Increases: parallel provider/network calls, higher burst load, more complex rate-limit exposure | Medium-high: introduces concurrency into a currently strictly sequential, well-understood loop |

This audit's evidence favors an ordering fix (A) over throughput fixes (C, D), since A is the only option that can increase measured physical-event coverage while holding attempt count and load exactly constant.
`;
}

export async function main(): Promise<void> {
  const audit = await buildAudit();
  mkdirSync(AUDIT_OUT_DIR, { recursive: true });
  const jsonPath = join(AUDIT_OUT_DIR, "AUDIT_LATEST.json");
  const mdPath = join(AUDIT_OUT_DIR, "AUDIT_LATEST.md");
  writeFileSync(jsonPath, JSON.stringify({ ARTIFACT: "PRIMARY_SCORER_STARVATION_AUDIT_V1", ...audit }, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, renderMarkdown(audit), "utf8");
  console.log(JSON.stringify({ OUTCOME: audit.OUTCOME, ARTIFACT_JSON: jsonPath, ARTIFACT_MD: mdPath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
