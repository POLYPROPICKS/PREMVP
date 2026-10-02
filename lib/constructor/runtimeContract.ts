// Constructor V1 runtime contract + fail-closed startup validation for PASSIVE contours.
//
// `describeRuntimeContract` answers "how do I boot this contour safely?" from the declaration alone
// (env-var NAMES only, never values). `validateContourRuntime` is the startup gate:
//
//   - the default contour with money movement (DEV_LIVE): returns immediately. DEV startup semantics are unchanged.
//   - every other contour (PROD_SHADOW, any future non-default one): the process must be fully and exclusively bound to its OWN
//     dedicated resources. Missing required bindings fail; any other declaration's binding present in
//     the environment fails. A passive process can therefore never silently run on DEV resources,
//     including through code that still reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY directly.
//
// Topology: SHADOW_DATA_TOPOLOGY = DEDICATED. A contour owns exactly one Supabase URL/key pair
// (ContourEnvBindingsV1) that every `supabaseAdmin` consumer in the process uses for reads AND
// writes, and Constructor has no read-only binding, so a shared-read split would need a client/proxy
// layer that does not exist. The shadow therefore gets its own project.

import type { ComposedContour, ContourEnvBindingsV1 } from "./contracts";
import { ACTIVE_CONTOUR_ENV, CONTOUR_REGISTRY, DEFAULT_CONTOUR_ID } from "./registry";

/**
 * A process serving ANY non-default contour (or any contour without money movement) must be bound
 * exclusively to its own declared resources. Only the default contour (DEV_LIVE) may coexist with
 * ambient env, because the ambient SUPABASE_* / EXECUTOR_* names ARE its bindings.
 */
export function requiresExclusiveBinding(contour: ComposedContour): boolean {
  return contour.profile.contourId !== DEFAULT_CONTOUR_ID || contour.profile.capabilities.moneyMovement !== "enabled";
}

export const CONSTRUCTOR_RUNTIME_INVALID = "CONSTRUCTOR_RUNTIME_INVALID" as const;

/** Bindings a process must have to serve a contour. */
export const REQUIRED_RUNTIME_BINDINGS = [
  "supabaseUrl",
  "supabaseServiceRoleKey",
  "executorCandidatesSecret",
] as const satisfies readonly (keyof ContourEnvBindingsV1)[];

/**
 * Optional on purpose, not by ambient fallback: when the schedule binding is absent the planner
 * uses its historical default anchor (see nightWindow.parseReservationTimes), never another
 * contour's value.
 */
export const OPTIONAL_RUNTIME_BINDINGS = [
  "reservationTimesMinsk",
] as const satisfies readonly (keyof ContourEnvBindingsV1)[];

export interface RuntimeContractV1 {
  readonly contourId: string;
  readonly instanceId: string;
  readonly manifest: { readonly manifestId: string; readonly version: string; readonly digest: string };
  readonly moneyMovement: "enabled" | "disabled";
  readonly selector: { readonly envVar: typeof ACTIVE_CONTOUR_ENV; readonly value: string };
  readonly runtime: { readonly service: string; readonly repository: string; readonly scheduler: string };
  readonly bindings: Readonly<Record<keyof ContourEnvBindingsV1, { readonly envVar: string; readonly required: boolean }>>;
  /** Env vars that must NOT be set in this process (other declarations' bindings). */
  readonly forbiddenAmbientEnv: readonly string[];
  readonly expectedBehavior: readonly string[];
}

const BINDING_KEYS = [...REQUIRED_RUNTIME_BINDINGS, ...OPTIONAL_RUNTIME_BINDINGS] as const;

function foreignBindingNames(contour: ComposedContour): { name: string; owner: string }[] {
  const out: { name: string; owner: string }[] = [];
  for (const declaration of Object.values(CONTOUR_REGISTRY)) {
    if (declaration.profile.contourId === contour.profile.contourId) continue;
    for (const name of Object.values(declaration.instance.envBindings)) {
      out.push({ name, owner: declaration.profile.contourId });
    }
  }
  return out;
}

export function describeRuntimeContract(contour: ComposedContour): RuntimeContractV1 {
  const passive = requiresExclusiveBinding(contour);
  const bindings = {} as Record<keyof ContourEnvBindingsV1, { envVar: string; required: boolean }>;
  for (const key of BINDING_KEYS) {
    bindings[key] = {
      envVar: contour.instance.envBindings[key],
      required: (REQUIRED_RUNTIME_BINDINGS as readonly string[]).includes(key),
    };
  }
  return {
    contourId: contour.profile.contourId,
    instanceId: contour.instance.instanceId,
    manifest: {
      manifestId: contour.manifest.manifestId,
      version: contour.manifest.version,
      digest: contour.manifestDigest,
    },
    moneyMovement: contour.profile.capabilities.moneyMovement,
    selector: { envVar: ACTIVE_CONTOUR_ENV, value: contour.profile.contourId },
    runtime: { ...contour.instance.runtime },
    bindings,
    forbiddenAmbientEnv: passive ? foreignBindingNames(contour).map((b) => b.name) : [],
    expectedBehavior: passive
      ? [
          "may compose, read, calculate and observe through the shared engine",
          "cannot admit an executable queue row: admitExecutableQueueRow throws CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED",
          "GET /api/executor/queue returns 403 before any DB read",
          "never reads another contour's binding names; startup fails if any is present",
        ]
      : ["money movement enabled; startup semantics unchanged"],
  };
}

function invalid(reason: string): never {
  throw new Error(`${CONSTRUCTOR_RUNTIME_INVALID}: ${reason}`);
}

/** Startup gate. No-op for money-enabled contours; strict for passive ones. */
export function validateContourRuntime(
  contour: ComposedContour,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!requiresExclusiveBinding(contour)) return;

  const own = new Set(Object.values(contour.instance.envBindings));
  const foreign = foreignBindingNames(contour);

  for (const { name, owner } of foreign) {
    if (own.has(name)) invalid(`BINDING_NAME_SHARED_WITH:${owner}:${name}`);
  }
  const ambient = foreign.filter(({ name }) => (env[name] ?? "") !== "").map(({ name }) => name);
  if (ambient.length > 0) invalid(`AMBIENT_FOREIGN_BINDING_PRESENT:${ambient.join(",")}`);

  const missing = REQUIRED_RUNTIME_BINDINGS
    .map((key) => contour.instance.envBindings[key])
    .filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) invalid(`MISSING_REQUIRED_BINDINGS:${missing.join(",")}`);
}
