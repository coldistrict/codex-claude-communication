import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "@collab/kernel";
import { RealCollaborationRunner } from "../src/real-runner.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collab-activity-"));
  const store = new EventStore(join(root, "events.sqlite"));
  const captured: Array<{
    runId: string;
    role: string;
    kind: string;
    summary: string;
  }> = [];
  const identities: Array<{
    runId: string;
    role: string;
    model: string | null;
    effort: string | null;
  }> = [];
  const runner = new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    publishActivity: (runId, activity) => captured.push({ runId, ...activity }),
    publishIdentity: (runId, identity) => identities.push({ runId, ...identity }),
    onCodexServerRequest: async () => ({}),
    onClaudeToolRequest: async () => ({}),
  });
  return { store, runner, captured, identities };
}

describe("live activity feed derivation", () => {
  it("derives tool and text lines from Claude SDK messages and redacts secrets", () => {
    const { store, runner, captured } = fixture();
    (runner as any).emitClaudeActivity("run_1", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la packages" } },
          { type: "text", text: "Reviewing the workspace layout.\nNext: styles." },
          { type: "tool_use", name: "Read", input: { file_path: "/ws/app.tsx" } },
        ],
      },
    });
    (runner as any).emitClaudeActivity("run_1", {
      type: "system",
      subtype: "init",
      model: "claude-opus-5",
    });
    expect(captured).toEqual([
      { runId: "run_1", role: "claude", kind: "tool", summary: "Bash: ls -la packages" },
      {
        runId: "run_1",
        role: "claude",
        kind: "text",
        summary: "Reviewing the workspace layout. Next: styles.",
      },
      { runId: "run_1", role: "claude", kind: "tool", summary: "Read: /ws/app.tsx" },
      {
        runId: "run_1",
        role: "claude",
        kind: "status",
        summary: "session started (model claude-opus-5)",
      },
    ]);
    store.close();
  });

  it("derives command, file-change, and message lines from codex notifications, skipping deltas and reasoning", () => {
    const { store, runner, captured } = fixture();
    (runner as any).emitCodexActivity("run_2", {
      method: "item/started",
      params: { item: { type: "commandExecution", command: "npm test -w @collab/ui" } },
    });
    (runner as any).emitCodexActivity("run_2", {
      method: "item/completed",
      params: {
        item: { type: "commandExecution", command: "npm test -w @collab/ui", exitCode: 0 },
      },
    });
    (runner as any).emitCodexActivity("run_2", {
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          changes: [{ path: "packages/ui/src/app.tsx" }, { path: "packages/ui/src/styles.css" }],
        },
      },
    });
    (runner as any).emitCodexActivity("run_2", {
      method: "item/agentMessage/delta",
      params: { delta: "streaming noise" },
    });
    (runner as any).emitCodexActivity("run_2", {
      method: "item/completed",
      params: { item: { type: "reasoning", content: "private chain of thought" } },
    });
    (runner as any).emitCodexActivity("run_2", {
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "Bearer abcdefghijklmnopqrstuvwxyz1234 applied" } },
    });
    expect(captured.map((entry) => entry.summary)).toEqual([
      "started command: npm test -w @collab/ui",
      "finished command: npm test -w @collab/ui (exit 0)",
      "finished file change: packages/ui/src/app.tsx, packages/ui/src/styles.css",
      "[REDACTED] applied",
    ]);
    expect(captured.every((entry) => entry.role === "codex")).toBe(true);
    store.close();
  });

  it("publishes model identity from claude init and codex reroute notifications", () => {
    const { store, runner, captured, identities } = fixture();
    (runner as any).emitClaudeActivity("run_3", {
      type: "system",
      subtype: "init",
      model: "claude-opus-5",
    });
    (runner as any).emitCodexActivity("run_3", {
      method: "model/rerouted",
      params: { toModel: "gpt-5.6-sol-mini" },
    });
    expect(identities).toEqual([
      { runId: "run_3", role: "claude", model: "claude-opus-5", effort: null },
      { runId: "run_3", role: "codex", model: "gpt-5.6-sol-mini", effort: null },
    ]);
    expect(captured.map((entry) => entry.summary)).toEqual([
      "session started (model claude-opus-5)",
      "model rerouted to gpt-5.6-sol-mini",
    ]);
    store.close();
  });

  it("builds redacted peer-only digests and advances each recipient's cut", () => {
    const { store, runner } = fixture();
    (runner as any).emitActivity(
      "run_digest",
      "codex",
      "status",
      "codex-only activity",
    );
    (runner as any).emitClaudeActivity("run_digest", {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Applied Bearer abcdefghijklmnopqrstuvwxyz1234 to peer work",
          },
        ],
      },
    });

    const first = (runner as any).peerDigest("run_digest", "codex") as string;
    expect(first).toContain("Peer activity since your last turn");
    expect(first).toContain("[REDACTED]");
    expect(first).toContain("to peer work");
    expect(first).not.toContain("codex-only activity");
    expect(first).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
    expect((runner as any).peerDigest("run_digest", "codex")).toBeNull();

    (runner as any).emitActivity(
      "run_digest",
      "claude",
      "tool",
      "new peer action",
    );
    const second = (runner as any).peerDigest("run_digest", "codex") as string;
    expect(second).toContain("new peer action");
    expect(second).not.toContain("to peer work");
    store.close();
  });

  it("keeps the newest actions behind one omitted marker within 2048 bytes", () => {
    const { store, runner } = fixture();
    for (let index = 0; index < 80; index += 1) {
      (runner as any).emitActivity(
        "run_cap",
        "claude",
        "tool",
        `action-${index} ${"x".repeat(350)}`,
      );
    }

    const digest = (runner as any).peerDigest("run_cap", "codex") as string;
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(2_048);
    expect(digest.match(/…\d+ earlier actions omitted/g)).toHaveLength(1);
    expect(digest).toContain("action-79");
    expect(digest).not.toContain("action-0 ");
    store.close();
  });
});
