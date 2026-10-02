// Canonical declaration of CURRENT DEV_LIVE as a Constructor V1 instance.
//
// Every value below records behavior that already runs in DEV today; changing
// one is a deliberate composition change, pinned by tests/constructor.
// Secrets never appear here — only env-var NAMES.

import {
  COMPONENT_MANIFEST_SCHEMA,
  CONTOUR_INSTANCE_SCHEMA,
  CONTOUR_PROFILE_SCHEMA,
  type ComponentManifestV1,
  type ContourDeclarationV1,
  type ContourInstanceV1,
  type ContourProfileV1,
} from "./contracts";

export const DEV_LIVE_CONTOUR_ID = "DEV_LIVE" as const;

/** WHAT DEV_LIVE composes. */
export const DEV_LIVE_PROFILE: ContourProfileV1 = {
  schema: CONTOUR_PROFILE_SCHEMA,
  contourId: DEV_LIVE_CONTOUR_ID,
  selectors: { planning: "CONTRACT_A_PLANNING_V1", final: "CONTRACT_A_V1" },
  capabilities: { moneyMovement: "enabled" },
  requiredComponents: [
    "selector.planning",
    "selector.final",
    "policy.contractA",
    "reservation.planner",
    "reservation.clock",
    "rebalance.engine",
    "queue.api",
    "reservation.cron",
    "rebalance.cron",
    "resource.supabaseAdmin",
    "contour.registry",
    "contour.selector",
    "capability.moneyMovementGuard",
    "runtime.bootstrap",
  ],
};

/** EXACTLY which shared components DEV_LIVE is made of. */
export const DEV_LIVE_COMPONENT_MANIFEST: ComponentManifestV1 = {
  schema: COMPONENT_MANIFEST_SCHEMA,
  manifestId: "premvp-dev-live",
  version: "1.2.0",
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
      id: "reservation.cron",
      role: "reservation-cron-entry",
      module: "app/api/cron/night-event-reservations/route.ts",
      contractVersion: "CONTRACT_A_PLANNING_V1",
    },
    {
      id: "rebalance.cron",
      role: "rebalance-cron-entry",
      module: "app/api/cron/event-rebalance/route.ts",
      contractVersion: "CONTRACT_A_PLANNING_V1",
    },
    {
      id: "resource.supabaseAdmin",
      role: "supabase-admin-client-factory",
      module: "lib/supabase/adminClientFactory.ts",
      symbol: "createSupabaseAdminClient",
      contractVersion: "SUPABASE_ADMIN_BINDING_V1",
    },
    {
      id: "queue.api",
      role: "immutable-queue-adapter",
      module: "app/api/executor/queue/route.ts",
      contractVersion: "EXECUTOR_QUEUE_V1",
    },
    {
      id: "contour.registry",
      role: "contour-declaration-registry",
      module: "lib/constructor/registry.ts",
      symbol: "CONTOUR_REGISTRY",
      contractVersion: "CONTOUR_REGISTRY_V1",
    },
    {
      id: "contour.selector",
      role: "active-contour-selector",
      module: "lib/constructor/registry.ts",
      symbol: "resolveActiveContourId",
      contractVersion: "CONTOUR_SELECTOR_V1",
    },
    {
      id: "capability.moneyMovementGuard",
      role: "money-movement-capability-guard",
      module: "lib/constructor/contracts.ts",
      symbol: "assertMoneyMovementEnabled",
      contractVersion: "MONEY_MOVEMENT_CAPABILITY_V1",
    },
    {
      id: "runtime.bootstrap",
      role: "runtime-instance-boot",
      module: "lib/constructor/bootstrap.ts",
      symbol: "bootContourRuntime",
      contractVersion: "RUNTIME_BOOTSTRAP_V1",
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
  envBindings: {
    reservationTimesMinsk: "RESERVATION_TIMES_MINSK",
    executorCandidatesSecret: "EXECUTOR_CANDIDATES_SECRET",
    supabaseUrl: "SUPABASE_URL",
    supabaseServiceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
  },
};

export const DEV_LIVE_DECLARATION: ContourDeclarationV1 = {
  profile: DEV_LIVE_PROFILE,
  instance: DEV_LIVE_INSTANCE,
  manifest: DEV_LIVE_COMPONENT_MANIFEST,
};
