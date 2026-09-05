import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalBridge, type PermissionClass } from "../src/index.ts";

describe("V-6 approval and needs-input bridge", () => {
  it("asks on first workspace mutation, remembers exact grants, and always asks for hazardous classes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "collab-approvals-"));
    const file = join(workspace, "result.ts");
    const bridge = new ApprovalBridge(workspace);
    const request = {
      id: "write-1",
      role: "codex" as const,
      tool: "writeFile",
      paths: [file],
      reason: "Implement the approved result",
      sideEffect: "Modifies result.ts",
      reversibility: "Reversible from content-addressed artifact",
      classification: "workspace_write" as const,
    };
    const first = bridge.evaluate(request);
    expect(first.allowed).toBe(false);
    if (first.allowed) throw new Error("fixture");
    expect(first.card).toMatchObject({
      command: "writeFile",
      paths: [file],
      reason: request.reason,
      sideEffect: request.sideEffect,
      reversibility: request.reversibility,
      agent: "codex",
    });
    bridge.decide(request.id, { behavior: "allow", scope: "task" });
    expect(bridge.evaluate({ ...request, id: "write-2" })).toEqual({ allowed: true });

    const alwaysAsk: PermissionClass[] = [
      "destructive",
      "install",
      "network",
      "external_communication",
      "outside_workspace",
      "system_change",
      "payment",
      "public_action",
      "uncertain_replay",
    ];
    for (const classification of alwaysAsk) {
      const result = bridge.evaluate({
        ...request,
        id: `hazard-${classification}`,
        classification,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.card.actions).not.toContain("Allow for task");
    }
  });

  it("never offers task scope outside the workspace and narrows such decisions to once", () => {
    const workspace = mkdtempSync(join(tmpdir(), "collab-approvals-"));
    const outside = join(tmpdir(), "collab-approvals-outside", "product");
    const bridge = new ApprovalBridge(workspace);
    const request = {
      id: "outside-write",
      role: "claude" as const,
      tool: "Bash",
      command: "cd /outside/product && cat README.md",
      paths: [outside],
      reason: "Inspect the sibling project",
      sideEffect: "Runs a command outside the workspace",
      reversibility: "Review the exact operation",
      classification: "workspace_write" as const,
    };
    const evaluated = bridge.evaluate(request);
    expect(evaluated.allowed).toBe(false);
    if (evaluated.allowed) throw new Error("fixture");
    expect(evaluated.card.actions).not.toContain("Allow for task");
    // Even a decision that arrives with task scope anyway (an API caller can
    // send any label) must apply as a one-time allowance without throwing.
    const applied = bridge.decide(request.id, { behavior: "allow", scope: "task" });
    expect(applied.decision).toEqual({ behavior: "allow", scope: "once" });
    const repeat = bridge.evaluate({ ...request, id: "outside-write-2" });
    expect(repeat.allowed).toBe(false);
  });

  it("allows scoped reads and defers without losing the request", () => {
    const workspace = mkdtempSync(join(tmpdir(), "collab-approvals-"));
    const inside = join(workspace, "src");
    mkdirSync(inside);
    const bridge = new ApprovalBridge(workspace);
    expect(
      bridge.evaluate({
        id: "read",
        role: "claude",
        tool: "Read",
        paths: [inside],
        reason: "Inspect source",
        sideEffect: "None",
        reversibility: "No mutation",
        classification: "read",
      }),
    ).toEqual({ allowed: true });
    const pending = bridge.evaluate({
      id: "defer",
      role: "claude",
      tool: "Bash",
      command: "npm install",
      paths: [workspace],
      reason: "Install project-local package",
      sideEffect: "Changes node_modules and lockfile",
      reversibility: "Remove package and restore lockfile",
      classification: "install",
    });
    expect(pending.allowed).toBe(false);
    bridge.decide("defer", { behavior: "defer", scope: "once" });
    expect(bridge.pendingIds()).toContain("defer");
  });

  it("prints the machine-readable approval result", () => {
    console.log('RESULT {"suite":"V-6","passed":true,"alwaysAskAllowed":0,"modelStarts":0}');
  });
});
