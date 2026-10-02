// Constructor V1 declaration registry + active-contour selector.
//
// The registry is a finite, static, typed set of valid declarations: no discovery, no JSON
// loading, no I/O, no secrets. The selector chooses WHICH declaration a process serves; the chosen
// profile then governs policy and components. The two concerns stay separate.
//
// Selection is pinned when a resolver is created (process start for the default resolver).
// Re-selecting after startup is intentionally unsupported: process-wide resources such as
// `supabaseAdmin` bind to the contour once, so a late switch would split one process across two
// instances. One process serves one declaration.

import { composeContour, type ComposedContour, type ContourDeclarationV1 } from "./contracts";
import { DEV_LIVE_CONTOUR_ID, DEV_LIVE_DECLARATION } from "./devLive";
import { PROD_SHADOW_CONTOUR_ID, PROD_SHADOW_DECLARATION } from "./prodShadow";

/** Env var that names the declaration a process serves. Unset = DEV_LIVE (current behavior). */
export const ACTIVE_CONTOUR_ENV = "CONSTRUCTOR_ACTIVE_CONTOUR" as const;
export const DEFAULT_CONTOUR_ID = DEV_LIVE_CONTOUR_ID;
export const CONSTRUCTOR_CONTOUR_UNKNOWN = "CONSTRUCTOR_CONTOUR_UNKNOWN" as const;

export const CONTOUR_REGISTRY = {
  [DEV_LIVE_CONTOUR_ID]: DEV_LIVE_DECLARATION,
  [PROD_SHADOW_CONTOUR_ID]: PROD_SHADOW_DECLARATION,
} as const satisfies Record<string, ContourDeclarationV1>;

export type ContourDeclarationId = keyof typeof CONTOUR_REGISTRY;

function isRegistered(id: string): id is ContourDeclarationId {
  return Object.hasOwn(CONTOUR_REGISTRY, id);
}

/**
 * Pure selector. Unset => default (DEV_LIVE). Anything set that is not exactly a registered id
 * (typo, wrong case, blank, whitespace) fails closed; it never degrades to the default.
 */
export function resolveActiveContourId(
  env: Record<string, string | undefined> = process.env,
): ContourDeclarationId {
  const raw = env[ACTIVE_CONTOUR_ENV];
  if (raw === undefined) return DEFAULT_CONTOUR_ID;
  if (!isRegistered(raw)) {
    throw new Error(`${CONSTRUCTOR_CONTOUR_UNKNOWN}: ${ACTIVE_CONTOUR_ENV}=${JSON.stringify(raw)}`);
  }
  return raw;
}

const composed = new Map<ContourDeclarationId, ComposedContour>();

/** Compose a registered declaration (memoized per id; composition is pure and immutable). */
export function getContour(id: string): ComposedContour {
  if (!isRegistered(id)) throw new Error(`${CONSTRUCTOR_CONTOUR_UNKNOWN}: ${JSON.stringify(id)}`);
  let contour = composed.get(id);
  if (!contour) {
    const declaration: ContourDeclarationV1 = CONTOUR_REGISTRY[id];
    if (declaration.profile.contourId !== id) {
      throw new Error(`${CONSTRUCTOR_CONTOUR_UNKNOWN}: registry key ${id} != profile ${declaration.profile.contourId}`);
    }
    contour = composeContour(declaration);
    composed.set(id, contour);
  }
  return contour;
}

export interface ContourResolver {
  readonly contourId: ContourDeclarationId;
  activeContour(): ComposedContour;
}

/** Resolve the selector NOW and pin it; later env changes cannot move this resolver. */
export function createContourResolver(
  env: Record<string, string | undefined> = process.env,
): ContourResolver {
  const contourId = resolveActiveContourId(env);
  return { contourId, activeContour: () => getContour(contourId) };
}

let processResolver: ContourResolver | null = null;

/** The contour the running process serves: selected on first use, pinned for the process. */
export function getActiveContour(): ComposedContour {
  processResolver ??= createContourResolver();
  return processResolver.activeContour();
}
