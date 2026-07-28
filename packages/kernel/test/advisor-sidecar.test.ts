import { describe, expect, it } from "vitest";
import { digest, EventStore, AdvisorSidecar, ReadyQueue } from "../src/index.ts";

function goalPayload(runId: string) {
  const base = {
    goal: "Adviser sidecar fixture",
    workspace: "/tmp",
    constraints: [],
    authority: {
      writableRoots: ["/tmp"],
      network: "off" as const,
      permissionPreset: "default" as const,
    },
    completionEvidence: [],
    usefulWorkBudget: { perMaterialChallenge: 4, perProvider: 24 },
  };
  return {
    goal: {
      id: "goal_fixture",
      runId,
      ...base,
      digest: digest(base),
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

describe("ReadyRole separation: the adviser shares only the causal queue", () => {
  it("keeps worker and adviser enqueue/claim lanes mechanically apart", () => {
    const store = new EventStore(":memory:");
    const queue = new ReadyQueue(store.db);
    expect(() =>
      queue.enqueue({
        runId: "run_x",
        role: "advisor" as never,
        triggerEventId: "evt_1",
        triggerSeq: 1,
        reason: "addressed_event",
      }),
    ).toThrow(/Worker enqueue accepts provider roles only/);
    expect(() => queue.claim("advisor" as never)).toThrow(
      /Worker claim can never return adviser work/,
    );

    queue.enqueueAdvisor({
      runId: "run_x",
      triggerEventId: "evt_adv",
      triggerSeq: 2,
      reason: "addressed_event",
    });
    queue.enqueue({
      runId: "run_x",
      role: "codex",
      triggerEventId: "evt_worker",
      triggerSeq: 3,
      reason: "addressed_event",
    });
    // A worker claim never returns adviser work and vice versa.
    const workerClaim = queue.claim("codex");
    expect(workerClaim?.role).toBe("codex");
    expect(workerClaim?.triggerEventId).toBe("evt_worker");
    const advisorClaim = queue.claimAdvisor();
    expect(advisorClaim?.role).toBe("advisor");
    expect(advisorClaim?.triggerEventId).toBe("evt_adv");
    expect(queue.claimAdvisor()).toBeNull();
    expect(queue.claim("codex")).toBeNull();

    // Duplicate adviser triggers deduplicate durably.
    expect(
      queue.enqueueAdvisor({
        runId: "run_x",
        triggerEventId: "evt_adv",
        triggerSeq: 2,
        reason: "addressed_event",
      }),
    ).toBeNull();
    store.close();
  });

  it("records explicit completion and surfaces claimed-unknown adviser work", () => {
    const store = new EventStore(":memory:");
    const queue = new ReadyQueue(store.db);
    const item = queue.enqueueAdvisor({
      runId: "run_x",
      triggerEventId: "evt_adv",
      triggerSeq: 1,
      reason: "user_action",
    })!;
    expect(queue.unresolvedAdvisorClaims()).toHaveLength(0);
    queue.claimAdvisor();
    expect(queue.unresolvedAdvisorClaims().map((entry) => entry.id)).toEqual([item.id]);
    queue.complete(item.id, "observed");
    expect(queue.unresolvedAdvisorClaims()).toHaveLength(0);
    expect(queue.claimedItem(item.id)).toMatchObject({
      outcome: "observed",
      role: "advisor",
    });
    expect(() => queue.complete(item.id, "observed")).toThrow(/not an uncompleted/);
    store.close();
  });
});

describe("kernel adviser sidecar: hash-linked, terminal-safe, usage-unique", () => {
  it("appends a verifiable chain and detects tampering", () => {
    const store = new EventStore(":memory:");
    const sidecar = new AdvisorSidecar(store.db);
    sidecar.append("run_x", "wake_claimed", "wake_1", { provider: "claude" });
    sidecar.append("run_x", "observation", "wake_1", { summary: "ok" });
    sidecar.append("run_x", "wake_outcome", "wake_1", {
      outcome: "observation",
      modelStarted: true,
      purpose: "advisor_observation",
    });
    expect(sidecar.verifyChain("run_x")).toEqual({ ok: true, count: 3 });
    store.db
      .prepare("UPDATE advisor_ledger SET payload_json=? WHERE seq=2")
      .run('{"summary":"tampered"}');
    expect(() => sidecar.verifyChain("run_x")).toThrow(/hash chain failed/);
    store.close();
  });

  it("accepts sidecar appends after a terminal core event that the core log rejects", () => {
    const store = new EventStore(":memory:");
    const sidecar = new AdvisorSidecar(store.db);
    const runId = "run_terminal";
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: goalPayload(runId),
    });
    store.append({
      runId,
      actor: "user",
      type: "cancelled",
      idempotencyKey: "cancel",
      payload: {},
    });
    expect(() =>
      store.append({
        runId,
        actor: "system",
        type: "advisor_trigger",
        idempotencyKey: "late",
        payload: {},
      }),
    ).toThrow(/terminal/);
    // The non-cancel retrospective path records adviser output only here.
    const row = sidecar.append(runId, "observation", "wake_retro", {
      retrospective: true,
    });
    expect(row.seq).toBe(1);
    expect(sidecar.verifyChain(runId).count).toBe(1);
    store.close();
  });

  it("rejects every core-event authoring path for an adviser pseudo-actor", () => {
    const store = new EventStore(":memory:");
    const runId = "run_authority";
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: goalPayload(runId),
    });
    const attempts: Array<[string, unknown]> = [
      ["packet_posted", { packet: { from: "advisor" } }],
      ["opening_committed", { packetId: "pkt" }],
      ["candidate_posted", { manifest: {} }],
      ["signoff", { role: "advisor" }],
      ["goal_set", goalPayload(runId)],
      ["permission_decided", { cardId: "card" }],
      ["human_override", { cardId: "card" }],
      ["budget_extended", { units: 1 }],
      ["advisor_budget_extended", { units: 1 }],
      ["cancelled", {}],
      ["completed", { outcome: "completed_consensus" }],
      ["work_claimed", { role: "codex" }],
      ["barrier_released", {}],
      ["needs_input", { card: {} }],
      ["permission_requested", { card: {} }],
      ["disagreement_declared", { card: {} }],
      ["advisor_trigger", {}],
      ["runtime_activity", { role: "codex" }],
    ];
    for (const [type, payload] of attempts) {
      expect(() =>
        store.append({
          runId,
          actor: "advisor" as never,
          type: type as never,
          idempotencyKey: `advisor:${type}`,
          payload,
        }),
      ).toThrow(/ACTOR_FORBIDDEN|requires/);
    }
    store.close();
  });

  it("keys adviser usage uniquely by wake id and reports coverage honestly", () => {
    const store = new EventStore(":memory:");
    const sidecar = new AdvisorSidecar(store.db);
    const runId = "run_usage";
    sidecar.append(runId, "wake_claimed", "wake_1", { provider: "claude" });
    sidecar.append(runId, "wake_outcome", "wake_1", {
      outcome: "observation",
      modelStarted: true,
      purpose: "advisor_observation",
    });
    const usage = {
      runId,
      wakeId: "wake_1",
      provider: "claude" as const,
      input: 100,
      cachedInput: 50,
      output: 20,
      reasoning: 0,
      complete: true,
    };
    sidecar.recordUsage(usage);
    sidecar.recordUsage(usage); // identical duplicate delivery is idempotent
    expect(() => sidecar.recordUsage({ ...usage, input: 101 })).toThrow(
      /ADVISOR_USAGE_WAKE_REUSED/,
    );
    let report = sidecar.usageReport(runId);
    expect(report).toMatchObject({
      wakeCount: 1,
      usageRows: 1,
      usageCoverageComplete: true,
      uncausedWakes: 0,
      totalTokens: 170,
    });

    // A usage row without a claimed wake is uncaused; a started wake without
    // usage breaks coverage.
    sidecar.recordUsage({ ...usage, wakeId: "wake_forged" });
    report = sidecar.usageReport(runId);
    expect(report.uncausedWakes).toBe(1);
    sidecar.append(runId, "wake_claimed", "wake_2", { provider: "claude" });
    sidecar.append(runId, "wake_outcome", "wake_2", {
      outcome: "failure",
      modelStarted: true,
      purpose: "advisor_observation",
    });
    report = sidecar.usageReport(runId);
    expect(report.usageCoverageComplete).toBe(false);
    store.close();
  });

  it("prints the machine-readable sidecar result", () => {
    console.log(
      'RESULT {"suite":"advisor-sidecar","passed":true,"modelStarts":0}',
    );
  });
});
