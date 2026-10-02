// Declaration of PROD_SHADOW: a PASSIVE Constructor V1 contour. NOT DEPLOYED.
//
// It reuses the shared engine components and DEV_LIVE's selector policy, but its profile declares
// `moneyMovement: "disabled"`, so it can plan and observe yet can never admit an executable queue
// row (see assertMoneyMovementEnabled in ./contracts). The env bindings below are placeholder
// env-var NAMES that are not provisioned anywhere; no value, URL or credential exists for them.
// Provisioning real resources for this instance is a separate, later, Founder-authorized step.

import {
  COMPONENT_MANIFEST_SCHEMA,
  CONTOUR_INSTANCE_SCHEMA,
  CONTOUR_PROFILE_SCHEMA,
  type ComponentManifestV1,
  type ContourDeclarationV1,
  type ContourInstanceV1,
  type ContourProfileV1,
} from "./contracts";
import { DEV_LIVE_COMPONENT_MANIFEST, DEV_LIVE_PROFILE } from "./devLive";

export const PROD_SHADOW_CONTOUR_ID = "PROD_SHADOW" as const;

/** WHAT PROD_SHADOW composes: DEV_LIVE's policy, with money movement disabled. */
export const PROD_SHADOW_PROFILE: ContourProfileV1 = {
  schema: CONTOUR_PROFILE_SCHEMA,
  contourId: PROD_SHADOW_CONTOUR_ID,
  selectors: DEV_LIVE_PROFILE.selectors,
  capabilities: { moneyMovement: "disabled" },
  requiredComponents: DEV_LIVE_PROFILE.requiredComponents,
};

/** EXACTLY which shared components PROD_SHADOW is made of (the same set as DEV_LIVE). */
export const PROD_SHADOW_COMPONENT_MANIFEST: ComponentManifestV1 = {
  schema: COMPONENT_MANIFEST_SCHEMA,
  manifestId: "premvp-prod-shadow",
  version: "1.0.0",
  contourId: PROD_SHADOW_CONTOUR_ID,
  components: DEV_LIVE_COMPONENT_MANIFEST.components,
};

/** WHICH concrete (not yet provisioned) instance would run PROD_SHADOW. */
export const PROD_SHADOW_INSTANCE: ContourInstanceV1 = {
  schema: CONTOUR_INSTANCE_SCHEMA,
  instanceId: "PROD_SHADOW_PASSIVE",
  profileRef: { contourId: PROD_SHADOW_CONTOUR_ID },
  manifestRef: { manifestId: PROD_SHADOW_COMPONENT_MANIFEST.manifestId, version: PROD_SHADOW_COMPONENT_MANIFEST.version },
  runtime: {
    service: "polypropicks-premvp-shadow",
    repository: "POLYPROPICKS/PREMVP",
    scheduler: "UNPROVISIONED",
  },
  envBindings: {
    reservationTimesMinsk: "SHADOW_RESERVATION_TIMES_MINSK",
    executorCandidatesSecret: "SHADOW_EXECUTOR_CANDIDATES_SECRET",
    supabaseUrl: "SHADOW_SUPABASE_URL",
    supabaseServiceRoleKey: "SHADOW_SUPABASE_SERVICE_ROLE_KEY",
  },
};

export const PROD_SHADOW_DECLARATION: ContourDeclarationV1 = {
  profile: PROD_SHADOW_PROFILE,
  instance: PROD_SHADOW_INSTANCE,
  manifest: PROD_SHADOW_COMPONENT_MANIFEST,
};
