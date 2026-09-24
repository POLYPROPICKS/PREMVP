// Football Execution Matrix S1/S2/S3 — bounded prospective evidence contract.
//
// Scope: research-clone evidence capture only. This module does not place
// orders, does not touch live money, and does not select or alter the
// underlying signal. It consumes an already-frozen signal identity and
// produces immutable-once-recorded evidence rows for three shadow execution
// strategies (taker hold, fixed maker hold, maker value-band hold) against
// the SAME candidate/event/token identity.
//
// "Fill" semantics are strict: a market price merely reaching a target price
// is a FILL_OPPORTUNITY, never an ACTUAL_FILL. Only externally supplied,
// authoritative execution evidence (an actual matched order) may produce
// ACTUAL_FILL.

export type FillStatus =
  | "ACTUAL_FILL"
  | "FILL_OPPORTUNITY"
  | "NO_FILL"
  | "UNKNOWN";

export type TakeDecision = "TAKE" | "NO_TAKE";

/** The single frozen signal/candidate identity shared by S1, S2 and S3. */
export interface CandidateIdentity {
  readonly conditionId: string;
  readonly selectedTokenId: string;
  readonly providerEventId: string;
  /** Formula/version of the frozen signal this evidence is bound to. */
  readonly formulaVersion: string;
  readonly decisionTimeIso: string;
}

/** Authoritative proof that a real (or shadow-authorized) order was matched. */
export interface ExecutionFillEvidence {
  readonly filledDecimalOdds: number;
  readonly filledAtIso: string;
  readonly source: "executor_order_events" | "bet_execution_ledger" | "manual_review";
}

// ---------------------------------------------------------------------------
// Decimal odds contract
// ---------------------------------------------------------------------------

/**
 * Converts a CLOB share price (0,1) to decimal odds. Internal probability
 * representations stay implementation detail; decimal odds are the
 * first-class business field everywhere in this module's public surface.
 */
export function sharePriceToDecimalOdds(sharePrice: number): number {
  if (!(sharePrice > 0) || !(sharePrice < 1)) {
    throw new RangeError(`sharePriceToDecimalOdds: price out of (0,1) range: ${sharePrice}`);
  }
  return 1 / sharePrice;
}

export function decimalOddsToSharePrice(decimalOdds: number): number {
  if (!(decimalOdds > 1)) {
    throw new RangeError(`decimalOddsToSharePrice: decimal odds must be > 1: ${decimalOdds}`);
  }
  return 1 / decimalOdds;
}

// ---------------------------------------------------------------------------
// S1_TAKER_HOLD
// ---------------------------------------------------------------------------

export interface S1Input {
  readonly candidate: CandidateIdentity;
  readonly modelFairDecimalOdds: number;
  readonly availableDecimalOdds: number;
  readonly minAcceptableDecimalOdds: number;
  readonly spread?: number;
  readonly depth?: number;
  readonly fill?: ExecutionFillEvidence;
}

export interface S1Evidence {
  readonly strategy: "S1_TAKER_HOLD";
  readonly candidate: CandidateIdentity;
  readonly modelFairDecimalOdds: number;
  readonly availableDecimalOdds: number;
  readonly minAcceptableDecimalOdds: number;
  readonly spread: number | null;
  readonly depth: number | null;
  readonly decision: TakeDecision;
  /** Only set when `fill` (authoritative execution evidence) was supplied. */
  readonly actualFillDecimalOdds: number | null;
}

export function evaluateS1TakerHold(input: S1Input): S1Evidence {
  const decision: TakeDecision =
    input.availableDecimalOdds >= input.minAcceptableDecimalOdds ? "TAKE" : "NO_TAKE";

  return {
    strategy: "S1_TAKER_HOLD",
    candidate: input.candidate,
    modelFairDecimalOdds: input.modelFairDecimalOdds,
    availableDecimalOdds: input.availableDecimalOdds,
    minAcceptableDecimalOdds: input.minAcceptableDecimalOdds,
    spread: input.spread ?? null,
    depth: input.depth ?? null,
    decision,
    actualFillDecimalOdds: input.fill ? input.fill.filledDecimalOdds : null,
  };
}

// ---------------------------------------------------------------------------
// S2_FIXED_MAKER_HOLD
// ---------------------------------------------------------------------------

export const S2_INITIAL_TARGET_DECIMAL_ODDS = 2.0;

export interface S2Observation {
  readonly observedAtIso: string;
  readonly bestObservedDecimalOdds: number;
}

export interface S2Input {
  readonly candidate: CandidateIdentity;
  readonly targetDecimalOdds: number;
  readonly observations: readonly S2Observation[];
  readonly fill?: ExecutionFillEvidence;
}

export interface S2Evidence {
  readonly strategy: "S2_FIXED_MAKER_HOLD";
  readonly candidate: CandidateIdentity;
  readonly targetDecimalOdds: number;
  readonly observationTimesIso: readonly string[];
  readonly targetReachable: boolean;
  readonly bestObservedAcceptableDecimalOdds: number | null;
  readonly status: FillStatus;
  readonly actualFillDecimalOdds: number | null;
}

export function evaluateS2FixedMakerHold(input: S2Input): S2Evidence {
  const observationTimesIso = input.observations.map((o) => o.observedAtIso);

  const acceptableObservations = input.observations.filter(
    (o) => o.bestObservedDecimalOdds >= input.targetDecimalOdds,
  );
  const targetReachable = acceptableObservations.length > 0;

  const bestObservedAcceptableDecimalOdds = acceptableObservations.length
    ? Math.max(...acceptableObservations.map((o) => o.bestObservedDecimalOdds))
    : null;

  let status: FillStatus;
  if (input.fill) {
    // Authoritative execution evidence is required for ACTUAL_FILL — a mere
    // price touch is never sufficient, even when the target was reachable.
    status = "ACTUAL_FILL";
  } else if (targetReachable) {
    status = "FILL_OPPORTUNITY";
  } else if (observationTimesIso.length > 0) {
    status = "NO_FILL";
  } else {
    status = "UNKNOWN";
  }

  return {
    strategy: "S2_FIXED_MAKER_HOLD",
    candidate: input.candidate,
    targetDecimalOdds: input.targetDecimalOdds,
    observationTimesIso,
    targetReachable,
    bestObservedAcceptableDecimalOdds,
    status,
    actualFillDecimalOdds: input.fill ? input.fill.filledDecimalOdds : null,
  };
}

// ---------------------------------------------------------------------------
// S3_MAKER_VALUE_BAND_HOLD
// ---------------------------------------------------------------------------

export const S3_INITIAL_LADDER_DECIMAL_ODDS: readonly number[] = [2.0, 1.95, 1.9];
export const S3_MIN_ACCEPTABLE_DECIMAL_ODDS = 1.85;

export interface S3LadderLevelResult {
  readonly ladderDecimalOdds: number;
  readonly reached: boolean;
  readonly reachedAtIso: string | null;
}

export interface S3Input {
  readonly candidate: CandidateIdentity;
  readonly ladderDecimalOdds?: readonly number[];
  readonly minAcceptableDecimalOdds?: number;
  readonly observations: readonly S2Observation[];
  readonly fill?: ExecutionFillEvidence;
}

export interface S3Evidence {
  readonly strategy: "S3_MAKER_VALUE_BAND_HOLD";
  readonly candidate: CandidateIdentity;
  readonly ladderDecimalOdds: readonly number[];
  readonly minAcceptableDecimalOdds: number;
  readonly levels: readonly S3LadderLevelResult[];
  readonly bestReachableAcceptableDecimalOdds: number | null;
  readonly status: FillStatus;
  readonly actualFillDecimalOdds: number | null;
}

export function evaluateS3MakerValueBandHold(input: S3Input): S3Evidence {
  const ladder = input.ladderDecimalOdds ?? S3_INITIAL_LADDER_DECIMAL_ODDS;
  const minAcceptable = input.minAcceptableDecimalOdds ?? S3_MIN_ACCEPTABLE_DECIMAL_ODDS;

  const levels: S3LadderLevelResult[] = ladder.map((level) => {
    const firstReach = input.observations
      .filter((o) => o.bestObservedDecimalOdds >= level)
      .sort((a, b) => a.observedAtIso.localeCompare(b.observedAtIso))[0];
    return {
      ladderDecimalOdds: level,
      reached: Boolean(firstReach),
      reachedAtIso: firstReach ? firstReach.observedAtIso : null,
    };
  });

  const reachableAndAcceptable = levels.filter((l) => l.reached && l.ladderDecimalOdds >= minAcceptable);
  const bestReachableAcceptableDecimalOdds = reachableAndAcceptable.length
    ? Math.max(...reachableAndAcceptable.map((l) => l.ladderDecimalOdds))
    : null;

  let status: FillStatus;
  if (input.fill) {
    status = "ACTUAL_FILL";
  } else if (bestReachableAcceptableDecimalOdds !== null) {
    status = "FILL_OPPORTUNITY";
  } else if (input.observations.length > 0) {
    status = "NO_FILL";
  } else {
    status = "UNKNOWN";
  }

  return {
    strategy: "S3_MAKER_VALUE_BAND_HOLD",
    candidate: input.candidate,
    ladderDecimalOdds: ladder,
    minAcceptableDecimalOdds: minAcceptable,
    levels,
    bestReachableAcceptableDecimalOdds,
    status,
    actualFillDecimalOdds: input.fill ? input.fill.filledDecimalOdds : null,
  };
}

// ---------------------------------------------------------------------------
// Cross-strategy identity guard
// ---------------------------------------------------------------------------

/**
 * Proves S1/S2/S3 evidence for one evaluation run consume the exact same
 * frozen candidate identity — no strategy may substitute a different
 * candidate/event/token/decision-time identity.
 */
export function assertSameCandidateIdentity(
  s1: S1Evidence,
  s2: S2Evidence,
  s3: S3Evidence,
): void {
  const key = (c: CandidateIdentity) =>
    `${c.conditionId}::${c.selectedTokenId}::${c.providerEventId}::${c.formulaVersion}::${c.decisionTimeIso}`;
  const k1 = key(s1.candidate);
  const k2 = key(s2.candidate);
  const k3 = key(s3.candidate);
  if (k1 !== k2 || k1 !== k3) {
    throw new Error(
      `S1/S2/S3 candidate identity mismatch: S1=${k1} S2=${k2} S3=${k3}`,
    );
  }
}
