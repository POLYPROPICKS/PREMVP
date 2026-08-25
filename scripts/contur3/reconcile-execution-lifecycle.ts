import { loadEnvConfig } from "@next/env";
import { reconcileExecutionLifecycle } from "../../lib/executor/executionLifecycle";

const TARGET_EVENT_IDS = [
  "a4aefc93-edfd-4967-8564-6077c8f00a24",
  "8261d5f8-020b-4e2e-9547-26d5d03d17db",
] as const;

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const writeMode = process.argv.includes("--write");
  const summary = await reconcileExecutionLifecycle(supabaseAdmin, {
    writeMode,
    eventIds: [...TARGET_EVENT_IDS],
    limit: TARGET_EVENT_IDS.length,
  });
  console.log(`[contur3:lifecycle] ${writeMode ? "WRITE" : "DRY_RUN"} ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error("[contur3:lifecycle] failed", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});
