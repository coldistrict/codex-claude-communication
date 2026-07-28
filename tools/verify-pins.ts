import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundledClaudeCliPath } from "../packages/adapters/src/index.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");
const manifest = JSON.parse(await readFile(join(productRoot, "pin-manifest.json"), "utf8"));

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function fail(predicate: string, detail: unknown): never {
  process.stderr.write(`PIN_DRIFT ${predicate}: ${JSON.stringify(detail)}\n`);
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== manifest.nodeMajor) fail("node.major", { expected: manifest.nodeMajor, actual: nodeMajor });

const sdkPackage = JSON.parse(
  await readFile(join(productRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"),
);
if (sdkPackage.version !== manifest.claude.sdkVersion) {
  fail("claude.sdkVersion", { expected: manifest.claude.sdkVersion, actual: sdkPackage.version });
}
const claudePath = bundledClaudeCliPath();
const claudeHash = sha256(await readFile(claudePath));
if (claudeHash !== manifest.claude.bundledCliSha256) {
  fail("claude.bundledCliSha256", { expected: manifest.claude.bundledCliSha256, actual: claudeHash });
}
const { stdout: claudeVersionOutput } = await execFileAsync(claudePath, ["--version"], {
  timeout: 10_000,
});
const claudeVersion = claudeVersionOutput.trim().split(" ")[0];
if (claudeVersion !== manifest.claude.bundledCliVersion) {
  fail("claude.bundledCliVersion", { expected: manifest.claude.bundledCliVersion, actual: claudeVersion });
}

const { stdout: codexVersionOutput } = await execFileAsync(manifest.codex.binary, ["--version"], {
  timeout: 10_000,
});
const codexVersion = codexVersionOutput.trim();
if (codexVersion !== manifest.codex.version) {
  fail("codex.version", { expected: manifest.codex.version, actual: codexVersion });
}
const generatedRoot = await mkdtemp(join(tmpdir(), "collab-codex-schema-"));
await execFileAsync(
  manifest.codex.binary,
  ["app-server", "generate-json-schema", "--out", generatedRoot],
  { timeout: 30_000 },
);
const generatedCombined = join(generatedRoot, basename("codex_app_server_protocol.v2.schemas.json"));
const generatedRaw = await readFile(generatedCombined);
const generatedHash = sha256(
  Buffer.from(JSON.stringify(canonical(JSON.parse(generatedRaw.toString("utf8"))))),
);
if (generatedHash !== manifest.codex.combinedSchemaCanonicalSha256) {
  fail("codex.appServerSchema", {
    expected: manifest.codex.combinedSchemaCanonicalSha256,
    actual: generatedHash,
  });
}
const { stdout: featureOutput } = await execFileAsync(manifest.codex.binary, ["features", "list"], {
  timeout: 10_000,
});
if (!featureOutput.trim()) fail("codex.features", "empty feature listing");
if (!manifest.claude.watchItems.some((item: string) => item.includes("--bare"))) {
  fail("claude.bareWatch", "missing");
}
if (!manifest.forbiddenProviderMethods.includes("account/rateLimitResetCredit/consume")) {
  fail("codex.resetCreditGuard", "missing");
}

// Overhead-gate-v2 absolute-allowance pin: the reference fixture bytes, the
// recorded derivation arithmetic, and the constant the kernel actually uses
// must all agree. Re-deriving the allowance from a judged run is forbidden.
const gate = manifest.overheadGate;
if (gate?.gateVersion !== "overhead-gate-v2" || gate.referenceClassifier !== "real-burst-v2") {
  fail("overheadGate.version", gate ?? "missing");
}
const fixtureHash = sha256(await readFile(join(productRoot, gate.referenceFixture)));
if (fixtureHash !== gate.referenceFixtureSha256) {
  fail("overheadGate.referenceFixtureSha256", {
    expected: gate.referenceFixtureSha256,
    actual: fixtureHash,
  });
}
const derived = 2 ** Math.ceil(
  Math.log2((gate.multiplier * gate.referenceChargedBytes) / gate.referenceWorkerBursts),
);
if (
  gate.rounding !== "next-power-of-two" ||
  derived !== gate.absoluteAllowanceBytesPerWorkerBurst
) {
  fail("overheadGate.derivation", {
    expected: gate.absoluteAllowanceBytesPerWorkerBurst,
    derived,
  });
}
const { ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST } = await import(
  "../packages/kernel/src/overhead.ts"
);
if (ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST !== gate.absoluteAllowanceBytesPerWorkerBurst) {
  fail("overheadGate.kernelConstant", {
    manifest: gate.absoluteAllowanceBytesPerWorkerBurst,
    kernel: ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST,
  });
}

process.stdout.write(
  `RESULT ${JSON.stringify({
    suite: "V-0",
    passed: true,
    nodeMajor,
    codexVersion,
    codexSchemaSha256: generatedHash,
    codexFeatureLines: featureOutput.trim().split("\n").length,
    claudeSdkVersion: sdkPackage.version,
    claudeBundledCliVersion: claudeVersion,
    claudeBundledCliSha256: claudeHash,
    collabdSchemaVersion: manifest.collabdSchemaVersion,
    modelStarts: 0,
  })}\n`,
);
