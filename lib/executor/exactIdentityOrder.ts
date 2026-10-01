/** Residual identity order shared by the Reservation manifest and one T3 snapshot. */
export function compareExactIdentity(
  a: { condition_id: string; token_id: string },
  b: { condition_id: string; token_id: string },
): number {
  return a.condition_id.localeCompare(b.condition_id) || a.token_id.localeCompare(b.token_id);
}
