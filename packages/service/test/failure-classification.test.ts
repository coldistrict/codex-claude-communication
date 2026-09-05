import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digest, EventStore } from "@collab/kernel";
import { ProviderFailure, RealCollaborationRunner } from "../src/real-runner.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collab-failure-class-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const store = new EventStore(join(root, "events.sqlite"));
  const runId = "run_failure_class";
  const base = {
    goal: "fixture",
    workspace,
    constraints: [],
    authority: {
      writableRoots: [workspace],
      readableRoots: [],
      network: "off" as const,
      permissionPreset: "auto" as const,
    },
    completionEvidence: [],
    usefulWorkBudget: { perMaterialChallenge: 4, perProvider: 24 },
  };
  store.append({
    runId,
    actor: "user",
    type: "goal_set",
    idempotencyKey: "goal",
    payload: {
      goal: {
        id: "goal_test",
        runId,
        ...base,
        digest: digest(base),
        createdAt: new Date().toISOString(),
      },
    },
  });
  const runner = new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    onCodexServerRequest: async () => ({}),
    onClaudeToolRequest: async () => ({}),
  });
  return { store, runner, runId };
}

describe("provider failure classification", () => {
  it("never classifies a transport timeout as a provider limit, even for rateLimits reads", () => {
    const { store, runner, runId } = fixture();
    (runner as any).recordFailure(
      runId,
      new ProviderFailure(
        "codex",
        new Error("CODEX_RPC_TIMEOUT:account/rateLimits/read"),
      ),
    );
    expect(
      store.events(runId).filter((event) => event.type === "paused_limit"),
    ).toHaveLength(0);
    const failure = store
      .events(runId)
      .find((event) => event.type === "needs_input")!;
    expect((failure.payload as any).card.title).toBe(
      "Collaboration paused after a codex failure",
    );
    expect((failure.payload as any).card.body).toContain("CODEX_RPC_TIMEOUT");
    store.close();
  });

  it("still classifies genuine provider limit messages as limits", () => {
    const { store, runner, runId } = fixture();
    (runner as any).recordFailure(
      runId,
      new ProviderFailure("codex", new Error("usage limit reached for plan")),
    );
    const limits = store
      .events(runId)
      .filter((event) => event.type === "paused_limit");
    expect(limits).toHaveLength(1);
    expect((limits[0]!.payload as any).card.title).toBe(
      "codex paused on a provider limit",
    );
    store.close();
  });
});
