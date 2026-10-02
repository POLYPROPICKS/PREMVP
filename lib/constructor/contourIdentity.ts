// Constructor V1 contour identity continuity at the PREMVP execution boundary.
//
// Dedicated topology means a Queue row's originating contour is the contour whose database holds it,
// i.e. the contour this process serves. PREMVP therefore stamps that id on every Queue response
// (`contour_id`) and expects the executor to echo it on every callback (queue mark, order-events).
//
//   - echoed id === serving contour            -> accepted
//   - echoed id !== serving contour            -> CONTOUR_ID_MISMATCH, fail closed (409), zero mutation
//   - echoed id absent, serving the DEFAULT    -> accepted as LEGACY_UNSPECIFIED (executors that predate
//                                                  the field keep working; absence is NOT read as any contour)
//   - echoed id absent, serving a NON-default  -> CONTOUR_ID_REQUIRED, fail closed
//   - echoed id present but not a non-empty string -> CONTOUR_ID_MALFORMED, fail closed

import type { ComposedContour } from "./contracts";
import { DEFAULT_CONTOUR_ID } from "./registry";

export const CONTOUR_ID_MISMATCH = "CONTOUR_ID_MISMATCH" as const;
export const CONTOUR_ID_REQUIRED = "CONTOUR_ID_REQUIRED" as const;
export const CONTOUR_ID_MALFORMED = "CONTOUR_ID_MALFORMED" as const;

export type ContourIdentityVerdict =
  | { readonly ok: true; readonly basis: "MATCH" | "LEGACY_UNSPECIFIED" }
  | { readonly ok: false; readonly code: typeof CONTOUR_ID_MISMATCH | typeof CONTOUR_ID_REQUIRED | typeof CONTOUR_ID_MALFORMED };

export function checkCallbackContour(contour: ComposedContour, received: unknown): ContourIdentityVerdict {
  const expected = contour.profile.contourId;
  if (received === undefined || received === null) {
    return expected === DEFAULT_CONTOUR_ID
      ? { ok: true, basis: "LEGACY_UNSPECIFIED" }
      : { ok: false, code: CONTOUR_ID_REQUIRED };
  }
  if (typeof received !== "string" || received.trim() === "") return { ok: false, code: CONTOUR_ID_MALFORMED };
  return received === expected ? { ok: true, basis: "MATCH" } : { ok: false, code: CONTOUR_ID_MISMATCH };
}
