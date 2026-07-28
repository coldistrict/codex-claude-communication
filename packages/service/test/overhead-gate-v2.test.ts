import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, reportOverhead, type UsageRecord } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import {
  composeOverheadView,
  persistStableOverheadBreach,
} from "../src/overhead-notice.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collab-overhead-v2-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const store = new EventStore(join(root, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  const runId = coordinator.createRun(
    {
      goal: "Exercise the stable overhead breach notice.",
      workspace,
      mode: "real",
    },
    true,
  );
  return { store, coordinator, runId };
}

function failingRecord(): UsageRecord {
  // 2,000 attributed coordinator bytes over 1,000 tokens: S_lower <= 0, so
  // the report fails regardless of arm.
  return {
    provider: "codex",
    input: 1_000,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    classification: "mixed",
    coordinatorOwnedContent: "x".repeat(1_998),
    attributionComplete: true,
    uncaused: false,
    nestedUsageComplete: true,
  };
}

function passingRecord(): UsageRecord {
  return {
    provider: "claude",
    input: 500_000,
    cachedInput: 0,
    output: 1_000,
    reasoning: 0,
    classification: "mixed",
    coordinatorOwnedContent: "y".repeat(100),
    attributionComplete: true,
    uncaused: false,
    nestedUsageComplete: true,
  };
}

describe("overhead-gate-v2 stable breach notice is typed and non-blocking", () => {
  it("persists one notice per boundary without an action, interrupt, or state change", () => {
    const { store, runId } = fixture();
    expect(persistStableOverheadBreach(store, runId, "waiting_user_budget")).toBeNull();

    store.recordUsage(runId, "codex:opening:work_1", failingRecord());
    expect(reportOverhead(store.usageRecords(runId)).passed).toBe(false);
    const stateBefore = store.projection(runId).state;
    const actionsBefore = store.projection(runId).actions.length;

    const notice = persistStableOverheadBreach(store, runId, "waiting_user_budget");
    expect(notice).not.toBeNull();
    expect(notice!.type).toBe("overhead_gate_breached");
    expect(notice!.actor).toBe("system");

    const projection = store.projection(runId);
    // Never needs_input, never waiting_user, never an ActionCard.
    expect(projection.state).toBe(stateBefore);
    expect(projection.actions.length).toBe(actionsBefore);
    expect(
      store.events(runId).filter((event) => event.type === "needs_input"),
    ).toHaveLength(0);
    expect(projection.overheadNotice).toMatchObject({
      boundary: "waiting_user_budget",
      gateVersion: "overhead-gate-v2",
      ratio: null,
      absoluteEligible: true,
    });

    // The same breach episode never records a duplicate notice.
    expect(persistStableOverheadBreach(store, runId, "waiting_user_budget")).toBeNull();
    expect(
      store
        .events(runId)
        .filter((event) => event.type === "overhead_gate_breached"),
    ).toHaveLength(1);
    store.close();
  });

  it("persists nothing when the report passes and nothing after a terminal event", () => {
    const passing = fixture();
    passing.store.recordUsage(passing.runId, "claude:review:work_1", passingRecord());
    expect(reportOverhead(passing.store.usageRecords(passing.runId)).passed).toBe(true);
    expect(
      persistStableOverheadBreach(passing.store, passing.runId, "cancellation"),
    ).toBeNull();
    passing.store.close();

    const terminal = fixture();
    terminal.store.recordUsage(terminal.runId, "codex:opening:work_1", failingRecord());
    terminal.store.append({
      runId: terminal.runId,
      actor: "user",
      type: "cancelled",
      idempotencyKey: "cancel:test",
      payload: {},
    });
    expect(
      persistStableOverheadBreach(terminal.store, terminal.runId, "cancellation"),
    ).toBeNull();
    terminal.store.close();
  });

  it("persists the notice before user cancellation and survives into the terminal projection", async () => {
    const { store, coordinator, runId } = fixture();
    store.recordUsage(runId, "codex:opening:work_1", failingRecord());
    await coordinator.cancelRun(runId);
    const projection = store.projection(runId);
    expect(projection.state).toBe("cancelled");
    expect(projection.overheadNotice).toMatchObject({ boundary: "cancellation" });
    expect(projection.actions).toHaveLength(0);
    const events = store.events(runId);
    const noticeSeq = events.find((event) => event.type === "overhead_gate_breached")!.seq;
    const cancelledSeq = events.find((event) => event.type === "cancelled")!.seq;
    expect(noticeSeq).toBeLessThan(cancelledSeq);
    store.close();
  });
});

describe("active gate results render as provisional and stale styling clears", () => {
  it("marks an active run provisional and a terminal run final", async () => {
    const { store, coordinator, runId } = fixture();
    expect(composeOverheadView(store.projection(runId), [])).toBeNull();

    store.recordUsage(runId, "codex:opening:work_1", failingRecord());
    const active = composeOverheadView(
      store.projection(runId),
      store.usageRecords(runId),
    );
    expect(active).toMatchObject({
      passed: false,
      provisional: true,
      gateVersion: "overhead-gate-v2",
      passedBy: null,
    });

    await coordinator.cancelRun(runId);
    const terminal = composeOverheadView(
      store.projection(runId),
      store.usageRecords(runId),
    );
    expect(terminal).toMatchObject({ passed: false, provisional: false });
    store.close();
  });

  it("clears provisional failing styling when later useful work repairs the report", () => {
    const { store, runId } = fixture();
    store.recordUsage(runId, "codex:opening:work_1", failingRecord());
    const failing = composeOverheadView(
      store.projection(runId),
      store.usageRecords(runId),
    );
    expect(failing).toMatchObject({ passed: false, provisional: true });

    // Later useful work repairs the ratio; the same live computation now
    // passes, so the provisional warning styling has nothing to attach to.
    store.recordUsage(runId, "claude:review:work_2", passingRecord());
    const repaired = composeOverheadView(
      store.projection(runId),
      store.usageRecords(runId),
    );
    expect(repaired).toMatchObject({
      passed: true,
      passedBy: "ratio",
      provisional: true,
    });
    expect(persistStableOverheadBreach(store, runId, "waiting_user_budget")).toBeNull();
    store.close();
  });

  it("prints the machine-readable result", () => {
    console.log(
      'RESULT {"suite":"overhead-gate-v2-notice","passed":true,"modelStarts":0}',
    );
  });
});
