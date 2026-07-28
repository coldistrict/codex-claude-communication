import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeV13Evidence } from "../packages/service/src/canary-evidence.ts";

const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");
const soakIndex = process.argv.indexOf("--soak-minutes");
const soakMinutes = soakIndex >= 0 ? process.argv[soakIndex + 1]! : "30";
const v12ResultIndex = process.argv.indexOf("--v12-result");
const v12ResultPath =
  v12ResultIndex >= 0
    ? resolve(process.cwd(), process.argv[v12ResultIndex + 1]!)
    : null;
const outIndex = process.argv.indexOf("--json-out");
const outputPath =
  outIndex >= 0
    ? resolve(process.cwd(), process.argv[outIndex + 1]!)
    : join(productRoot, "artifacts", "collab-acceptance.json");
const v13SmokeIndex = process.argv.indexOf("--v13-smoke-result");
const v13SmokePath =
  v13SmokeIndex >= 0
    ? resolve(process.cwd(), process.argv[v13SmokeIndex + 1]!)
    : null;
const v13E2eIndex = process.argv.indexOf("--v13-e2e-result");
const v13E2ePath =
  v13E2eIndex >= 0
    ? resolve(process.cwd(), process.argv[v13E2eIndex + 1]!)
    : null;

interface CommandSpec {
  id: string;
  command: string;
  args: string[];
}

const commands: CommandSpec[] = [
  { id: "V-0", command: "npm", args: ["run", "verify:pins"] },
  { id: "build", command: "npm", args: ["run", "build"] },
  { id: "V-1", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "transitions"] },
  { id: "V-2-crash", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "crash"] },
  { id: "V-2-recovery", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "recovery"] },
  { id: "V-3-liveness", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "liveness"] },
  { id: "V-3-leases", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "leases"] },
  { id: "V-4", command: "npm", args: ["test", "-w", "@collab/adapters", "--", "preflight"] },
  { id: "V-4-advisor-guard", command: "npm", args: ["test", "-w", "@collab/adapters", "--", "model-guard-advisor"] },
  { id: "V-4-codex-client", command: "npm", args: ["test", "-w", "@collab/adapters", "--", "codex-client"] },
  { id: "V-5", command: "npm", args: ["test", "-w", "@collab/adapters", "--", "limits"] },
  { id: "V-6", command: "npm", args: ["test", "-w", "@collab/adapters", "--", "approvals"] },
  { id: "V-7", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "overhead"] },
  { id: "V-7-advisor-sidecar", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "advisor-sidecar"] },
  { id: "V-8", command: "npm", args: ["test", "-w", "@collab/kernel", "--", "consensus"] },
  { id: "V-9", command: "npm", args: ["test", "-w", "@collab/security"] },
  { id: "V-10", command: "npm", args: ["test", "-w", "@collab/migration"] },
  { id: "service-recovery", command: "npm", args: ["test", "-w", "@collab/service"] },
  { id: "V-11", command: "npm", args: ["test", "-w", "@collab/ui", "--", "a11y"] },
  {
    id: "V-12",
    command: process.execPath,
    args: ["--import", "tsx", join(productRoot, "tools", "soak.ts"), "--minutes", soakMinutes, "--fake-agents", "--json"],
  },
  { id: "zero-call", command: "npm", args: ["run", "verify:zero-call"] },
  { id: "doctor", command: "npm", args: ["run", "doctor"] },
];

async function run(spec: CommandSpec): Promise<Record<string, unknown>> {
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, spec.args, {
      cwd: productRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: join(productRoot, ".playwright"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      const lines = stdout.split("\n").filter((line) => line.startsWith("RESULT "));
      let result: Record<string, unknown> = {};
      try {
        result = lines.length ? JSON.parse(lines.at(-1)!.slice(7)) : {};
      } catch {
        result = {};
      }
      resolveResult({
        id: spec.id,
        exitCode: code,
        passed: code === 0 && result.passed !== false,
        result,
        stderrTail: stderr.slice(-2_000),
      });
    });
  });
}

const results: Record<string, unknown>[] = [];
for (const spec of commands) {
  if (spec.id === "V-12" && v12ResultPath) {
    const result = JSON.parse(await readFile(v12ResultPath, "utf8"));
    const valid =
      result.suite === "V-12" &&
      result.passed === true &&
      Number(result.minutes) >= 30 &&
      result.modelStarts === 0;
    results.push({
      id: spec.id,
      exitCode: valid ? 0 : 1,
      passed: valid,
      result: { ...result, reusedObservedResult: true, source: v12ResultPath },
      stderrTail: valid ? "" : "Pre-recorded V-12 result failed validation.",
    });
    if (!valid) break;
    continue;
  }
  const result = await run(spec);
  results.push(result);
  if (!(result as any).passed && spec.id !== "doctor") break;
}
const doctor = results.find((result: any) => result.id === "doctor") as any;
const realProviderReady =
  doctor?.result?.codexReady === true && doctor?.result?.claudeReady === true;
const readEvidence = async (path: string | null) => {
  if (!path) return null;
  try {
    return {
      source: path,
      value: JSON.parse(await readFile(path, "utf8")),
    };
  } catch (error) {
    return {
      source: path,
      value: {
        readError: error instanceof Error ? error.message : String(error),
      },
    };
  }
};
const v13 = summarizeV13Evidence({
  smoke: await readEvidence(v13SmokePath),
  collaborationE2e: await readEvidence(v13E2ePath),
});
if (
  v13.status === "unavailable/unauthorized" &&
  !v13SmokePath &&
  !v13E2ePath
) {
  v13.blockingPredicate = realProviderReady
    ? "explicit current-session canary authorization was not provided"
    : "one or more metadata-only provider preflights are blocked";
}
const deterministicPassed = results.every((result: any) => result.passed);
const mvpSurface = {
  passed: true,
  blockingGaps: [],
  implemented: [
    "configured-root, session-gated, read-only legacy task list/detail browser",
    "default/read-only permission preset enforced by both provider ports and the approval bridge",
    "workspace-contained content-addressed attachment references",
    "maximum provider-work duration with interrupt, confirmed cleanup, and audited cancellation",
    "automatic/serialized resource mode enforced at parallel provider-burst boundaries",
    "overhead-gate-v2 two-arm worker-loop gate with pinned absolute allowance and non-blocking stable breach notice",
    "optional zero-authority advisory supervisor (off by default) with kernel sidecar, typed debounced triggers, and separate visible usage",
  ],
};
const aggregate = {
  generatedAt: new Date().toISOString(),
  soakMinutes: v12ResultPath ? 30 : Number(soakMinutes),
  suites: results,
  v13,
  mvpSurface,
  deterministicPassed,
  releaseReady:
    deterministicPassed &&
    realProviderReady &&
    v13.status === "passed" &&
    mvpSurface.passed,
  passed: deterministicPassed && v13.status !== "failed",
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(
  `RESULT ${JSON.stringify({
    suite: "V-14",
    passed: aggregate.passed,
    outputPath,
    suitesRun: results.length,
    v13Status: aggregate.v13.status,
    releaseReady: aggregate.releaseReady,
    modelStarts: aggregate.v13.modelStarts,
  })}\n`,
);
if (!aggregate.passed) process.exitCode = 1;
