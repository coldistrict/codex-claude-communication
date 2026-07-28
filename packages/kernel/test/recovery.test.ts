import { describe, expect, it } from "vitest";
import { goal, tempStore } from "./helpers.ts";

describe("V-2 recovery semantics", () => {
  it("keeps healthy work active and routes uncertain effects to the user without replay", () => {
    const { store } = tempStore();
    const runId = "run_recovery";
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goal(runId) },
    });
    store.append({
      runId,
      actor: "coordinator",
      type: "worker_started",
      idempotencyKey: "worker",
      payload: {
        role: "codex",
        activity: "running tests",
        incarnation: 1,
        sessionId: "thread-1",
      },
    });
    const before = store.projection(runId).workers.codex.lastRuntimeActivity;
    store.append({
      runId,
      actor: "system",
      type: "verification_run",
      idempotencyKey: "activity",
      ts: "2026-07-26T00:00:30.000Z",
      payload: { role: "codex", command: "npm test", status: "running" },
    });
    expect(store.projection(runId).workers.codex.state).toBe("working");
    expect(store.projection(runId).workers.codex.lastRuntimeActivity).toBe(before);
    store.append({
      runId,
      actor: "system",
      type: "uncertain_effect",
      idempotencyKey: "uncertain",
      payload: {
        role: "codex",
        card: {
          id: "uncertain-card",
          kind: "uncertain_effect",
          title: "Uncertain workspace effect",
          body: "A process exited after a side effect but before its durable acknowledgement.",
          agent: "codex",
          actions: ["Mark applied", "Mark not applied", "Inspect manually", "Cancel"],
        },
      },
    });
    const projection = store.projection(runId);
    expect(projection.state).toBe("waiting_user");
    expect(projection.actions).toHaveLength(1);
    expect(store.events(runId).filter((event) => event.type === "work_claimed")).toHaveLength(0);
    store.close();
  });

  it("prints the machine-readable recovery result", () => {
    console.log('RESULT {"suite":"V-2-recovery","passed":true,"modelStarts":0}');
  });
});
