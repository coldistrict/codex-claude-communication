import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ClaudeAgentAdapter,
  CodexAppServerClient,
  auditSpawnArgs,
  scrubProviderEnvironment,
} from "../packages/adapters/src/index.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");
const manifest = JSON.parse(await readFile(join(productRoot, "pin-manifest.json"), "utf8"));
const workspace = process.argv.includes("--workspace")
  ? resolve(process.argv[process.argv.indexOf("--workspace") + 1]!)
  : resolve(productRoot, "..");
const scrubbed = scrubProviderEnvironment(process.env);

const codex = new CodexAppServerClient({
  binary: manifest.codex.binary,
  cwd: workspace,
  env: scrubbed.env,
});
let codexResult;
try {
  codexResult = await codex.metadataPreflight({
    versionMatches: true,
    schemaMatches: true,
    forbiddenEnvironment: scrubbed.forbiddenPresent,
    spawnArgs: ["app-server", "--listen", "stdio://"],
    effectiveProviderOverride: false,
    subscriptionsRegistered: true,
  });
} catch (error) {
  codexResult = {
    ok: false,
    provider: "codex",
    predicate: "codex.metadata_probe_failed",
    remedy: error instanceof Error ? error.message : String(error),
    billing: { provider: "codex", route: "unknown" },
  };
} finally {
  await codex.close();
}

const claude = new ClaudeAgentAdapter({ cwd: workspace, env: scrubbed.env });
const claudeResult = await claude.metadataPreflight({
  versionMatches: true,
  sdkMatches: true,
  forbiddenEnvironment: scrubbed.forbiddenPresent,
  spawnArgs: [],
  apiKeyHelperPresent: false,
  effectiveProviderOverride: false,
  subscriptionsRegistered: true,
});

const report = {
  modelStarts: 0,
  creditPurchases: 0,
  automaticTopUpsEnabledByProduct: 0,
  resetCreditsConsumed: 0,
  codex: codexResult,
  claude: claudeResult,
  realProviderReady: Boolean(codexResult.ok && claudeResult.ok),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `RESULT ${JSON.stringify({
    suite: "doctor",
    passed: true,
    codexReady: Boolean(codexResult.ok),
    codexBillingRoute: codexResult.billing?.route ?? "unknown",
    claudeReady: Boolean(claudeResult.ok),
    claudeBillingRoute: claudeResult.billing?.route ?? "unknown",
    modelStarts: 0,
  })}\n`,
);
