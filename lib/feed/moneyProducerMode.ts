export type SignalProducerMode = "money" | "research";

/** Normal scheduled runs are money-only. Research requires explicit opt-in. */
export function resolveSignalProducerMode(raw: string | undefined): SignalProducerMode {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "money") return "money";
  if (value === "research") return "research";
  throw new Error(`INVALID_SIGNAL_PRODUCER_MODE: ${raw}`);
}

export function isDatabaseTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:statement\s+timeout|timed?\s*out|timeout|57014)/i.test(message);
}
