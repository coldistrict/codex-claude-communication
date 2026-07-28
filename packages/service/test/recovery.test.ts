import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, EventStore } from "@collab/kernel";
import { describe, expect, it } from "vitest";
import { Coordinator } from "../src/coordinator.ts";

describe("provider wait recovery", () => {
  it("turns a persisted permission wait into a non-replaying recovery action", () => {
    const directory = mkdtempSync(join(tmpdir(), "collab-service-recovery-"));
    const file = join(directory, "events.sqlite");
    const runId = "run_stale_permission";
    let store = new EventStore(file);
    const base = {
      goal: "Recover without replay.",
      workspace: directory,
      constraints: [],
      authority: {
        writableRoots: [directory],
        network: "off" as const,
        permissionPreset: "default" as const,
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
          id: "goal_recovery",
          runId,
          ...base,
          digest: digest(base),
          createdAt: "2026-07-26T00:00:00.000Z",
        },
      },
    });
    store.append({
      runId,
      actor: "system",
      type: "permission_requested",
      idempotencyKey: "permission",
      payload: {
        role: "claude",
        card: {
          id: "permission_stale",
          kind: "permission",
          title: "Claude requests a write",
          body: "Write result.txt",
          agent: "claude",
          paths: [join(directory, "result.txt")],
          actions: ["Allow once", "Deny"],
        },
      },
    });
    store.close();

    store = new EventStore(file);
    new Coordinator(store, { codexBinary: "/not-used" });
    const projection = store.projection(runId);
    expect(projection.actions.map((card) => card.id)).toEqual([
      "recovery_permission_stale",
    ]);
    expect(projection.actions[0]).toMatchObject({
      kind: "uncertain_effect",
      actions: ["Retry collaboration", "Cancel"],
    });
    expect(projection.workers.claude.state).toBe("waiting_user_input");
    expect(store.events(runId).filter((event) => event.type === "work_claimed")).toHaveLength(0);
    store.close();
  });
});
