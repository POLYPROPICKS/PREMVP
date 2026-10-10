// Dedicated, research-only sports state listener. Run with: npx tsx scripts/research-inplay-core-path.ts
import { createClient } from "@supabase/supabase-js";
import { captureInplayCorePath, deriveStructuredState, STATE_MAX_AGE_MS, type InplayAdmissionReason, type SportsState } from "../lib/research/inplayCorePath";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("INPLAY_PRODUCTION_DB_CONFIG_MISSING");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const latest = new Map<string, SportsState>();
const receivedAt = new Map<string, number>();
const pending: string[] = [];
const processing = new Set<string>();
let socket: WebSocket | null = null;
let stopped = false;
let busy = false;
// Aggregate admission diagnostics (T20-cohort gate): rejection and cohort-read failures stay visible.
const admissionCounts: Record<InplayAdmissionReason, number> = { ALREADY_ADMITTED: 0, T20_COHORT_MEMBER: 0, NOT_IN_T20_COHORT: 0, COHORT_READ_FAILED: 0 };
let lastAdmissionLogAt = 0;
const countAdmission = (reason: InplayAdmissionReason): void => { admissionCounts[reason]++; };

function connect(): void {
  if (stopped) return;
  socket = new WebSocket("wss://sports-api.polymarket.com/ws");
  socket.onmessage = (message) => {
    try {
      const raw: unknown = JSON.parse(String(message.data));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const state = deriveStructuredState(raw as SportsState);
      if (!state) return;
      latest.set(state.gameId, raw as SportsState);
      receivedAt.set(state.gameId, Date.now());
      if (!pending.includes(state.gameId) && !processing.has(state.gameId)) pending.push(state.gameId);
      if (latest.size > 100 || pending.length > 100) {
        const oldest = pending.shift();
        if (oldest) { latest.delete(oldest); receivedAt.delete(oldest); }
      }
    } catch { /* malformed provider message is ignored */ }
  };
  socket.onclose = () => { socket = null; if (!stopped) setTimeout(connect, 5_000); };
  socket.onerror = () => socket?.close();
}

async function loop(): Promise<void> {
  if (stopped || busy) return;
  busy = true;
  const deadline = Date.now() + 25_000;
  try {
    const work: Array<{ id: string; state: SportsState; receivedAtMs: number }> = [];
    while (pending.length && work.length < 3) {
      const id = pending.shift()!;
      const state = latest.get(id);
      if (!state) continue;
      const receivedAtMs = receivedAt.get(id) ?? 0;
      if (Date.now() - receivedAtMs > STATE_MAX_AGE_MS) { latest.delete(id); receivedAt.delete(id); continue; }
      processing.add(id);
      work.push({ id, state, receivedAtMs });
    }
    await Promise.allSettled(work.map(async ({ id, state, receivedAtMs }) => {
      try {
        await captureInplayCorePath(state, db, Date.now(), () => !stopped && Date.now() < deadline, receivedAtMs, countAdmission);
        if (state.ended === true) { latest.delete(id); receivedAt.delete(id); }
        else if (!pending.includes(id)) pending.push(id);
      } catch (error) { console.error("INPLAY_CAPTURE_FAILED", error instanceof Error ? error.message : "UNKNOWN"); }
      finally { processing.delete(id); }
    }));
  } finally {
    busy = false;
    if (Date.now() - lastAdmissionLogAt >= 5 * 60_000) { lastAdmissionLogAt = Date.now(); console.log("INPLAY_ADMISSION_COUNTS", JSON.stringify(admissionCounts)); }
  }
}

function shutdown(): void {
  stopped = true;
  clearInterval(timer);
  socket?.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const timer = setInterval(() => { void loop(); }, 30_000);
connect();
