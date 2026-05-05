// Server-only Supabase admin client
// Uses SERVICE_ROLE_KEY - must never be exposed to browser code

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("Missing required environment variable: SUPABASE_URL");
}

if (!supabaseServiceKey) {
  throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
}

// Server-only admin client with elevated privileges
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
