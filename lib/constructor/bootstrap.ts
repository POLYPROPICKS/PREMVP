// Constructor V1 runtime-instance boot: the ONE place that turns "which declaration does this
// process serve" into a validated, ready-to-use contour. Entry points (instrumentation, the
// process-wide Supabase client, the shadow boot check) call this instead of each re-deriving
// select -> compose -> validate by hand, so they cannot drift apart or bind a resource before the
// contour is selected and validated.
//
// Order is fixed: select (fail-closed) -> compose -> validate bindings (fail-closed for passive
// contours) -> describe. Pure over the env it is given; no I/O, no secrets, no client creation.

import type { ComposedContour } from "./contracts";
import { ACTIVE_CONTOUR_ENV, createContourResolver, getActiveContour } from "./registry";
import { describeRuntimeContract, validateContourRuntime, type RuntimeContractV1 } from "./runtimeContract";

export const CONSTRUCTOR_SELECTOR_NOT_EXPLICIT = "CONSTRUCTOR_SELECTOR_NOT_EXPLICIT" as const;

export interface ContourRuntimeBoot {
  readonly contour: ComposedContour;
  readonly contract: RuntimeContractV1;
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
): ContourRuntimeBoot {
  if (options.requireExplicitSelector && env[ACTIVE_CONTOUR_ENV] === undefined) {
    throw new Error(`${CONSTRUCTOR_SELECTOR_NOT_EXPLICIT}: ${ACTIVE_CONTOUR_ENV} must be set explicitly`);
  }
  const contour = createContourResolver(env).activeContour();
  validateContourRuntime(contour, env);
  return { contour, contract: describeRuntimeContract(contour) };
}

let processBoot: ContourRuntimeBoot | null = null;

/**
 * Boot the contour THIS process serves (the pinned process selection) exactly once; later callers
 * get the same validated result. Money-enabled contours (DEV_LIVE) validate as a no-op, so DEV
 * startup semantics are unchanged.
 */
export function bootProcessRuntime(): ContourRuntimeBoot {
  if (!processBoot) {
    const contour = getActiveContour();
    validateContourRuntime(contour);
    processBoot = { contour, contract: describeRuntimeContract(contour) };
  }
  return processBoot;
}
