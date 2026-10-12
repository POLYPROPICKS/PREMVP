/**
 * Display-only CEO names for the ten approved research tracks. Canonical ids, versions, definitions, definition
 * hashes and BET permissions stay owned by their registries; this module only labels them and derives each
 * track's mode FROM those registries, so a label can never claim a capability the registry does not grant.
 */
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES, TIMELY_SOURCE_PATH_PROVEN } from "./inplayPaperDecisions";

export const PREMATCH_TRACK_IDS = ["P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE", "TENNIS_P50_52_SAFE"] as const;

export const TRACK_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  P50_52_SAFE: "Прематч · Цена 50–52¢",
  PORTFOLIO_BROAD_SAFE: "Прематч · Широкий портфель",
  QUALITY_FILL_A_SAFE: "Прематч · Сбалансированный",
  QUALITY_FILL_D_SAFE: "Прематч · Футбольный расширенный",
  TENNIS_P50_52_SAFE: "Прематч · Теннис 50–52¢",
  CONTROL_PRICE_BUCKET_A: "Лайв · Контроль 48–52¢",
  CONTROL_PRICE_BUCKET_B: "Лайв · Контроль 53–58¢",
  CONTROL_PRICE_BUCKET_C: "Лайв · Контроль 35–44¢",
  VALUE_BACKED_TAIL_REPRICING: "Alpha 1 · Недооценённые исходы",
  STATEWISE_PAYOFF_ARBITRAGE: "Alpha 2 · Арбитраж связанных рынков",
});

export type TrackMode =
  | "PREMATCH_FORWARD_BET_ENGINE"   // emits BET through the prospective shadow cycle (FORWARD_BET_V1 once the schema is live)
  | "LIVE_DELAYED_PAPER"            // emits BET, but timing authority is unproven, so every decision is DELAYED_PAPER
  | "LIVE_PROSPECTIVE_ELIGIBLE"     // emits BET and the timely source path is proven
  | "FACTS_ONLY";                   // canEmitBet=false: factual hooks only, structurally unable to produce BET

export type TrackInfo = { canonicalId: string; displayName: string; group: "PREMATCH" | "LIVE_CONTROL" | "ALPHA"; mode: TrackMode; canEmitBet: boolean; version: string | null };

export function buildTrackRegistry(): TrackInfo[] {
  const tracks: TrackInfo[] = [
    ...PREMATCH_TRACK_IDS.map((id): TrackInfo => ({ canonicalId: id, displayName: TRACK_DISPLAY_NAMES[id], group: "PREMATCH", mode: "PREMATCH_FORWARD_BET_ENGINE", canEmitBet: true, version: null })),
    ...CONTROL_STRATEGIES.map((s): TrackInfo => ({ canonicalId: s.id, displayName: TRACK_DISPLAY_NAMES[s.id], group: "LIVE_CONTROL", mode: !s.canEmitBet ? "FACTS_ONLY" : TIMELY_SOURCE_PATH_PROVEN ? "LIVE_PROSPECTIVE_ELIGIBLE" : "LIVE_DELAYED_PAPER", canEmitBet: s.canEmitBet, version: s.version })),
    ...ALPHA_PROGRAMS.map((s): TrackInfo => ({ canonicalId: s.id, displayName: TRACK_DISPLAY_NAMES[s.id], group: "ALPHA", mode: s.canEmitBet ? "LIVE_DELAYED_PAPER" : "FACTS_ONLY", canEmitBet: s.canEmitBet, version: s.version })),
  ];
  const missing = tracks.filter((t) => !t.displayName).map((t) => t.canonicalId);
  const labelled = new Set(tracks.map((t) => t.canonicalId));
  const orphan = Object.keys(TRACK_DISPLAY_NAMES).filter((id) => !labelled.has(id));
  if (missing.length || orphan.length) throw new Error(`TRACK_LABEL_REGISTRY_DESYNC:missing=${missing.join(",")}:orphan=${orphan.join(",")}`);
  return tracks;
}

export const displayNameFor = (canonicalId: string): string => TRACK_DISPLAY_NAMES[canonicalId] ?? canonicalId;
