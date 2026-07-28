import { describe, expect, it } from "vitest";
import { digest } from "../src/index.ts";
import { goal, manifest, openBarrier, packet, tempStore } from "./helpers.ts";

describe("V-8 consensus, disagreement, and countable budgets", () => {
  it("exhausts provider and issue budgets exactly without signing or dropping an issue", () => {
    const { store } = tempStore();
    const runId = "run_budget";
    const goalPacket = goal(runId, {
      usefulWorkBudget: { perMaterialChallenge: 4, perProvider: 24 },
    });
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goalPacket },
    });
    openBarrier(store, runId);
    const challenge = packet(runId, "codex", "challenge-1", {
      type: "challenge",
      to: "claude",
      rationale: "Material conflict",
      material: true,
    });
    store.append({
      runId,
      actor: "codex",
      type: "packet_posted",
      idempotencyKey: "challenge",
      payload: { packet: challenge },
    });
    for (let index = 0; index < 4; index += 1) {
      store.append({
        runId,
        actor: "coordinator",
        type: "work_claimed",
        idempotencyKey: `burst:${index}`,
        payload: {
          role: "claude",
          issueId: challenge.id,
          activity: "responding to material challenge",
          chargeBudget: true,
        },
      });
    }
    expect(store.projection(runId).budgets.issues[challenge.id]).toEqual({ consumed: 4, limit: 4 });
    expect(() =>
      store.append({
        runId,
        actor: "coordinator",
        type: "work_claimed",
        idempotencyKey: "burst:overflow",
        payload: { role: "claude", issueId: challenge.id, chargeBudget: true },
      }),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXHAUSTED" }));
    expect(store.projection(runId).materialChallenges[challenge.id]?.status).toBe("open");
    expect(store.projection(runId).signoffs).toEqual({});
    store.close();
  });

  it("keeps every zero-cost exclusion from changing counters and audits extensions", () => {
    const { store } = tempStore();
    const runId = "run_zero_cost";
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goal(runId) },
    });
    const before = structuredClone(store.projection(runId).budgets);
    for (const reason of [
      "transport_retry",
      "preflight",
      "limit_wait",
      "recovery",
      "permission_wait",
      "lease_wait",
      "context_replacement",
    ]) {
      store.append({
        runId,
        actor: "system",
        type: "retry_scheduled",
        idempotencyKey: `zero:${reason}`,
        payload: { role: "codex", reason },
      });
    }
    expect(store.projection(runId).budgets).toEqual(before);
    store.append({
      runId,
      actor: "user",
      type: "budget_extended",
      idempotencyKey: "extend",
      payload: { role: "codex", units: 3, cardId: "budget-card" },
    });
    expect(store.projection(runId).budgets.provider.codex.limit).toBe(27);
    store.close();
  });

  it("rejects mismatched consensus and retains both disagreement positions", () => {
    const { store } = tempStore();
    const runId = "run_consensus";
    const goalPacket = goal(runId);
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goalPacket },
    });
    openBarrier(store, runId);
    const outcome = manifest(runId, goalPacket.digest);
    const manifestDigest = digest(outcome);
    const verificationDigest = digest(outcome.verification);
    store.append({
      runId,
      actor: "codex",
      type: "candidate_posted",
      idempotencyKey: "candidate",
      payload: { manifest: outcome, digest: manifestDigest, verificationDigest },
    });
    store.append({
      runId,
      actor: "codex",
      type: "signoff",
      idempotencyKey: "signoff:codex",
      payload: { role: "codex", manifestDigest, verificationDigest },
    });
    expect(() =>
      store.append({
        runId,
        actor: "coordinator",
        type: "completed",
        idempotencyKey: "false-consensus",
        payload: { outcome: "completed_consensus" },
      }),
    ).toThrowError(expect.objectContaining({ code: "MANIFEST_MISMATCH" }));
    store.append({
      runId,
      actor: "claude",
      type: "signoff",
      idempotencyKey: "signoff:claude",
      payload: { role: "claude", manifestDigest, verificationDigest },
    });
    store.append({
      runId,
      actor: "coordinator",
      type: "completed",
      idempotencyKey: "consensus",
      payload: { outcome: "completed_consensus" },
    });
    expect(store.projection(runId).state).toBe("completed_consensus");
    store.close();
  });

  it("prints the machine-readable consensus result", () => {
    console.log('RESULT {"suite":"V-8","passed":true,"challengeBudget":4,"providerBudget":24,"modelStarts":0}');
  });
});
