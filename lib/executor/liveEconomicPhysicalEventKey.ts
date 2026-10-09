// LIVE_PHYSICAL_EVENT_GAME_IDENTITY_V1
//
// ONE PHYSICAL EVENT = MAX ONE ECONOMIC EXPOSURE. A derivative Reservation (e.g. a `... - Total Corners`
// sub-event) persists its own provider-event physical id, while the root Reservation of the SAME match
// persists `provider:polymarket:game:<gameId>:<date>`. The T_MINUS_10 capture proves the derivative's
// provider gameId deterministically (own gameId, or the root parent's via provider-authored parentEventId)
// and records it in the run's discovery audit.
//
// For LIVE economic exposure identity only, that proven gameId owns the match key. The persisted
// Reservation physical_event_id / history is never rewritten. Never title, slug or start-time matching.

import { physicalMatchId } from "./contractADecisions";
import type { FinalT3MarketObservation } from "./reservationMarketBaseline";

export const LIVE_PHYSICAL_EVENT_KEY_VERSION = "LIVE_PHYSICAL_EVENT_GAME_IDENTITY_V1" as const;
export const LIVE_PHYSICAL_EVENT_GAME_ID_AMBIGUOUS = "LIVE_PHYSICAL_EVENT_GAME_ID_AMBIGUOUS";
export const LIVE_PHYSICAL_EVENT_GAME_ID_CONTRADICTION = "LIVE_PHYSICAL_EVENT_GAME_ID_CONTRADICTION";
export const LIVE_PHYSICAL_EVENT_KEY_UNRESOLVED = "LIVE_PHYSICAL_EVENT_KEY_UNRESOLVED";

export type LiveEconomicPhysicalEventKey =
  | { ok: true; key: string; source: "PROVEN_PROVIDER_GAME_ID" | "PERSISTED_PHYSICAL_EVENT_ID" }
  | { ok: false; reason: string };

const GAME_PREFIX = "provider:polymarket:game:";

/**
 * Canonical live physical-match key of one Reservation's finalized capture universe.
 * - exact provider gameId proven by the capture -> provider:polymarket:game:<gameId>:<date>
 * - otherwise -> the persisted physical_event_id (existing fail-closed identity, unchanged)
 * Conflicting proven gameIds, or a proven gameId contradicting a game-based persisted id, fail closed.
 */
export function liveEconomicPhysicalEventKey(input: {
  persistedPhysicalEventId: string | null | undefined;
  eventStartIso: string | null | undefined;
  providerEventId: string | null | undefined;
  universe: readonly Pick<FinalT3MarketObservation, "discovery_provider_game_id">[];
}): LiveEconomicPhysicalEventKey {
  const persisted = input.persistedPhysicalEventId;
  const start = input.eventStartIso;
  if (!persisted || !start || !Number.isFinite(Date.parse(start))) return { ok: false, reason: LIVE_PHYSICAL_EVENT_KEY_UNRESOLVED };
  const proven = new Set(input.universe.map((o) => o.discovery_provider_game_id).filter((g): g is string => typeof g === "string" && g.trim() !== ""));
  if (proven.size > 1) return { ok: false, reason: LIVE_PHYSICAL_EVENT_GAME_ID_AMBIGUOUS };
  if (proven.size === 0) return { ok: true, key: persisted, source: "PERSISTED_PHYSICAL_EVENT_ID" };
  const gameId = [...proven][0].trim();
  const key = physicalMatchId({ eventId: input.providerEventId ?? "", eventStartIso: start, gameId });
  // A game-based Reservation already names its match; the capture must agree with it exactly.
  if (persisted.startsWith(GAME_PREFIX) && persisted !== key) return { ok: false, reason: LIVE_PHYSICAL_EVENT_GAME_ID_CONTRADICTION };
  return { ok: true, key, source: "PROVEN_PROVIDER_GAME_ID" };
}
