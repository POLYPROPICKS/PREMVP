import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { isFounderModelingSession, PRIVATE_MODELING_HEADERS } from "@/lib/auth/founderModeling";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CLONE_URL = "https://nppznoujvnyjargjkmnv.supabase.co";
// Supabase publishable keys are intentionally public. The table's RLS and
// column grants expose only the sanitized dashboard snapshot, never the ledger.
const CLONE_PUBLISHABLE_KEY = "sb_publishable_23QgBZl_1CeWQ0iTuOiBOw_2-x9-5oh";

export async function GET(req: NextRequest) {
  if (!isFounderModelingSession(req.cookies.get("ppp_session")?.value)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: PRIVATE_MODELING_HEADERS });
  }
  try {
    const db = createClient(
      CLONE_URL,
      process.env.SUPABASE_CLONE_PUBLISHABLE_KEY || CLONE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await db
      .from("prospective_selection_shadow_runtime")
      .select("snapshot_payload,updated_at")
      .eq("row_key", "CURRENT")
      .eq("row_kind", "SNAPSHOT")
      .limit(1)
      .maybeSingle();
    if (error || !data?.snapshot_payload) {
      return NextResponse.json({ status: "UNAVAILABLE" }, {
        status: 503,
        headers: PRIVATE_MODELING_HEADERS,
      });
    }
    return NextResponse.json({
      status: "OK",
      snapshot: data.snapshot_payload,
      persistedAt: data.updated_at,
    }, { headers: PRIVATE_MODELING_HEADERS });
  } catch {
    return NextResponse.json({ status: "UNAVAILABLE" }, {
      status: 503,
      headers: PRIVATE_MODELING_HEADERS,
    });
  }
}
