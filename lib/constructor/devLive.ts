// Canonical declaration of CURRENT DEV_LIVE as a Constructor V1 instance.
//
// Every value below records behavior that already runs in DEV today; changing
// one is a deliberate composition change, pinned by tests/constructor.
// Secrets never appear here — only env-var NAMES.

import {
  COMPONENT_MANIFEST_SCHEMA,
  CONTOUR_INSTANCE_SCHEMA,
  CONTOUR_PROFILE_SCHEMA,
  composeContour,
  type ComponentManifestV1,
  type ComposedContour,
  type ContourInstanceV1,
  type ContourProfileV1,
} from "./contracts";

export const DEV_LIVE_CONTOUR_ID = "DEV_LIVE" as const;

/** WHAT DEV_LIVE composes. */
export const DEV_LIVE_PROFILE: ContourProfileV1 = {
  schema: CONTOUR_PROFILE_SCHEMA,
  contourId: DEV_LIVE_CONTOUR_ID,
  selectors: { planning: "CONTRACT_A_PLANNING_V1", final: "CONTRACT_A_V1" },
  requiredComponents: [
    "selector.planning",
    "selector.final",
    "policy.contractA",
    "reservation.planner",
    "reservation.clock",
    "rebalance.engine",
    "queue.api",
  ],
};

/** EXACTLY which shared components DEV_LIVE is made of. */
export const DEV_LIVE_COMPONENT_MANIFEST: ComponentManifestV1 = {
  schema: COMPONENT_MANIFEST_SCHEMA,
  manifestId: "premvp-dev-live",
  version: "1.0.0",
  contourId: DEV_LIVE_CONTOUR_ID,
  components: [
    {
      id: "selector.planning",
      role: "candidate-selector",
      module: "lib/executor/buildFireModelCandidates.ts",
      symbol: "buildFireModelCandidates",
      contractVersion: "CONTRACT_A_PLANNING_V1",
    },
    {
      id: "selector.final",
      role: "candidate-selector",
      module: "lib/executor/buildFireModelCandidates.ts",
      symbol: "buildFireModelCandidates",
      contractVersion: "CONTRACT_A_V1",
    },
    {
      id: "policy.contractA",
      role: "planning-policy",
      module: "lib/executor/contractADecisions.ts",
      symbol: "produceContractAPlanningDecisions",
      contractVersion: "CONTRACT_A_DECISION_V1",
    },
    {
      id: "reservation.planner",
      role: "physical-event-reservation",
      module: "lib/executor/nightEventReservations.ts",
      symbol: "buildReservationPlan",
      contractVersion: "CONTRACT_A_PLANNING_V1",
    },
    {
      id: "reservation.clock",
      role: "reservation-anchor-clock",
      module: "lib/executor/nightWindow.ts",
      symbol: "parseReservationTimesMinsk",
      contractVersion: "MINSK_ANCHOR_CLOCK",
    },
    {
      id: "rebalance.engine",
      role: "exact-identity-rebalance",
      module: "lib/executor/eventExecutionQueue.ts",
      symbol: "runEventRebalance",
      contractVersion: "CONTRACT_A_PLANNING_V1",
    },
    {
      id: "queue.api",
      role: "immutable-queue-adapter",
      module: "app/api/executor/queue/route.ts",
      contractVersion: "EXECUTOR_QUEUE_V1",
    },
  ],
};

/** WHICH concrete instance runs DEV_LIVE. */
export const DEV_LIVE_INSTANCE: ContourInstanceV1 = {
  schema: CONTOUR_INSTANCE_SCHEMA,
  instanceId: "DEV_LIVE_PRIMARY",
  profileRef: { contourId: DEV_LIVE_CONTOUR_ID },
  manifestRef: { manifestId: DEV_LIVE_COMPONENT_MANIFEST.manifestId, version: DEV_LIVE_COMPONENT_MANIFEST.version },
  runtime: {
    service: "polypropicks-premvp",
    repository: "POLYPROPICKS/PREMVP",
    scheduler: "RAILWAY_CRON_WAKE",
  },
  envBindings: { reservationTimesMinsk: "RESERVATION_TIMES_MINSK" },
};

let active: ComposedContour | null = null;

/** The contour the running process serves. Composed once, fail-closed. */
export function getActiveContour(): ComposedContour {
  active ??= composeContour({
    profile: DEV_LIVE_PROFILE,
    instance: DEV_LIVE_INSTANCE,
    manifest: DEV_LIVE_COMPONENT_MANIFEST,
  });
  return active;
}
