import { loadEnvConfig } from "@next/env";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

type Manifest = {
  status: string;
  date: string;
  subject: string;
  files: Array<{ kind: string; path: string; bytes: number }>;
};

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function minskDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

async function main() {
  loadEnvConfig(process.cwd());
  const date = argValue("--date=") ?? minskDateKey();
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
  if (attachments.length !== 3) throw new Error(`MORNING_PACKAGE_NOT_READY: attachmentCount=${attachments.length}`);

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
