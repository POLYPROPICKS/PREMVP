import type { ContractARejectionEvidenceRow, ContractARejectionEvidenceWritePort } from "./contractARejectionEvidence";

const UPSERT_CHUNK = 500;

export function createSupabaseContractARejectionEvidencePort(
  getClient?: () => unknown | Promise<unknown>,
): ContractARejectionEvidenceWritePort {
  return {
    async upsert(rows) {
      // Runtime-bound when a client getter is supplied; otherwise the process-wide client (legacy).
      const supabaseAdmin = (getClient ? await getClient() : (await import("@/lib/supabase/server")).supabaseAdmin) as typeof import("@/lib/supabase/server").supabaseAdmin;
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
  try {
    await port.upsert(rows);
    return { attempted: true, written: rows.length, errorSafe: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.warn("[contract-a-rejection-evidence] fail-open persistence failure:", message.slice(0, 180));
    return { attempted: true, written: 0, errorSafe: message.slice(0, 180) };
  }
}
