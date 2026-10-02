// Constructor V1 contracts: a contour is composed from three explicit, versioned
// declarations and nothing else.
//
//   ContourProfileV1     WHAT the contour is allowed to compose (policy, env-neutral).
//   ContourInstanceV1    WHICH concrete instance is running (identity + env-key bindings).
//   ComponentManifestV1  EXACTLY which shared components make up the composition.
//
// `composeContour` is the only way to obtain a ComposedContour. It fails closed
// on any inconsistency between the three declarations. No secrets and no
// executable engine logic live here: the instance carries env-var NAMES only.

import { createHash } from "node:crypto";
import type { FireModelSelectorMode } from "../executor/buildFireModelCandidates";

export const CONTOUR_PROFILE_SCHEMA = "CONTOUR_PROFILE_V1" as const;
export const CONTOUR_INSTANCE_SCHEMA = "CONTOUR_INSTANCE_V1" as const;
export const COMPONENT_MANIFEST_SCHEMA = "COMPONENT_MANIFEST_V1" as const;

export const CONSTRUCTOR_COMPOSE_INVALID = "CONSTRUCTOR_COMPOSE_INVALID" as const;
export const CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED = "CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED" as const;

/** May a contour cause real-money execution? The only capability Constructor V1 knows. */
export type MoneyMovementCapability = "enabled" | "disabled";

export interface ContourProfileV1 {
  readonly schema: typeof CONTOUR_PROFILE_SCHEMA;
  readonly contourId: string;
  /** Selector modes the shared engine must be driven with for this contour. */
  readonly selectors: {
    readonly planning: FireModelSelectorMode;
    readonly final: FireModelSelectorMode;
  };
  /**
   * What this contour is allowed to do. `moneyMovement: "disabled"` makes it a passive contour:
   * it may plan and observe but can never admit an executable queue row (see
   * `assertMoneyMovementEnabled`). Carries no wallet, amount or venue detail.
   */
  readonly capabilities: {
    readonly moneyMovement: MoneyMovementCapability;
  };
  /** Manifest component ids this contour requires; composition fails if any is absent. */
  readonly requiredComponents: readonly string[];
}

/**
 * Logical env bindings an instance declares. Values are env-var NAMES, never secrets or values.
 * Shared code addresses a binding by its logical key and never names the env var itself.
 */
export interface ContourEnvBindingsV1 {
  /** Reservation anchor schedule ("HH:MM,HH:MM"); absent value = historical 17:00 default. */
  readonly reservationTimesMinsk: string;
  /** Shared secret expected in the x-executor-secret header on executor/cron routes. */
  readonly executorCandidatesSecret: string;
  /** Supabase project URL for this instance's admin client. */
  readonly supabaseUrl: string;
  /** Supabase service-role key for this instance's admin client. */
  readonly supabaseServiceRoleKey: string;
}

export interface ContourInstanceV1 {
  readonly schema: typeof CONTOUR_INSTANCE_SCHEMA;
  readonly instanceId: string;
  readonly profileRef: { readonly contourId: string };
  readonly manifestRef: { readonly manifestId: string; readonly version: string };
  readonly runtime: {
    readonly service: string;
    readonly repository: string;
    readonly scheduler: string;
  };
  readonly envBindings: ContourEnvBindingsV1;
}

export interface ManifestComponentV1 {
  readonly id: string;
  readonly role: string;
  /** Repo-relative module path that implements the component. */
  readonly module: string;
  /** Exported symbol in `module` (omitted for non-code components). */
  readonly symbol?: string;
  /** Contract/version identity the component is pinned to. */
  readonly contractVersion: string;
}

export interface ComponentManifestV1 {
  readonly schema: typeof COMPONENT_MANIFEST_SCHEMA;
  readonly manifestId: string;
  readonly version: string;
  readonly contourId: string;
  readonly components: readonly ManifestComponentV1[];
}

export interface ContourDeclarationV1 {
  readonly profile: ContourProfileV1;
  readonly instance: ContourInstanceV1;
  readonly manifest: ComponentManifestV1;
}

export interface ComposedContour {
  readonly profile: ContourProfileV1;
  readonly instance: ContourInstanceV1;
  readonly manifest: ComponentManifestV1;
  /** sha256 of the canonical manifest JSON: the deterministic composition fingerprint. */
  readonly manifestDigest: string;
  /** `<contourId>/<instanceId>@<first 12 of manifestDigest>` */
  readonly identity: string;
  component(id: string): ManifestComponentV1;
  /** Resolve a logical binding to its value through the instance's declared env-var name. */
  resolveEnv(binding: keyof ContourEnvBindingsV1, env?: Record<string, string | undefined>): string | undefined;
  /** Like resolveEnv, but fails closed (`Missing required environment variable: <NAME>`) when absent/empty. */
  requireEnv(binding: keyof ContourEnvBindingsV1, env?: Record<string, string | undefined>): string;
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Every logical binding an instance must declare; composition fails if one is missing. */
export const REQUIRED_ENV_BINDINGS = [
  "reservationTimesMinsk",
  "executorCandidatesSecret",
  "supabaseUrl",
  "supabaseServiceRoleKey",
] as const satisfies readonly (keyof ContourEnvBindingsV1)[];

function invalid(reason: string): never {
  throw new Error(`${CONSTRUCTOR_COMPOSE_INVALID}: ${reason}`);
}

/** Canonical JSON: object keys sorted recursively; array order preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeManifestDigest(manifest: ComponentManifestV1): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function composeContour(declaration: ContourDeclarationV1): ComposedContour {
  const { profile, instance, manifest } = declaration;

  if (profile.schema !== CONTOUR_PROFILE_SCHEMA) invalid("PROFILE_SCHEMA");
  if (instance.schema !== CONTOUR_INSTANCE_SCHEMA) invalid("INSTANCE_SCHEMA");
  if (manifest.schema !== COMPONENT_MANIFEST_SCHEMA) invalid("MANIFEST_SCHEMA");
  if (profile.capabilities?.moneyMovement !== "enabled" && profile.capabilities?.moneyMovement !== "disabled") {
    invalid("CAPABILITY_MONEY_MOVEMENT_INVALID");
  }
  if (!profile.contourId || !instance.instanceId || !manifest.manifestId || !manifest.version) invalid("EMPTY_IDENTITY");

  if (instance.profileRef.contourId !== profile.contourId) invalid("INSTANCE_PROFILE_MISMATCH");
  if (manifest.contourId !== profile.contourId) invalid("MANIFEST_PROFILE_MISMATCH");
  if (
    instance.manifestRef.manifestId !== manifest.manifestId ||
    instance.manifestRef.version !== manifest.version
  ) invalid("INSTANCE_MANIFEST_MISMATCH");

  const byId = new Map<string, ManifestComponentV1>();
  for (const c of manifest.components) {
    if (!c.id || !c.module || !c.contractVersion) invalid(`COMPONENT_INCOMPLETE:${c.id || "?"}`);
    if (byId.has(c.id)) invalid(`COMPONENT_DUPLICATE:${c.id}`);
    byId.set(c.id, c);
  }
  for (const id of profile.requiredComponents) {
    if (!byId.has(id)) invalid(`REQUIRED_COMPONENT_MISSING:${id}`);
  }

  // The profile's selector policy must be exactly what the manifest pins.
  if (byId.get("selector.planning")?.contractVersion !== profile.selectors.planning) {
    invalid("SELECTOR_PLANNING_NOT_PINNED_BY_MANIFEST");
  }
  if (byId.get("selector.final")?.contractVersion !== profile.selectors.final) {
    invalid("SELECTOR_FINAL_NOT_PINNED_BY_MANIFEST");
  }

  for (const key of REQUIRED_ENV_BINDINGS) {
    if (!(key in instance.envBindings)) invalid(`ENV_BINDING_MISSING:${key}`);
  }
  for (const [binding, name] of Object.entries(instance.envBindings)) {
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) invalid(`ENV_BINDING_NOT_AN_ENV_NAME:${binding}`);
  }

  const manifestDigest = computeManifestDigest(manifest);
  const frozen = deepFreeze({
    profile: structuredClone(profile),
    instance: structuredClone(instance),
    manifest: structuredClone(manifest),
  });

  return {
    ...frozen,
    manifestDigest,
    identity: `${profile.contourId}/${instance.instanceId}@${manifestDigest.slice(0, 12)}`,
    component(id: string) {
      const c = byId.get(id);
      if (!c) invalid(`UNKNOWN_COMPONENT:${id}`);
      return c;
    },
    resolveEnv(binding, env = process.env) {
      return env[instance.envBindings[binding]];
    },
    requireEnv(binding, env = process.env) {
      const name = instance.envBindings[binding];
      const value = env[name];
      if (!value) throw new Error(`Missing required environment variable: ${name}`);
      return value;
    },
  };
}

/**
 * Fail-closed money boundary. Throws unless the contour's capability is exactly "enabled", so a
 * missing, malformed or "disabled" capability all block. Call it immediately before any step that
 * makes an instruction executable (queue admission) or hands one to the executor.
 */
export function assertMoneyMovementEnabled(contour: ComposedContour, boundary: string): void {
  if (contour.profile.capabilities.moneyMovement !== "enabled") {
    throw new Error(`${CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED}: ${boundary} contour=${contour.identity}`);
  }
}
