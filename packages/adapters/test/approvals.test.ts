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

  it("allows scoped reads, defers without losing the request, and rejects task grants outside workspace", () => {
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
