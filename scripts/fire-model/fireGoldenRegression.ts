import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

export type LegacyWcSmokeTestRow = {
  anchor_id: string;
  expected_roi: number;
  actual_roi: number | null;
  status: string;
  source_path: string;
  diagnostic_only: boolean;
  is_benchmark: false;
};

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !(quoted && line[i + 1] !== '"');
    if (ch === "," && !quoted) {
      cells.push(cell.replace(/^"|"$/g, ""));
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.replace(/^"|"$/g, ""));
  return cells;
}

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsv(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function asNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function legacyWcSmokeTest(): Promise<LegacyWcSmokeTestRow[]> {
  const rows: LegacyWcSmokeTestRow[] = [];
  const researchPath = path.join(process.cwd(), "modeling", "wc_research_universe_roi_202606191920Z", "wc_research_roi_policy_window.csv");
  if (existsSync(researchPath)) {
    const data = await readCsv(researchPath);
    const anchors = [
      { id: "WC_PUBLISHED_ALL_ALL_TIME", policy: "PUBLISHED_SIGNALS_FROM_PAIRS", window: "all-time", expected: 23.56 },
      { id: "WC_PUBLISHED_ONE_ALL_TIME", policy: "PUBLISHED_SIGNALS_ONE_PER_FIXTURE", window: "all-time", expected: 27.06 },
    ];
    for (const anchor of anchors) {
      const row = data.find((r) => r.policy === anchor.policy && r.window === anchor.window);
      const actual = asNumber(row?.ROI ?? row?.roi);
      rows.push({
        anchor_id: anchor.id,
        expected_roi: anchor.expected,
        actual_roi: actual,
        status: actual == null ? "WARN_MISSING" : Math.abs(actual - anchor.expected) <= 0.25 ? "PASS" : "WARN_DRIFT",
        source_path: researchPath,
        diagnostic_only: true,
        is_benchmark: false,
      });
    }
  } else {
    rows.push({ anchor_id: "WC_RESEARCH_FILE", expected_roi: 0, actual_roi: null, status: "WARN_LEGACY_WC_SMOKE_DATA_MISSING", source_path: researchPath, diagnostic_only: true, is_benchmark: false });
  }

  const founderPath = path.join(process.cwd(), "modeling", "wc_founder_style_line_layer_20260619_2252Z", "wc_founder_style_policy_roi.csv");
  if (existsSync(founderPath)) {
    const data = await readCsv(founderPath);
    const row = data.find((r) => r.policy === "FOUNDER_CORE_5_LINES" && r.window === "all-time");
    const actual = asNumber(row?.ROI ?? row?.roi);
    rows.push({
      anchor_id: "WC_FOUNDER_CORE_5_ALL_TIME",
      expected_roi: 8.27,
      actual_roi: actual,
      status: actual == null ? "WARN_MISSING" : Math.abs(actual - 8.27) <= 0.25 ? "PASS" : "WARN_DRIFT",
      source_path: founderPath,
      diagnostic_only: true,
      is_benchmark: false,
    });
  } else {
    rows.push({ anchor_id: "WC_FOUNDER_FILE", expected_roi: 0, actual_roi: null, status: "WARN_LEGACY_WC_SMOKE_DATA_MISSING", source_path: founderPath, diagnostic_only: true, is_benchmark: false });
  }
  return rows;
}

export const goldenRegression = legacyWcSmokeTest;
