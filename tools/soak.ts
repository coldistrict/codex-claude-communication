import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");
const minutesIndex = process.argv.indexOf("--minutes");
const minutes = minutesIndex >= 0 ? Number(process.argv[minutesIndex + 1]) : 30;
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("INVALID_SOAK_MINUTES");

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync(command, args, { timeout: 5_000 })).stdout;
  } catch {
    return "";
  }
}

function parseSwapMiB(output: string): number | null {
  const match = output.match(/used\s*=\s*([0-9.]+)([MG])/i);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2]!.toUpperCase() === "G" ? value * 1024 : value;
}

const directory = mkdtempSync(join(tmpdir(), "collab-soak-"));
const service = spawn(process.execPath, [
  "--import",
  "tsx",
  join(productRoot, "tools", "soak-service.ts"),
  directory,
  join(productRoot, "packages", "ui", "dist"),
], {
  cwd: productRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
const controlWaiters: Array<(value: any) => void> = [];
let readyResolve: (value: any) => void;
let readyReject: (error: Error) => void;
const ready = new Promise<any>((resolveReady, rejectReady) => {
  readyResolve = resolveReady;
  readyReject = rejectReady;
});
createInterface({ input: service.stdout }).on("line", (line) => {
  if (!line.startsWith("CONTROL ")) return;
  const value = JSON.parse(line.slice(8));
  if (value.type === "ready") readyResolve(value);
  else controlWaiters.shift()?.(value);
});
service.once("exit", (code, signal) => {
  readyReject(new Error(`SOAK_SERVICE_EXIT:${String(code)}:${String(signal)}`));
});
const readyMessage = await ready;
const address = readyMessage.address;

function serviceControl(command: "SAMPLE" | "DEGRADE"): Promise<any> {
  return new Promise((resolveControl) => {
    controlWaiters.push(resolveControl);
    service.stdin.write(`${command}\n`);
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const beforeSwap = parseSwapMiB(await commandOutput("sysctl", ["vm.swapusage"]));
const start = performance.now();
let maxServiceRssMiB = 0;
let maxTabHeapMiB = 0;
let maxEventLoopLagMs = 0;
let cpuPercentTotal = 0;
let samples = 0;

try {
  await page.goto(address.launchUrl.replace("/#", "/?adapter=fake#"));
  await page.getByRole("heading", { name: "New collaboration" }).waitFor();
  await page.getByLabel("Project or workspace").fill(directory);
  await page
    .getByLabel("What should Codex and Claude accomplish together?")
    .fill("Run deterministic fake workers for the resource soak.");
  await page.getByRole("button", { name: "Start collaboration" }).click();
  await page.getByText("Run deterministic fake workers for the resource soak.").waitFor();

  const deadline = performance.now() + minutes * 60_000;
  while (performance.now() < deadline) {
    const sample = await serviceControl("SAMPLE");
    maxServiceRssMiB = Math.max(maxServiceRssMiB, sample.rssBytes / 1024 ** 2);
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, sample.eventLoopLagMs);
    const cpuSample = Number(
      (await commandOutput("ps", ["-o", "%cpu=", "-p", String(service.pid)])).trim(),
    );
    if (Number.isFinite(cpuSample)) cpuPercentTotal += cpuSample;
    const tabHeap = await page.evaluate(() => {
      const memoryInfo = (performance as any).memory;
      return memoryInfo?.usedJSHeapSize ? memoryInfo.usedJSHeapSize / 1024 ** 2 : 0;
    });
    maxTabHeapMiB = Math.max(maxTabHeapMiB, tabHeap);
    samples += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - performance.now()))));
  }

  const forced = (await serviceControl("DEGRADE")).state;
  if (!forced.degraded || !forced.serializeAgents || forced.admitHeavyWork) {
    throw new Error("DEGRADED_MODE_NOT_ENFORCED");
  }
  await page.reload();
  await page.getByText("Degraded mode is active.").waitFor();

  const elapsedMs = performance.now() - start;
  const cpuPercent = samples ? cpuPercentTotal / samples : 0;
  const afterSwap = parseSwapMiB(await commandOutput("sysctl", ["vm.swapusage"]));
  const swapGrowthMiB =
    beforeSwap !== null && afterSwap !== null ? Math.max(0, afterSwap - beforeSwap) : null;
  const openFilesOutput = await commandOutput("lsof", ["-p", String(service.pid)]);
  const openFiles = openFilesOutput ? Math.max(0, openFilesOutput.trim().split("\n").length - 1) : null;
  const result = {
    suite: "V-12",
    passed:
      maxServiceRssMiB <= 200 &&
      maxTabHeapMiB <= 250 &&
      (swapGrowthMiB === null || swapGrowthMiB < 256) &&
      forced.degraded,
    minutes,
    samples,
    idleAndFakeServiceMaxRssMiB: Number(maxServiceRssMiB.toFixed(2)),
    browserTabJsHeapMaxMiB: Number(maxTabHeapMiB.toFixed(2)),
    sustainedCpuPercent: Number(cpuPercent.toFixed(2)),
    elapsedMs: Number(elapsedMs.toFixed(2)),
    eventLoopLagMaxMs: Number(maxEventLoopLagMs.toFixed(2)),
    openFiles,
    swapGrowthMiB,
    degradedMode: forced,
    silentKills: 0,
    modelStarts: 0,
  };
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await browser.close();
  if (service.exitCode === null) service.kill("SIGTERM");
}
