// Constructor V1 runtime-instance boot: the ONE place that turns "which declaration does this
// process serve" into a validated, ready-to-use contour. Entry points (instrumentation, the
// process-wide Supabase client, the shadow boot check) call this instead of each re-deriving
// select -> compose -> validate by hand, so they cannot drift apart or bind a resource before the
// contour is selected and validated.
//
// Order is fixed: select (fail-closed) -> compose -> validate bindings (fail-closed for passive
// contours) -> describe. Pure over the env it is given; no I/O, no secrets, no client creation.

import { createSupabaseAdminClient } from "../supabase/adminClientFactory";
import type { ComposedContour } from "./contracts";
import { ACTIVE_CONTOUR_ENV, createContourResolver, getActiveContour } from "./registry";
import { describeRuntimeContract, validateContourRuntime, type RuntimeContractV1 } from "./runtimeContract";

export const CONSTRUCTOR_SELECTOR_NOT_EXPLICIT = "CONSTRUCTOR_SELECTOR_NOT_EXPLICIT" as const;

export type RuntimeSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Contour-bound resources of one booted instance. Lazy and memoized per runtime: nothing is created
 * (and no env value is read) until first use, and two runtimes never share a client.
 */
export interface RuntimeResourcesV1 {
  supabaseAdmin(): RuntimeSupabaseClient;
}

/** One booted Constructor instance: validated contour + its secret-free contract + its resources. */
export interface ContourRuntimeV1 {
  readonly contour: ComposedContour;
  readonly contract: RuntimeContractV1;
  readonly resources: RuntimeResourcesV1;
}

/** @deprecated name kept for existing callers; identical to ContourRuntimeV1. */
export type ContourRuntimeBoot = ContourRuntimeV1;

function assembleRuntime(contour: ComposedContour, env: Record<string, string | undefined>): ContourRuntimeV1 {
  let client: RuntimeSupabaseClient | null = null;
  const resources: RuntimeResourcesV1 = Object.freeze({
    supabaseAdmin: () => (client ??= createSupabaseAdminClient(contour, env)),
  });
  return Object.freeze({ contour, contract: describeRuntimeContract(contour), resources });
}

export interface BootOptions {
  /** Refuse to boot unless the selector env var is set (a passive service must never default to DEV). */
  readonly requireExplicitSelector?: boolean;
}

/**
 * Boot a contour from an explicit env. Independent per call, so two instances can be booted in one
 * process (tests, tooling). Does NOT touch the process-pinned selection.
 */
export function bootContourRuntime(
  env: Record<string, string | undefined> = process.env,
  options: BootOptions = {},
): ContourRuntimeV1 {
  if (options.requireExplicitSelector && env[ACTIVE_CONTOUR_ENV] === undefined) {
    throw new Error(`${CONSTRUCTOR_SELECTOR_NOT_EXPLICIT}: ${ACTIVE_CONTOUR_ENV} must be set explicitly`);
  }
  const contour = createContourResolver(env).activeContour();
  validateContourRuntime(contour, env);
  return assembleRuntime(contour, env);
}

let processBoot: ContourRuntimeV1 | null = null;

/**
 * Boot the contour THIS process serves (the pinned process selection) exactly once; later callers
 * get the same validated result. Money-enabled contours (DEV_LIVE) validate as a no-op, so DEV
 * startup semantics are unchanged.
 */
export function bootProcessRuntime(): ContourRuntimeV1 {
  if (!processBoot) {
    const contour = getActiveContour();
    validateContourRuntime(contour);
    processBoot = assembleRuntime(contour, process.env);
  }
  return processBoot;
}
