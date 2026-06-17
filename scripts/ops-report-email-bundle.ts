import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";

type StepResult = {
  name: string;
  ok: boolean;
  exitCode: number | null;
};

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function runStep(name: string, command: string, args: string[]): StepResult {
  console.log(`[ops-email-bundle] Starting ${name}`);
  const cmdLine = [command, ...args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" ");
  const res = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdLine], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  const ok = (res.status ?? 1) === 0;
  if (!ok) {
    console.error(`[ops-email-bundle] ${name} failed with exit code ${res.status ?? 1}`);
  }
  return { name, ok, exitCode: res.status };
}

async function main() {
  loadEnvConfig(process.cwd());

  const recipient = argValue("--email=") ?? "alexgrushin@gmail.com";
  const results: StepResult[] = [];

  results.push(
    runStep("morning", "npm", [
      "run",
      "morning:model-report",
      "--",
      "--send-test",
      `--email=${recipient}`,
    ]),
  );

  results.push(
    runStep("night-plan", "npm", [
      "run",
      "night:plan:email",
      "--",
      `--email=${recipient}`,
    ]),
  );

  results.push(
    runStep("alert", "npm", [
      "run",
      "night:plan:email",
      "--",
      "--alert-only",
      `--email=${recipient}`,
    ]),
  );

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  console.log(`[ops-email-bundle] DONE sent=${sent} failed=${failed}`);

  const morningOk = results[0]?.ok ?? false;
  const anyFailed = failed > 0;
  if (!morningOk || anyFailed) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[ops-email-bundle] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
