import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, reportOverhead } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import {
  RealCollaborationRunner,
  type RealClaudePort,
  type RealCodexPort,
} from "../src/real-runner.ts";

const usage = { input: 50_000, cachedInput: 0, output: 500, reasoning: 100 };

function billing(provider: "codex" | "claude") {
  return {
    ok: true as const,
    provider,
    trace: ["1", "2", "3", "4", "5", "6", "7"],
    billing: {
      provider,
      route: "subscription_allowance" as const,
      authenticatedBy:
        provider === "codex" ? ("chatgpt" as const) : ("claude.ai" as const),
      plan: provider === "codex" ? "plus" : "max",
      proof: ["deterministic fixture"],
      checkedAt: new Date().toISOString(),
    },
  };
}

function opening(role: "codex" | "claude") {
  return {
    rationale: `Independent ${role} opening`,
    evidence: [`${role} inspected the workspace`],
    risks: [],
  };
}

function fixture(budgets?: { perProvider?: number; perMaterialChallenge?: number }) {
  const root = mkdtempSync(join(tmpdir(), "collab-causality-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const store = new EventStore(join(root, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  const runId = coordinator.createRun(
    { workflow: "execution",
      goal: "Exercise causality, budget, attribution, and cancellation paths.",
      workspace,
      mode: "real",
      ...(budgets ? { budgets } : {}),
    },
    true,
  );
  return { root, workspace, store, coordinator, runId };
}

function makeRunner(store: EventStore) {
  return new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    onCodexServerRequest: async () => ({ decision: "decline" }),
    onClaudeToolRequest: async () => ({ behavior: "deny" }),
  });
}

function appendTrigger(store: EventStore, runId: string, key: string) {
  return store.append({
    runId,
    actor: "system",
    type: "needs_input",
    idempotencyKey: `causality:trigger:${key}`,
    payload: {
      card: {
        id: `causality_trigger_${key}`,
        kind: "needs_input",
        title: "fixture",
        body: "fixture",
        actions: [],
      },
    },
  });
}

describe("V-7 usage flags are derived from the causal record, never asserted", () => {
  it("fails the overhead gate for a burst executed without a ready-queue claim", () => {
    const { store, runId } = fixture();
    const runner = makeRunner(store);

    // A rogue burst with no claiming event: the recorded row must derive
    // uncaused=true and the plan §8 gate must FAIL. Every invocation records
    // its own row — nothing can overwrite the uncaused evidence later.
    (runner as any).recordUsage(runId, "codex", "rogue", usage, "candidate", null);
    let report = reportOverhead(store.usageRecords(runId));
    expect(report.uncausedInvocations).toBe(1);
    expect(report.passed).toBe(false);

    // A forged claim naming a ready-work id that was never enqueued or
    // claimed must also derive uncaused=true, as a second distinct row.
    (runner as any).recordUsage(runId, "codex", "rogue", usage, "candidate", {
      payload: { modelWake: true, readyWorkId: "work_never_enqueued" },
    });
    report = reportOverhead(store.usageRecords(runId));
    expect(store.usageRecords(runId)).toHaveLength(2);
    expect(report.uncausedInvocations).toBe(2);
    expect(report.passed).toBe(false);
    store.close();
  });

  it("clears the flag only for a burst genuinely claimed through the durable queue", () => {
    const { store, runId } = fixture();
    const runner = makeRunner(store);
    const trigger = appendTrigger(store, runId, "genuine");
    const claim = (runner as any).claimModelWork(
      runId,
      "codex",
      "fixture burst",
      "rogue",
      trigger,
    );
    (runner as any).recordUsage(runId, "codex", "rogue", usage, "candidate", claim);
    const records = store.usageRecords(runId);
    const report = reportOverhead(records);
    expect(report.uncausedInvocations).toBe(0);
    expect(report.passed).toBe(true);
    // The row is durably bound to its exact ready claim.
    expect(records[0]!.readyWorkId).toBe((claim.payload as any).readyWorkId);
    expect(records[0]!.claimEventId).toBe(claim.id);
    expect(records[0]!.triggerEventId).toBe((claim.payload as any).triggerEventId);
    store.close();
  });

  it("rejects reuse of a genuine claim with a forged trigger or wake reason", () => {
    const { store, runId } = fixture();
    const runner = makeRunner(store);
    const trigger = appendTrigger(store, runId, "forgery");
    const claim = (runner as any).claimModelWork(
      runId,
      "codex",
      "fixture burst",
      "rogue",
      trigger,
    );
    (runner as any).recordUsage(runId, "codex", "rogue", usage, "candidate", claim);
    (runner as any).recordUsage(
      runId,
      "codex",
      "swapped-trigger",
      usage,
      "candidate",
      {
        ...claim,
        payload: {
          ...(claim.payload as object),
          triggerEventId: "event_from_another_wake",
        },
      },
    );
    (runner as any).recordUsage(
      runId,
      "codex",
      "swapped-reason",
      usage,
      "candidate",
      {
        ...claim,
        payload: {
          ...(claim.payload as object),
          wakeReason: "trusted_timer",
        },
      },
    );
    const report = reportOverhead(store.usageRecords(runId));
    expect(store.usageRecords(runId)).toHaveLength(3);
    expect(report.uncausedInvocations).toBe(2);
    expect(report.passed).toBe(false);
    store.close();
  });

  it("records distinct rows with distinct causal bindings for repeated and recovery calls", () => {
    const { store, runId } = fixture();
    const runner = makeRunner(store);
    const trigger = appendTrigger(store, runId, "retry");
    const firstClaim = (runner as any).claimModelWork(
      runId,
      "codex",
      "first attempt",
      "candidate",
      trigger,
    );
    (runner as any).recordUsage(
      runId,
      "codex",
      "candidate",
      usage,
      "candidate",
      firstClaim,
    );
    // The recovery path claims a NEW ready item (the same trigger cannot
    // enqueue twice) and must create a second row, never overwrite the first.
    const secondClaim = (runner as any).claimModelWork(
      runId,
      "codex",
      "recovery attempt",
      "candidate",
      trigger,
    );
    (runner as any).recordUsage(
      runId,
      "codex",
      "candidate",
      { ...usage, input: usage.input + 1 },
      "candidate",
      secondClaim,
    );
    const records = store.usageRecords(runId);
    expect(records).toHaveLength(2);
    expect(records[0]!.readyWorkId).not.toBe(records[1]!.readyWorkId);
    expect(records[0]!.claimEventId).not.toBe(records[1]!.claimEventId);
    expect(records[0]!.input).toBe(usage.input);
    expect(records[1]!.input).toBe(usage.input + 1);
    expect((secondClaim.payload as any).wakeReason).toBe("recovery_obligation");
    expect((secondClaim.payload as any).chargeBudget).toBe(false);
    const report = reportOverhead(records);
    expect(report.uncausedInvocations).toBe(0);
    expect(report.workerBurstCount).toBe(2);
    store.close();
  });

  it("fails coverage when a provider reports no usage for a burst", () => {
    const { store, runId } = fixture();
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    (runner as any).recordUsage(
      runId,
      "claude",
      "silent",
      { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
      "review",
      null,
    );
    const report = reportOverhead(store.usageRecords(runId));
    expect(report.coverageComplete).toBe(false);
    expect(report.passed).toBe(false);
    store.close();
  });
});

describe("failure attribution is carried from the failing call site", () => {
  it("attributes a Codex limit correctly even when the error text mentions claude", async () => {
    const { store, runId } = fixture();
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async () => {
        throw new Error(
          "CODEX_APP_SERVER_EXIT:1:null:usage limit reached while running in /Users/coldistric/source/repos/codex-claude-communication",
        );
      },
      close: async () => undefined,
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async () => ({
        sessionId: "claude-session",
        messages: [],
        text: JSON.stringify(opening("claude")),
        structuredOutput: opening("claude"),
        usage,
      }),
    };
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    await runner.run(runId, true, "real_canary");

    const projection = store.projection(runId);
    const pausedLimit = store
      .events(runId)
      .filter((event) => event.type === "paused_limit");
    expect(pausedLimit).toHaveLength(1);
    expect((pausedLimit[0]!.payload as any).role).toBe("codex");
    const card = projection.actions.find((action) => action.kind === "limit");
    expect(card?.agent).toBe("codex");
    expect(card?.title).toBe("codex paused on a provider limit");
    expect(projection.workers.codex.state).toBe("paused_limit_unknown");
    expect(projection.workers.claude.state).not.toBe("paused_limit_unknown");
    store.close();
  });

  it("attributes a Claude limit correctly when the error text mentions Codex", async () => {
    const { store, runId } = fixture();
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async () => ({
        threadId: "codex-session",
        turnId: "codex-turn-1",
        text: JSON.stringify(opening("codex")),
        turn: { status: "completed" },
        usage,
      }),
      close: async () => undefined,
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async () => {
        throw new Error(
          "CLAUDE_BURST_FAILED:usage limit reached while reviewing codex output",
        );
      },
    };
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    await runner.run(runId, true, "real_canary");

    const projection = store.projection(runId);
    const pausedLimit = store
      .events(runId)
      .filter((event) => event.type === "paused_limit");
    expect(pausedLimit).toHaveLength(1);
    expect((pausedLimit[0]!.payload as any).role).toBe("claude");
    expect(
      projection.actions.find((action) => action.kind === "limit"),
    ).toMatchObject({
      agent: "claude",
      title: "claude paused on a provider limit",
    });
    expect(projection.workers.claude.state).toBe("paused_limit_unknown");
    expect(projection.workers.codex.state).not.toBe("paused_limit_unknown");
    store.close();
  });
});

describe("budget exhaustion enters waiting_user with the plan §3.8 card", () => {
  it("emits counts, both positions, and all five actions instead of a dead end", async () => {
    const { store, runId } = fixture({ perProvider: 1 });
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async () => ({
        threadId: "codex-session",
        turnId: "codex-turn-1",
        text: JSON.stringify(opening("codex")),
        turn: { status: "completed" },
        usage,
      }),
      close: async () => undefined,
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async () => ({
        sessionId: "claude-session",
        messages: [],
        text: JSON.stringify(opening("claude")),
        structuredOutput: opening("claude"),
        usage,
      }),
    };
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    await runner.run(runId, true, "real_canary");

    const projection = store.projection(runId);
    expect(projection.state).toBe("waiting_user");
    const card = projection.actions.find(
      (action) => action.kind === "budget_exhausted",
    );
    expect(card).toBeDefined();
    expect(card!.actions).toEqual([
      "Extend budget",
      "Supply information or authority",
      "Decide",
      "Accept disagreement",
      "Cancel",
    ]);
    expect(card!.body).toContain("Codex bursts: 1 consumed of 1 (0 remaining)");
    expect(card!.body).toContain("Claude bursts: 1 consumed of 1 (0 remaining)");
    expect(card!.body).toContain("Independent codex opening");
    expect(card!.body).toContain("Independent claude opening");
    expect(
      projection.actions.some((action) =>
        action.title.includes("provider failure"),
      ),
    ).toBe(false);
    store.close();
  });

  it("requires and durably records structured information before resuming", async () => {
    const { store, coordinator, runId } = fixture({ perProvider: 1 });
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    const card = {
      id: "budget_structured_input",
      kind: "budget_exhausted" as const,
      title: "Budget exhausted",
      body: "Supply information before resuming.",
      actions: ["Supply information or authority", "Decide"],
      requiresDetailsFor: ["Supply information or authority", "Decide"],
      detailsLabel: "Information, authority, or decision",
    };
    store.append({
      runId,
      actor: "system",
      type: "needs_input",
      idempotencyKey: "structured-input-card",
      payload: { card },
    });
    (coordinator as any).runReal = async () => undefined;

    await expect(
      coordinator.decideAction(
        runId,
        card.id,
        "Supply information or authority",
        "   ",
      ),
    ).rejects.toThrow("ACTION_DETAILS_REQUIRED");

    await coordinator.decideAction(
      runId,
      card.id,
      "Supply information or authority",
      "Use the already-approved local fixture; network access remains forbidden.",
    );
    await new Promise((resolve) => setImmediate(resolve));

    const override = store
      .events(runId)
      .find(
        (event) =>
          event.type === "human_override" &&
          (event.payload as any).cardId === card.id,
      );
    expect(override?.payload).toMatchObject({
      decision: "supply_information_or_authority",
      information:
        "Use the already-approved local fixture; network access remains forbidden.",
    });
    expect((runner as any).interventionContext(runId)).toContain(
      "Use the already-approved local fixture",
    );
    expect(store.projection(runId).budgets.provider.codex.limit).toBe(5);
    expect(store.projection(runId).budgets.provider.claude.limit).toBe(5);
    store.close();
  });
});

describe("cancellation interrupts the in-flight turn before terminating", () => {
  it("calls turn interrupt with bounded grace before close, in order", async () => {
    const { store, runId } = fixture();
    const calls: string[] = [];
    let rejectCodexBurst: ((error: Error) => void) | null = null;
    let codexBurstStarted!: () => void;
    const codexStarted = new Promise<void>((resolve) => {
      codexBurstStarted = resolve;
    });
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: () => {
        codexBurstStarted();
        return new Promise((_, reject) => {
          rejectCodexBurst = (error) => reject(error);
        });
      },
      interruptActiveTurn: async () => {
        calls.push("interrupt");
      },
      close: async () => {
        calls.push("close");
        rejectCodexBurst?.(
          new Error("CODEX_APP_SERVER_EXIT:143:SIGTERM:cancelled"),
        );
      },
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: (input) =>
        new Promise((_, reject) => {
          input.abortController?.signal.addEventListener("abort", () =>
            reject(new Error("Claude burst aborted")),
          );
        }),
    };
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });

    const running = runner.run(runId, true, "real_canary");
    await codexStarted;
    await runner.cancel(runId);
    await running;

    // close() runs once in cancel() and once in run()'s cleanup; the first
    // close must be preceded by the interrupt.
    expect(calls[0]).toBe("interrupt");
    expect(calls[1]).toBe("close");
    expect(calls.indexOf("interrupt")).toBe(0);
    store.close();
  });

  it("does not commit cancellation until provider shutdown has settled", async () => {
    const { store, coordinator, runId } = fixture();
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const calls: string[] = [];
    (coordinator as any).runnerPromise = Promise.resolve({
      cancel: async () => {
        calls.push("shutdown-started");
        expect(store.projection(runId).state).not.toBe("cancelled");
        await shutdownGate;
        calls.push("shutdown-settled");
      },
    });

    const cancellation = coordinator.cancelRun(runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.projection(runId).state).not.toBe("cancelled");
    releaseShutdown();
    await cancellation;

    expect(calls).toEqual(["shutdown-started", "shutdown-settled"]);
    expect(store.projection(runId).state).toBe("cancelled");
    store.close();
  });

  it("contains a provider-cleanup failure instead of rejecting the fire-and-forget run path", async () => {
    const { store, coordinator, runId } = fixture();
    (coordinator as any).runnerPromise = Promise.resolve({
      run: async () => {
        throw new Error("CODEX_PROCESS_EXIT_UNCONFIRMED:12345");
      },
      cancel: async () => undefined,
    });

    // runReal is invoked fire-and-forget in production; it must never reject.
    await expect(
      (coordinator as any).runReal(runId, true),
    ).resolves.toBeUndefined();

    const projection = store.projection(runId);
    expect(projection.completedAt).toBeNull();
    const card = projection.actions.find(
      (action) => action.title === "Provider shutdown did not confirm cleanly",
    );
    expect(card).toBeDefined();
    expect(card!.body).toContain("CODEX_PROCESS_EXIT_UNCONFIRMED");
    expect(card!.actions).toEqual(["Retry collaboration", "Cancel"]);
    store.close();
  });

  it("treats Cancel on the uncertain-effect card itself as an audited acknowledgment", async () => {
    const { store, coordinator, runId } = fixture();
    store.append({
      runId,
      actor: "system",
      type: "uncertain_effect",
      idempotencyKey: "uncertain-ack-fixture",
      payload: {
        role: "codex",
        card: {
          id: "uncertain_ack",
          kind: "uncertain_effect",
          title: "codex may have left an uncertain workspace effect",
          body: "Inspect the workspace before retrying or releasing the lease.",
          agent: "codex",
          actions: ["Retry collaboration", "Cancel"],
        },
      },
    });

    await coordinator.decideAction(runId, "uncertain_ack", "Cancel");

    const projection = store.projection(runId);
    expect(projection.state).toBe("cancelled");
    expect(projection.completedAt).not.toBeNull();
    const override = store
      .events(runId)
      .find((event) => event.type === "human_override");
    expect((override?.payload as any)?.decision).toBe(
      "acknowledge_uncertain_effect_and_cancel",
    );
    expect(
      store.events(runId).some((event) => event.type === "cancelled"),
    ).toBe(true);
    store.close();
  });

  it("preserves an uncertain-effect reconciliation card instead of terminalizing", async () => {
    const { store, coordinator, runId } = fixture();
    (coordinator as any).runnerPromise = Promise.resolve({
      cancel: async () => {
        store.append({
          runId,
          actor: "system",
          type: "uncertain_effect",
          idempotencyKey: "cancel-uncertain-effect",
          payload: {
            role: "codex",
            card: {
              id: "cancel_uncertain",
              kind: "uncertain_effect",
              title: "Cancellation requires reconciliation",
              body: "Inspect the authorized workspace mutation.",
              agent: "codex",
              actions: ["Inspect manually"],
            },
          },
        });
      },
    });

    await coordinator.cancelRun(runId);

    const projection = store.projection(runId);
    expect(projection.state).toBe("waiting_user");
    expect(projection.completedAt).toBeNull();
    expect(projection.actions).toEqual([
      expect.objectContaining({ id: "cancel_uncertain" }),
    ]);
    expect(
      store.events(runId).some((event) => event.type === "cancelled"),
    ).toBe(false);
    store.close();
  });
});
