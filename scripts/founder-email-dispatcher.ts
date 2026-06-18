import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";

type Mode = "auto" | "morning" | "night-plan" | "alert" | "all";

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function runCommand(label: string, command: string, args: string[]): void {
  console.log(`[founder-email] Starting ${label}: ${[command, ...args].join(" ")}`);
  const res = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", shell: true });
  if (res.status !== 0) {
    throw new Error(`[founder-email] ${label} failed with exit code ${res.status ?? 1}`);
  }
}

function runTrustedMorning(recipient: string): void {
  runCommand("resolver-live-priority", "npm", ["run", "resolve:signals:live-priority"]);
  runCommand("resolver-cron", "npm", ["run", "resolve:signals:cron"]);
  runCommand("resolver-verify", "npm", ["run", "verify:resolver-pipeline"]);
  runCommand("morning-model", "npm", ["run", "morning:model-report", "--", "--send-test", `--email=${recipient}`]);
}

function minskNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { date, minutes };
}

function inWindow(minutes: number, start: number, end: number): boolean {
  return minutes >= start && minutes <= end;
}

async function main() {
  loadEnvConfig(process.cwd());

  const modeArg = (argValue("--mode=") ?? "auto") as Mode;
  const allowed: Mode[] = ["auto", "morning", "night-plan", "alert", "all"];
  if (!allowed.includes(modeArg)) {
    throw new Error(`[founder-email] Invalid --mode=${modeArg}`);
  }

  const recipient = argValue("--email=") ?? process.env.FOUNDER_EMAIL_TO ?? process.env.MORNING_MODEL_EMAIL_TO ?? process.env.NIGHT_PLAN_EMAIL_TO ?? "alexgrushin@gmail.com";
  const { date: minskDate, minutes: minskMinutes } = minskNow();
  const summary = { mode: modeArg, minskDate, minskMinutes, recipient };
  console.log(JSON.stringify(summary, null, 2));

  if (modeArg === "auto") {
    if (inWindow(minskMinutes, 8 * 60 + 55, 9 * 60 + 10)) {
      runTrustedMorning(recipient);
      return;
    }
    if (inWindow(minskMinutes, 16 * 60 + 55, 17 * 60 + 10)) {
      runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
      return;
    }
    if (inWindow(minskMinutes, 17 * 60 + 40, 17 * 60 + 55)) {
      runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
      return;
    }
    console.log("NO_EMAIL_DUE");
    return;
  }

  if (modeArg === "morning") {
    runTrustedMorning(recipient);
    return;
  }
  if (modeArg === "night-plan") {
    runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
    return;
  }
  if (modeArg === "alert") {
    runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
    return;
  }

  runTrustedMorning(recipient);
  runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
  runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
}

main().catch((e) => {
  console.error("[founder-email] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
