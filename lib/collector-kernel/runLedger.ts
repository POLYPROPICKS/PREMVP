export type RunState = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "STALE" | "SKIPPED_LOCKED";
export interface RunLedger { state: RunState; sourceContractId: string; sourceContractHash: string; gitSha: string; }
const terminal = new Set<RunState>(["SUCCEEDED", "PARTIAL", "FAILED", "STALE", "SKIPPED_LOCKED"]);
export function transitionRunLedger(run: RunLedger, next: RunState): RunLedger { if (!run.sourceContractId || !run.sourceContractHash || !run.gitSha) throw new Error("run provenance required"); if (terminal.has(run.state) || (run.state === "RUNNING" && next === "RUNNING")) throw new Error("invalid run transition"); return Object.freeze({ ...run, state: next }); }
