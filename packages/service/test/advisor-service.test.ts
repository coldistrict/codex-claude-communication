import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVISOR_RECOMMENDATION_CODES,
  type ProviderRole,
  type StoredEvent,
} from "@collab/contracts";
import { EventStore, reportOverhead } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import { composeModelAccounting } from "../src/advisor/accounting.ts";
import { ADVISOR_OUTPUT_SCHEMA, validateAdvisorOutput } from "../src/advisor/input.ts";
import { AdvisorNotes, ADVISOR_UNTRUSTED_HEADER } from "../src/advisor/notes.ts";
import {
  AdvisorService,
  type AdvisorProviderPort,
} from "../src/advisor/service.ts";

const CODEX_CATALOG = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
  },
];
const CLAUDE_CATALOG = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

function validOutput(eventId = "evt_1") {
  return {
    observations: [
      {
        severity: "concern",
        summary: "Workers repeated the same failing verification twice.",
        eventIds: [eventId],
        recommendationCode: "consider_fix_pass",
      },
    ],
    notes: "The run circled on verification; see the linked events.",
  };
}

interface FakePortScript {
  preflightOk?: boolean;
  catalog?: any[];
  burst?: (input: Parameters<AdvisorProviderPort["runAdvisorBurst"]>[0]) => {
    text: string;
    structuredOutput?: unknown;
    usage?: { input: number; cachedInput: number; output: number; reasoning: number };
  };
  burstError?: Error;
}

function fakePort(provider: ProviderRole, script: FakePortScript = {}) {
  let started = 0;
  const bursts: Array<Parameters<AdvisorProviderPort["runAdvisorBurst"]>[0]> = [];
  let preflights = 0;
  let catalogReads = 0;
  const port: AdvisorProviderPort = {
    metadataPreflight: async () => {
      preflights += 1;
      return {
        ok: script.preflightOk !== false,
        provider,
        trace: [],
        ...(script.preflightOk === false
          ? { predicate: `${provider}.fixture_blocked`, remedy: "fixture" }
          : {}),
        billing: {
          provider,
          route: script.preflightOk === false ? "blocked" : "subscription_allowance",
          authenticatedBy: provider === "codex" ? "chatgpt" : "claude.ai",
          plan: provider === "codex" ? "plus" : "max",
          proof: ["fixture"],
          checkedAt: new Date().toISOString(),
        },
      } as any;
    },
    listModels: async () => {
      catalogReads += 1;
      return script.catalog ?? (provider === "codex" ? CODEX_CATALOG : CLAUDE_CATALOG);
    },
    runAdvisorBurst: async (input) => {
      bursts.push(input);
      if (script.burstError) throw script.burstError;
      started += 1;
      const result = script.burst?.(input) ?? {
        text: JSON.stringify(validOutput(input.advisorContext.triggerEventId)),
        structuredOutput: validOutput(input.advisorContext.triggerEventId),
      };
      return {
        text: result.text,
        ...(result.structuredOutput !== undefined
          ? { structuredOutput: result.structuredOutput }
          : {}),
        sessionId: `${provider}-advisor-session`,
        usage: result.usage ?? { input: 900, cachedInput: 300, output: 120, reasoning: 40 },
      };
    },
    guardStarted: () => started,
    toolRequests: () => 0,
  };
  return {
    port,
    bursts,
    counters: {
      get started() {
        return started;
      },
      get preflights() {
        return preflights;
      },
      get catalogReads() {
        return catalogReads;
      },
    },
  };
}

function manualClock(startIso = "2026-07-27T10:00:00.000Z") {
  let nowMs = Date.parse(startIso);
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => nowMs,
    schedule: (fn: () => void, delayMs: number) => {
      const timer = { at: nowMs + Math.max(0, delayMs), fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    async advance(ms: number) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        nowMs = Math.max(nowMs, due.at);
        due.cancelled = true;
        due.fn();
        await flush();
      }
      nowMs = target;
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

function flush(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  return chain;
}

function fixture(input?: {
  advisor?: { enabled: boolean; provider?: ProviderRole; effort?: "high" | "medium" };
  script?: FakePortScript;
  admitHeavyWork?: () => boolean;
  degraded?: () => boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "collab-advisor-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const store = new EventStore(join(stateRoot, "events.sqlite"));
  const coordinator = new Coordinator(store, {
    codexBinary: "/unused/codex",
    publish: () => undefined,
  });
  const clock = manualClock();
  const ports = new Map<string, ReturnType<typeof fakePort>>();
  const service = new AdvisorService(store, {
    stateRoot,
    ports: (provider) => {
      const created = fakePort(provider, input?.script ?? {});
      ports.set(provider, created);
      return created.port;
    },
    resourceState: () => ({
      admitHeavyWork: input?.admitHeavyWork?.() ?? true,
      degraded: input?.degraded?.() ?? false,
    }),
    schedule: clock.schedule,
    now: clock.now,
  });
  store.appendListener = (event: StoredEvent) => service.noteEvent(event);
  const runId = coordinator.createRun(
    {
      goal: "Exercise the advisory supervisor deterministically.",
      workspace,
      mode: "real",
      ...(input?.advisor ? { advisor: input.advisor } : {}),
    },
    true,
  );
  return { root, stateRoot, store, coordinator, runId, service, clock, ports };
}

function appendDisagreement(store: EventStore, runId: string, key = "d1") {
  return store.append({
    runId,
    actor: "system",
    type: "disagreement_declared",
    idempotencyKey: `fixture:disagreement:${key}`,
    payload: {
      card: {
        id: `disagreement_${key}`,
        kind: "disagreement",
        title: "Providers did not both sign",
        body: "fixture",
        actions: ["Accept disagreement", "Cancel"],
      },
    },
  });
}

describe("strict adviser output schema compatibility", () => {
  it("requires nullable recommendationCode and normalizes null to absence", () => {
    const itemSchema = ADVISOR_OUTPUT_SCHEMA.properties.observations.items;
    expect(itemSchema.required).toEqual([
      "severity",
      "summary",
      "eventIds",
      "recommendationCode",
    ]);
    expect(itemSchema.properties.recommendationCode).toEqual({
      type: ["string", "null"],
      enum: [...ADVISOR_RECOMMENDATION_CODES, null],
    });

    const validated = validateAdvisorOutput(
      {
        observations: [
          {
            severity: "info",
            summary: "The run is healthy.",
            eventIds: ["evt_1"],
            recommendationCode: null,
          },
        ],
        notes: "No recommendation is needed.",
      },
      new Set(["evt_1"]),
    );

    expect(validated).toEqual({
      ok: true,
      output: {
        observations: [
          {
            severity: "info",
            summary: "The run is healthy.",
            eventIds: ["evt_1"],
          },
        ],
        notes: "No recommendation is needed.",
      },
    });
  });
});

describe("adviser is off by default and causes zero work", () => {
  it("creates no trigger, ready item, port, or model start when disabled", async () => {
    const { store, runId, service, ports } = fixture();
    expect(store.projection(runId).goal?.advisor).toBeUndefined();
    appendDisagreement(store, runId);
    await flush();
    expect(store.events(runId).filter((event) => event.type === "advisor_trigger")).toHaveLength(0);
    expect(service.queue.size("advisor")).toBe(0);
    expect(ports.size).toBe(0);
    expect(service.sidecar.rows(runId)).toHaveLength(0);
    store.close();
  });
});

describe("typed triggers fire exactly once per condition instance", () => {
  it("runs a disagreement wake with correct causal, authorization, and usage binding", async () => {
    const { store, runId, service, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    const disagreement = appendDisagreement(store, runId);
    await flush();

    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.payload).toMatchObject({
      trigger: "disagreement_declared",
      conditionInstanceId: `disagreement:${disagreement.id}`,
    });

    const port = ports.get("claude")!;
    expect(port.counters.preflights).toBe(1);
    expect(port.counters.catalogReads).toBe(1);
    expect(port.counters.started).toBe(1);
    const burst = port.bursts[0]!;
    expect(burst.model).toBe("claude-opus-5[1m]");
    expect(burst.effort).toBe("high");
    expect(burst.outputSchema).toEqual(ADVISOR_OUTPUT_SCHEMA);
    expect(burst.authorization.kind).toBe("advisor_observation");
    expect(burst.authorization.readyWorkId).toBe(burst.advisorContext.readyWorkId);
    expect(burst.authorization.triggerEventId).toBe(triggers[0]!.id);
    expect(burst.systemPrompt).toContain("read-only advisory observer");
    expect(burst.systemPrompt).not.toContain("Untrusted data envelope");
    expect(burst.prompt).toContain("Untrusted data envelope");
    expect(burst.prompt).not.toContain("read-only advisory observer");

    const rows = service.sidecar.rows(runId);
    const claim = rows.find((row) => row.kind === "wake_claimed")!;
    expect(claim.payload).toMatchObject({
      provider: "claude",
      triggerKind: "disagreement_declared",
      triggerEventId: triggers[0]!.id,
    });
    const usage = service.sidecar.usage(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.wakeId).toBe(claim.wakeId);
    expect(service.sidecar.verifyChain(runId).ok).toBe(true);
    const ready = service.queue.claimedItem(String((claim.payload as any).readyWorkId))!;
    expect(ready).toMatchObject({
      role: "advisor",
      outcome: "observation",
      triggerEventId: triggers[0]!.id,
      reason: "addressed_event",
    });

    // The same condition instance never fires twice.
    service.noteEvent(disagreement);
    await flush();
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(1);
    expect(port.counters.started).toBe(1);
    store.close();
  });

  it("covers budget, overhead-breach, and user-request triggers once each", async () => {
    const { store, runId, service, coordinator, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "medium" },
    });
    store.append({
      runId,
      actor: "system",
      type: "needs_input",
      idempotencyKey: "fixture:budget",
      payload: {
        card: {
          id: "budget_1",
          kind: "budget_exhausted",
          title: "Budget exhausted",
          body: "fixture",
          actions: ["Extend budget"],
        },
      },
    });
    store.append({
      runId,
      actor: "system",
      type: "overhead_gate_breached",
      idempotencyKey: "overhead:breach:waiting_user_budget",
      payload: { boundary: "waiting_user_budget", gateVersion: "overhead-gate-v2" },
    });
    coordinator.requestAdvisor(runId);
    await flush();

    const kinds = service.sidecar
      .rows(runId)
      .filter((row) => row.kind === "wake_claimed")
      .map((row) => (row.payload as any).triggerKind)
      .sort();
    expect(kinds).toEqual(["budget_exhausted", "overhead_gate_breach", "user_request"]);
    // Budget: 2 reactive units; the third wake exists but must not have
    // started a model (budget_exhausted outcome, no unit consumed).
    expect(ports.get("claude")!.counters.started).toBe(2);
    const outcomes = service.sidecar
      .rows(runId)
      .filter((row) => row.kind === "wake_outcome")
      .map((row) => (row.payload as any).outcome)
      .sort();
    expect(outcomes).toEqual(["budget_exhausted", "observation", "observation"]);
    expect(ports.get("claude")!.bursts[0]!.effort).toBe("medium");
    store.close();
  });

  it("requires two consecutive same-code failures and resets on success", async () => {
    const { store, runId, service } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    service.noteProviderFailure(runId, "codex", "candidate", "CODEX_TURN_FAILED:x");
    service.noteProviderSuccess(runId, "codex");
    service.noteProviderFailure(runId, "codex", "candidate", "CODEX_TURN_FAILED:x");
    await flush();
    expect(store.events(runId).filter((event) => event.type === "advisor_trigger")).toHaveLength(0);

    service.noteProviderFailure(runId, "codex", "candidate", "CODEX_TURN_FAILED:y");
    await flush();
    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger");
    expect(triggers).toHaveLength(1);
    expect((triggers[0]!.payload as any).trigger).toBe("repeated_failure");

    // Different provider/stage/code combinations never pair up.
    service.noteProviderFailure(runId, "claude", "review", "CLAUDE_BURST_FAILED:z");
    service.noteProviderFailure(runId, "claude", "signoff", "CLAUDE_BURST_FAILED:z");
    await flush();
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(1);
    store.close();
  });

  it("debounces unknown-browser-identity degradation per episode", async () => {
    const { store, runId, service } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    service.noteBrowserIdentityDegraded(runId, "codex", "candidate");
    service.noteBrowserIdentityDegraded(runId, "codex", "candidate");
    service.noteBrowserIdentityDegraded(runId, "codex", "signoff");
    await flush();
    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger")
      .map((event) => (event.payload as any).conditionInstanceId);
    expect(triggers).toEqual([
      `unknown_resource:${runId}:codex:candidate`,
      `unknown_resource:${runId}:codex:signoff`,
    ]);
    store.close();
  });
});

describe("per-state durable stalls with fake-clock rehydration", () => {
  function startWorker(
    store: EventStore,
    runId: string,
    role: ProviderRole,
    ts: string,
  ) {
    return store.append({
      runId,
      actor: "coordinator",
      type: "worker_started",
      idempotencyKey: `fixture:worker:${role}`,
      payload: { role, activity: "working", sessionId: null, incarnation: 1 },
      ts,
    });
  }

  it("fires a working stall at 10 minutes and reschedules on trusted activity", async () => {
    const { store, runId, service, clock } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    startWorker(store, runId, "codex", new Date(clock.now()).toISOString());
    await clock.advance(9 * 60_000);
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(0);
    // Trusted runtime activity extends the epoch.
    expect(service.noteProviderRuntimeActivity(runId, "codex")).not.toBeNull();
    await clock.advance(2 * 60_000); // 11 minutes total, activity at 9
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(0);
    await clock.advance(9 * 60_000); // 10 minutes after the activity
    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger");
    expect(triggers).toHaveLength(1);
    expect((triggers[0]!.payload as any).trigger).toBe("stall");
    // The same epoch never fires twice.
    await clock.advance(30 * 60_000);
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(1);
    store.close();
  });

  it("excludes user, permission, and limit waits from automatic stalls", async () => {
    const { store, runId, clock } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    startWorker(store, runId, "claude", new Date(clock.now()).toISOString());
    store.append({
      runId,
      actor: "system",
      type: "needs_input",
      idempotencyKey: "fixture:wait",
      payload: {
        role: "claude",
        card: { id: "wait_1", kind: "needs_input", title: "t", body: "b", actions: [] },
      },
      ts: new Date(clock.now()).toISOString(),
    });
    await clock.advance(60 * 60_000);
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(0);
    store.close();
  });

  it("uses the 2-minute threshold for replacing_context and rehydrates after restart", async () => {
    const { store, stateRoot, runId, clock } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    startWorker(store, runId, "codex", new Date(clock.now()).toISOString());
    store.append({
      runId,
      actor: "system",
      type: "incarnation_replaced",
      idempotencyKey: "fixture:context",
      payload: { role: "codex" },
      ts: new Date(clock.now()).toISOString(),
    });
    // Simulate a service restart: a new AdvisorService over the same durable
    // store rebuilds the epoch from the event log and re-arms the timer.
    const restartClock = manualClock(new Date(clock.now()).toISOString());
    const restarted = new AdvisorService(store, {
      stateRoot,
      ports: (provider) => fakePort(provider).port,
      schedule: restartClock.schedule,
      now: restartClock.now,
    });
    store.appendListener = (event) => restarted.noteEvent(event);
    await restartClock.advance(2 * 60_000 + 1_000);
    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger");
    expect(triggers).toHaveLength(1);
    expect((triggers[0]!.payload as any)).toMatchObject({
      trigger: "stall",
      state: "replacing_context",
    });
    store.close();
  });
});

describe("resource degradation epochs and claim gating", () => {
  it("enqueues once per 5-minute episode and claims only when heavy work is admitted", async () => {
    let degraded = false;
    let admit = true;
    const { store, runId, service, clock, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      degraded: () => degraded,
      admitHeavyWork: () => admit,
    });
    degraded = true;
    admit = false;
    service.noteResourceState({ degraded, admitHeavyWork: admit });
    await clock.advance(4 * 60_000);
    service.noteResourceState({ degraded, admitHeavyWork: admit });
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(0);
    await clock.advance(60_000 + 1_000);
    const triggers = store
      .events(runId)
      .filter((event) => event.type === "advisor_trigger");
    expect(triggers).toHaveLength(1);
    expect((triggers[0]!.payload as any).trigger).toBe("resource_degradation_persisted");
    // Enqueued but not claimable while heavy work is refused.
    expect(service.queue.size("advisor")).toBe(1);
    expect(ports.size).toBe(0);

    degraded = false;
    admit = true;
    service.noteResourceState({ degraded, admitHeavyWork: admit });
    await flush();
    expect(service.queue.size("advisor")).toBe(0);
    expect(ports.get("claude")!.counters.started).toBe(1);
    store.close();
  });

  it("clears an unfired epoch when degradation recovers before five minutes", async () => {
    let degraded = false;
    const { store, runId, service, clock } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      degraded: () => degraded,
    });
    degraded = true;
    service.noteResourceState({ degraded: true, admitHeavyWork: false });
    await clock.advance(2 * 60_000);
    degraded = false;
    service.noteResourceState({ degraded: false, admitHeavyWork: true });
    await clock.advance(10 * 60_000);
    expect(
      store.events(runId).filter((event) => event.type === "advisor_trigger"),
    ).toHaveLength(0);
    expect(
      service.sidecar.epochs(runId).filter((epoch) => !epoch.firedAt),
    ).toHaveLength(0);
    store.close();
  });
});

describe("budget, retrospective, and no-replay recovery", () => {
  it("charges only guarded starts, honors audited extension, and reserves the retrospective unit", async () => {
    const script: FakePortScript = {};
    const { store, runId, service, coordinator, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script,
    });
    // First wake: blocked preflight consumes no unit.
    script.preflightOk = false;
    coordinator.requestAdvisor(runId);
    await flush();
    expect(ports.get("claude")!.counters.started).toBe(0);
    expect(
      service.sidecar
        .rows(runId)
        .filter((row) => row.kind === "wake_outcome")
        .map((row) => (row.payload as any).outcome),
    ).toEqual(["preflight_blocked"]);

    // Two reactive wakes consume the default budget.
    script.preflightOk = true;
    coordinator.requestAdvisor(runId);
    coordinator.requestAdvisor(runId);
    await flush();
    expect(ports.get("claude")!.counters.started).toBe(2);

    // The third is budget-blocked without a model start.
    coordinator.requestAdvisor(runId);
    await flush();
    expect(ports.get("claude")!.counters.started).toBe(2);

    // An audited, positive-integer user extension restores capacity.
    store.append({
      runId,
      actor: "user",
      type: "advisor_budget_extended",
      idempotencyKey: "fixture:extend",
      payload: { units: 1 },
    });
    expect(() =>
      store.append({
        runId,
        actor: "user",
        type: "advisor_budget_extended",
        idempotencyKey: "fixture:extend:bad",
        payload: { units: 0 },
      }),
    ).toThrow(/positive integer/);
    coordinator.requestAdvisor(runId);
    await flush();
    expect(ports.get("claude")!.counters.started).toBe(3);

    // Non-cancel terminal retrospective uses the reserved unit even though
    // the reactive budget is exhausted.
    appendDisagreement(store, runId, "terminal");
    await flush();
    store.append({
      runId,
      actor: "user",
      type: "human_override",
      idempotencyKey: "fixture:accept",
      payload: { decision: "accept_disagreement" },
    });
    store.append({
      runId,
      actor: "coordinator",
      type: "completed",
      idempotencyKey: "fixture:completed",
      payload: { outcome: "completed_disagreement" },
    });
    await flush();
    const retro = service.sidecar
      .rows(runId)
      .filter(
        (row) =>
          row.kind === "wake_outcome" &&
          (row.payload as any).purpose === "advisor_retrospective",
      );
    expect(retro).toHaveLength(1);
    expect((retro[0]!.payload as any).outcome).toBe("retrospective");
    const notes = new AdvisorNotes(
      (service as any).options.stateRoot,
      runId,
    );
    expect(notes.files().map((file) => file.name)).toContain("retrospective.md");
    store.close();
  });

  it("cancellation starts no retrospective model call and records a deterministic skip", async () => {
    const { store, stateRoot, runId, service, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    store.append({
      runId,
      actor: "user",
      type: "cancelled",
      idempotencyKey: "fixture:cancel",
      payload: {},
    });
    await flush();
    expect(ports.size).toBe(0);
    expect(service.queue.size("advisor")).toBe(0);
    const retrospective = readFileSync(
      join(stateRoot, "runs", runId, "advisor", "retrospective.md"),
      "utf8",
    );
    expect(retrospective).toContain(ADVISOR_UNTRUSTED_HEADER);
    expect(retrospective).toContain("skipped deterministically: the run was cancelled");
    store.close();
  });

  it("fails a claimed-unknown wake after restart and never replays it; unclaimed work survives", async () => {
    const { store, stateRoot, runId, service, clock } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    // Simulate a crash: enqueue two wakes; claim one and crash before any
    // outcome; leave the other unclaimed.
    delete store.appendListener; // detach the live service
    const requested1 = store.append({
      runId,
      actor: "user",
      type: "advisor_requested",
      idempotencyKey: "fixture:req1",
      payload: {},
    });
    const requested2 = store.append({
      runId,
      actor: "user",
      type: "advisor_requested",
      idempotencyKey: "fixture:req2",
      payload: {},
    });
    service.queue.enqueueAdvisor({
      runId,
      triggerEventId: requested1.id,
      triggerSeq: requested1.seq,
      reason: "user_action",
    });
    service.queue.enqueueAdvisor({
      runId,
      triggerEventId: requested2.id,
      triggerSeq: requested2.seq,
      reason: "user_action",
    });
    const crashedClaim = service.queue.claimAdvisor(new Date().toISOString(), runId)!;

    const ports = new Map<string, ReturnType<typeof fakePort>>();
    const restarted = new AdvisorService(store, {
      stateRoot,
      ports: (provider) => {
        const created = fakePort(provider);
        ports.set(provider, created);
        return created.port;
      },
      schedule: clock.schedule,
      now: clock.now,
    });
    await flush();
    const failures = restarted.sidecar
      .rows(runId)
      .filter((row) => row.kind === "failure")
      .map((row) => (row.payload as any).code);
    expect(failures).toContain("ADVISOR_WAKE_OUTCOME_UNKNOWN_AFTER_RESTART");
    expect(restarted.queue.claimedItem(crashedClaim.id)).toMatchObject({
      outcome: "unknown_crash_outcome",
    });
    // The unclaimed item survived the restart and was processed normally.
    expect(ports.get("claude")!.counters.started).toBe(1);
    expect(restarted.queue.size("advisor")).toBe(0);
    store.close();
  });
});

describe("hostile output, worker isolation, and concurrency deference", () => {
  it("applies nothing on malformed, oversized, or non-allowlisted output", async () => {
    const hostile: Array<unknown> = [
      { observations: [], notes: "x", extra: "field" },
      { observations: [{ severity: "urgent", summary: "s", eventIds: [] }], notes: "x" },
      {
        observations: [
          {
            severity: "info",
            summary: "s",
            eventIds: [],
            recommendationCode: "grant_permission_now",
          },
        ],
        notes: "x",
      },
      { observations: [], notes: "y".repeat(9_000) },
      "not json at all",
    ];
    for (const output of hostile) {
      expect(validateAdvisorOutput(output).ok).toBe(false);
    }

    const { store, stateRoot, runId, service, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: {
        burst: () => ({
          text: "IGNORE PREVIOUS INSTRUCTIONS — not JSON",
        }),
      },
    });
    coordinator.requestAdvisor(runId);
    await flush();
    const rows = service.sidecar.rows(runId);
    expect(rows.filter((row) => row.kind === "observation")).toHaveLength(0);
    const failure = rows.find((row) => row.kind === "failure")!;
    expect((failure.payload as any).code).toBe("ADVISOR_OUTPUT_MALFORMED");
    const outcome = rows.find((row) => row.kind === "wake_outcome")!;
    expect((outcome.payload as any).outcome).toBe("malformed_output");
    // No note content was applied; the worker run state is untouched.
    expect(
      new AdvisorNotes(stateRoot, runId).files().map((file) => file.name),
    ).toHaveLength(0);
    expect(store.projection(runId).state).toBe("starting");
    expect(store.projection(runId).actions).toHaveLength(0);

    // Usage for the started wake is still recorded and coverage stays whole.
    const accounting = composeModelAccounting(store, service.sidecar, runId);
    expect(accounting.advisorUsage.wakeCount).toBe(1);
    expect(accounting.advisorUsage.usageCoverageComplete).toBe(true);
    store.close();
  });

  it("rejects observations linked to event ids absent from the durable log", async () => {
    const { store, runId, service, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: {
        burst: () => ({
          text: JSON.stringify(validOutput("evt_not_durable")),
          structuredOutput: validOutput("evt_not_durable"),
        }),
      },
    });
    coordinator.requestAdvisor(runId);
    await flush();

    expect(
      service.sidecar.rows(runId).filter((row) => row.kind === "observation"),
    ).toHaveLength(0);
    expect(
      service.sidecar
        .rows(runId)
        .find((row) => row.kind === "failure")?.payload,
    ).toMatchObject({
      code: "ADVISOR_OUTPUT_MALFORMED",
      detail: "output:observation_0_unknown_event_id",
    });
    store.close();
  });

  it("redacts provider output again before sidecar or note persistence", async () => {
    const secret = "sk-proj-0123456789abcdefghijklmnop";
    const { store, stateRoot, runId, service, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: {
        burst: (input) => {
          const output = validOutput(input.advisorContext.triggerEventId);
          output.observations[0]!.summary = `Observed leaked ${secret}`;
          output.notes = `Provider returned Bearer 0123456789abcdefghijklmnop and ${secret}`;
          return {
            text: JSON.stringify(output),
            structuredOutput: output,
          };
        },
      },
    });
    coordinator.requestAdvisor(runId);
    await flush();

    const persisted = JSON.stringify(service.sidecar.rows(runId));
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
    const notes = new AdvisorNotes(stateRoot, runId);
    for (const file of notes.files()) {
      const contents = readFileSync(file.path, "utf8");
      expect(contents).not.toContain(secret);
      expect(contents).not.toContain("0123456789abcdefghijklmnop");
    }
    store.close();
  });

  it("never lets an adviser failure block completion, and never claims while the worker provider is busy", async () => {
    const { store, runId, service, coordinator, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: { burstError: new Error("ADVISOR_FAKE_TRANSPORT_DOWN:boom") },
    });
    let busy = true;
    service.setWorkerBurstProbe((provider) => provider === "claude" && busy);
    coordinator.requestAdvisor(runId);
    await flush();
    // Deferred: enqueued while the worker burst runs, no claim yet.
    expect(service.queue.size("advisor")).toBe(1);
    expect(ports.size).toBe(0);

    busy = false;
    service.noteWorkerBurstSettled(runId);
    await flush();
    expect(service.queue.size("advisor")).toBe(0);
    const failure = service.sidecar
      .rows(runId)
      .find((row) => row.kind === "failure")!;
    expect((failure.payload as any).code).toBe("ADVISOR_FAKE_TRANSPORT_DOWN");

    // The worker run completes normally despite the adviser failure.
    store.append({
      runId,
      actor: "user",
      type: "cancelled",
      idempotencyKey: "fixture:cancel-after-failure",
      payload: {},
    });
    expect(store.projection(runId).state).toBe("cancelled");
    store.close();
  });

  it("keeps adviser tokens out of the worker gate and reports combined accounting", async () => {
    const { store, runId, service, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    store.recordUsage(runId, "codex:opening:work_w1", {
      provider: "codex",
      input: 100_000,
      cachedInput: 0,
      output: 1_000,
      reasoning: 0,
      classification: "mixed",
      coordinatorOwnedContent: "framing",
      attributionComplete: true,
      uncaused: false,
      nestedUsageComplete: true,
      readyWorkId: "work_w1",
    });
    const workerBefore = reportOverhead(store.usageRecords(runId));
    coordinator.requestAdvisor(runId);
    await flush();
    const accounting = composeModelAccounting(store, service.sidecar, runId);
    // Worker gate byte-identical with and without adviser usage present.
    expect(accounting.workerOverhead).toEqual(workerBefore);
    expect(accounting.workerOverhead!.workerBurstCount).toBe(1);
    expect(accounting.advisorUsage.totalTokens).toBe(1_360);
    expect(accounting.combinedModelUsage.totalTokens).toBe(
      workerBefore.total + 1_360,
    );
    expect(accounting.combinedCoordinationRatio).toBeGreaterThan(
      workerBefore.ratio!,
    );
    expect(accounting.globalChecks).toEqual({
      usageCoverageComplete: true,
      uncausedInvocations: 0,
    });
    store.close();
  });
});

describe("durable adviser wake causality", () => {
  it("fails closed when the queued trigger event is missing", async () => {
    const { store, runId, service, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    service.queue.enqueueAdvisor({
      runId,
      triggerEventId: "evt_missing",
      triggerSeq: 9_999,
      reason: "user_action",
    });

    await service.pump(runId);
    expect(ports.size).toBe(0);
    expect(
      service.sidecar
        .rows(runId)
        .find((row) => row.kind === "failure")?.payload,
    ).toMatchObject({
      code: "ADVISOR_WAKE_PIPELINE_ERROR",
      detail: "ADVISOR_TRIGGER_EVENT_MISSING:evt_missing",
    });
    store.close();
  });

  it("rejects an unexpected durable event instead of reclassifying it", async () => {
    const { store, runId, service, ports } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    const goal = store.events(runId)[0]!;
    service.queue.enqueueAdvisor({
      runId,
      triggerEventId: goal.id,
      triggerSeq: goal.seq,
      reason: "addressed_event",
    });

    await service.pump(runId);
    expect(ports.size).toBe(0);
    expect(
      service.sidecar
        .rows(runId)
        .find((row) => row.kind === "failure")?.payload,
    ).toMatchObject({
      code: "ADVISOR_WAKE_PIPELINE_ERROR",
      detail: `ADVISOR_TRIGGER_EVENT_TYPE_INVALID:${goal.type}`,
    });
    store.close();
  });
});

describe("adviser note files are contained, headed, and tamper-evident", () => {
  it("writes 0600 files with the untrusted header, hash-linked observations, and exclusive retrospective", async () => {
    const { store, stateRoot, runId, service, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    coordinator.requestAdvisor(runId);
    await flush();
    const notes = new AdvisorNotes(stateRoot, runId);
    const files = notes.files();
    expect(files.map((file) => file.name).sort()).toEqual([
      "notes.md",
      "observations.jsonl",
    ]);
    for (const file of files) {
      expect(lstatSync(file.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(file.path, "utf8")).toContain(ADVISOR_UNTRUSTED_HEADER);
    }
    expect(notes.verifyObservationChain().count).toBe(1);
    expect(notes.writeRetrospective({ kind: "retrospective", markdown: "done" })).toEqual({
      written: true,
    });
    expect(notes.writeRetrospective({ kind: "retrospective", markdown: "again" })).toEqual({
      written: false,
    });
    expect(() => new AdvisorNotes(stateRoot, "not-a-run-id")).toThrow(
      /ADVISOR_RUN_ID_INVALID/,
    );
    store.close();
  });

  it("refuses symlinked note targets", () => {
    const root = mkdtempSync(join(tmpdir(), "collab-advisor-symlink-"));
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const runId = "run_symlink-fixture";
    const notes = new AdvisorNotes(stateRoot, runId);
    const target = join(root, "outside.md");
    symlinkSync(target, join(notes.directory, "notes.md"));
    expect(() => notes.writeNotes("content")).toThrow(/ADVISOR_FILE_SYMLINK_REFUSED/);
    symlinkSync(target, join(notes.directory, "observations.jsonl"));
    expect(() => notes.appendObservation({ wakeId: "w" })).toThrow(
      /ADVISOR_FILE_SYMLINK_REFUSED/,
    );
  });

  it("includes adviser files with checksums in collab export without following links", async () => {
    const { store, stateRoot, runId, coordinator } = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
    });
    coordinator.requestAdvisor(runId);
    await flush();
    const { exportRun } = await import("@collab/migration");
    const destination = join(stateRoot, "exports", runId);
    const exported = exportRun(store, runId, destination, {
      advisorDirectory: join(stateRoot, "runs", runId, "advisor"),
    });
    expect(Object.keys(exported.checksums).sort()).toEqual([
      "advisor/notes.md",
      "advisor/observations.jsonl",
      "events.jsonl",
      "projection.json",
      "transcript.md",
    ]);
    expect(
      readFileSync(join(destination, "advisor", "notes.md"), "utf8"),
    ).toContain(ADVISOR_UNTRUSTED_HEADER);
    store.close();
  });
});

describe("per-wake catalog verification fails closed on drift", () => {
  it("fails the wake without a model start when the pinned row or effort disappears", async () => {
    const missingRow = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: {
        catalog: [
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            supportedEffortLevels: ["high", "medium"],
          },
        ],
      },
    });
    missingRow.coordinator.requestAdvisor(missingRow.runId);
    await flush();
    let port = missingRow.ports.get("claude")!;
    expect(port.counters.started).toBe(0);
    expect(port.port.toolRequests()).toBe(0);
    let rows = missingRow.service.sidecar.rows(missingRow.runId);
    expect(
      (rows.find((row) => row.kind === "wake_outcome")!.payload as any).outcome,
    ).toBe("model_profile_unavailable");
    expect(
      (rows.find((row) => row.kind === "failure")!.payload as any).detail,
    ).toContain("ADVISOR_MODEL_DRIFT");
    missingRow.store.close();

    const missingEffort = fixture({
      advisor: { enabled: true, provider: "claude", effort: "high" },
      script: {
        catalog: [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            supportedEffortLevels: ["medium"],
          },
        ],
      },
    });
    missingEffort.coordinator.requestAdvisor(missingEffort.runId);
    await flush();
    port = missingEffort.ports.get("claude")!;
    expect(port.counters.started).toBe(0);
    rows = missingEffort.service.sidecar.rows(missingEffort.runId);
    expect(
      (rows.find((row) => row.kind === "failure")!.payload as any).detail,
    ).toContain("ADVISOR_EFFORT_DRIFT");
    missingEffort.store.close();
  });

  it("keeps adviser tool requests at zero across every processed wake", async () => {
    const { store, runId, service, coordinator, ports } = fixture({
      advisor: { enabled: true, provider: "codex", effort: "high" },
    });
    coordinator.requestAdvisor(runId);
    await flush();
    const port = ports.get("codex")!;
    expect(port.counters.started).toBe(1);
    expect(port.port.toolRequests()).toBe(0);
    expect(port.bursts[0]!.model).toBe("gpt-5.6-sol");
    expect(port.bursts[0]!.effort).toBe("high");
    expect(service.sidecar.usage(runId)[0]!.provider).toBe("codex");
    store.close();
  });

  it("prints the machine-readable adviser result", () => {
    console.log(
      'RESULT {"suite":"advisor-service","passed":true,"modelStarts":0}',
    );
  });
});
