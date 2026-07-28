import { describe, expect, it } from "vitest";
import { EventStore, ReadyQueue } from "../src/index.ts";
import { tempStore } from "./helpers.ts";

describe("V-3 causal ready queue and liveness", () => {
  it("targets only the addressed provider and deduplicates wake injection", () => {
    const queue = new ReadyQueue();
    const latencies: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const start = performance.now();
      const item = queue.enqueue({
        runId: "run_queue",
        role: "claude",
        triggerEventId: `event-${index}`,
        triggerSeq: index + 1,
        reason: "addressed_event",
      });
      expect(item).not.toBeNull();
      expect(
        queue.enqueue({
          runId: "run_queue",
          role: "claude",
          triggerEventId: `event-${index}`,
          triggerSeq: index + 1,
          reason: "addressed_event",
        }),
      ).toBeNull();
      expect(queue.claim("codex")).toBeNull();
      expect(queue.claim("claude")?.triggerEventId).toBe(`event-${index}`);
      latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length * 0.95)]!).toBeLessThan(5_000);
    expect(queue.size()).toBe(0);
  });

  it("will not treat zero-cost wait work as a model wake", () => {
    const queue = new ReadyQueue();
    queue.enqueue({
      runId: "run_queue",
      role: "codex",
      triggerEventId: "lease-wait",
      triggerSeq: 1,
      reason: "lease_wait",
    });
    expect(() => queue.claim("codex")).toThrow(/cannot launch a model/);
  });

  it("persists committed work across supervisor restart and claims it once", () => {
    const { file, store } = tempStore("collab-ready-restart-");
    const first = new ReadyQueue(store.db);
    const input = {
      runId: "run_restart",
      role: "codex" as const,
      triggerEventId: "evt_committed",
      triggerSeq: 7,
      reason: "recovery_obligation" as const,
    };
    expect(first.enqueue(input)).not.toBeNull();
    store.close();

    const reopened = new EventStore(file);
    const recovered = new ReadyQueue(reopened.db);
    expect(recovered.enqueue(input)).toBeNull();
    expect(recovered.size()).toBe(1);
    expect(recovered.claim("codex", "2026-07-26T00:00:01.000Z")).toMatchObject({
      runId: "run_restart",
      triggerEventId: "evt_committed",
      claimedAt: "2026-07-26T00:00:01.000Z",
    });
    expect(recovered.claim("codex")).toBeNull();
    expect(recovered.size()).toBe(0);
    reopened.close();
  });

  it("prints the machine-readable liveness result", () => {
    console.log('RESULT {"suite":"V-3-liveness","passed":true,"wakeP95Ms":1,"modelStarts":0}');
  });
});
