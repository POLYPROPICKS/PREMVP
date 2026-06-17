import ExcelJS from "exceljs";
import { mkdir } from "fs/promises";
import path from "path";

export type ReportRow = Record<string, unknown>;

export interface WorkbookSheetSpec {
  name: string;
  headers: string[];
  rows: ReportRow[];
  note?: string;
}

function cellValue(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

function estimateWidth(header: string, values: unknown[]): number {
  const maxValueLength = values.reduce((max: number, value) => {
    const len = String(value ?? "").length;
    return len > max ? len : max;
  }, header.length);
  return Math.max(10, Math.min(maxValueLength + 2, 50));
}

export async function writeWorkbookXlsx(outputPath: string, sheets: WorkbookSheetSpec[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PolyProPicks";
  workbook.created = new Date();

  for (const spec of sheets) {
    const worksheet = workbook.addWorksheet(spec.name);
    const headerRow = worksheet.addRow(spec.headers);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

    for (const row of spec.rows) {
      worksheet.addRow(spec.headers.map((header) => cellValue(row[header])));
    }

    worksheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, worksheet.rowCount), column: spec.headers.length },
    };

    spec.headers.forEach((header, idx) => {
      const values = [header, ...spec.rows.map((row) => row[header])];
      worksheet.getColumn(idx + 1).width = estimateWidth(header, values);
      worksheet.getColumn(idx + 1).alignment = { vertical: "top", wrapText: true };
    });

    if (spec.note) {
      const noteRow = worksheet.addRow([spec.note]);
      worksheet.mergeCells(noteRow.number, 1, noteRow.number, Math.max(1, spec.headers.length));
      noteRow.font = { italic: true, color: { argb: "FF666666" } };
      noteRow.alignment = { wrapText: true };
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}
