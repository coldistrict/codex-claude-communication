import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "@collab/kernel";
import { inventoryTree } from "@collab/migration";
import { Coordinator } from "../src/coordinator.ts";
import {
  RealCollaborationRunner,
  type RealClaudePort,
  type RealCodexPort,
} from "../src/real-runner.ts";
import { createCollabServer } from "../src/server.ts";

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

const opening = (role: "codex" | "claude") => ({
  rationale: `${role} opening`,
  evidence: ["workspace inspected"],
  risks: [],
});

const manifest = {
  artifacts: [],
  evidenceLedger: ["deterministic fixture"],
  verification: [],
  knownLimitations: [],
  unresolvedNonMaterial: [],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collab-mvp-surface-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const store = new EventStore(join(root, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  return { root, workspace, store, coordinator };
}

describe("F-11 advanced controls are immutable and mechanically honored", () => {
  it("content-addresses workspace-contained attachments and denies mutation under read-only", async () => {
    const { root, workspace, store, coordinator } = fixture();
    const attachment = join(workspace, "requirements.md");
    writeFileSync(attachment, "# <script>fixture</script>\n", { mode: 0o600 });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n", { mode: 0o600 });

    const runId = coordinator.createRun(
      {
        goal: "Inspect the attachment without changing the workspace.",
        workspace,
        attachmentPaths: ["requirements.md"],
        permissionPreset: "read_only",
        stopConditions: { maxDurationMinutes: 5 },
        resourceMode: "serialized",
        mode: "real",
      },
      true,
    );
    const goal = store.projection(runId).goal!;
    expect(goal.authority).toEqual({
      writableRoots: [],
      readableRoots: [],
      network: "off",
      permissionPreset: "read_only",
    });
    expect(goal.resourceMode).toBe("serialized");
    expect(goal.stopConditions).toEqual({ maxDurationMinutes: 5 });
    expect(goal.attachments).toEqual([
      {
        path: "requirements.md",
        sha256: createHash("sha256")
          .update("# <script>fixture</script>\n")
          .digest("hex"),
        size: Buffer.byteLength("# <script>fixture</script>\n"),
        mediaType: "text/markdown",
      },
    ]);

    const codexDecision = await (coordinator as any).handleCodexServerRequest(
      runId,
      {
        method: "item/fileChange/requestApproval",
        params: {
          approvalId: "codex-read-only-write",
          grantRoot: workspace,
          reason: "Attempt a fixture write.",
        },
      },
    );
    expect(codexDecision).toEqual({ decision: "decline" });
    const claudeDecision = await (coordinator as any).handleClaudeToolRequest(
      runId,
      "Write",
      { file_path: join(workspace, "result.txt") },
      { requestId: "claude-read-only-write" },
    );
    expect(claudeDecision).toMatchObject({ behavior: "deny" });
    const outsideReadDecision = await (coordinator as any).handleClaudeToolRequest(
      runId,
      "Read",
      { file_path: outside },
      { requestId: "claude-read-only-outside-read" },
    );
    expect(outsideReadDecision).toMatchObject({ behavior: "deny" });
    expect(
      store
        .events(runId)
        .filter((event) => event.type === "permission_decided")
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ preset: "read_only", role: "codex" }),
      expect.objectContaining({ preset: "read_only", role: "claude" }),
      expect.objectContaining({
        preset: "read_only",
        role: "claude",
        classification: "outside_workspace",
      }),
    ]);

    expect(() =>
      coordinator.createRun(
        {
          goal: "Reject an attachment outside the workspace.",
          workspace,
          attachmentPaths: [outside],
        },
        true,
      ),
    ).toThrow("ATTACHMENT_OUTSIDE_WORKSPACE");
    store.close();
  });

  it("passes the read-only sandbox to every Codex burst and serializes provider bursts", async () => {
    const { workspace, store, coordinator } = fixture();
    const attachment = join(workspace, "evidence.txt");
    writeFileSync(attachment, "immutable evidence\n", { mode: 0o600 });
    const runId = coordinator.createRun(
      {
        goal: "Produce a read-only, serialized fixture outcome.",
        workspace,
        attachmentPaths: [attachment],
        permissionPreset: "read_only",
        resourceMode: "serialized",
        mode: "real",
      },
      true,
    );
    let active = 0;
    let maxActive = 0;
    const codexSandboxes: unknown[] = [];
    const claudeReadOnly: unknown[] = [];
    const prompts: string[] = [];
    let codexBurst = 0;
    let claudeBurst = 0;
    const tracked = async <T>(value: T): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return value;
    };
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async (input) => {
        codexSandboxes.push(input.sandbox);
        prompts.push(input.prompt);
        codexBurst += 1;
        const value =
          codexBurst === 1
            ? opening("codex")
            : codexBurst === 2
              ? manifest
              : { sign: true, rationale: "verified" };
        return tracked({
          threadId: "codex-session",
          turnId: `codex-turn-${codexBurst}`,
          text: JSON.stringify(value),
          turn: { status: "completed" },
          usage,
        });
      },
      close: async () => undefined,
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async (input) => {
        claudeReadOnly.push(input.readOnly);
        prompts.push(input.prompt);
        claudeBurst += 1;
        const value =
          claudeBurst === 1
            ? opening("claude")
            : claudeBurst === 2
              ? { rationale: "reviewed", manifest }
              : { sign: true, rationale: "verified" };
        return tracked({
          sessionId: "claude-session",
          messages: [],
          text: JSON.stringify(value),
          structuredOutput: value,
          usage,
        });
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

    expect(store.projection(runId).state).toBe("completed_consensus");
    expect(codexSandboxes).toEqual([
      "read-only",
      "read-only",
      "read-only",
    ]);
    expect(claudeReadOnly).toEqual([true, true, true]);
    expect(maxActive).toBe(1);
    const attachmentReference = store.projection(runId).goal!.attachments![0]!;
    expect(
      prompts
        .slice(0, 4)
        .every((prompt) => prompt.includes(attachmentReference.sha256)),
    ).toBe(true);
    expect(prompts.every((prompt) => !prompt.includes("immutable evidence\n"))).toBe(
      true,
    );
    store.close();
  });

  it("interrupts and closes provider work before a duration stop becomes terminal", async () => {
    const { workspace, store, coordinator } = fixture();
    const runId = coordinator.createRun(
      {
        goal: "Stop this deliberately stalled fixture.",
        workspace,
        stopConditions: { maxDurationMinutes: 0.001 },
        mode: "real",
      },
      true,
    );
    const calls: string[] = [];
    let rejectCodex!: (error: Error) => void;
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async () =>
        new Promise((_, reject) => {
          rejectCodex = reject;
        }),
      interruptActiveTurn: async () => {
        calls.push("interrupt");
      },
      close: async () => {
        if (!calls.includes("close")) calls.push("close");
        rejectCodex?.(new Error("fixture stopped"));
      },
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async (input) =>
        new Promise((_, reject) => {
          input.abortController?.signal.addEventListener(
            "abort",
            () => reject(new Error("fixture aborted")),
            { once: true },
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

    await runner.run(runId, true, "real_canary");

    expect(calls.slice(0, 2)).toEqual(["interrupt", "close"]);
    expect(store.projection(runId).state).toBe("cancelled");
    expect(
      store
        .events(runId)
        .find((event) => event.type === "cancelled")?.payload,
    ).toMatchObject({
      reason: "stop_condition_max_duration",
      maxDurationMinutes: 0.001,
    });
    store.close();
  });
});

describe("F-11 configured legacy browser is session-gated and write-free", () => {
  it("lists and reads only immediate tasks below the configured root", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-legacy-api-"));
    const legacyRoot = join(root, "historical");
    const taskRoot = join(legacyRoot, "task-<script>");
    mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(taskRoot, "TASK.md"),
      "Objective: **Review <script data-fixture>bad()</script> safely**\n",
      { mode: 0o600 },
    );
    writeFileSync(join(taskRoot, "state.json"), '{"status":"completed"}\n', {
      mode: 0o600,
    });
    writeFileSync(
      join(taskRoot, "codex-notes.md"),
      "<img src=x onerror=bad()>\n",
      { mode: 0o600 },
    );
    writeFileSync(join(taskRoot, "transcript.md"), "escaped transcript\n", {
      mode: 0o600,
    });
    writeFileSync(join(taskRoot, "final-plan.md"), "immutable plan\n", {
      mode: 0o600,
    });
    const outsideTask = join(root, "outside-task");
    mkdirSync(outsideTask, { mode: 0o700 });
    writeFileSync(join(outsideTask, "TASK.md"), "Objective: outside\n", {
      mode: 0o600,
    });
    symlinkSync(outsideTask, join(legacyRoot, "outside-link"), "dir");
    const before = inventoryTree(legacyRoot);
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const app = createCollabServer({
      stateFile: join(root, "state", "events.sqlite"),
      legacyTasksRoot: legacyRoot,
    });
    const address = await app.listen();
    try {
      expect(
        (await fetch(`${address.url}/api/legacy-tasks`)).status,
      ).toBe(403);
      const bootstrap = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: {
          Origin: address.url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      const listResponse = await fetch(`${address.url}/api/legacy-tasks`, {
        headers: { Cookie: cookie },
      });
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json();
      expect(list).toEqual([
        expect.objectContaining({
          id: "task-<script>",
          readOnly: true,
          fileCount: 5,
        }),
      ]);
      const detailResponse = await fetch(
        `${address.url}/api/legacy-tasks/${encodeURIComponent("task-<script>")}`,
        { headers: { Cookie: cookie } },
      );
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        id: "task-<script>",
        readOnly: true,
        transcript: "escaped transcript\n",
        finalPlan: "immutable plan\n",
      });
      const traversal = await fetch(
        `${address.url}/api/legacy-tasks/${encodeURIComponent("../outside")}`,
        { headers: { Cookie: cookie } },
      );
      expect(traversal.status).toBe(400);
      expect((await traversal.json()).error).toBe("INVALID_LEGACY_TASK_ID");
      const escapedSymlink = await fetch(
        `${address.url}/api/legacy-tasks/outside-link`,
        { headers: { Cookie: cookie } },
      );
      expect(escapedSymlink.status).toBe(400);
      expect((await escapedSymlink.json()).error).toBe(
        "LEGACY_TASK_OUTSIDE_CONFIGURED_ROOT",
      );
      expect(inventoryTree(legacyRoot)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it("does not expose the legacy feature when no root is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-legacy-disabled-"));
    const app = createCollabServer({
      stateFile: join(root, "events.sqlite"),
    });
    const address = await app.listen();
    try {
      const bootstrap = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: {
          Origin: address.url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      const system = await fetch(`${address.url}/api/system`, {
        headers: { Cookie: cookie },
      });
      expect(await system.json()).toMatchObject({
        legacyTasksEnabled: false,
      });
      const legacy = await fetch(`${address.url}/api/legacy-tasks`, {
        headers: { Cookie: cookie },
      });
      expect(legacy.status).toBe(404);
      expect((await legacy.json()).error).toBe("LEGACY_TASKS_DISABLED");
    } finally {
      await app.close();
    }
  });
});

describe("2026-07-28 first-real-run regression", () => {
  it("auto-allows read-only Bash inside the workspace and narrows outside-path decisions instead of failing", async () => {
    const { root, workspace: rawWorkspace, store, coordinator } = fixture();
    mkdirSync(join(rawWorkspace, "docs"));
    const runId = coordinator.createRun(
      { goal: "Improve the UI of the sibling product.", workspace: rawWorkspace, mode: "real" },
      true,
    );
    // The goal records the canonical workspace; commands must reference the
    // same form for containment to be provable (macOS tmpdir is symlinked).
    const workspace = store.projection(runId).goal!.workspace;

    // The run's first burst listed directories inside the workspace. That is
    // provably read-only and must pass silently: no card, no approval stall.
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Bash",
        { command: `ls -la ${workspace} && echo "---" && ls -la ${join(workspace, "docs")}` },
        { requestId: "regression-ls" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(store.projection(runId).actions).toHaveLength(0);

    // The second burst reached a folder outside the workspace (and outside
    // shared scratch — tmpdir-based fixture paths count as scratch now).
    // The card must classify as outside_workspace and never offer task
    // scope. Classification never stats paths, so this needs no mkdir.
    const outsidePath = "/opt/collab-test-outside/product";
    const pendingDecision = (coordinator as any).handleClaudeToolRequest(
      runId,
      "Bash",
      { command: `cd ${outsidePath} && cat README.md package.json` },
      { requestId: "regression-outside", blockedPath: outsidePath },
    );
    const card = store
      .projection(runId)
      .actions.find((action) => action.kind === "permission")!;
    expect(card.title).toContain("outside workspace");
    expect(card.paths).toEqual([outsidePath]);
    expect(card.actions).toEqual(["Allow once", "Deny", "Defer"]);

    // Even if a client submits task scope anyway, the decision applies as a
    // narrowed one-time allowance — previously this crashed the dashboard
    // with a raw TASK_GRANT_OUTSIDE_WORKSPACE error.
    await coordinator.decideAction(runId, card.id, "Allow for task");
    await expect(pendingDecision).resolves.toMatchObject({ behavior: "allow" });
    const decided = store
      .events(runId)
      .find((event) => event.type === "permission_decided")!;
    expect((decided.payload as any).decision).toEqual({
      behavior: "allow",
      scope: "once",
    });
    store.close();
  });

  it("auto-allows read-only commands inside a declared readable root while writes there still ask", async () => {
    const { root, workspace: rawWorkspace, store, coordinator } = fixture();
    const sibling = join(root, "sibling-repo");
    mkdirSync(sibling);
    const runId = coordinator.createRun(
      {
        goal: "Improve the UI with the sibling repository readable.",
        workspace: rawWorkspace,
        readableRoots: [sibling],
        mode: "real",
      },
      true,
    );
    const goal = store.projection(runId).goal!;
    const readableRoot = goal.authority.readableRoots![0]!;
    expect(goal.authority.readableRoots).toHaveLength(1);

    // The exact command shape from the 2026-07-28 run: cd into the declared
    // root, list, and read git history with stderr silenced — no card.
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Bash",
        { command: `cd ${readableRoot} && ls -la && git log --oneline -10 2>/dev/null` },
        { requestId: "readable-root-read", blockedPath: readableRoot },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(store.projection(runId).actions).toHaveLength(0);

    // A Read tool inside the root is equally silent; a write there is not.
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Read",
        { file_path: join(readableRoot, "README.md") },
        { requestId: "readable-root-read-tool" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    void (coordinator as any).handleClaudeToolRequest(
      runId,
      "Write",
      { file_path: join(readableRoot, "notes.md") },
      { requestId: "readable-root-write" },
    );
    const card = store
      .projection(runId)
      .actions.find((action) => action.kind === "permission")!;
    expect(card.title).toContain("outside workspace");
    expect(card.actions).not.toContain("Allow for task");
    store.close();
  });

  it("auto preset runs workspace commands without a card while hazardous classes still ask", async () => {
    const { workspace, store, coordinator } = fixture();
    const runId = coordinator.createRun(
      {
        goal: "Improve the UI without permission friction.",
        workspace,
        permissionPreset: "auto",
        mode: "real",
      },
      true,
    );

    // The exact command that interrupted the 2026-07-28 runs twice: a test
    // suite invocation classified workspace_write. Under auto it proceeds
    // with no card for either provider.
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Bash",
        { command: "/bin/zsh -lc 'npm test -w @collab/ui'" },
        { requestId: "auto-claude-test" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      (coordinator as any).handleCodexServerRequest(runId, {
        method: "item/commandExecution/requestApproval",
        params: {
          approvalId: "auto-codex-test",
          command: "/bin/zsh -lc 'npm test -w @collab/ui'",
        },
      }),
    ).resolves.toMatchObject({ decision: "accept" });
    expect(store.projection(runId).actions).toHaveLength(0);
    expect(
      store.events(runId).filter((event) => event.type === "permission_requested"),
    ).toHaveLength(0);

    // The 2026-07-28 run-4 blockers: deleting the agent's own artifacts
    // (with $PWD) and hashing into /tmp scratch are ordinary dev-loop work.
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Bash",
        {
          command:
            'npm run build -w @collab/ui 2>&1 | tail -8 && rm -f artifacts/ui/*.png && PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright" node --import tsx tools/ui-shots.ts 2>&1 | tail -6',
        },
        { requestId: "auto-workspace-rm" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      (coordinator as any).handleClaudeToolRequest(
        runId,
        "Bash",
        {
          command:
            "shasum -a 256 packages/ui/dist/assets/* > /tmp/h1.txt && diff /tmp/h1.txt /tmp/h1.txt",
        },
        { requestId: "auto-scratch-write" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(store.projection(runId).actions).toHaveLength(0);

    // Deletions that cannot be proven workspace-contained stay behind a card.
    void (coordinator as any).handleClaudeToolRequest(
      runId,
      "Bash",
      { command: "rm -rf $TARGET" },
      { requestId: "auto-destructive" },
    );
    const card = store
      .projection(runId)
      .actions.find((action) => action.kind === "permission")!;
    expect(card.title).toContain("destructive");
    expect(card.actions).not.toContain("Allow for task");
    store.close();
  });
});
