// Constructor-bound Supabase admin client factory. Resolves the project URL and service-role key
// through the contour instance's declared env bindings, so shared code never names the env vars
// and a second instance can bind different ones. Side-effect free at import; server-only (the
// service-role key must never reach browser code).

import { createClient } from "@supabase/supabase-js";
import type { ComposedContour } from "../constructor/contracts";

export const SUPABASE_ADMIN_BINDING_V1 = "SUPABASE_ADMIN_BINDING_V1" as const;

export function createSupabaseAdminClient(
  contour: ComposedContour,
  env: Record<string, string | undefined> = process.env,
){
  const url = contour.requireEnv("supabaseUrl", env);
  const serviceKey = contour.requireEnv("supabaseServiceRoleKey", env);
  // Server-only admin client with elevated privileges
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
