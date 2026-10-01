// Server-only Supabase admin client
// Uses SERVICE_ROLE_KEY - must never be exposed to browser code
//
// Constructor V1: this process-wide client is the ACTIVE contour's client. The env-var names come
// from the active ContourInstanceV1 bindings (DEV_LIVE: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY),
// resolved by the factory. A second instance in the same process must call
// createSupabaseAdminClient(itsContour) rather than reuse this export.

import { getActiveContour } from "../constructor/devLive";
import { createSupabaseAdminClient } from "./adminClientFactory";

export const supabaseAdmin = createSupabaseAdminClient(getActiveContour());
