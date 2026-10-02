// Constructor V1 runtime scope: lets ONE explicit ContourRuntimeV1 own every Supabase access made by
// shared business code (signal producer, serving projection, evidence publication) without threading a
// client through each signature. Inside runWithContourRuntime(runtime, fn) the runtime's client is the
// only client `scopedSupabaseAdmin()` returns; outside any scope it falls back to the process-wide
// client, so DEV behaviour is unchanged. The scope is async-context local: a process-global selector or
// client cannot leak into a scoped call, and two scopes in one process never see each other.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ContourRuntimeV1, RuntimeSupabaseClient } from "./bootstrap";

const scope = new AsyncLocalStorage<ContourRuntimeV1>();

export function runWithContourRuntime<T>(runtime: ContourRuntimeV1, fn: () => T): T {
  return scope.run(runtime, fn);
}

export function currentScopedRuntime(): ContourRuntimeV1 | undefined {
  return scope.getStore();
}

/** The scoped runtime's client; the process-wide client only when no runtime scope is active. */
export async function scopedSupabaseAdmin(): Promise<RuntimeSupabaseClient> {
  const runtime = scope.getStore();
  if (runtime) return runtime.resources.supabaseAdmin();
  const { supabaseAdmin } = await import("../supabase/server");
  return supabaseAdmin;
}
