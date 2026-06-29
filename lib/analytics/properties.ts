// Safe shared analytics property helpers.
//
// Rule: analytics properties must never contain PII (raw email, card data) or
// secrets. For referral/lead flows we only record presence, never the value.

// Derive non-PII signal from an email input. We capture only whether an email
// was provided — never the address itself, and (per current project policy) not
// the domain either.
export function referralEmailProps(email: unknown): { has_email: boolean } {
  return {
    has_email: typeof email === "string" && email.trim().includes("@"),
  };
}
