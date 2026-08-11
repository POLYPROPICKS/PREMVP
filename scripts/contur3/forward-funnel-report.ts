// Read-only replay of the production Contract A -> reservation planning seam.
import { loadEnvConfig } from "@next/env";
import { compareReservationSets, rowsForEventWindow, summarizeForwardFunnel } from "@/lib/executor/forwardFunnelReport";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function zonedUtc(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new Error("INVALID_DATE_OR_TIME");
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += wanted - shown;
  }
  return guess;
}

function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function reservationIds(plan: { reservations: Array<{ physical_event_id?: string | null }> }): string[] {
  return plan.reservations.map((reservation) => reservation.physical_event_id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function main() {
  const date = arg("date");
  const tz = arg("tz") ?? "Europe/Minsk";
  const at = arg("at");
  const compare = arg("compare");
  if (!date || !at || !compare) throw new Error("USAGE: npm run contur3:forward-funnel-report -- --date YYYY-MM-DD --tz IANA --at HH:MM --compare HH:MM");
  const startMs = zonedUtc(date, "00:00", tz);
  const endMs = zonedUtc(nextDate(date), "00:00", tz);
  const atMs = zonedUtc(date, at, tz);
  const compareMs = zonedUtc(date, compare, tz);
  loadEnvConfig(process.cwd());
  const { loadContractAPlanningSourceRows } = await import("@/lib/executor/buildFireModelCandidates");
  const { buildFireModelCandidates } = await import("@/lib/executor/buildFireModelCandidates");
  const { produceContractAPlanningDecisions } = await import("@/lib/executor/contractADecisions");
  const { buildReservationPlan } = await import("@/lib/executor/nightEventReservations");
  const sourceSnapshot = await loadContractAPlanningSourceRows(atMs);
  const { datedRows } = rowsForEventWindow(sourceSnapshot, startMs, endMs);
  const buildAt = async (nowMs: number) => {
    // Re-evaluate the same immutable source snapshot at each requested clock.
    // The source is fetched once; only the existing policy's time-dependent
    // predicates are replayed.
    const preContract = await buildFireModelCandidates(100_000, "all", true, datedRows, "CONTRACT_A_PLANNING_V1", nowMs);
    const decisions = await produceContractAPlanningDecisions(datedRows, 100_000, nowMs);
    const plan = await buildReservationPlan(nowMs, {
    selectorMode: "CONTRACT_A_PLANNING_V1",
    fetchSourceRows: async () => datedRows,
    produceDecisions: async () => decisions,
    });
    return { decisions, preContract, plan };
  };
  const [atPlan, comparePlan] = await Promise.all([buildAt(atMs), buildAt(compareMs)]);
  const atIds = reservationIds(atPlan.plan);
  const compareIds = reservationIds(comparePlan.plan);
  const summary = summarizeForwardFunnel({ rows: sourceSnapshot, decisions: atPlan.decisions, contractAFunctionInput: datedRows.length, preContractEligible: atPlan.preContract.candidates.length, reservationPhysicalEventIds: atIds, planningSelected: atPlan.plan.diagnostics.planning_eligible_events, startMs, endMs });
  const delta = compareReservationSets(atIds, compareIds);
  console.log(JSON.stringify({
    reporter: "contur3:forward-funnel-report",
    read_only: true,
    eval: { date, timezone: tz, event_start_gte: new Date(startMs).toISOString(), event_start_lt: new Date(endMs).toISOString(), at: new Date(atMs).toISOString(), compare: new Date(compareMs).toISOString() },
    ...summary,
    pre_contract_a_deduped_rows: datedRows.length - (atPlan.preContract.rawDiagnostics?.total_db_rows ?? datedRows.length),
    pre_contract_a_drop_reasons: atPlan.preContract.rawDiagnostics?.rejected_before_planning_by_reason ?? {},
    would_reserve_13_10: atIds.length,
    would_reserve_17_00: compareIds.length,
    delta,
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
