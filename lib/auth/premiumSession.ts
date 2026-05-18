import { createHmac, timingSafeEqual } from "crypto";

export type PremiumSessionPayload = {
  checkoutSessionId: string;
  email: string | null;
  activePlan: string | null;
  accessUntil: string | null;
  issuedAt: number;
};

function getSecret(): string {
  const s = process.env.PPP_SESSION_SECRET;
  if (!s || s.trim().length < 16) {
    throw new Error("PPP_SESSION_SECRET is not set or too short");
  }
  return s;
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function signPremiumSession(payload: PremiumSessionPayload): string {
  if (!payload.checkoutSessionId) throw new Error("checkoutSessionId required");
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString("base64url");
  const sig = hmac(getSecret(), encoded);
  return `${encoded}.${sig}`;
}

export function verifyPremiumSession(token: string): PremiumSessionPayload {
  if (!token || !token.includes(".")) throw new Error("malformed token");

  const dot = token.lastIndexOf(".");
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = hmac(getSecret(), encoded);
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (sigBuf.length !== expectedBuf.length) throw new Error("invalid signature");
  if (!timingSafeEqual(sigBuf, expectedBuf)) throw new Error("invalid signature");

  let payload: PremiumSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed payload");
  }

  if (!payload.checkoutSessionId) throw new Error("missing checkoutSessionId");

  if (payload.accessUntil) {
    const until = new Date(payload.accessUntil);
    if (isNaN(until.getTime()) || until <= new Date()) {
      throw new Error("session expired");
    }
  }

  return payload;
}
