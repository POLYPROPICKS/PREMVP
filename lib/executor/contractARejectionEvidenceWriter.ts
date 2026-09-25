// lib/executor/contractARejectionEvidenceWriter.ts
//
// DATA_CAPTURE_V2_REJECTION_EVIDENCE — fail-open transport for the compact
// contract_a_rejection_evidence table. Reuses the repo's established evidence
// conventions: the job_runs write in schedulerJobEvidence.ts and the
// persistReservationPlanDiagnostics writer are both non-fatal; a telemetry
// write failure likewise never changes which event is selected, which event is
// reserved, what the Queue emits or what Ireland executes.

import type { ContractARejectionEvidenceRow, ContractARejectionEvidenceWritePort } from "./contractARejectionEvidence";

const UPSERT_CHUNK = 500;

export function isContractARejectionEvidenceDisabled(): boolean {
  return process.env.CONTRACT_A_REJECTION_EVIDENCE_DISABLE === "1";
}

export function createSupabaseContractARejectionEvidencePort(): ContractARejectionEvidenceWritePort {
  return {
    async upsert(rows) {
      if (rows.length === 0) return;
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const { error } = await supabaseAdmin
          .from("contract_a_rejection_evidence")
          .upsert(rows.slice(i, i + UPSERT_CHUNK) as unknown as Record<string, unknown>[], {
            onConflict: "rejection_key",
            ignoreDuplicates: true,
          });
        if (error) throw new Error(`CONTRACT_A_REJECTION_EVIDENCE_UPSERT_FAILED: ${error.message}`);
      }
    },
  };
}

export async function persistContractARejectionEvidenceFailOpen(
  rows: readonly ContractARejectionEvidenceRow[],
  port: ContractARejectionEvidenceWritePort = createSupabaseContractARejectionEvidencePort()
): Promise<{ attempted: boolean; written: number; errorSafe: string | null }> {
  if (rows.length === 0) return { attempted: false, written: 0, errorSafe: null };
  if (process.env.CONTRACT_A_REJECTION_EVIDENCE_DISABLE === "1") {
    return { attempted: false, written: 0, errorSafe: "CONTRACT_A_REJECTION_EVIDENCE_DISABLED_BY_ENV" };
  }
  try {
    await port.upsert(rows);
    return { attempted: true, written: rows.length, errorSafe: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.warn(
      "[contract-a-rejection-evidence] fail-open persistence failure:",
      message.slice(0, 180)
    );
    return { attempted: true, written: 0, errorSafe: message.slice(0, 180) };
  }
}
