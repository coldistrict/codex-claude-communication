import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import {
  RealCollaborationRunner,
  type InteractiveResourceRegistry,
} from "../src/real-runner.ts";

const COMPUTER = "interactive:computer_use";
const BROWSER_GLOBAL = "interactive:browser:global";

function fixture(registry?: InteractiveResourceRegistry) {
  const root = mkdtempSync(join(tmpdir(), "collab-interactive-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const store = new EventStore(join(root, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  const createRun = (suffix: string) =>
    coordinator.createRun(
      {
        goal: `Exercise interactive-resource coordination (${suffix}).`,
        workspace,
        mode: "real",
      },
      true,
    );
  const runId = createRun("primary");
  const runner = new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    ...(registry ? { interactiveResources: registry } : {}),
    onCodexServerRequest: async () => ({ decision: "decline" }),
    onClaudeToolRequest: async () => ({ behavior: "deny" }),
  });
  return { root, workspace, store, coordinator, createRun, runId, runner };
}

function flush(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
  }
  return chain;
}

function browserClaim(kind: "unverified" | "profile" | "isolated_context", id?: string) {
  return {
    class: "browser" as const,
    identity: kind === "unverified" ? { kind } : ({ kind, id: id! } as any),
  };
}

describe("interactive-resource classification is transport-derived and fail-safe", () => {
  it("classifies computer-use and browser tools without trusting model-supplied ids", () => {
    const { runner, store, runId } = fixture();
    const computer = (runner as any).claudeToolLeaseRequest(
      runId,
      "mcp__computer-use__left_click",
      { coordinate: [1, 2] },
      {},
    );
    expect(computer.mutation).toBe(false);
    expect(computer.interactiveResources).toEqual([{ class: "computer_use" }]);

    // A model-supplied context id in the input is untrusted: with no
    // registered controller the identity fails safe to the global browser.
    const forged = (runner as any).claudeToolLeaseRequest(
      runId,
      "mcp__claude-in-chrome__navigate",
      { url: "https://example.test", contextId: "attacker-isolated-1" },
      {},
    );
    expect(forged.interactiveResources).toEqual([
      { class: "browser", identity: { kind: "unverified" } },
    ]);

    const bashBrowser = (runner as any).claudeToolLeaseRequest(
      runId,
      "Bash",
      { command: "npx playwright screenshot https://example.test out.png" },
      {},
    );
    expect(bashBrowser.mutation).toBe(true);
    expect(bashBrowser.interactiveResources).toEqual([
      { class: "browser", identity: { kind: "unverified" } },
    ]);

    const bashDesktop = (runner as any).claudeToolLeaseRequest(
      runId,
      "Bash",
      { command: "cliclick c:100,200" },
      {},
    );
    expect(bashDesktop.interactiveResources).toEqual([
      { class: "computer_use" },
    ]);

    const plainWrite = (runner as any).claudeToolLeaseRequest(
      runId,
      "Write",
      { file_path: "/tmp/x", content: "y" },
      {},
    );
    expect(plainWrite.interactiveResources).toEqual([]);
    store.close();
  });

  it("classifies codex command approvals the same way", () => {
    const { runner, runId, store } = fixture();
    const codexDesktop = (runner as any).codexToolLeaseRequest(runId, {
      id: 1,
      method: "execCommandApproval",
      params: { command: "osascript -e 'tell application \"System Events\" to click'" },
    });
    expect(codexDesktop.interactiveResources).toEqual([
      { class: "computer_use" },
    ]);
    const codexBrowser = (runner as any).codexToolLeaseRequest(runId, {
      id: 2,
      method: "execCommandApproval",
      params: { command: "open -a 'Google Chrome' https://example.test" },
    });
    expect(codexBrowser.interactiveResources).toEqual([
      { class: "browser", identity: { kind: "unverified" } },
    ]);
    store.close();
  });

  it("treats a registry answer without a verifiable id as unverified", () => {
    const { runner, store, runId } = fixture({
      identifyBrowserSession: () => ({ kind: "isolated_context", id: "" }),
    });
    const request = (runner as any).claudeToolLeaseRequest(
      runId,
      "mcp__claude-in-chrome__navigate",
      { url: "https://example.test" },
      {},
    );
    expect(request.interactiveResources).toEqual([
      { class: "browser", identity: { kind: "unverified" } },
    ]);
    store.close();
  });
});

describe("same-resource requests serialize across providers and runs", () => {
  it("keeps Computer Use at maximum concurrency 1 with waiting_lease projection and zero model wakes", async () => {
    const { store, runId, runner } = fixture();
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const enter = async (role: "codex" | "claude", gate?: Promise<void>) => {
      await (runner as any).acquireToolLease(runId, role, {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: `${role} computer use`,
        interactiveResources: [{ class: "computer_use" }],
      });
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (gate) await gate;
      active -= 1;
    };
    const first = (runner as any).executeProviderBurst(
      runId,
      "codex",
      "candidate",
      () => enter("codex", firstGate),
    );
    await flush();
    const second = (runner as any).executeProviderBurst(
      runId,
      "claude",
      "review",
      () => enter("claude"),
    );
    await flush();

    const projection = store.projection(runId);
    expect(projection.workers.claude.state).toBe("waiting_lease");
    expect(projection.workers.claude.waitingLease).toMatchObject({
      holder: "codex:candidate",
      reason: "claude computer use",
      resources: [COMPUTER],
    });
    expect(maxActive).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);

    const events = store.events(runId);
    // Waiting consumed no model wake and no useful-work burst.
    expect(events.filter((event) => event.type === "work_claimed")).toHaveLength(0);
    const resumed = events.filter((event) => event.type === "resumed");
    expect(resumed.length).toBeGreaterThan(0);
    expect(
      resumed.every(
        (event) =>
          (event.payload as any).modelWake === false &&
          (event.payload as any).chargeBudget === false,
      ),
    ).toBe(true);
    expect(store.projection(runId).budgets.provider.codex.consumed).toBe(0);
    expect(store.projection(runId).budgets.provider.claude.consumed).toBe(0);
    store.close();
  });

  it("serializes the same trusted browser profile and across runs", async () => {
    const { store, createRun, runId, runner } = fixture({
      identifyBrowserSession: () => ({ kind: "profile", id: "chrome-default" }),
    });
    const secondRunId = createRun("secondary");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = (runner as any).executeProviderBurst(
      runId,
      "codex",
      "candidate",
      async () => {
        await (runner as any).acquireToolLease(runId, "codex", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "codex drives the signed-in profile",
          interactiveResources: [browserClaim("profile", "chrome-default")],
        });
        await firstGate;
      },
    );
    await flush();
    const second = (runner as any).executeProviderBurst(
      secondRunId,
      "claude",
      "review",
      async () => {
        await (runner as any).acquireToolLease(secondRunId, "claude", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "claude wants the same profile",
          interactiveResources: [browserClaim("profile", "chrome-default")],
        });
        secondEntered = true;
      },
    );
    await flush();
    expect(secondEntered).toBe(false);
    expect(store.projection(secondRunId).workers.claude.state).toBe(
      "waiting_lease",
    );
    expect(
      store.projection(secondRunId).workers.claude.waitingLease?.resources,
    ).toEqual(["interactive:browser:profile:chrome-default"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    store.close();
  });

  it("lets two product-created, controller-verified isolated contexts run concurrently", async () => {
    const { store, runId, runner } = fixture({
      identifyBrowserSession: ({ provider }) => ({
        kind: "isolated_context",
        id: `ctx-${provider}`,
      }),
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const gates: Array<() => void> = [];
    const barrier = new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    // Distinct verified contexts: claim per role through the registry.
    const first = (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
      await (runner as any).acquireToolLease(runId, "codex", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "codex isolated context",
        interactiveResources: [browserClaim("isolated_context", "ctx-codex")],
      });
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await barrier;
      concurrent -= 1;
    });
    await flush();
    const second = (runner as any).executeProviderBurst(runId, "claude", "review", async () => {
      await (runner as any).acquireToolLease(runId, "claude", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "claude isolated context",
        interactiveResources: [browserClaim("isolated_context", "ctx-claude")],
      });
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      gates.forEach((open) => open());
      concurrent -= 1;
    });
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(2);
    expect(
      store
        .events(runId)
        .filter((event) => event.type === "lease_waiting"),
    ).toHaveLength(0);
    store.close();
  });

  it("serializes unverified browser identities globally, even against an isolated context", async () => {
    const { store, runId, runner } = fixture({
      identifyBrowserSession: ({ provider }) =>
        provider === "codex"
          ? { kind: "isolated_context", id: "ctx-codex" }
          : { kind: "unverified" },
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = (runner as any).executeProviderBurst(runId, "claude", "review", async () => {
      await (runner as any).acquireToolLease(runId, "claude", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "claude unverified browser",
        interactiveResources: [browserClaim("unverified")],
      });
      await firstGate;
    });
    await flush();
    const second = (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
      await (runner as any).acquireToolLease(runId, "codex", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "codex isolated context",
        interactiveResources: [browserClaim("isolated_context", "ctx-codex")],
      });
      secondEntered = true;
    });
    await flush();
    // The global fail-safe conflicts with every browser identity.
    expect(secondEntered).toBe(false);
    expect(
      store.projection(runId).workers.codex.waitingLease?.resources,
    ).toEqual(["interactive:browser:isolated:ctx-codex"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    store.close();
  });
});

describe("permission and resource ownership are separate", () => {
  it("blocks an approved tool request on the lease and never acquires for a denied one", async () => {
    const { store, runId, runner } = fixture();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let approvedProceeded = false;
    const first = (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
      const gated = await (runner as any).gateCodexToolRequest(
        runId,
        {
          id: 7,
          method: "execCommandApproval",
          params: { command: "cliclick c:5,5" },
        },
        { decision: "accept" },
      );
      expect(gated).toEqual({ decision: "accept" });
      await firstGate;
    });
    await flush();
    const second = (runner as any).executeProviderBurst(runId, "claude", "review", async () => {
      // The user-approved permission is granted, but the tool still cannot
      // execute until the exclusive resource lease is acquired.
      const gated = await (runner as any).gateClaudeToolRequest(
        runId,
        "mcp__computer-use__left_click",
        { coordinate: [3, 4] },
        {},
        { behavior: "allow" },
      );
      expect(gated.behavior).toBe("allow");
      approvedProceeded = true;
    });
    await flush();
    expect(approvedProceeded).toBe(false);
    expect(store.projection(runId).workers.claude.state).toBe("waiting_lease");

    // A denied request never touches the lease manager.
    const denied = await (runner as any).gateClaudeToolRequest(
      runId,
      "mcp__computer-use__left_click",
      { coordinate: [3, 4] },
      {},
      { behavior: "deny", message: "user denied" },
    );
    expect(denied.behavior).toBe("deny");

    releaseFirst();
    await Promise.all([first, second]);
    expect(approvedProceeded).toBe(true);
    store.close();
  });
});

describe("multiple-resource requests do not deadlock", () => {
  it("acquires multi-resource requests atomically regardless of claim order", async () => {
    const { runId, runner, store } = fixture();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
      await (runner as any).acquireToolLease(runId, "codex", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "desktop plus browser",
        interactiveResources: [
          { class: "computer_use" },
          browserClaim("unverified"),
        ],
      });
      await firstGate;
    });
    await flush();
    const second = (runner as any).executeProviderBurst(runId, "claude", "review", async () => {
      await (runner as any).acquireToolLease(runId, "claude", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "browser plus desktop, reversed order",
        interactiveResources: [
          browserClaim("unverified"),
          { class: "computer_use" },
        ],
      });
      secondEntered = true;
    });
    await flush();
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    store.close();
  });

  it("breaks a two-party escalation cycle with an honest denial instead of deadlocking", async () => {
    const { runId, runner, store } = fixture();
    let codexHasDesktop!: () => void;
    const codexDesktopHeld = new Promise<void>((resolve) => {
      codexHasDesktop = resolve;
    });
    let claudeDenied: Record<string, unknown> | null = null;
    let claudeDone!: () => void;
    const claudeFinished = new Promise<void>((resolve) => {
      claudeDone = resolve;
    });

    const codexBurst = (runner as any).executeProviderBurst(
      runId,
      "codex",
      "candidate",
      async () => {
        await (runner as any).acquireToolLease(runId, "codex", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "codex desktop first",
          interactiveResources: [{ class: "computer_use" }],
        });
        codexHasDesktop();
        // Escalate to the browser, which Claude holds: parks until release.
        await (runner as any).acquireToolLease(runId, "codex", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "codex escalates to the browser",
          interactiveResources: [browserClaim("unverified")],
        });
      },
    );

    const claudeBurst = (runner as any).executeProviderBurst(
      runId,
      "claude",
      "review",
      async () => {
        await (runner as any).acquireToolLease(runId, "claude", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "claude browser first",
          interactiveResources: [browserClaim("unverified")],
        });
        await codexDesktopHeld;
        await flush();
        // Cross escalation: waiting here would deadlock both providers; the
        // gate converts it into an honest denial and the burst continues.
        claudeDenied = await (runner as any).gateClaudeToolRequest(
          runId,
          "mcp__computer-use__left_click",
          { coordinate: [9, 9] },
          {},
          { behavior: "allow" },
        );
        claudeDone();
      },
    );

    await claudeFinished;
    expect(claudeDenied).toMatchObject({ behavior: "deny" });
    expect(String((claudeDenied as any).message)).toContain("deadlock");
    // Claude's burst ends, releasing the browser; Codex's parked escalation
    // then proceeds and both bursts settle — liveness holds.
    await Promise.all([codexBurst, claudeBurst]);
    const held = (runner as any).leases.held();
    expect(held).toHaveLength(0);
    store.close();
  });
});

describe("failure keeps interactive leases and blocks the waiting provider", () => {
  it("retains the uncertain lease, raises a resource card, and never wakes the waiter", async () => {
    const { store, runId, runner } = fixture();
    await expect(
      (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
        await (runner as any).acquireToolLease(runId, "codex", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "codex drives the browser",
          interactiveResources: [browserClaim("unverified")],
        });
        throw new Error("BROWSER_OPERATION_INTERRUPTED_MID_FLIGHT");
      }),
    ).rejects.toThrow("BROWSER_OPERATION_INTERRUPTED_MID_FLIGHT");

    const card = store
      .projection(runId)
      .actions.find((action) => action.kind === "uncertain_effect");
    expect(card).toBeDefined();
    expect(card!.title).toContain("interactive resource");
    expect(card!.body).toContain(BROWSER_GLOBAL);
    const held = (runner as any).leases.held();
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe("uncertain");

    let waiterEntered = false;
    const waiter = (runner as any).executeProviderBurst(runId, "claude", "review", async () => {
      await (runner as any).acquireToolLease(runId, "claude", {
        mutation: false,
        targets: [],
        dynamic: false,
        heavy: false,
        reason: "claude wants the browser",
        interactiveResources: [browserClaim("unverified")],
      });
      waiterEntered = true;
    });
    void waiter.catch(() => undefined);
    await flush(6);
    // The uncertain lease is never released blindly; the peer stays blocked
    // until the user reconciles.
    expect(waiterEntered).toBe(false);
    expect(store.projection(runId).workers.claude.state).toBe("waiting_lease");
    store.close();
  });

  it("surfaces an outstanding interactive lease as a reconciliation card after service restart", async () => {
    const { store, runId, runner, root } = fixture();
    await expect(
      (runner as any).executeProviderBurst(runId, "codex", "candidate", async () => {
        await (runner as any).acquireToolLease(runId, "codex", {
          mutation: false,
          targets: [],
          dynamic: false,
          heavy: false,
          reason: "codex desktop work",
          interactiveResources: [{ class: "computer_use" }],
        });
        throw new Error("SERVICE_CRASH_SIMULATION");
      }),
    ).rejects.toThrow("SERVICE_CRASH_SIMULATION");
    store.close();

    const reopened = new EventStore(join(root, "events.sqlite"));
    new Coordinator(reopened, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
    });
    const cards = reopened
      .projection(runId)
      .actions.filter((action) => action.kind === "uncertain_effect");
    expect(
      cards.some(
        (action) =>
          action.title.includes("interactive-resource lease needs reconciliation") &&
          action.body.includes(COMPUTER),
      ),
    ).toBe(true);
    reopened.close();
  });
});
