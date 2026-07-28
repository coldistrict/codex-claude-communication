import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import { RealCollaborationRunner } from "../src/real-runner.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collab-real-leases-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const store = new EventStore(join(root, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  const runId = coordinator.createRun(
    {
      goal: "Exercise production lease boundaries.",
      workspace,
      mode: "real",
    },
    true,
  );
  const runner = new RealCollaborationRunner(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
    codexAdapter: {
      metadataPreflight: async () => {
        throw new Error("not called");
      },
      runBurst: async () => {
        throw new Error("not called");
      },
      close: async () => undefined,
    },
    claudeAdapter: {
      metadataPreflight: async () => {
        throw new Error("not called");
      },
      startBurst: async () => {
        throw new Error("not called");
      },
    },
    onCodexServerRequest: async () => ({ decision: "decline" }),
    onClaudeToolRequest: async () => ({ behavior: "deny" }),
  });
  return { workspace, store, coordinator, runId, runner };
}

describe("real-run production mutation leases", () => {
  it("serializes overlapping tool effects without another model wake", async () => {
    const { workspace, store, runId, runner } = fixture();
    let releaseFirst!: () => void;
    let firstAcquired!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });
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
          mutation: true,
          targets: [join(workspace, "shared.txt")],
          dynamic: false,
          heavy: false,
          reason: "write shared.txt",
        });
        firstAcquired();
        await firstGate;
      },
    );
    await firstReady;
    const second = (runner as any).executeProviderBurst(
      runId,
      "claude",
      "review",
      async () => {
        await (runner as any).acquireToolLease(runId, "claude", {
          mutation: true,
          targets: [join(workspace, "shared.txt")],
          dynamic: false,
          heavy: false,
          reason: "repair shared.txt",
        });
        secondEntered = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(secondEntered).toBe(false);
    expect(
      store.events(runId).some((event) => event.type === "lease_waiting"),
    ).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);

    const events = store.events(runId);
    expect(events.filter((event) => event.type === "lease_acquired")).toHaveLength(
      2,
    );
    expect(events.filter((event) => event.type === "lease_released")).toHaveLength(
      2,
    );
    expect(
      events.filter(
        (event) =>
          event.type === "resumed" &&
          (event.payload as any).modelWake === false,
      ),
    ).toHaveLength(1);
    store.close();
  });

  it("journals uncertain effects and recovers without replay after a crash", async () => {
    const { workspace, store, runId, runner } = fixture();
    await expect(
      (runner as any).executeProviderBurst(
        runId,
        "codex",
        "candidate",
        async () => {
          await (runner as any).acquireToolLease(runId, "codex", {
            mutation: true,
            targets: [join(workspace, "result.txt")],
            dynamic: false,
            heavy: false,
            reason: "write result.txt",
          });
          throw new Error("CRASH_AFTER_MUTATION_PERMISSION");
        },
      ),
    ).rejects.toThrow("CRASH_AFTER_MUTATION_PERMISSION");

    expect(
      store.events(runId).filter((event) => event.type === "lease_released"),
    ).toHaveLength(0);
    expect(store.projection(runId).actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "uncertain_effect", agent: "codex" }),
      ]),
    );

    new Coordinator(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
    });
    const events = store.events(runId);
    expect(
      events.some(
        (event) =>
          event.idempotencyKey.startsWith("recovery:uncertain-lease:"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "work_claimed" &&
          (event.payload as any).activity === "candidate",
      ),
    ).toBe(false);
    store.close();
  });
});
