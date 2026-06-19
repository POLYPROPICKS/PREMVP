import { loadEnvConfig } from "@next/env";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

type Manifest = {
  status: string;
  date: string;
  subject: string;
  files: Array<{ kind: string; path: string; bytes: number }>;
  fire_model?: {
    status?: string;
    run_id?: string;
    run_dir?: string;
    workbook_path?: string;
    primary_scope?: string;
    model_count?: number;
    current_champion?: string;
    best_96h_model?: string;
    warning_count?: number;
    live_contour_status?: string;
    doctrine?: string;
    attachment_included?: boolean;
  };
};

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

async function main() {
  loadEnvConfig(process.cwd());
  const date = argValue("--date=") ?? utcDateKey();
  const recipient = argValue("--email=") ?? process.env.MORNING_MODEL_EMAIL_TO ?? "alexgrushin@gmail.com";
  const sendTest = process.argv.includes("--send-test");
  const dryRun = process.argv.includes("--dry-run") || !sendTest;
  const packageDir = path.join(process.cwd(), "modeling", "morning_model_report", `${date}_0600UTC`);
  const manifestPath = path.join(packageDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`MORNING_PACKAGE_NOT_READY: expected ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (manifest.status !== "READY") {
    throw new Error(`MORNING_PACKAGE_STALE: status=${manifest.status} manifest=${manifestPath}`);
  }
  const attachments = manifest.files.map((f) => {
    if (!existsSync(f.path)) throw new Error(`MORNING_PACKAGE_NOT_READY: missing ${f.path}`);
    return { filename: path.basename(f.path), path: f.path, bytes: f.bytes };
  });
  if (attachments.length < 3) throw new Error(`MORNING_PACKAGE_NOT_READY: attachmentCount=${attachments.length}`);

  const result = {
    manifestPath,
    packageDir,
    recipient,
    dryRun,
    subject: manifest.subject,
    attachmentCount: attachments.length,
    files: attachments,
  };

  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", ...result }, null, 2));
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("LOCAL_EMAIL_ENV_MISSING: RESEND_API_KEY or EMAIL_FROM not set");
  }
  const payload = {
    from,
    to: [recipient],
    subject: manifest.subject,
    text: [
      `Status: ${manifest.status}`,
      `Date: ${manifest.date}`,
      `FireModel status: ${manifest.fire_model?.status ?? "NOT_RECORDED"}`,
      `FireModel scope: ${manifest.fire_model?.primary_scope ?? manifest.fire_model?.doctrine ?? "UNKNOWN"}`,
      `FireModel current champion: ${manifest.fire_model?.current_champion ?? ""}`,
      `FireModel best 96h model: ${manifest.fire_model?.best_96h_model ?? ""}`,
      `FireModel warnings: ${manifest.fire_model?.warning_count ?? "N/A"}`,
      `FireModel live contour: ${manifest.fire_model?.live_contour_status ?? "UNKNOWN"}`,
      `FireModel run_id: ${manifest.fire_model?.run_id ?? ""}`,
      `FireModel run_dir: ${manifest.fire_model?.run_dir ?? ""}`,
      `Attachments: ${attachments.map((a) => a.filename).join(", ")}`,
    ].join("\n"),
    attachments: await Promise.all(
      attachments.map(async (attachment) => ({
        filename: attachment.filename,
        content: (await readFile(attachment.path)).toString("base64"),
      })),
    ),
  };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`EMAIL_SEND_FAILED: Resend ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  console.log(JSON.stringify({ mode: "send-test", ...result, sent: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
