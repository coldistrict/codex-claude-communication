import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BillingStatus } from "@collab/contracts";
import {
  globalModelStartGuard,
  type AdvisorStartContext,
  type ModelAuthorization,
  type ModelStartGuard,
} from "./model-guard.ts";
import {
  evaluateClaudePreflight,
  scrubProviderEnvironment,
  type ClaudePreflightInput,
  type PreflightResult,
} from "./policy.ts";

import { observeRuntime } from './runtime.ts';
import { redactSecrets } from '@collab/security';

const execFileAsync = promisify(execFile);

export function bundledClaudeCliPath(): string {
  const require = createRequire(import.meta.url);
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const packageJson = require.resolve(`${platformPackage}/package.json`);
  return join(dirname(packageJson), process.platform === "win32" ? "claude.exe" : "claude");
}

export interface ClaudeAdapterOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  guard?: ModelStartGuard;
  onMessage?: (message: unknown) => void;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export interface ClaudeBillingUsage {
  includedUsageRemaining: boolean | null;
  extraUsageEnabled: boolean | null;
  existingCreditsRemaining: boolean | null;
  currentRoute: "subscription_allowance" | "existing_credits" | null;
}

export function parseClaudeBillingUsage(
  usage: Record<string, any> | null,
): ClaudeBillingUsage {
  const rateLimits =
    usage?.rate_limits && typeof usage.rate_limits === "object"
      ? usage.rate_limits
      : null;
  const utilizations: unknown[] = [];

  if (rateLimits) {
    for (const [name, window] of Object.entries(rateLimits)) {
      if (name === "extra_usage" || name === "limits" || name === "spend") continue;
      if (name === "model_scoped" && Array.isArray(window)) {
        for (const scopedWindow of window) {
          if (
            scopedWindow &&
            typeof scopedWindow === "object" &&
            Object.hasOwn(scopedWindow, "utilization")
          ) {
            utilizations.push((scopedWindow as { utilization?: unknown }).utilization);
          }
        }
      } else if (
        window &&
        typeof window === "object" &&
        !Array.isArray(window) &&
        Object.hasOwn(window, "utilization")
      ) {
        utilizations.push((window as { utilization?: unknown }).utilization);
      }
    }

    // Newer bundled runtimes may also expose the normalized limit list used by
    // the Claude UI. Count it as corroborating limit evidence without treating
    // unrelated objects such as `spend` as utilization windows.
    if (Array.isArray(rateLimits.limits)) {
      for (const limit of rateLimits.limits) {
        if (limit && typeof limit === "object" && Object.hasOwn(limit, "percent")) {
          utilizations.push((limit as { percent?: unknown }).percent);
        }
      }
    }
  }

  const windowsComplete =
    utilizations.length > 0 &&
    utilizations.every(
      (value: unknown) => typeof value === "number" && Number.isFinite(value),
    );
  const includedUsageRemaining =
    usage?.rate_limits_available === true && windowsComplete
      ? utilizations.every((utilization) => (utilization as number) < 100)
      : null;
  const extra = rateLimits?.extra_usage;
  // A monthly spending limit is not proof of a funded prepaid balance.
  // The observed experimental payload has no verified prepaid-balance field.
  const existingCreditsRemaining: boolean | null = null;
  const currentRoute =
    includedUsageRemaining === true
      ? "subscription_allowance"
      : includedUsageRemaining === false &&
          extra?.is_enabled === true &&
          existingCreditsRemaining === true
        ? "existing_credits"
        : null;

  return {
    includedUsageRemaining,
    extraUsageEnabled:
      typeof extra?.is_enabled === "boolean" ? extra.is_enabled : null,
    existingCreditsRemaining,
    currentRoute,
  };
}

export class ClaudeAgentAdapter {
  private billing: BillingStatus | null = null;
  private readonly guard: ModelStartGuard;

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.guard = options.guard ?? globalModelStartGuard;
  }

  async authStatus(): Promise<Record<string, any>> {
    const scrubbed = scrubProviderEnvironment(this.options.env ?? process.env);
    if (scrubbed.forbiddenPresent.length) {
      throw new Error(`CLAUDE_FORBIDDEN_ENVIRONMENT:${scrubbed.forbiddenPresent.join(",")}`);
    }
    const cli = bundledClaudeCliPath();
    try {
      const { stdout } = await execFileAsync(cli, ["auth", "status", "--json"], {
        cwd: this.options.cwd,
        env: scrubbed.env,
        timeout: 10_000,
      });
      return JSON.parse(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout;
      if (stdout) return JSON.parse(String(stdout));
      throw error;
    }
  }

  async metadataPreflight(
    input: Omit<ClaudePreflightInput, "auth" | "billing">,
  ): Promise<PreflightResult> {
    const observed = await observeRuntime('claude', bundledClaudeCliPath());
    input = { ...input, versionMatches: observed.versionMatches, sdkMatches: observed.sdkMatches };
    const diagnostics: string[] = [];
    let auth: Record<string, any> | null = null;
    let account: Record<string, any> | null = null;
    let usage: Record<string, any> | null = null;
    try {
      auth = await this.authStatus();
    } catch (error) {
      diagnostics.push(`auth/status: ${redactSecrets(String(error)).slice(0,1500)}`);
      auth = null;
    }
    if (auth?.loggedIn) {
      try {
        ({ account, usage } = await this.controlMetadata());
      } catch (error) {
        diagnostics.push(`control metadata: ${redactSecrets(String(error)).slice(0,1500)}`);
        account = null;
        usage = null;
      }
    }
    const billing = parseClaudeBillingUsage(usage);
    const result = evaluateClaudePreflight({
      ...input,
      auth: auth
        ? {
            loggedIn: Boolean(auth.loggedIn),
            // authMethod comes only from `claude auth status --json`; no
            // fallback field may satisfy the plan §5.1.4 predicate.
            authMethod: String(auth.authMethod ?? "unknown"),
            apiProvider: String(account?.apiProvider ?? auth.apiProvider ?? "unknown"),
            subscriptionType:
              usage?.subscription_type ??
              account?.subscriptionType ??
              auth.subscriptionType ??
              auth.subscription_type ??
              auth.planType ??
              null,
            apiKeySource: account?.apiKeySource ?? auth.apiKeySource ?? null,
            tokenSource: account?.tokenSource ?? auth.tokenSource ?? null,
          }
        : null,
      billing: {
        ...billing,
      },
    });
    if (diagnostics.length) {
      result.trace.push(...diagnostics);
      if (!auth) { result.predicate = 'claude.auth_metadata_unavailable'; result.remedy = 'The official auth-status probe failed. Check the redacted diagnostics and retry; this does not establish a missing login.'; result.billing.blockingPredicate = result.predicate; result.billing.remedy = result.remedy; }
    }
    result.trace.push(...observed.trace);
    result.billing.proof.push(...observed.trace, ...diagnostics);
    this.billing = result.ok ? result.billing : null;
    return result;
  }

  /**
   * Metadata-only model catalog read on the existing no-model metadata
   * stream. Never a model-query site: it powers the adviser profile pin and
   * per-wake catalog verification only.
   */
  async listModels(): Promise<any[]> {
    const { models } = await this.controlMetadata({ models: true });
    return models ?? [];
  }

  private async controlMetadata(fetch: { models?: boolean } = {}): Promise<{
    account: Record<string, any>;
    usage: Record<string, any>;
    models?: any[];
  }> {
    const scrubbed = scrubProviderEnvironment(this.options.env ?? process.env);
    async function* noModelMessages(): AsyncGenerator<any> {
      await new Promise<void>(() => undefined);
    }
    const stream = query({
      prompt: noModelMessages(),
      options: {
        cwd: this.options.cwd,
        env: scrubbed.env,
        pathToClaudeCodeExecutable: bundledClaudeCliPath(),
        permissionMode: "dontAsk",
        disallowedTools: ["Agent", "WebFetch", "WebSearch"],
        settingSources: [],
        strictMcpConfig: true,
      },
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CLAUDE_METADATA_TIMEOUT")), 15_000);
      timer.unref();
    });
    try {
      const [account, usage, models] = await Promise.race([
        Promise.all([
          stream.accountInfo(),
          stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          fetch.models ? stream.supportedModels() : Promise.resolve(undefined),
        ]),
        timeout,
      ]);
      return {
        account: account as any,
        usage: usage as any,
        ...(models ? { models: models as any[] } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      stream.close();
    }
  }

  async startBurst(input: {
    runId: string;
    prompt: string;
    systemPrompt?: string;
    sessionTitle?: string;
    sessionId?: string;
    authorization: ModelAuthorization;
    outputSchema?: Record<string, unknown>;
    maxTurns?: number;
    abortController?: AbortController;
    readOnly?: boolean;
    /**
     * Adviser profile: no tools, no MCP/skills/subagents/web, no permission
     * callback, dontAsk, maxTurns 1, the wake-time resolved default model
     * and effort, and a one-use bound authorization. The worker profile
     * never sets these.
     */
    executionProfile?: "worker" | "advisor" | "planning";
    model?: string;
    effort?: string;
    advisorContext?: AdvisorStartContext;
  }): Promise<{
    sessionId: string | null;
    messages: unknown[];
    text: string;
    structuredOutput: unknown;
    usage: { input: number; cachedInput: number; output: number; reasoning: number };
  }> {
    if (!this.billing || !["subscription_allowance", "existing_credits"].includes(this.billing.route)) {
      throw new Error("CLAUDE_PREFLIGHT_REQUIRED");
    }
    const advisor = input.executionProfile === "advisor";
    if (
      advisor &&
      (!input.model ||
        !input.effort ||
        !input.advisorContext ||
        !input.systemPrompt)
    ) {
      throw new Error("CLAUDE_ADVISOR_PROFILE_INCOMPLETE");
    }

    const scrubbed = scrubProviderEnvironment(this.options.env ?? process.env);
    const messages: unknown[] = [];
    let sessionId: string | null = input.sessionId ?? null;
    let text = "";
    let structuredOutput: unknown;
    let usage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    // A worker burst that exhausts its turn budget mid-work resumes its own
    // session with a fresh budget instead of failing into lease
    // reconciliation — the budget bounds one SDK call, not the work item.
    // Two continuations at most; adviser wakes (maxTurns 1 by design) and
    // sessions that never reported an id keep the hard-failure semantics.
    // Usage is reported from the completing call only, which can only
    // understate useful work and therefore tightens the overhead gate.
    let prompt = input.prompt;
    let continuations = 0;
    while (true) {
      try {
        return await this.runBurstOnce(input, advisor, scrubbed.env, prompt, sessionId, messages, {
          setSession: (id) => {
            sessionId = id;
          },
          setOutcome: (burstText, burstStructured, burstUsage) => {
            text = burstText;
            structuredOutput = burstStructured;
            usage = burstUsage;
          },
          getOutcome: () => ({ sessionId, text, structuredOutput, usage }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          advisor || input.executionProfile === "planning" ||
          continuations >= 2 ||
          !sessionId ||
          !message.includes("Reached maximum number of turns")
        ) {
          throw error;
        }
        continuations += 1;
        prompt =
          "The previous turn budget ran out mid-work. Continue in this same session exactly where you stopped and finish by producing the required structured output.";
      }
    }
  }

  private async runBurstOnce(
    input: Parameters<ClaudeAgentAdapter["startBurst"]>[0],
    advisor: boolean,
    env: NodeJS.ProcessEnv,
    prompt: string,
    resumeSessionId: string | null,
    messages: unknown[],
    sink: {
      setSession: (id: string) => void;
      setOutcome: (
        text: string,
        structuredOutput: unknown,
        usage: { input: number; cachedInput: number; output: number; reasoning: number },
      ) => void;
      getOutcome: () => {
        sessionId: string | null;
        text: string;
        structuredOutput: unknown;
        usage: { input: number; cachedInput: number; output: number; reasoning: number };
      };
    },
  ): Promise<{
    sessionId: string | null;
    messages: unknown[];
    text: string;
    structuredOutput: unknown;
    usage: { input: number; cachedInput: number; output: number; reasoning: number };
  }> {
    this.guard.authorize("claude", input.runId, input.authorization, input.advisorContext);
    const scrubbedEnv = env;
    const isolated = advisor || input.executionProfile === "planning";
    const stream = query({
      prompt,
      options: {
        cwd: this.options.cwd,
        env: scrubbedEnv,
        pathToClaudeCodeExecutable: bundledClaudeCliPath(),
        ...(input.abortController
          ? { abortController: input.abortController }
          : {}),
        maxTurns: advisor ? 1 : input.maxTurns ?? 8,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(input.sessionTitle ? { title: input.sessionTitle } : {}),
        ...(input.executionProfile === "planning" ? { persistSession: true } : {}),
        ...(input.outputSchema
          ? { outputFormat: { type: "json_schema", schema: input.outputSchema } }
          : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        permissionMode: isolated || input.readOnly ? "dontAsk" : "default",
        ...(isolated ? { tools: [], mcpServers: {} } : {}),
        disallowedTools: isolated
          ? [
              "Agent",
              "Task",
              "Skill",
              "WebFetch",
              "WebSearch",
              "Write",
              "Edit",
              "NotebookEdit",
              "Bash",
              "Read",
              "Glob",
              "Grep",
            ]
          : input.readOnly
            ? [
                "Agent",
                "WebFetch",
                "WebSearch",
                "Write",
                "Edit",
                "NotebookEdit",
                "Bash",
              ]
            : ["Agent", "WebFetch", "WebSearch"],
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: false,
        // The adviser has no canUseTool path at all: with zero tools there is
        // nothing to approve, and no permission decision can be requested.
        ...(isolated
          ? {}
          : {
              canUseTool: async (
                toolName: string,
                toolInput: Record<string, unknown>,
                context: any,
              ) => {
                if (!this.options.canUseTool) {
                  return {
                    behavior: "deny",
                    message:
                      "User approval is required in the collaboration dashboard.",
                  };
                }
                return (await this.options.canUseTool(
                  toolName,
                  toolInput,
                  context,
                )) as any;
              },
            }),
      } as any,
    });
    for await (const message of stream) {
      const candidate = message as any;
      if (candidate.session_id) sink.setSession(String(candidate.session_id));
      if (candidate.type === "result" && candidate.subtype === "success") {
        sink.setOutcome(String(candidate.result ?? ""), candidate.structured_output, {
          input: Number(candidate.usage?.input_tokens ?? 0) + Number(candidate.usage?.cache_creation_input_tokens ?? 0),
          cachedInput: Number(
            candidate.usage?.cache_read_input_tokens ??
              candidate.usage?.cached_input_tokens ??
              0,
          ),
          output: Number(candidate.usage?.output_tokens ?? 0),
          reasoning: Number(candidate.usage?.reasoning_output_tokens ?? 0),
        });
      }
      if (candidate.type === "result" && candidate.is_error) {
        throw new Error(`CLAUDE_BURST_FAILED:${(candidate.errors ?? []).join(";")}`);
      }
      messages.push(message);
      this.options.onMessage?.(message);
      if (
        candidate.type === "system" &&
        candidate.subtype === "init" &&
        candidate.apiKeySource &&
        candidate.apiKeySource !== "none" &&
        candidate.apiKeySource !== "subscription"
      ) {
        await stream.interrupt();
        throw new Error("CLAUDE_BILLING_INTEGRITY_UNKNOWN");
      }
      if (
        input.model &&
        candidate.type === "system" &&
        candidate.subtype === "init" &&
        String(candidate.model ?? "") !== input.model
      ) {
        // With an exact pinned model, the actual selected model reported by
        // system/init must match; any drift or reroute fails closed.
        await stream.interrupt();
        throw new Error(
          `CLAUDE_MODEL_DRIFT:requested=${input.model}:selected=${String(candidate.model ?? "unknown")}`,
        );
      }
    }
    const outcome = sink.getOutcome();
    return { ...outcome, messages };
  }
}
