import { createHash } from "node:crypto";
import { supabaseAdmin } from "../supabase/server";
import { buildGeneratedSignalPairRows, type WritePairsInput } from "./cacheGeneratedSignals";

export type PrimaryServingPublicationResult = {
  servingProjectedCount: number;
  primaryEvidenceCapturedCount: number;
  durationMs: number;
};

function observationUuid(envelopeId: string, row: Record<string, unknown>): string {
  const identity = `${row.condition_id ?? ""}::${row.selected_token_id ?? ""}::${row.metric_formula_version ?? ""}`;
  const hex = createHash("sha256").update(`${envelopeId}::${identity}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildPrimaryEvidenceRows(envelopeId: string, input: WritePairsInput) {
  return buildGeneratedSignalPairRows(input).map((row) => ({
    ...row,
    observation_id: observationUuid(envelopeId, row),
  }));
}

export async function publishPrimaryEvidenceToServing(args: {
  observationId: string;
  observedAt: string;
  input: WritePairsInput;
}): Promise<PrimaryServingPublicationResult> {
  const startedAt = Date.now();
  const rows = buildPrimaryEvidenceRows(args.observationId, args.input);
  const { data, error } = await supabaseAdmin.rpc("publish_primary_signal_observation", {
    p_observation_id: args.observationId,
    p_observed_at: args.observedAt,
    p_rows: rows,
  });
  if (error) throw new Error(`DIRECT_SERVING_PUBLICATION_FAILED: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const servingProjectedCount = Number(record.serving_projected_n);
  const primaryEvidenceCapturedCount = Number(record.primary_evidence_captured_n);
  if (!Number.isInteger(servingProjectedCount) || servingProjectedCount < 0 ||
      !Number.isInteger(primaryEvidenceCapturedCount) || primaryEvidenceCapturedCount !== rows.length) {
    throw new Error("DIRECT_SERVING_PUBLICATION_INVALID_RESULT");
  }
  return { servingProjectedCount, primaryEvidenceCapturedCount, durationMs: Date.now() - startedAt };
}
