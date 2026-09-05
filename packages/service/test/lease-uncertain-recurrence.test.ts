import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digest, EventStore } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import { RealCollaborationRunner } from "../src/real-runner.ts";

function runnerOver(store: EventStore) {
  return new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    onCodexServerRequest: async () => ({}),
    onClaudeToolRequest: async () => ({}),
  });
}

function goalSet(store: EventStore, runId: string, workspace: string) {
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
}

function failWithHeldLease(
  runner: RealCollaborationRunner,
  runId: string,
  workspace: string,
  message: string,
): void {
  const owner = { runId, role: "claude" as const, incarnation: 1, workItem: "review" };
  const acquisition = (runner as any).leases.acquire({
    owner,
    workspace,
    targets: [workspace],
    dynamic: true,
    sandboxEnforcesRoots: false,
    heavy: false,
    reason: "fixture mutation",
  });
  expect(acquisition.acquired).toBe(true);
  (runner as any).heldLeases.set(`${runId}:claude`, [
    { lease: acquisition.lease, owner },
  ]);
  (runner as any).markBurstLeaseUncertain(runId, "claude", new Error(message));
}

describe("recurring lease names across resumes", () => {
  it("records every uncertain-lease failure even when a later incarnation reuses lease_1", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-lease-recur-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const store = new EventStore(join(root, "events.sqlite"));
    const runId = "run_recurrence";
    goalSet(store, runId, workspace);

    // Two incarnations over the same durable store, exactly like a resume:
    // each fresh LeaseManager numbers from lease_1 again.
    failWithHeldLease(runnerOver(store), runId, workspace, "CLAUDE_BURST_FAILED:first");
    failWithHeldLease(runnerOver(store), runId, workspace, "CLAUDE_BURST_FAILED:second");

    const uncertain = store
      .events(runId)
      .filter((event) => event.type === "uncertain_effect");
    expect(uncertain).toHaveLength(2);
    expect(
      uncertain.map((event) => (event.payload as any).leaseId),
    ).toEqual(["lease_1", "lease_1"]);
    const keys = uncertain.map((event) => event.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    const cardIds = uncertain.map((event) => (event.payload as any).card.id);
    expect(new Set(cardIds).size).toBe(2);
    expect((uncertain[1]!.payload as any).card.body).toContain("second");
    store.close();
  });

  it("never lets stale bookkeeping mask the original burst failure", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-lease-stale-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const store = new EventStore(join(root, "events.sqlite"));
    const runId = "run_stale_entry";
    goalSet(store, runId, workspace);
    const runner = runnerOver(store);
    const owner = { runId, role: "claude" as const, incarnation: 1, workItem: "signoff" };
    const acquisition = (runner as any).leases.acquire({
      owner,
      workspace,
      targets: [workspace],
      dynamic: true,
      sandboxEnforcesRoots: false,
      heavy: false,
      reason: "fixture mutation",
    });
    expect(acquisition.acquired).toBe(true);
    (runner as any).heldLeases.set(`${runId}:claude`, [
      // A ghost entry for a lease the manager no longer knows about — the
      // exact shape that used to throw LEASE_OWNER_MISMATCH out of the
      // failure path and bury the real error.
      { lease: { id: "lease_99", targets: [], reason: "gone" }, owner },
      { lease: acquisition.lease, owner },
    ]);
    expect(() =>
      (runner as any).markBurstLeaseUncertain(
        runId,
        "claude",
        new Error("CLAUDE_BURST_FAILED:the real cause"),
      ),
    ).not.toThrow();
    const uncertain = store
      .events(runId)
      .filter((event) => event.type === "uncertain_effect");
    expect(uncertain).toHaveLength(1);
    expect((uncertain[0]!.payload as any).leaseId).toBe(acquisition.lease.id);
    expect((uncertain[0]!.payload as any).card.body).toContain("the real cause");
    // Release skips the ghost entry (no owner-mismatch masking) and
    // surfaces only the genuine conflict: the live lease is uncertain and
    // must not be blindly released.
    expect(() =>
      (runner as any).releaseBurstLease(runId, "claude"),
    ).toThrow(/Uncertain side effects/);
    store.close();
  });

  it("reconciles uncertain leases on retry so an in-process resume cannot block on its own ghost", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-lease-reconcile-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const store = new EventStore(join(root, "events.sqlite"));
    const runId = "run_reconcile";
    goalSet(store, runId, workspace);
    const runner = runnerOver(store);
    failWithHeldLease(runner, runId, workspace, "CLAUDE_BURST_FAILED:starved");
    expect((runner as any).leases.held()).toHaveLength(1);

    (runner as any).reconcileUncertainLeases(runId);
    expect((runner as any).leases.held()).toHaveLength(0);
    expect((runner as any).heldLeases.has(`${runId}:claude`)).toBe(false);
    expect(
      store
        .events(runId)
        .some(
          (event) =>
            event.type === "lease_released" &&
            (event.payload as any).reconciliation === "user_reconciled",
        ),
    ).toBe(true);

    // The same target must be acquirable again immediately.
    const again = (runner as any).leases.acquire({
      owner: { runId, role: "claude" as const, incarnation: 2, workItem: "signoff" },
      workspace,
      targets: [workspace],
      dynamic: true,
      sandboxEnforcesRoots: false,
      heavy: false,
      reason: "fixture retry",
    });
    expect(again.acquired).toBe(true);
    store.close();
  });

  it("journals acquire and release for a recurring lease name without key collisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-lease-journal-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const store = new EventStore(join(root, "events.sqlite"));
    const runId = "run_journal";
    goalSet(store, runId, workspace);

    // Two incarnations, each acquiring the exact production path
    // (acquireToolLease journals lease_acquired) with the recurring name
    // lease_1, then releasing. The 09:14 failure was this append colliding
    // and tearing down codex's approval mid-command.
    for (let incarnation = 1; incarnation <= 2; incarnation += 1) {
      const runner = runnerOver(store);
      const owner = {
        runId,
        role: "claude" as const,
        incarnation,
        workItem: "signoff",
      };
      (runner as any).activeBursts.set(`${runId}:claude`, {
        key: "signoff",
        owner,
        workspace,
      });
      await (runner as any).acquireToolLease(runId, "claude", {
        mutation: true,
        targets: [workspace],
        dynamic: false,
        heavy: false,
        reason: "fixture mutation",
      });
      (runner as any).releaseBurstLease(runId, "claude");
    }

    const acquiredEvents = store
      .events(runId)
      .filter((event) => event.type === "lease_acquired");
    const releasedEvents = store
      .events(runId)
      .filter((event) => event.type === "lease_released");
    expect(acquiredEvents).toHaveLength(2);
    expect(releasedEvents).toHaveLength(2);
    expect(
      acquiredEvents.every(
        (event) => (event.payload as any).lease.id === "lease_1",
      ),
    ).toBe(true);
    expect(
      new Set(acquiredEvents.map((event) => event.idempotencyKey)).size,
    ).toBe(2);
    expect(
      new Set(releasedEvents.map((event) => event.idempotencyKey)).size,
    ).toBe(2);
    store.close();
  });

  it("survives a second restart with the same outstanding lease and does not duplicate the card", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-lease-boot-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const store = new EventStore(join(root, "events.sqlite"));
    const runId = "run_double_restart";
    goalSet(store, runId, workspace);
    store.append({
      runId,
      actor: "system",
      type: "lease_acquired",
      idempotencyKey: "lease:acquired",
      payload: {
        role: "claude",
        lease: {
          id: "lease_1",
          targets: [workspace],
          reason: "fixture mutation",
          interactiveResources: [],
        },
      },
    });

    // Boot #1 posts the recovery reconciliation; boot #2 finds the same
    // outstanding lease and must neither collide nor re-post the card.
    new Coordinator(store, { codexBinary: "/unused/codex" });
    expect(() => new Coordinator(store, { codexBinary: "/unused/codex" })).not.toThrow();
    const recoveryCards = store
      .events(runId)
      .filter(
        (event) =>
          event.type === "uncertain_effect" &&
          String((event.payload as any).leaseId) === "lease_1",
      );
    expect(recoveryCards).toHaveLength(1);
    const pending = store
      .projection(runId)
      .actions.filter((action) => action.kind === "uncertain_effect");
    expect(pending).toHaveLength(1);
    store.close();
  });
});
