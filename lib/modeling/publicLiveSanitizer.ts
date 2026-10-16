// Public-safe view of the Production LIVE runtime aggregate.
// The raw artifact (LIVE_RUNTIME_DATA.js / readLiveModelingRuntime) carries wallet balances, the production
// project ref and operational detail. The public dashboard only ever receives the output of this module.

const DROP_KEY = new RegExp([
  "^wallet$", "wallet", "spendable", "collateral", "allowance",
  "projectref", "^ref$", "secret", "token", "credential", "password", "apikey", "api_key", "servicerole", "service_role",
  "idempotency", "exchange", "clob_?order_?id", "order_?id", "reservation_?id", "queue_?id", "account", "address", "email",
  "path", "url", "host", "operator",
  "balance", "bankroll", "^cash", "funds", "equity", "usdc", "funder", "signer", "maker", "owner", "error",
].join("|"), "i");
const DROP_ID_SUFFIX = /^ids?$|[a-z0-9](Id|Ids|_id|_ids)$/;
const DROP_VALUE = new RegExp([
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", // uuid
  "0x[0-9a-fA-F]{16,}", // chain / order / token ids
  "eyJ[A-Za-z0-9_-]{10,}\\.", // jwt
  "sb_(secret|publishable)_", "supabase\\.co", "[A-Za-z]:\\\\", "/(Users|home|var|etc)/",
  "nbnldzfsxffztsfrrxqy", // production project ref, wherever it appears in free text
].join("|"));

// Free-text notes written on read failures embed raw driver errors; only static explanatory notes are published.
const RAW_ERROR_TEXT = /fail|error|exception|econn|timeout|denied|invalid/i;

function safeValue(v: unknown, key?: string): boolean {
  if (typeof v !== "string") return true;
  return !DROP_VALUE.test(v) && !(key === "note" && RAW_ERROR_TEXT.test(v));
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.filter(v => safeValue(v)).map(clean);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (DROP_KEY.test(key) || DROP_ID_SUFFIX.test(key) || !safeValue(value, key)) continue;
      out[key] = clean(value);
    }
    return out;
  }
  return node;
}

/** Reduces an operator-facing stop reason to its stable code so no env/config detail is published. */
function publicStopReason(reason: unknown): string {
  const code = typeof reason === "string" ? /^[A-Z][A-Z_]{2,48}/.exec(reason)?.[0] : undefined;
  return code ?? "RUNTIME_STOPPED";
}

export function sanitizePublicLive(raw: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const body = clean(raw) as Record<string, unknown>;
  const generatedAt = typeof body.GENERATED_AT === "string" ? Date.parse(body.GENERATED_AT) : NaN;
  const ageHours = Number.isFinite(generatedAt) ? Math.max(0, Math.round((now - generatedAt) / 3_600_000)) : null;
  const sanitized: Record<string, unknown> = {
    ...body,
    publicView: "AGGREGATE_ONLY_V1",
    publicRedactions: ["account balances", "infrastructure references", "account/order/exchange identifiers"],
    freshness: { generatedAt: body.GENERATED_AT ?? null, ageHours, stale: ageHours == null || ageHours > 36 },
  };
  if ("stopReason" in sanitized) sanitized.stopReason = publicStopReason(raw.stopReason);
  if (sanitized.lastRefreshAttempt && typeof sanitized.lastRefreshAttempt === "object") {
    (sanitized.lastRefreshAttempt as Record<string, unknown>).stopReason = publicStopReason(
      (raw.lastRefreshAttempt as Record<string, unknown> | undefined)?.stopReason,
    );
  }
  return sanitized;
}

const LIVE_ASSIGN = /window\.POLYPROPICKS_LIVE_RUNTIME_DATA\s*=\s*/;

/** Sanitizes the committed LIVE_RUNTIME_DATA.js file text; returns a minimal STOPPED artifact if it cannot be parsed. */
export function sanitizePublicLiveAsset(source: string, now = Date.now()): string {
  let body: Record<string, unknown>;
  try {
    const m = LIVE_ASSIGN.exec(source);
    if (!m) throw new Error("no assignment");
    body = JSON.parse(source.slice(m.index + m[0].length).replace(/;\s*$/, ""));
  } catch {
    body = { ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: "LIVE_SNAPSHOT_UNREADABLE", days: [] };
  }
  return `/* LIVE_RUNTIME_DATA_V1 — public aggregate-only view; sensitive fields removed server-side. */\nwindow.POLYPROPICKS_LIVE_RUNTIME_DATA = ${JSON.stringify(sanitizePublicLive(body, now), null, 2)};\n`;
}
