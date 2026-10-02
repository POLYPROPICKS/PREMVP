// Shared fail-closed gate for executor CALLBACK routes (queue mark, order-events). Both run BEFORE any
// lifecycle mutation (queue status, order event, maker-fallback, ledger):
//   - rejectPassiveCallback: a contour without money movement never accepts execution-lifecycle input.
//   - rejectContourMismatch: the executor's echoed contour_id must match the contour this process serves
//     (see lib/constructor/contourIdentity.ts for the explicit DEV legacy-compatibility rule).

import { NextResponse } from "next/server";
import { assertMoneyMovementEnabled } from "@/lib/constructor/contracts";
import { checkCallbackContour } from "@/lib/constructor/contourIdentity";
import { getActiveContour } from "@/lib/constructor/registry";

export function rejectPassiveCallback(boundary: string): NextResponse | null {
  try {
    assertMoneyMovementEnabled(getActiveContour(), boundary);
    return null;
  } catch (error) {
    return NextResponse.json({ ok: false, success: false, error: (error as Error).message }, { status: 403 });
  }
}

export function rejectContourMismatch(received: unknown): NextResponse | null {
  const contour = getActiveContour();
  const verdict = checkCallbackContour(contour, received);
  if (verdict.ok) return null;
  return NextResponse.json(
    { ok: false, success: false, error: verdict.code, expected_contour_id: contour.profile.contourId },
    { status: 409 },
  );
}
