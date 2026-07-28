import { CodexAppServerClient } from "../src/codex-client.ts";
import { ModelStartGuard, type ModelAuthorization } from "../src/model-guard.ts";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

function advisorAuthorization(runId: string): ModelAuthorization {
  return {
    id: "advauth_codex",
    kind: "advisor_observation",
    runId,
    providers: ["codex"],
    recordedAt: "2026-07-27T00:00:00.000Z",
    readyWorkId: "work_1",
    triggerEventId: "evt_trigger",
    purpose: "advisor_observation",
  };
}

describe("Codex advisor execution profile", () => {
  function advisorClient(threadModel: string) {
    const guard = new ModelStartGuard();
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/advisor-runtime",
      guard,
      advisorToolIsolation: true,
    });
    (client as any).advisorMcpServerOverrides = {
      fixture_server: { enabled: false },
    };
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    (client as any).billing = { route: "subscription_allowance" };
    (client as any).request = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return {
          thread: { id: "thread_adv", model: threadModel },
          modelProvider: "openai",
        };
      }
      if (method === "turn/start") {
        (client as any).completedTurns.set("turn_adv", {
          turn: { id: "turn_adv", status: "completed", items: [] },
        });
        return { turn: { id: "turn_adv" } };
      }
      throw new Error(`unexpected method ${method}`);
    };
    return { client, guard, calls };
  }

  it("passes exact model, effort, outputSchema, read-only sandbox, and never-approve", async () => {
    const { client, guard, calls } = advisorClient("gpt-5.6-sol");
    const schema = { type: "object" };
    const result = await client.runBurst({
      runId: "run_adv",
      systemPrompt: "fixed adviser instructions",
      prompt: "observe",
      authorization: advisorAuthorization("run_adv"),
      executionProfile: "advisor",
      model: "gpt-5.6-sol",
      effort: "high",
      outputSchema: schema,
      advisorContext: {
        readyWorkId: "work_1",
        triggerEventId: "evt_trigger",
        purpose: "advisor_observation",
      },
    });
    expect(result.turnId).toBe("turn_adv");
    expect(guard.started).toBe(1);
    const thread = calls.find((call) => call.method === "thread/start")!;
    expect(thread.params).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "gpt-5.6-sol",
      serviceTier: "standard",
      developerInstructions: "fixed adviser instructions",
      config: {
        mcp_servers: { fixture_server: { enabled: false } },
        web_search: "disabled",
        features: {
          shell_tool: false,
          multi_agent: false,
          skill_search: false,
        },
      },
    });
    expect(client.spawnArgs()).toEqual(
      expect.arrayContaining([
        "--disable",
        "shell_tool",
        "multi_agent",
        "skill_search",
        "--config",
        "mcp_servers={}",
        'web_search="disabled"',
        "app-server",
        "--listen",
        "stdio://",
      ]),
    );
    const turn = calls.find((call) => call.method === "turn/start")!;
    expect(turn.params).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
      outputSchema: schema,
      serviceTier: "standard",
    });
  });

  it("fails closed on thread-model drift before the turn starts", async () => {
    const { client, guard, calls } = advisorClient("gpt-other");
    await expect(
      client.runBurst({
        runId: "run_adv",
        systemPrompt: "fixed adviser instructions",
        prompt: "observe",
        authorization: advisorAuthorization("run_adv"),
        executionProfile: "advisor",
        model: "gpt-5.6-sol",
        effort: "high",
        outputSchema: {},
        advisorContext: {
          readyWorkId: "work_1",
          triggerEventId: "evt_trigger",
          purpose: "advisor_observation",
        },
      }),
    ).rejects.toThrow(/CODEX_MODEL_DRIFT/);
    expect(guard.started).toBe(0);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("treats a model/rerouted notification as a failed adviser burst", async () => {
    const { client } = advisorClient("gpt-5.6-sol");
    const original = (client as any).request.bind(client);
    (client as any).request = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await original(method, params);
      if (method === "turn/start") {
        (client as any).trackNotification({
          method: "model/rerouted",
          params: {
            threadId: "thread_adv",
            turnId: "turn_adv",
            fromModel: "gpt-5.6-sol",
            toModel: "gpt-safety",
            reason: "highRiskCyberActivity",
          },
        });
      }
      return result;
    };
    await expect(
      client.runBurst({
        runId: "run_adv",
        systemPrompt: "fixed adviser instructions",
        prompt: "observe",
        authorization: advisorAuthorization("run_adv"),
        executionProfile: "advisor",
        model: "gpt-5.6-sol",
        effort: "high",
        outputSchema: {},
        advisorContext: {
          readyWorkId: "work_1",
          triggerEventId: "evt_trigger",
          purpose: "advisor_observation",
        },
      }),
    ).rejects.toThrow(/CODEX_MODEL_REROUTED/);
  });

  it("rejects an incomplete advisor profile and worker-authorization cross-use", async () => {
    const { client, guard } = advisorClient("gpt-5.6-sol");
    await expect(
      client.runBurst({
        runId: "run_adv",
        systemPrompt: "fixed adviser instructions",
        prompt: "observe",
        authorization: advisorAuthorization("run_adv"),
        executionProfile: "advisor",
      }),
    ).rejects.toThrow(/CODEX_ADVISOR_PROFILE_INCOMPLETE/);
    await expect(
      client.runBurst({
        runId: "run_adv",
        systemPrompt: "fixed adviser instructions",
        prompt: "observe",
        authorization: {
          id: "auth_worker",
          kind: "user_goal",
          runId: "run_adv",
          providers: ["codex"],
          recordedAt: "2026-07-27T00:00:00.000Z",
        },
        executionProfile: "advisor",
        model: "gpt-5.6-sol",
        effort: "high",
        outputSchema: {},
        advisorContext: {
          readyWorkId: "work_1",
          triggerEventId: "evt_trigger",
          purpose: "advisor_observation",
        },
      }),
    ).rejects.toThrow(/advisor_observation authorization/);
    expect(guard.started).toBe(0);
  });

  it("discovers inherited MCP names during preflight for thread-level disabling", async () => {
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/advisor-runtime",
      advisorToolIsolation: true,
    });
    (client as any).connect = async () => undefined;
    (client as any).request = async (method: string) => {
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", planType: "plus" },
          requiresOpenaiAuth: true,
        };
      }
      if (method === "account/rateLimits/read") {
        return {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 10, resetsAt: 1_900_000_000 },
            credits: { hasCredits: false, unlimited: false },
          },
        };
      }
      if (method === "config/read") {
        return {
          config: {
            model_provider: "openai",
            mcp_servers: {
              alpha: { command: "alpha" },
              beta: { url: "https://example.invalid" },
            },
          },
          layers: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    };

    const preflight = await client.metadataPreflight({
      versionMatches: true,
      schemaMatches: true,
      forbiddenEnvironment: [],
      spawnArgs: client.spawnArgs(),
      effectiveProviderOverride: false,
      subscriptionsRegistered: true,
    });

    expect(preflight.ok).toBe(true);
    expect((client as any).advisorMcpServerOverrides).toEqual({
      alpha: { enabled: false },
      beta: { enabled: false },
    });
  });
});

describe("Codex app-server thread sandbox selection", () => {
  it("uses an explicit read-only sandbox for the bounded smoke harness", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/not-used",
    });
    (client as any).request = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      return { thread: { id: "thread_fixture" }, modelProvider: "openai" };
    };

    await client.startOrResumeThread({ sandbox: "read-only" });
    expect(calls).toEqual([
      {
        method: "thread/start",
        params: expect.objectContaining({
          sandbox: "read-only",
          serviceTier: "standard",
          ephemeral: false,
        }),
      },
    ]);
  });

  it("retains workspace-write as the normal collaboration default", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/not-used",
    });
    (client as any).request = async (
      _method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push(params);
      return { thread: { id: "thread_fixture" }, modelProvider: "openai" };
    };

    await client.startOrResumeThread({});
    expect(calls[0]?.sandbox).toBe("workspace-write");
  });

  it("compares provider-managed credit balance without persisting the balance", async () => {
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/not-used",
    });
    let balance = "19.50";
    (client as any).connect = async () => undefined;
    (client as any).request = async (method: string) => {
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", planType: "plus" },
          requiresOpenaiAuth: true,
        };
      }
      if (method === "account/rateLimits/read") {
        return {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 20, resetsAt: 1_900_000_000 },
            credits: { hasCredits: true, unlimited: false, balance },
            rateLimitReachedType: null,
            spendControlReached: false,
          },
        };
      }
      if (method === "config/read") {
        return { config: { model_provider: "openai" }, layers: [] };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const input = {
      versionMatches: true,
      schemaMatches: true,
      forbiddenEnvironment: [],
      spawnArgs: ["app-server", "--listen", "stdio://"],
      effectiveProviderOverride: false,
      subscriptionsRegistered: true,
    };

    const first = await client.metadataPreflight(input);
    const second = await client.metadataPreflight(input);
    balance = "19.25";
    const changed = await client.metadataPreflight(input);

    expect(first.billing.usage).toMatchObject({
      providerManagedCreditBalanceAvailable: true,
      providerManagedCreditBalanceChangedSincePrevious: null,
    });
    expect(second.billing.usage).toMatchObject({
      providerManagedCreditBalanceChangedSincePrevious: false,
    });
    expect(changed.billing.usage).toMatchObject({
      providerManagedCreditBalanceChangedSincePrevious: true,
    });
    expect(JSON.stringify([first, second, changed])).not.toContain("19.50");
    expect(JSON.stringify([first, second, changed])).not.toContain("19.25");
  });

  it("terminates the detached app-server process group", async () => {
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/not-used",
    });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.pid = 42_424;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    (client as any).process = child;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push({ pid, signal: signal as NodeJS.Signals });
      child.signalCode = signal as NodeJS.Signals;
      child.emit("exit", null, signal);
      return true;
    });

    try {
      await client.close(10);
      expect(signals).toEqual([{ pid: -42_424, signal: "SIGTERM" }]);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("does not resolve close until exit is confirmed after force-kill", async () => {
    const client = new CodexAppServerClient({
      binary: "/not-spawned",
      cwd: "/tmp/not-used",
    });
    const signals: NodeJS.Signals[] = [];
    let exited = false;
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setImmediate(() => {
          exited = true;
          child.signalCode = signal;
          child.emit("exit", null, signal);
        });
      }
      return true;
    };
    (client as any).process = child;

    await client.close(1);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exited).toBe(true);
  });
});
