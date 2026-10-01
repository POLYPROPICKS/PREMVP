import { loadEnvConfig } from "@next/env";
import { reconcileExecutionLifecycle } from "../../lib/executor/executionLifecycle";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const writeMode = process.argv.includes("--write");
  const eventId = process.argv.find((arg) => arg.startsWith("--event-id="))?.slice("--event-id=".length);
  const summary = await reconcileExecutionLifecycle(supabaseAdmin, {
    writeMode,
    eventIds: eventId ? [eventId] : undefined,
    limit: eventId ? 1 : 20,
  });
  console.log(`[contur3:lifecycle] ${writeMode ? "WRITE" : "DRY_RUN"} ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error("[contur3:lifecycle] failed", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});
