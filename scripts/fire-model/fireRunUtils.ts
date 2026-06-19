import { existsSync, readdirSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

export function fireRunsRoot() {
  return path.join(process.cwd(), "modeling", "fire_runs");
}

export function listFireRunDirs(): string[] {
  const root = fireRunsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /_fire_model$/.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => b.localeCompare(a));
}

export function latestFireRunDir(): string | null {
  return listFireRunDirs()[0] ?? null;
}

export async function readJson<T = any>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else {
        cell += ch;
      }
    }
    cells.push(cell);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}
