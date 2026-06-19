import { mkdir, stat, writeFile } from "fs/promises";
import path from "path";

export function utcStamp(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}${m}${d}_${hh}${mm}Z`;
}

export async function createRunDir(now = new Date()) {
  const runDir = path.join(process.cwd(), "modeling", "fire_runs", `${utcStamp(now)}_fire_model`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function fileSize(filePath: string) {
  return (await stat(filePath)).size;
}
