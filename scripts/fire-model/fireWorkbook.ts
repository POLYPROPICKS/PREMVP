import ExcelJS from "exceljs";

function addSheet(wb: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  const headers = Object.keys(rows[0] ?? { status: "NO_ROWS" });
  ws.columns = headers.map((header) => ({ header, key: header, width: Math.min(36, Math.max(14, header.length + 3)) }));
  ws.addRows(rows.length ? rows : [{ status: "NO_ROWS" }]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

export async function writeFireWorkbook(filePath: string, sheets: Record<string, Record<string, unknown>[]>) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PolyProPicks FireModel";
  wb.created = new Date();
  for (const [name, rows] of Object.entries(sheets)) addSheet(wb, name, rows);
  await wb.xlsx.writeFile(filePath);
}
