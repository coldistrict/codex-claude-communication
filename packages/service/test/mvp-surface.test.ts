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
