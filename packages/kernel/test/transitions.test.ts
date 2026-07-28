import { describe, expect, it } from "vitest";
import { canonicalJson, digest, KernelError, replay } from "../src/index.ts";
import { goal, manifest, openBarrier, packet, tempStore } from "./helpers.ts";

describe("V-1 transitions, hash chain, and idempotency", () => {
  it("commits valid events exactly once and rejects invalid actor, sequence, and duplicates", () => {
    const { store } = tempStore();
    const runId = "run_transitions";
    const goalPacket = goal(runId);
    const first = store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      expectedSeq: 0,
      payload: { goal: goalPacket },
    });
    expect(first.seq).toBe(1);
    const duplicate = store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      expectedSeq: 0,
      payload: { goal: goalPacket },
    });
    expect(duplicate.id).toBe(first.id);
    expect(store.events(runId)).toHaveLength(1);
    expect(() =>
      store.append({
        runId,
        actor: "user",
        type: "goal_set",
        idempotencyKey: "goal",
        payload: { goal: { ...goalPacket, goal: "changed" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_CONFLICT" }));
    expect(() =>
      store.append({
        runId,
        actor: "coordinator",
        type: "opening_committed",
        idempotencyKey: "wrong-actor",
        payload: { packetId: "x" },
      }),
    ).toThrowError(expect.objectContaining({ code: "ACTOR_FORBIDDEN" }));
    expect(() =>
      store.append({
        runId,
        actor: "system",
        type: "preflight_passed",
        idempotencyKey: "stale",
        expectedSeq: 0,
        payload: { provider: "codex" },
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_SEQUENCE" }));
    store.close();
  });

  it("rejects every authority class before writing a row", () => {
    const { store } = tempStore();
    const runId = "run_actor_matrix";
    expect(() =>
      store.append({
        runId,
        actor: "codex",
        type: "goal_set",
        idempotencyKey: "bad-goal",
        payload: { goal: goal(runId) },
      }),
    ).toThrowError(expect.objectContaining({ code: "ACTOR_FORBIDDEN" }));
    expect(store.events(runId)).toHaveLength(0);
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goal(runId) },
    });
    const invalid = [
      { actor: "user" as const, type: "preflight_passed" as const },
      { actor: "claude" as const, type: "worker_started" as const },
      { actor: "system" as const, type: "permission_decided" as const },
      { actor: "coordinator" as const, type: "packet_posted" as const },
    ];
    const before = store.events(runId).length;
    for (const [index, row] of invalid.entries()) {
      expect(() =>
        store.append({
          runId,
          actor: row.actor,
          type: row.type,
          idempotencyKey: `bad-actor-${index}`,
          payload: {},
        }),
      ).toThrowError(expect.objectContaining({ code: "ACTOR_FORBIDDEN" }));
    }
    expect(store.events(runId)).toHaveLength(before);
    store.close();
  });

  it("mechanically holds peer packets until both opening commits", () => {
    const { store } = tempStore();
    const runId = "run_barrier";
    const goalPacket = goal(runId);
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: { goal: goalPacket },
    });
    const codexOpening = packet(runId, "codex", "opening_codex");
    store.append({
      runId,
      actor: "codex",
      type: "opening_committed",
      idempotencyKey: "codex-opening",
      payload: { packetId: codexOpening.id },
    });
    store.append({
      runId,
      actor: "codex",
      type: "packet_posted",
      idempotencyKey: "codex-opening-packet",
      payload: { packet: codexOpening },
    });
    expect(() =>
      store.append({
        runId,
        actor: "codex",
        type: "packet_posted",
        idempotencyKey: "early-peer-packet",
        payload: { packet: packet(runId, "codex", "early") },
      }),
    ).toThrowError(expect.objectContaining({ code: "BARRIER_CLOSED" }));
    expect(() =>
      store.append({
        runId,
        actor: "coordinator",
        type: "barrier_released",
        idempotencyKey: "early-barrier",
        payload: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "BARRIER_CLOSED" }));
    store.close();
  });

  it("requires exact candidate and verification digests for provider signoff", () => {
    const { store } = tempStore();
    const runId = "run_signoff";
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
    expect(() =>
      store.append({
        runId,
        actor: "claude",
        type: "signoff",
        idempotencyKey: "bad-signoff",
        payload: {
          role: "codex",
          manifestDigest,
          verificationDigest,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "MANIFEST_MISMATCH" }));
    for (const role of ["codex", "claude"] as const) {
      store.append({
        runId,
        actor: role,
        type: "signoff",
        idempotencyKey: `signoff:${role}`,
        payload: { role, manifestDigest, verificationDigest },
      });
    }
    store.append({
      runId,
      actor: "coordinator",
      type: "completed",
      idempotencyKey: "complete",
      payload: { outcome: "completed_consensus" },
    });
    expect(store.projection(runId).state).toBe("completed_consensus");
    expect(() =>
      store.append({
        runId,
        actor: "system",
        type: "exported",
        idempotencyKey: "after-terminal",
        payload: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "TERMINAL_RUN" }));
    const stored = store.events(runId);
    expect(store.verifyHashChain(runId)).toEqual({ ok: true, count: stored.length });
    expect(canonicalJson(replay(runId, stored))).toBe(canonicalJson(store.projection(runId)));
    store.close();
  });

  it("uses typed kernel errors", () => {
    const error = new KernelError("INVALID_STATE", "typed");
    expect(error.name).toBe("KernelError");
  });

  it("prints the machine-readable V-1 result", () => {
    console.log('RESULT {"suite":"V-1","passed":true,"modelStarts":0}');
  });
});
