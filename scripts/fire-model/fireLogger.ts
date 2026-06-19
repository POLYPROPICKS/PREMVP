import { appendFile, mkdir, writeFile } from "fs/promises";
import path from "path";

export type FireLogEvent = {
  timestamp?: string;
  run_id: string;
  step: string;
  model_id?: string;
  dataset_id?: string;
  funnel_id?: string;
  sql_id?: string;
  query_id?: string;
  source_table?: string;
  row_count?: number;
  included_count?: number;
  excluded_count?: number;
  warning_count?: number;
  status: "OK" | "WARN" | "FAIL";
  message?: string;
};

export class FireLogger {
  private readonly ndjsonPath: string;
  private readonly markdownPath: string;
  private events: FireLogEvent[] = [];

  constructor(private readonly runDir: string) {
    this.ndjsonPath = path.join(runDir, "run_log.ndjson");
    this.markdownPath = path.join(runDir, "run_log.md");
  }

  async init() {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(this.ndjsonPath, "", "utf8");
    await writeFile(this.markdownPath, "# FireModel Run Log\n\n", "utf8");
  }

  async log(event: FireLogEvent) {
    const row = { timestamp: new Date().toISOString(), ...event };
    this.events.push(row);
    await appendFile(this.ndjsonPath, JSON.stringify(row) + "\n", "utf8");
    await appendFile(
      this.markdownPath,
      `- ${row.timestamp} ${row.status} ${row.step} rows=${row.row_count ?? ""} included=${row.included_count ?? ""} excluded=${row.excluded_count ?? ""} warnings=${row.warning_count ?? 0} ${row.message ?? ""}\n`,
      "utf8",
    );
  }

  warningCount() {
    return this.events.filter((event) => event.status === "WARN").length;
  }
}
