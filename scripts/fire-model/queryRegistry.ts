import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";

export type QueryKind = "dataset" | "model" | "funnel" | "diagnostic";

export type RegisteredQuery = {
  queryId: string;
  sqlId: string;
  kind: QueryKind;
  relativePath: string;
  sourceTables: string[];
  outputGrain: string;
  expectedColumns: string[];
  version: string;
  hash: string;
};

const SQL_ROOT = path.join(process.cwd(), "modeling", "sql_registry");

function parseHeader(text: string): Record<string, string> {
  const header: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(0, 16)) {
    const match = line.match(/^--\s*([^:]+):\s*(.*)$/);
    if (match) header[match[1].trim()] = match[2].trim();
  }
  return header;
}

async function loadFolder(kind: QueryKind, folder: string): Promise<RegisteredQuery[]> {
  const dir = path.join(SQL_ROOT, folder);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const queries: RegisteredQuery[] = [];
  for (const file of files) {
    const relativePath = path.join("modeling", "sql_registry", folder, file).replace(/\\/g, "/");
    const fullPath = path.join(dir, file);
    const text = await readFile(fullPath, "utf8");
    const header = parseHeader(text);
    const sqlId = header.sql_id || file.replace(/\.sql$/, "");
    queries.push({
      queryId: sqlId,
      sqlId,
      kind,
      relativePath,
      sourceTables: (header.source_tables || "").split(",").map((x) => x.trim()).filter(Boolean),
      outputGrain: header.output_grain || "UNKNOWN",
      expectedColumns: (header.expected_columns || "").split(",").map((x) => x.trim()).filter(Boolean),
      version: header.version || "UNKNOWN",
      hash: createHash("sha256").update(text).digest("hex"),
    });
  }
  return queries;
}

export async function loadQueryRegistry(): Promise<Map<string, RegisteredQuery>> {
  const rows = [
    ...(await loadFolder("dataset", "datasets")),
    ...(await loadFolder("model", "models")),
    ...(await loadFolder("funnel", "funnels")),
    ...(await loadFolder("diagnostic", "diagnostics")),
  ];
  return new Map(rows.map((row) => [row.queryId, row]));
}

export async function sqlManifest(): Promise<RegisteredQuery[]> {
  return [...(await loadQueryRegistry()).values()].sort((a, b) => a.queryId.localeCompare(b.queryId));
}
