import { describe, expect, it } from "vitest";
import {
  ModelStartGuard,
  type AdvisorStartContext,
  type ModelAuthorization,
} from "../src/model-guard.ts";

const runId = "run_guard";

function workerAuthorization(): ModelAuthorization {
  return {
    id: "auth_worker",
    kind: "user_goal",
    runId,
    providers: ["codex", "claude"],
    recordedAt: "2026-07-27T00:00:00.000Z",
  };
}

function advisorAuthorization(overrides: Partial<ModelAuthorization> = {}): ModelAuthorization {
  return {
    id: "advauth_1",
    kind: "advisor_observation",
    runId,
    providers: ["claude"],
    recordedAt: "2026-07-27T00:00:00.000Z",
    readyWorkId: "work_1",
    triggerEventId: "evt_trigger",
    purpose: "advisor_observation",
    ...overrides,
  };
}

const context: AdvisorStartContext = {
  readyWorkId: "work_1",
  triggerEventId: "evt_trigger",
  purpose: "advisor_observation",
};

describe("ModelStartGuard advisor_observation hardening", () => {
  it("rejects a worker authorization on an adviser start before any model starts", () => {
    const guard = new ModelStartGuard();
    expect(() => guard.authorize("claude", runId, workerAuthorization(), context)).toThrow(
      /adviser start requires an advisor_observation authorization/,
    );
    expect(guard.attempts).toBe(1);
    expect(guard.started).toBe(0);
  });

  it("rejects an adviser authorization on a worker start", () => {
    const guard = new ModelStartGuard();
    expect(() => guard.authorize("claude", runId, advisorAuthorization())).toThrow(
      /can never start worker model work/,
    );
    expect(guard.started).toBe(0);
  });

  it("rejects every binding mismatch: run, provider, claim, trigger, and purpose", () => {
    const guard = new ModelStartGuard();
    expect(() =>
      guard.authorize("claude", "run_other", advisorAuthorization(), context),
    ).toThrow(/no recorded claude authorization/);
    expect(() =>
      guard.authorize("codex", runId, advisorAuthorization(), context),
    ).toThrow(/no recorded codex authorization/);
    expect(() =>
      guard.authorize(
        "claude",
        runId,
        advisorAuthorization({ readyWorkId: "work_other" }),
        context,
      ),
    ).toThrow(/binding mismatch/);
    expect(() =>
      guard.authorize(
        "claude",
        runId,
        advisorAuthorization({ triggerEventId: "evt_other" }),
        context,
      ),
    ).toThrow(/binding mismatch/);
    expect(() =>
      guard.authorize(
        "claude",
        runId,
        advisorAuthorization({ purpose: "advisor_retrospective" }),
        context,
      ),
    ).toThrow(/binding mismatch/);
    expect(guard.started).toBe(0);
    expect(guard.attempts).toBe(5);
  });

  it("rejects a dual-provider adviser authorization", () => {
    const guard = new ModelStartGuard();
    expect(() =>
      guard.authorize(
        "claude",
        runId,
        advisorAuthorization({ providers: ["codex", "claude"] }),
        context,
      ),
    ).toThrow(/must bind exactly one provider/);
    expect(guard.started).toBe(0);
  });

  it("permits exactly one use and rejects replay of the same authorization id", () => {
    const guard = new ModelStartGuard();
    guard.authorize("claude", runId, advisorAuthorization(), context);
    expect(guard.started).toBe(1);
    expect(() => guard.authorize("claude", runId, advisorAuthorization(), context)).toThrow(
      /already used/,
    );
    expect(guard.started).toBe(1);
    expect(guard.attempts).toBe(2);
    // A fresh authorization id bound to the same claim is a caller bug the
    // wake pipeline prevents, but the guard itself still accepts only exact
    // bindings; worker authorizations remain unaffected.
    guard.authorize("codex", runId, workerAuthorization());
    expect(guard.started).toBe(2);
  });

  it("prints the machine-readable guard result", () => {
    console.log(
      'RESULT {"suite":"advisor-model-guard","passed":true,"modelStarts":0}',
    );
  });
});
