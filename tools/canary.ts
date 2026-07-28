import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeAgentAdapter,
  CodexAppServerClient,
  ModelStartGuard,
  scrubProviderEnvironment,
  type ModelAuthorization,
} from "../packages/adapters/src/index.ts";
import { EventStore, reportOverhead } from "../packages/kernel/src/index.ts";
import { isContainedPath } from "../packages/security/src/index.ts";
import { Coordinator } from "../packages/service/src/coordinator.ts";
import { RealCollaborationRunner } from "../packages/service/src/real-runner.ts";
import {
  claimCanaryAuthorization,
  createCanaryEvidence,
  type CanaryAuthorizationRecord,
  type CanarySuite,
} from "../packages/service/src/canary-evidence.ts";
import {
  runRealSmoke,
  type SmokeBurstResult,
} from "../packages/service/src/real-smoke.ts";

const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");

const suiteIndex = process.argv.indexOf("--suite");
const suite = suiteIndex >= 0 ? process.argv[suiteIndex + 1] : null;
if (!["smoke", "collab-e2e"].includes(String(suite))) {
  throw new Error("CANARY_SUITE_REQUIRED: use --suite smoke or --suite collab-e2e");
}

const authorizationPath = process.env.COLLAB_REAL_CANARY_AUTHORIZATION_FILE;
if (!authorizationPath) {
  process.stderr.write(
    "REAL_CANARY_UNAUTHORIZED: set COLLAB_REAL_CANARY_AUTHORIZATION_FILE only after the user explicitly authorizes this subscription-consuming canary in the current session.\n",
  );
  process.stdout.write(
    `RESULT ${JSON.stringify({
      suite: `V-13-${suite}`,
      passed: false,
      status: "unavailable/unauthorized",
      blockingPredicate: "missing explicit current-session canary authorization",
      modelStarts: 0,
    })}\n`,
  );
  process.exit(2);
}

const authorization = JSON.parse(await readFile(resolve(authorizationPath), "utf8"));
if (
  authorization.kind !== "real_canary" ||
  authorization.scope !== suite ||
  authorization.confirmed !== true ||
  !Array.isArray(authorization.providers) ||
  authorization.providers.length !== 2 ||
  !authorization.providers.includes("codex") ||
  !authorization.providers.includes("claude") ||
  !Number.isFinite(Date.parse(authorization.issuedAt)) ||
  Date.now() - Date.parse(authorization.issuedAt) > 15 * 60_000 ||
  Date.now() < Date.parse(authorization.issuedAt) - 60_000 ||
  !Number.isFinite(Date.parse(authorization.expiresAt)) ||
  Date.parse(authorization.expiresAt) <= Date.now() ||
  Date.parse(authorization.expiresAt) > Date.now() + 60 * 60_000
) {
  throw new Error("REAL_CANARY_AUTHORIZATION_INVALID");
}
const authorizationRecord = authorization as CanaryAuthorizationRecord;
const jsonOutIndex = process.argv.indexOf("--json-out");
if (jsonOutIndex < 0 || !process.argv[jsonOutIndex + 1]) {
  throw new Error(
    "CANARY_JSON_OUT_REQUIRED: authorized real canaries must persist an evidence artifact",
  );
}
const evidenceOutputPath = resolve(process.cwd(), process.argv[jsonOutIndex + 1]!);
const authorizationClaim = await claimCanaryAuthorization({
  authorizationPath: resolve(authorizationPath),
  authorization: authorizationRecord,
  evidenceOutputPath,
  claimedAt: new Date().toISOString(),
});

const manifest = JSON.parse(
  await readFile(join(productRoot, "pin-manifest.json"), "utf8"),
);
const canaryRoot = mkdtempSync(join(tmpdir(), `collab-canary-${suite}-`));
const directory = join(canaryRoot, "workspace");
mkdirSync(directory, { recursive: true, mode: 0o700 });

async function persistResult(
  canarySuite: CanarySuite,
  result: Record<string, any>,
): Promise<void> {
  const persistedResult = { ...result, authorizationClaim };
  const evidence = createCanaryEvidence({
    suite: canarySuite,
    observedAt: new Date().toISOString(),
    authorization: authorizationRecord,
    result: persistedResult,
  });
  await mkdir(dirname(evidenceOutputPath), { recursive: true, mode: 0o700 });
  await writeFile(evidenceOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(evidenceOutputPath, 0o600);
  process.stdout.write(
    `RESULT ${JSON.stringify({
      ...persistedResult,
      evidencePath: evidenceOutputPath,
      evidenceDigest: evidence.evidenceDigest,
      authorizationDigest: evidence.authorizationDigest,
    })}\n`,
  );
}

async function runSmoke(): Promise<void> {
  const runId = `run_smoke_${randomUUID()}`;
  const modelAuthorization: ModelAuthorization = {
    id: `auth_${randomUUID()}`,
    kind: "real_canary",
    runId,
    providers: ["codex", "claude"],
    recordedAt: new Date().toISOString(),
  };
  const scrubbed = scrubProviderEnvironment(process.env);
  const codexGuard = new ModelStartGuard();
  const claudeGuard = new ModelStartGuard();
  const codex = new CodexAppServerClient({
    binary: manifest.codex.binary,
    cwd: directory,
    env: scrubbed.env,
    guard: codexGuard,
    onServerRequest: async (message) => {
      const method = String(message.method ?? "");
      if (method === "item/tool/requestUserInput") return { answers: {} };
      if (method === "item/permissions/requestApproval") {
        return { permissions: {}, scope: "turn", strictAutoReview: true };
      }
      return { decision: "decline" };
    },
  });
  const claude = new ClaudeAgentAdapter({
    cwd: directory,
    env: scrubbed.env,
    guard: claudeGuard,
    canUseTool: async () => ({
      behavior: "deny",
      message: "The bounded read-only smoke test denies every tool.",
    }),
  });
  const metadataInput = {
    versionMatches: true,
    forbiddenEnvironment: scrubbed.forbiddenPresent,
    spawnArgs: [] as string[],
    effectiveProviderOverride: false,
    subscriptionsRegistered: true,
  };

  try {
    const report = await runRealSmoke({
      runId,
      workspace: directory,
      authorization: modelAuthorization,
      providers: {
        codex: {
          role: "codex",
          metadataPreflight: () =>
            codex.metadataPreflight({
              ...metadataInput,
              schemaMatches: true,
              spawnArgs: ["app-server", "--listen", "stdio://"],
            }),
          burst: async (input): Promise<SmokeBurstResult> => {
            const result = await codex.runBurst({
              runId: input.runId,
              prompt: input.prompt,
              authorization: input.authorization,
              ...(input.sessionId ? { threadId: input.sessionId } : {}),
              sandbox: "read-only",
              timeoutMs: input.timeoutMs,
            });
            return {
              sessionId: result.threadId,
              text: result.text,
              usage: result.usage,
            };
          },
          guardSnapshot: () => codexGuard.snapshot(),
        },
        claude: {
          role: "claude",
          metadataPreflight: () =>
            claude.metadataPreflight({
              ...metadataInput,
              sdkMatches: true,
              apiKeyHelperPresent: false,
            }),
          burst: async (input): Promise<SmokeBurstResult> => {
            const abortController = new AbortController();
            const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
            timer.unref();
            try {
              const result = await claude.startBurst({
                runId: input.runId,
                prompt: input.prompt,
                authorization: input.authorization,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                maxTurns: 1,
                abortController,
              });
              return {
                sessionId: result.sessionId,
                text: result.text,
                usage: result.usage,
              };
            } finally {
              clearTimeout(timer);
            }
          },
          guardSnapshot: () => claudeGuard.snapshot(),
        },
      },
      nonce: randomUUID().replaceAll("-", ""),
    });
    const result = {
      suite: "V-13-smoke",
      ...report,
      status: report.passed ? "passed" : "failed",
      runId,
      workspacePath: directory,
      canaryRoot,
      codexBillingRoute:
        report.billingAfter.codex?.route ??
        report.billingBefore.codex?.route ??
        "unknown",
      claudeBillingRoute:
        report.billingAfter.claude?.route ??
        report.billingBefore.claude?.route ??
        "unknown",
    };
    await persistResult("V-13-smoke", result);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await codex.close();
  }
}

async function runCollaborationE2e(): Promise<void> {
  const expectedContent = "collaboration canary passed.";
  const maximumDurationMs = 30 * 60_000;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let deadlineExceeded = false;
  const store = new EventStore(join(canaryRoot, "state", "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: manifest.codex.binary,
    publish: () => undefined,
  });
  const runId = coordinator.createRun(
    {
      goal: `Create canary-output.txt containing exactly the UTF-8 bytes ${JSON.stringify(expectedContent)} with no trailing newline. Verify its exact contents and reach shared consensus.`,
      workspace: directory,
      constraints: [
        "No network access.",
        "No dependency installation.",
        "No destructive commands.",
        "Only the temporary canary workspace may be changed.",
      ],
      completionEvidence: [
        `canary-output.txt has SHA-256 ${createHash("sha256").update(expectedContent).digest("hex")}.`,
        "Both providers sign the same manifest.",
      ],
      mode: "real",
      budgets: { perProvider: 8, perMaterialChallenge: 2 },
    },
    true,
  );
  const codexGuard = new ModelStartGuard();
  const claudeGuard = new ModelStartGuard();
  const runner = new RealCollaborationRunner(store, {
    codexBinary: manifest.codex.binary,
    publish: () => undefined,
    modelGuards: { codex: codexGuard, claude: claudeGuard },
    onCodexServerRequest: async (_runId, message) => {
      const method = String(message.method ?? "");
      const params = message.params ?? {};
      const command = String(params.command ?? "");
      const path = String(params.grantRoot ?? params.cwd ?? directory);
      const hazardous =
        Boolean(params.networkApprovalContext) ||
        Boolean(params.proposedNetworkPolicyAmendments?.length) ||
        /\b(?:curl|wget|ssh|scp|nc|rm|rmdir|unlink|truncate|install|add)\b/i.test(command) ||
        !isContainedPath(directory, path);
      if (method === "item/tool/requestUserInput") return { answers: {} };
      if (method === "item/permissions/requestApproval") {
        return {
          permissions: hazardous ? {} : params.permissions ?? {},
          scope: "turn",
          strictAutoReview: true,
        };
      }
      return { decision: hazardous ? "decline" : "accept" };
    },
    onClaudeToolRequest: async (_runId, toolName, input, context) => {
      const path = String(
        input.file_path ??
          input.path ??
          input.notebook_path ??
          context.blockedPath ??
          directory,
      );
      const command = String(input.command ?? "");
      const hazardous =
        ["WebFetch", "WebSearch"].includes(toolName) ||
        /\b(?:curl|wget|ssh|scp|nc|rm|rmdir|unlink|truncate|install|add)\b/i.test(command) ||
        !isContainedPath(directory, path);
      return hazardous
        ? { behavior: "deny", message: "The bounded canary denies this operation." }
        : { behavior: "allow" };
    },
  });

  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void runner.cancel(runId);
  }, maximumDurationMs);
  deadline.unref();
  try {
    await runner.run(runId, true, "real_canary");
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const projection = store.projection(runId);
    const events = store.events(runId);
    const usage = store.usageRecords(runId);
    const overhead = reportOverhead(usage);
    let eventChain: { ok: boolean; count: number; error?: string };
    try {
      eventChain = store.verifyHashChain(runId);
    } catch (error) {
      eventChain = {
        ok: false,
        count: events.length,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const billingSnapshots = { codex: [] as any[], claude: [] as any[] };
    for (const event of events) {
      if (event.type !== "preflight_passed") continue;
      const provider = (event.payload as any)?.provider;
      const billing = (event.payload as any)?.billing;
      if (provider === "codex" && billing) billingSnapshots.codex.push(billing);
      if (provider === "claude" && billing) billingSnapshots.claude.push(billing);
    }
    const billingBefore = {
      codex: billingSnapshots.codex.at(0) ?? null,
      claude: billingSnapshots.claude.at(0) ?? null,
    };
    const billingAfter = {
      codex: billingSnapshots.codex.at(-1) ?? null,
      claude: billingSnapshots.claude.at(-1) ?? null,
    };
    const codexCreditBalance = {
      snapshots: billingSnapshots.codex.map((snapshot, index) => ({
        index,
        route: snapshot.route ?? "unknown",
        creditsPresent:
          snapshot.usage?.providerManagedCreditsPresent ?? null,
        balanceAvailable:
          snapshot.usage?.providerManagedCreditBalanceAvailable ?? null,
        changedSincePrevious:
          snapshot.usage
            ?.providerManagedCreditBalanceChangedSincePrevious ?? null,
      })),
      consumingExistingCredits: billingSnapshots.codex.some(
        (snapshot) => snapshot.route === "existing_credits",
      ),
      changedWhileSubscription: billingSnapshots.codex
        .slice(1)
        .some(
          (snapshot) =>
            snapshot.route === "subscription_allowance" &&
            snapshot.usage
              ?.providerManagedCreditBalanceChangedSincePrevious === true,
        ),
      complete:
        billingSnapshots.codex.length >= 3 &&
        billingSnapshots.codex.every((snapshot, index) => {
          if (snapshot.route === "existing_credits") return true;
          if (snapshot.route !== "subscription_allowance") return false;
          if (snapshot.usage?.providerManagedCreditsPresent !== true) return true;
          return (
            snapshot.usage?.providerManagedCreditBalanceAvailable === true &&
            (index === 0 ||
              snapshot.usage
                ?.providerManagedCreditBalanceChangedSincePrevious === false)
          );
        }),
    };
    const claudePosture = {
      authenticatedByUnchanged:
        billingSnapshots.claude.length > 0 &&
        billingSnapshots.claude.every(
          (snapshot) =>
            snapshot.authenticatedBy ===
            billingSnapshots.claude[0]?.authenticatedBy,
        ),
      planUnchanged:
        billingSnapshots.claude.length > 0 &&
        billingSnapshots.claude.every(
          (snapshot) => snapshot.plan === billingSnapshots.claude[0]?.plan,
        ),
      extraUsageSettingUnchanged:
        billingSnapshots.claude.length > 0 &&
        billingSnapshots.claude.every(
          (snapshot) =>
            snapshot.usage?.extraUsageEnabled ===
            billingSnapshots.claude[0]?.usage?.extraUsageEnabled,
        ),
    };
    const modelWakeEvents = events.filter(
      (event) =>
        (event.type === "work_claimed" || event.type === "resumed") &&
        (event.payload as any)?.modelWake === true,
    );
    const wakeLatencies = modelWakeEvents
      .map((event) => Number((event.payload as any)?.wakeLatencyMs))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const wakeP95Ms = wakeLatencies.length
      ? wakeLatencies[Math.max(0, Math.ceil(wakeLatencies.length * 0.95) - 1)]!
      : null;
    const artifactPath = join(directory, "canary-output.txt");
    const expectedSha256 = createHash("sha256").update(expectedContent).digest("hex");
    let actualContent: Buffer | null = null;
    try {
      actualContent = await readFile(artifactPath);
    } catch {
      actualContent = null;
    }
    const actualSha256 = actualContent
      ? createHash("sha256").update(actualContent).digest("hex")
      : null;
    const artifact = {
      path: artifactPath,
      expectedSha256,
      actualSha256,
      exact:
        actualContent !== null &&
        actualContent.equals(Buffer.from(expectedContent, "utf8")),
    };
    const modelStartsByProvider = {
      codex: codexGuard.snapshot().started,
      claude: claudeGuard.snapshot().started,
    };
    const modelStarts =
      modelStartsByProvider.codex + modelStartsByProvider.claude;
    const noOpInvocations = Math.max(0, modelStarts - usage.length);
    const usageCoverageComplete = usage.length === modelStarts;
    const modelAttemptsByProvider = {
      codex: codexGuard.snapshot().attempts,
      claude: claudeGuard.snapshot().attempts,
    };
    const forbiddenBillingMethods =
      codexGuard.snapshot().forbiddenBillingMethods +
      claudeGuard.snapshot().forbiddenBillingMethods;
    const wakeLatency = {
      sampleCount: wakeLatencies.length,
      p95Ms: wakeP95Ms,
      thresholdMs: 5_000,
      coverageComplete: wakeLatencies.length === modelStarts,
      passed:
        wakeLatencies.length === modelStarts &&
        wakeP95Ms !== null &&
        wakeP95Ms <= 5_000,
    };
    const duration = {
      startedAt,
      finishedAt,
      durationMs,
      maximumDurationMs,
      deadlineExceeded,
      passed: !deadlineExceeded && durationMs <= maximumDurationMs,
    };
    const billingAllowed = [
      billingBefore.codex?.route,
      billingBefore.claude?.route,
      billingAfter.codex?.route,
      billingAfter.claude?.route,
    ].every(
      (route) => route === "subscription_allowance" || route === "existing_credits",
    );
    const passed =
      projection.state === "completed_consensus" &&
      overhead.passed &&
      eventChain.ok &&
      artifact.exact &&
      usageCoverageComplete &&
      noOpInvocations === 0 &&
      forbiddenBillingMethods === 0 &&
      wakeLatency.passed &&
      duration.passed &&
      codexCreditBalance.complete &&
      !codexCreditBalance.changedWhileSubscription &&
      claudePosture.authenticatedByUnchanged &&
      claudePosture.planUnchanged &&
      claudePosture.extraUsageSettingUnchanged &&
      billingAllowed &&
      modelStartsByProvider.codex <= 8 &&
      modelStartsByProvider.claude <= 8;
    const result = {
      suite: "V-13-collab-e2e",
      passed,
      status: passed ? "passed" : projection.state,
      terminalOutcome: projection.state,
      runId,
      workspace: directory,
      canaryRoot,
      codexBillingRoute: billingAfter.codex?.route ?? "unknown",
      claudeBillingRoute: billingAfter.claude?.route ?? "unknown",
      billingBefore,
      billingAfter,
      billingSnapshots,
      codexCreditBalance,
      claudePosture,
      duration,
      wakeLatency,
      overhead,
      eventChain,
      finalEventHash: events.at(-1)?.hash ?? null,
      artifact,
      candidateDigest: projection.candidate?.digest ?? null,
      verificationDigest: projection.candidate?.verificationDigest ?? null,
      usageRecordCount: usage.length,
      usageCoverageComplete,
      noOpInvocations,
      forbiddenBillingMethods,
      modelAttemptsByProvider,
      modelStartsByProvider,
      modelStarts,
      budgetedUsefulBursts: {
        codex: projection.budgets.provider.codex.consumed,
        claude: projection.budgets.provider.claude.consumed,
      },
    };
    await persistResult("V-13-collab-e2e", result);
    if (!passed) process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    store.close();
  }
}

if (suite === "smoke") {
  await runSmoke();
} else {
  await runCollaborationE2e();
}
