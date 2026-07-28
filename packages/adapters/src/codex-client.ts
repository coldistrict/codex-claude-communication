import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { BillingStatus } from "@collab/contracts";
import {
  globalModelStartGuard,
  type AdvisorStartContext,
  type ModelAuthorization,
  type ModelStartGuard,
} from "./model-guard.ts";
import {
  FORBIDDEN_CODEX_METHODS,
  evaluateCodexPreflight,
  scrubProviderEnvironment,
  type CodexPreflightInput,
  type PreflightResult,
} from "./policy.ts";

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexClientOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Makes this a dedicated adviser client with fixed capability-off process
   * and thread configuration.
   */
  advisorToolIsolation?: boolean;
  disabledFeatures?: readonly string[];
  configOverrides?: readonly string[];
  guard?: ModelStartGuard;
  onNotification?: (message: JsonRpcMessage) => void;
  onServerRequest?: (message: JsonRpcMessage) => Promise<unknown>;
}

export const CODEX_ADVISOR_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
] as const;

export const CODEX_ADVISOR_CONFIG_OVERRIDES = [
  "mcp_servers={}",
  'web_search="disabled"',
] as const;

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly turnWaiters = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly completedTurns = new Map<string, any>();
  private readonly turnText = new Map<string, string>();
  private readonly turnUsage = new Map<string, Record<string, number>>();
  /** turnId -> toModel for model/rerouted notifications observed this burst. */
  private readonly reroutedTurns = new Map<string, string>();
  private stderrTail = "";
  private billing: BillingStatus | null = null;
  private previousCreditBalance: string | null | undefined;
  private readonly guard: ModelStartGuard;
  private advisorMcpServerOverrides: Record<string, { enabled: false }> = {};
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private activeTurnDone: (() => void) | null = null;

  constructor(private readonly options: CodexClientOptions) {
    this.guard = options.guard ?? globalModelStartGuard;
  }

  private disabledFeatures(): readonly string[] {
    return [
      ...new Set([
        ...(this.options.advisorToolIsolation
          ? CODEX_ADVISOR_DISABLED_FEATURES
          : []),
        ...(this.options.disabledFeatures ?? []),
      ]),
    ];
  }

  private configOverrides(): readonly string[] {
    return [
      ...new Set([
        ...(this.options.advisorToolIsolation
          ? CODEX_ADVISOR_CONFIG_OVERRIDES
          : []),
        ...(this.options.configOverrides ?? []),
      ]),
    ];
  }

  spawnArgs(): string[] {
    return [
      ...this.disabledFeatures().flatMap((feature) => [
        "--disable",
        feature,
      ]),
      ...this.configOverrides().flatMap((override) => [
        "--config",
        override,
      ]),
      "app-server",
      "--listen",
      "stdio://",
    ];
  }

  async connect(): Promise<void> {
    if (this.process) return;
    const scrubbed = scrubProviderEnvironment(this.options.env ?? process.env);
    if (scrubbed.forbiddenPresent.length) {
      throw new Error(`CODEX_FORBIDDEN_ENVIRONMENT:${scrubbed.forbiddenPresent.join(",")}`);
    }
    const child = spawn(this.options.binary, this.spawnArgs(), {
      cwd: this.options.cwd,
      env: scrubbed.env,
      stdio: ["pipe", "pipe", "pipe"],
      // The app-server may launch descendants. On POSIX, make it the leader
      // of a dedicated process group so cancellation can terminate the whole
      // tree instead of leaving provider work behind.
      detached: process.platform !== "win32",
    });
    this.process = child;
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && message.method) {
        void this.handleServerRequest(message);
      } else if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(`CODEX_RPC:${message.error.code}:${message.error.message}`));
        else waiter.resolve(message.result);
      } else if (message.method) {
        this.trackNotification(message);
        this.options.onNotification?.(message);
      }
    });
    child.on("exit", (code, signal) => {
      const error = new Error(
        `CODEX_APP_SERVER_EXIT:${String(code)}:${String(signal)}:${this.stderrTail}`,
      );
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.turnWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.turnWaiters.clear();
      this.process = null;
    });
    await this.request("initialize", {
      clientInfo: {
        name: "collaboration_product",
        title: "Local Codex and Claude collaboration",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  async metadataPreflight(input: Omit<CodexPreflightInput, "account" | "rateLimits">): Promise<PreflightResult> {
    await this.connect();
    const [accountResult, limitsResult, initialConfigResult] = await Promise.all([
      this.request("account/read", { refreshToken: false }),
      this.request("account/rateLimits/read", null),
      this.request("config/read", { cwd: this.options.cwd, includeLayers: true }),
    ]);
    let configResult = initialConfigResult;
    if (this.options.advisorToolIsolation) {
      const configured =
        configResult?.config?.mcp_servers &&
        typeof configResult.config.mcp_servers === "object" &&
        !Array.isArray(configResult.config.mcp_servers)
          ? Object.keys(configResult.config.mcp_servers)
          : [];
      const discoveredOverrides = Object.fromEntries(
        configured.map((name) => [name, { enabled: false as const }]),
      ) as Record<string, { enabled: false }>;
      this.advisorMcpServerOverrides = discoveredOverrides;
    }
    const configAudit = this.auditConfig(configResult);
    const result = evaluateCodexPreflight({
      ...input,
      effectiveProviderOverride:
        input.effectiveProviderOverride || configAudit.effectiveProviderOverride,
      effectiveProviderOverrideDetails: configAudit.forbiddenPaths,
      account: accountResult?.account
        ? {
            type: accountResult.account.type,
            planType: accountResult.account.planType ?? null,
            requiresOpenaiAuth: Boolean(accountResult.requiresOpenaiAuth),
          }
        : null,
      rateLimits: limitsResult?.rateLimits
        ? {
            structurallyTrusted: true,
            planType: limitsResult.rateLimits.planType ?? null,
            primary: limitsResult.rateLimits.primary
              ? {
                  usedPercent: limitsResult.rateLimits.primary.usedPercent,
                  resetsAt: limitsResult.rateLimits.primary.resetsAt ?? null,
                }
              : null,
            secondary: limitsResult.rateLimits.secondary
              ? {
                  usedPercent: limitsResult.rateLimits.secondary.usedPercent,
                  resetsAt: limitsResult.rateLimits.secondary.resetsAt ?? null,
                }
              : null,
            credits: limitsResult.rateLimits.credits
              ? {
                  hasCredits: limitsResult.rateLimits.credits.hasCredits,
                  unlimited: limitsResult.rateLimits.credits.unlimited,
                  balance: limitsResult.rateLimits.credits.balance ?? null,
                }
              : null,
            rateLimitReachedType: limitsResult.rateLimits.rateLimitReachedType ?? null,
            spendControlReached: limitsResult.rateLimits.spendControlReached ?? null,
          }
        : null,
    });
    if (result.ok && result.billing.usage) {
      const currentCreditBalance =
        typeof limitsResult?.rateLimits?.credits?.balance === "string"
          ? limitsResult.rateLimits.credits.balance
          : null;
      result.billing.usage.providerManagedCreditBalanceChangedSincePrevious =
        this.previousCreditBalance === undefined ||
        this.previousCreditBalance === null ||
        currentCreditBalance === null
          ? null
          : currentCreditBalance !== this.previousCreditBalance;
      this.previousCreditBalance = currentCreditBalance;
    }
    this.billing = result.ok ? result.billing : null;
    return result;
  }

  private auditConfig(result: any): {
    effectiveProviderOverride: boolean;
    forbiddenPaths: string[];
  } {
    const forbiddenPaths: string[] = [];
    const inspect = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const nextPath = path ? `${path}.${key}` : key;
        const normalized = key.toLowerCase();
        if (
          entry !== null &&
          entry !== undefined &&
          !(
            (typeof entry === "string" && entry.length === 0) ||
            (Array.isArray(entry) && entry.length === 0) ||
            (typeof entry === "object" &&
              !Array.isArray(entry) &&
              Object.keys(entry as object).length === 0)
          ) &&
          (normalized === "model_providers" ||
            normalized === "base_url" ||
            normalized.endsWith("_base_url") ||
            normalized === "env_key")
        ) {
          forbiddenPaths.push(nextPath);
        }
        inspect(entry, nextPath);
      }
    };
    for (const [index, layer] of (result?.layers ?? []).entries()) {
      inspect(layer?.config, `layers[${index}].config`);
    }
    const provider = result?.config?.model_provider;
    return {
      effectiveProviderOverride:
        (provider !== null && provider !== undefined && provider !== "openai") ||
        forbiddenPaths.length > 0,
      forbiddenPaths,
    };
  }

  /**
   * Metadata-only model catalog read on the existing connection. Never a
   * turn site: it is used by the adviser profile pin and per-wake catalog
   * verification only.
   */
  async listModels(): Promise<any[]> {
    await this.connect();
    const models: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request("model/list", {
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  async startOrResumeThread(params: Record<string, unknown>): Promise<any> {
    const method = params.threadId ? "thread/resume" : "thread/start";
    const result = await this.request(method, {
      ...params,
      serviceTier: "standard",
      sandbox: params.sandbox ?? "workspace-write",
      ephemeral: false,
    });
    if (result?.modelProvider && result.modelProvider !== "openai") {
      this.billing = null;
      throw new Error(`CODEX_BILLING_INTEGRITY_UNKNOWN:${String(result.modelProvider)}`);
    }
    return result;
  }

  async startTurn(
    runId: string,
    params: Record<string, unknown>,
    authorization: ModelAuthorization,
    advisorContext?: AdvisorStartContext,
  ): Promise<any> {
    if (!this.billing || !["subscription_allowance", "existing_credits"].includes(this.billing.route)) {
      throw new Error("CODEX_PREFLIGHT_REQUIRED");
    }
    this.guard.authorize("codex", runId, authorization, advisorContext);
    return this.request("turn/start", { ...params, serviceTier: "standard" });
  }

  async runBurst(input: {
    runId: string;
    prompt: string;
    systemPrompt?: string;
    authorization: ModelAuthorization;
    threadId?: string;
    sandbox?: "read-only" | "workspace-write";
    timeoutMs?: number;
    /**
     * Adviser profile: read-only sandbox, exact pinned model and effort,
     * provider-side output schema, and a one-use bound authorization. The
     * worker profile never sets these.
     */
    executionProfile?: "worker" | "advisor";
    model?: string;
    effort?: string;
    outputSchema?: Record<string, unknown>;
    advisorContext?: AdvisorStartContext;
  }): Promise<{
    threadId: string;
    turnId: string;
    text: string;
    turn: any;
    usage: { input: number; cachedInput: number; output: number; reasoning: number };
  }> {
    const advisor = input.executionProfile === "advisor";
    if (
      advisor &&
      (!input.model ||
        !input.effort ||
        !input.advisorContext ||
        !input.systemPrompt ||
        !this.options.advisorToolIsolation)
    ) {
      throw new Error("CODEX_ADVISOR_PROFILE_INCOMPLETE");
    }
    this.reroutedTurns.clear();
    const threadResult = await this.startOrResumeThread({
      ...(input.threadId ? { threadId: input.threadId } : {}),
      cwd: this.options.cwd,
      approvalPolicy: advisor ? "never" : "on-request",
      ...(advisor
        ? { sandbox: "read-only" }
        : input.sandbox
          ? { sandbox: input.sandbox }
          : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(advisor
        ? {
            developerInstructions: input.systemPrompt,
            config: {
              mcp_servers: this.advisorMcpServerOverrides,
              web_search: "disabled",
              features: Object.fromEntries(
                this.disabledFeatures().map((feature) => [
                  feature,
                  false,
                ]),
              ),
            },
          }
        : {}),
    });
    const threadId = String(threadResult?.thread?.id ?? input.threadId ?? "");
    if (!threadId) throw new Error("CODEX_THREAD_ID_MISSING");
    if (input.model) {
      // The thread response reports the actually selected model. Any drift
      // from the exact pinned id fails closed before the turn starts.
      const threadModel = String(
        threadResult?.thread?.model ?? threadResult?.model ?? "",
      );
      if (threadModel !== input.model) {
        throw new Error(
          `CODEX_MODEL_DRIFT:requested=${input.model}:selected=${threadModel || "unknown"}`,
        );
      }
    }
    const turnResult = await this.startTurn(
      input.runId,
      {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      },
      input.authorization,
      input.advisorContext,
    );
    const turnId = String(turnResult?.turn?.id ?? "");
    if (!turnId) throw new Error("CODEX_TURN_ID_MISSING");
    this.activeTurn = { threadId, turnId };
    let completed;
    try {
      completed = await this.waitForTurn(turnId, input.timeoutMs ?? 10 * 60_000);
    } finally {
      this.activeTurn = null;
      this.activeTurnDone?.();
      this.activeTurnDone = null;
    }
    if (completed?.turn?.status === "failed") {
      throw new Error(
        `CODEX_TURN_FAILED:${String(completed.turn.error?.message ?? "unknown failure")}`,
      );
    }
    if (input.model && this.reroutedTurns.has(turnId)) {
      // With an exact pinned model, a provider reroute is drift and the burst
      // fails closed; there is no silent downgrade or fallback.
      throw new Error(
        `CODEX_MODEL_REROUTED:${input.model}->${this.reroutedTurns.get(turnId)}`,
      );
    }
    const persistedText = Array.isArray(completed?.turn?.items)
      ? completed.turn.items
          .filter((item: any) => item?.type === "agentMessage")
          .map((item: any) => String(item.text ?? ""))
          .join("\n")
      : "";
    return {
      threadId,
      turnId,
      text: this.turnText.get(turnId) || persistedText,
      turn: completed.turn,
      usage: {
        input: Number(this.turnUsage.get(turnId)?.inputTokens ?? 0),
        cachedInput: Number(this.turnUsage.get(turnId)?.cachedInputTokens ?? 0),
        output: Number(this.turnUsage.get(turnId)?.outputTokens ?? 0),
        reasoning: Number(this.turnUsage.get(turnId)?.reasoningOutputTokens ?? 0),
      },
    };
  }

  interrupt(threadId: string, turnId: string): Promise<any> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  /**
   * Plan §10 kill contract, first stage: interrupt the in-flight turn and
   * wait a bounded grace period for the provider to acknowledge it before
   * the caller terminates the app-server. Resolves immediately when no turn
   * is in flight.
   */
  async interruptActiveTurn(graceMs = 3_000): Promise<void> {
    const active = this.activeTurn;
    if (!this.process || !active) return;
    try {
      await this.interrupt(active.threadId, active.turnId);
    } catch {
      // A failed interrupt request must not block termination; the grace
      // period below still bounds the wait.
    }
    if (this.activeTurn?.turnId !== active.turnId) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.activeTurnDone === finish) this.activeTurnDone = null;
        resolve();
      }, graceMs);
      timer.unref();
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      this.activeTurnDone = finish;
    });
  }

  async close(graceMs = 2_000): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    const gracefulExit = this.waitForExit(child, graceMs);
    this.signalProcessGroup(child, "SIGTERM");
    if (await gracefulExit) return;

    const forcedExit = this.waitForExit(child, Math.max(graceMs, 250));
    this.signalProcessGroup(child, "SIGKILL");
    if (!(await forcedExit)) {
      throw new Error(
        `CODEX_PROCESS_EXIT_UNCONFIRMED:${String(child.pid ?? "unknown")}`,
      );
    }
  }

  private signalProcessGroup(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // A process that predates the detached-spawn contract or lost its
        // group is still terminated directly as a safe compatibility path.
      }
    }
    child.kill(signal);
  }

  private waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(exited);
      };
      child.once("exit", onExit);
    });
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (!this.process || message.id === undefined || !message.method) return;
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(message)
        : this.defaultServerRequestResponse(message.method);
      this.process.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    } catch (error) {
      this.process.stdin.write(
        `${JSON.stringify({
          id: message.id,
          error: {
            code: -32001,
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`,
      );
    }
  }

  private defaultServerRequestResponse(method: string): unknown {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      return { decision: "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    }
    if (method === "item/tool/requestUserInput") return { answers: {} };
    throw new Error(`CODEX_SERVER_REQUEST_UNSUPPORTED:${method}`);
  }

  private trackNotification(message: JsonRpcMessage): void {
    if (message.method === "item/agentMessage/delta") {
      const turnId = String(message.params?.turnId ?? "");
      if (turnId) {
        this.turnText.set(turnId, `${this.turnText.get(turnId) ?? ""}${String(message.params?.delta ?? "")}`);
      }
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const turnId = String(message.params?.turnId ?? "");
      if (turnId && message.params?.tokenUsage?.last) {
        this.turnUsage.set(turnId, message.params.tokenUsage.last);
      }
      return;
    }
    if (message.method === "model/rerouted") {
      const turnId = String(message.params?.turnId ?? "");
      if (turnId) {
        this.reroutedTurns.set(turnId, String(message.params?.toModel ?? "unknown"));
      }
      return;
    }
    if (message.method !== "turn/completed") return;
    const turnId = String(message.params?.turn?.id ?? "");
    if (!turnId) return;
    const waiter = this.turnWaiters.get(turnId);
    if (!waiter) {
      this.completedTurns.set(turnId, message.params);
      return;
    }
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(turnId);
    waiter.resolve(message.params);
  }

  private waitForTurn(turnId: string, timeoutMs: number): Promise<any> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error(`CODEX_TURN_TIMEOUT:${turnId}`));
      }, timeoutMs);
      timer.unref();
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  private request(method: string, params: unknown): Promise<any> {
    if (FORBIDDEN_CODEX_METHODS.has(method)) this.guard.recordForbiddenBillingMethod(method);
    if (!this.process) return Promise.reject(new Error("CODEX_NOT_CONNECTED"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CODEX_RPC_TIMEOUT:${method}`));
      }, 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.process) throw new Error("CODEX_NOT_CONNECTED");
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
}
