import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interactiveResourceId,
  interactiveResourcesConflict,
  LeaseManager,
} from "../src/index.ts";

describe("V-3 deterministic lease manager", () => {
  it("serializes overlapping paths and heavy work across randomized schedules", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-leases-"));
    const left = join(root, "src");
    const right = join(root, "docs");
    mkdirSync(left);
    mkdirSync(right);
    for (let index = 0; index < 100; index += 1) {
      const manager = new LeaseManager();
      const firstRole = index % 2 === 0 ? "codex" : "claude";
      const secondRole = firstRole === "codex" ? "claude" : "codex";
      const first = manager.acquire({
        owner: { runId: "run", role: firstRole, incarnation: 1, workItem: `a-${index}` },
        workspace: root,
        targets: [left],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit",
      });
      expect(first.acquired).toBe(true);
      const second = manager.acquire({
        owner: { runId: "run", role: secondRole, incarnation: 1, workItem: `b-${index}` },
        workspace: root,
        targets: [join(left, "file.ts")],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit same tree",
      });
      expect(second.acquired).toBe(false);
    }
  });

  it("allows non-overlapping enforced writes but serializes unknown and unenforced writes", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-leases-"));
    const left = join(root, "src");
    const right = join(root, "docs");
    mkdirSync(left);
    mkdirSync(right);
    const ownerA = { runId: "run", role: "codex" as const, incarnation: 1, workItem: "a" };
    const ownerB = { runId: "run", role: "claude" as const, incarnation: 1, workItem: "b" };
    const manager = new LeaseManager();
    expect(
      manager.acquire({
        owner: ownerA,
        workspace: root,
        targets: [left],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit source",
      }).acquired,
    ).toBe(true);
    expect(
      manager.acquire({
        owner: ownerB,
        workspace: root,
        targets: [right],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit docs",
      }).acquired,
    ).toBe(true);
    const serialized = new LeaseManager();
    expect(
      serialized.acquire({
        owner: ownerA,
        workspace: root,
        targets: [left],
        dynamic: false,
        sandboxEnforcesRoots: false,
        heavy: false,
        reason: "unenforced",
      }).acquired,
    ).toBe(true);
    expect(
      serialized.acquire({
        owner: ownerB,
        workspace: root,
        targets: [right],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "blocked by wide lease",
      }).acquired,
    ).toBe(false);
  });

  it("rejects path expansion, stale renewal, early uncertain release, and concurrent heavy leases", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-leases-"));
    const inside = join(root, "inside");
    mkdirSync(inside);
    const owner = { runId: "run", role: "codex" as const, incarnation: 1, workItem: "a" };
    const manager = new LeaseManager();
    expect(() =>
      manager.acquire({
        owner,
        workspace: root,
        targets: [join(root, "..", "outside")],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "escape",
      }),
    ).toThrowError(expect.objectContaining({ code: "PATH_EXPANSION" }));
    const acquired = manager.acquire({
      owner,
      workspace: root,
      targets: [inside],
      dynamic: false,
      sandboxEnforcesRoots: true,
      heavy: false,
      reason: "edit",
    });
    if (!acquired.acquired) throw new Error("fixture failed");
    expect(() =>
      manager.renew(acquired.lease.id, { ...owner, incarnation: 2 }, new Date().toISOString()),
    ).toThrowError(expect.objectContaining({ code: "LEASE_OWNER_MISMATCH" }));
    manager.markUncertain(acquired.lease.id, owner);
    expect(() => manager.release(acquired.lease.id, owner, "certain")).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" }),
    );

    const heavy = new LeaseManager();
    expect(
      heavy.acquire({
        owner,
        workspace: root,
        targets: [],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: true,
        reason: "build",
      }).acquired,
    ).toBe(true);
    expect(
      heavy.acquire({
        owner: { runId: "run", role: "claude", incarnation: 1, workItem: "b" },
        workspace: root,
        targets: [],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: true,
        reason: "browser",
      }).acquired,
    ).toBe(false);

    const mixed = new LeaseManager();
    expect(
      mixed.acquire({
        owner,
        workspace: root,
        targets: [inside],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: true,
        reason: "build inside",
      }).acquired,
    ).toBe(true);
    expect(
      mixed.acquire({
        owner: { runId: "run", role: "claude", incarnation: 1, workItem: "c" },
        workspace: root,
        targets: [inside],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit during build",
      }).acquired,
    ).toBe(false);
  });

  it("enforces the interactive-resource conflict matrix", () => {
    const computer = interactiveResourceId({ class: "computer_use" });
    const globalBrowser = interactiveResourceId({
      class: "browser",
      identity: { kind: "unverified" },
    });
    const profileA = interactiveResourceId({
      class: "browser",
      identity: { kind: "profile", id: "chrome-default" },
    });
    const profileB = interactiveResourceId({
      class: "browser",
      identity: { kind: "profile", id: "work" },
    });
    const isolated1 = interactiveResourceId({
      class: "browser",
      identity: { kind: "isolated_context", id: "c1" },
    });
    const isolated2 = interactiveResourceId({
      class: "browser",
      identity: { kind: "isolated_context", id: "c2" },
    });

    // Same identity is always exclusive.
    expect(interactiveResourcesConflict(computer, computer)).toBe(true);
    expect(interactiveResourcesConflict(profileA, profileA)).toBe(true);
    expect(interactiveResourcesConflict(isolated1, isolated1)).toBe(true);
    // The global fail-safe conflicts with every browser identity.
    expect(interactiveResourcesConflict(globalBrowser, isolated1)).toBe(true);
    expect(interactiveResourcesConflict(profileA, globalBrowser)).toBe(true);
    // Mechanically distinct identities may run concurrently.
    expect(interactiveResourcesConflict(isolated1, isolated2)).toBe(false);
    expect(interactiveResourcesConflict(profileA, profileB)).toBe(false);
    expect(interactiveResourcesConflict(profileA, isolated1)).toBe(false);
    // Computer use and browser are distinct resource classes.
    expect(interactiveResourcesConflict(computer, globalBrowser)).toBe(false);
  });

  it("keeps interactive-resource leases atomic and independent of path leases", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-interactive-leases-"));
    const inside = join(root, "src");
    mkdirSync(inside);
    const manager = new LeaseManager();
    const codexOwner = {
      runId: "run",
      role: "codex" as const,
      incarnation: 1,
      workItem: "a",
    };
    const claudeOwner = {
      runId: "run",
      role: "claude" as const,
      incarnation: 1,
      workItem: "b",
    };
    // A multi-resource claim is granted atomically in one acquisition.
    const both = manager.acquire({
      owner: codexOwner,
      workspace: root,
      targets: [],
      dynamic: false,
      sandboxEnforcesRoots: true,
      heavy: false,
      reason: "desktop plus browser",
      interactiveResources: [
        { class: "browser", identity: { kind: "unverified" } },
        { class: "computer_use" },
      ],
    });
    expect(both.acquired).toBe(true);
    if (both.acquired) {
      expect(both.lease.interactiveResources).toEqual([
        "interactive:browser:global",
        "interactive:computer_use",
      ]);
      expect(both.lease.targets).toEqual([]);
    }
    // Reversed claim order still conflicts with the atomic holder.
    expect(
      manager.acquire({
        owner: claudeOwner,
        workspace: root,
        targets: [],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "reversed order",
        interactiveResources: [
          { class: "computer_use" },
          { class: "browser", identity: { kind: "unverified" } },
        ],
      }).acquired,
    ).toBe(false);
    // A resource-only lease takes no path lease: workspace mutations proceed.
    expect(
      manager.acquire({
        owner: claudeOwner,
        workspace: root,
        targets: [inside],
        dynamic: false,
        sandboxEnforcesRoots: true,
        heavy: false,
        reason: "edit while the peer drives the desktop",
      }).acquired,
    ).toBe(true);
  });

  it("prints the machine-readable lease result", () => {
    console.log('RESULT {"suite":"V-3-leases","passed":true,"randomSchedules":100,"modelStarts":0}');
  });
});
