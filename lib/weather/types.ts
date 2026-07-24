import { createHash } from "node:crypto";

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
export interface SourceContract { id: string; venue: string; apiFamily: string; adapterVersion: string; schemaVersion: string; timestampSemantics: string; paginationContract: string; retryContract: string; activeClosedContract: string; normalizationBoundary: string; canonicalSerialization: string; contractHash: string; }
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("unsupported numeric value"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value) { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`; }
  throw new Error("unsupported canonical value");
}
export function sha256(value: unknown): string { return createHash("sha256").update(canonicalize(value)).digest("hex"); }
export function hashSourceContract(contract: SourceContract): string { const { contractHash: _ignored, ...semantic } = contract; return sha256(semantic); }
