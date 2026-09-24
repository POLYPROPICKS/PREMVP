/**
 * ONE-OFF, READ-ONLY adjudication check for the PR #396 discrepancy between
 * the canonical repaired runner and an undocumented independent DB
 * cross-check. NOT a new modeling authority; NOT persisted as evidence;
 * reuses runner primitives verbatim. Tests one falsifiable hypothesis: that
 * some football physical events have MIXED settlement status across their
 * qualifying candidate rows (different market/token rows for the same event
 * settle at different times), so which row gets selected for the event
 * determines whether it counts as terminal or unresolved.
 */
import { toDecisionTimeSelectionInput } from "./factor-atlas";
import { SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import { fetchRows, loadReconciledClassificationMap, applyReconciledAuthority, classifyStatusForFinality } from "./tennis-safe-comparable-leaderboard";

async function main() {
  const rawRows = await fetchRows();
  const { candidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);
  const overlay = loadReconciledClassificationMap();
  const reconciled = applyReconciledAuthority(candidates, overlay);

  for (const [label, lo, hi] of [["P50_52", 0.5, 0.52], ["P50_54", 0.5, 0.54]] as const) {
    const qualifying = reconciled.eligible.filter((e) => e.sportFamily === SOCCER_FAMILY && e.entryPrice >= lo && e.entryPrice < hi);
    const byEvent = new Map<string, typeof qualifying>();
    for (const e of qualifying) {
      const list = byEvent.get(e.physicalEventKey);
      if (list) list.push(e);
      else byEvent.set(e.physicalEventKey, [e]);
    }
    let mixedEvents = 0;
    let flipFirstVsLast = 0;
    let multiRowEvents = 0;
    for (const rows of byEvent.values()) {
      if (rows.length < 2) continue;
      multiRowEvents++;
      const statuses = new Set(rows.map((r) => classifyStatusForFinality(settlementByCandidateIdentity.get(r.candidateIdentity)!)));
      const hasTerminal = [...statuses].some((s) => s !== "UNRESOLVED");
      const hasUnresolved = statuses.has("UNRESOLVED");
      if (hasTerminal && hasUnresolved) mixedEvents++;
      const sorted = [...rows].sort((a, b) => a.decisionTimestamp.localeCompare(b.decisionTimestamp));
      const firstStatus = classifyStatusForFinality(settlementByCandidateIdentity.get(sorted[0].candidateIdentity)!);
      const lastStatus = classifyStatusForFinality(settlementByCandidateIdentity.get(sorted[sorted.length - 1].candidateIdentity)!);
      if (firstStatus !== lastStatus) flipFirstVsLast++;
    }
    console.log(JSON.stringify({ label, totalQualifyingRows: qualifying.length, uniqueEvents: byEvent.size, multiRowEvents, mixedStatusEvents: mixedEvents, firstVsLastStatusFlips: flipFirstVsLast }));
  }
}
main().catch((e) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: String(e) })); process.exitCode = 1; });
