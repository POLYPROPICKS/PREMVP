// job_runs insert bound to an explicit client. Kept free of any process-global import so a
// Constructor runtime can write its own job evidence; cacheGeneratedSignals.writeJobRun delegates here
// with the process-wide client, so the row shape is defined once.

import type { JobRunInput } from "./cacheGeneratedSignals";

type JobRunClient = {
  from(table: "job_runs"): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
};

export async function writeJobRunWith(client: unknown, input: JobRunInput): Promise<void> {
  const { error } = await (client as JobRunClient).from("job_runs").insert({
    source: input.source,
    formula_version: input.formulaVersion,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    status: input.status,
    generated_count: input.generatedCount,
    rejected_count: input.rejectedCount,
    duration_ms: input.durationMs,
    error_message: input.errorMessage ?? null,
    diagnostics: input.diagnostics ?? null,
  });

  if (error) {
    throw new Error(`Failed to write job run: ${error.message}`);
  }
}
