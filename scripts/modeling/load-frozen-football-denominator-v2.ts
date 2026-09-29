/** Read the accepted Git-owned denominator overlay for downstream economics. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  OUT_DIR,
  RANGE_END,
  RANGE_START,
  readAllSourceRows,
} from "./build-football-denominator-reconciliation-v2";
import {
  countDuplicateIdentities,
  type OverlayRecord,
  type SourceRow,
} from "./build-football-denominator-reconciliation";

export const FROZEN_OVERLAY_COMPRESSED_SHA256 = "944d45b4a5c8dcffbbc12a54fbe4926a1bba269fad1fefc592ca7db2e4ce1665";
export const FROZEN_OVERLAY_CONTENT_SHA256 = "ca2929fd30e16cbb188350ccceadc75c19055ef45f5a8d990881b4c13c40fcf3";
export const FROZEN_OVERLAY_ROW_N = 75_743;

type PeriodId = "AUG" | "SEP_1_12" | "SEP_13_24" | "COMBINED";
type FrozenManifest = Record<PeriodId, unknown> & {
  OVERLAY_ROW_N: number;
  OVERLAY_CONTENT_SHA256: string;
  DUPLICATE_OVERLAY_IDENTITY_N: number;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(row: SourceRow | OverlayRecord): string {
  return [row.model_date, row.population_id, row.condition_id, row.selected_token_id, row.decision_at].join("::");
}

export function loadFrozenOverlayV2(): {
  overlay: OverlayRecord[];
  periods: Record<PeriodId, unknown>;
  compressedSha256: string;
  contentSha256: string;
} {
  const basename = `FOOTBALL_DENOMINATOR_OVERLAY_${RANGE_START}_${RANGE_END}.jsonl.gz`;
  const compressed = readFileSync(join(OUT_DIR, basename));
  const compressedSha256 = sha256(compressed);
  if (compressedSha256 !== FROZEN_OVERLAY_COMPRESSED_SHA256) {
    throw new Error("FROZEN_DENOMINATOR_COMPRESSED_SHA_MISMATCH");
  }
  const content = gunzipSync(compressed);
  const contentSha256 = sha256(content);
  if (contentSha256 !== FROZEN_OVERLAY_CONTENT_SHA256) {
    throw new Error("FROZEN_DENOMINATOR_CONTENT_SHA_MISMATCH");
  }

  const lines = content.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== FROZEN_OVERLAY_ROW_N) {
    throw new Error(`FROZEN_DENOMINATOR_OVERLAY_ROW_COUNT:${lines.length}`);
  }
  const overlay = lines.map((line) => JSON.parse(line) as OverlayRecord);
  const duplicateCount = countDuplicateIdentities(overlay);
  if (duplicateCount !== 0) {
    throw new Error(`FROZEN_DENOMINATOR_DUPLICATE_OVERLAY_IDENTITY:${duplicateCount}`);
  }

  const manifest = JSON.parse(readFileSync(
    join(OUT_DIR, `MANIFEST_${RANGE_START}_${RANGE_END}.json`), "utf8",
  )) as FrozenManifest;
  if (manifest.OVERLAY_ROW_N !== FROZEN_OVERLAY_ROW_N
    || manifest.OVERLAY_CONTENT_SHA256 !== contentSha256
    || manifest.DUPLICATE_OVERLAY_IDENTITY_N !== 0) {
    throw new Error("FROZEN_DENOMINATOR_MANIFEST_MISMATCH");
  }
  const periods = {
    AUG: manifest.AUG,
    SEP_1_12: manifest.SEP_1_12,
    SEP_13_24: manifest.SEP_13_24,
    COMBINED: manifest.COMBINED,
  };
  console.error(JSON.stringify({ STAGE: "FROZEN_OVERLAY_VERIFIED", ROWS: overlay.length, COMPRESSED_SHA256: compressedSha256, CONTENT_SHA256: contentSha256 }));
  return { overlay, periods, compressedSha256, contentSha256 };
}

export async function loadFrozenFootballDenominatorV2(db: any): Promise<{
  sourceRows: SourceRow[];
  overlay: OverlayRecord[];
  periods: Record<PeriodId, unknown>;
}> {
  const frozen = loadFrozenOverlayV2();
  const sourceRows = await readAllSourceRows(db);
  if (sourceRows.length !== FROZEN_OVERLAY_ROW_N) {
    throw new Error(`FROZEN_DENOMINATOR_SOURCE_ROW_COUNT:${sourceRows.length}`);
  }
  const sourceIdentities = new Set(sourceRows.map(identity));
  if (sourceIdentities.size !== FROZEN_OVERLAY_ROW_N) {
    throw new Error("FROZEN_DENOMINATOR_DUPLICATE_SOURCE_IDENTITY");
  }
  for (const row of frozen.overlay) {
    if (!sourceIdentities.has(identity(row))) {
      throw new Error("FROZEN_DENOMINATOR_SOURCE_OVERLAY_IDENTITY_MISMATCH");
    }
  }
  console.error(JSON.stringify({ STAGE: "FROZEN_DENOMINATOR_READY", SOURCE_ROWS: sourceRows.length, OVERLAY_ROWS: frozen.overlay.length }));
  return { sourceRows, overlay: frozen.overlay, periods: frozen.periods };
}
