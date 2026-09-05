import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AdvisorConfig,
  AdvisorTriggerKind,
  ProviderRole,
  ReadyWorkItem,
  StoredEvent,
  WorkerStateName,
} from "@collab/contracts";
import { ADVISOR_TRIGGER_KINDS } from "@collab/contracts";
import {
  ClaudeAgentAdapter,
  CodexAppServerClient,
  ModelStartGuard,
  scrubProviderEnvironment,
  type AdvisorStartContext,
  type ModelAuthorization,
  type PreflightResult,
} from "@collab/adapters";
import {
  AdvisorSidecar,
  ReadyQueue,
  applyEvent,
  initialProjection,
  type EventStore,
} from "@collab/kernel";
import {
  ADVISOR_OUTPUT_SCHEMA,
  ADVISOR_RECOMMENDATION_COPY,
  buildAdvisorInput,
  validateAdvisorOutput,
} from "./input.ts";
import type { ProviderExecutionGate } from "./execution-gate.ts";
import { AdvisorNotes } from "./notes.ts";
import { resolveDefaultAdvisorProfile } from "./profile.ts";

/** Pinned per-state stall thresholds (milliseconds). */
export const STALL_THRESHOLDS_MS: Partial<Record<WorkerStateName, number>> = {
  working: 10 * 60_000,
  waiting_lease: 10 * 60_000,
  recovering: 2 * 60_000,
  replacing_context: 2 * 60_000,
};

export const RESOURCE_DEGRADATION_TRIGGER_MS = 5 * 60_000;
export const RUNTIME_ACTIVITY_COALESCE_MS = 30_000;
export const ADVISOR_WAKE_TIMEOUT_MS = 5 * 60_000;

export interface AdvisorProviderPort {
  metadataPreflight(): Promise<PreflightResult>;
  listModels(): Promise<any[]>;
  runAdvisorBurst(input: {
    runId: string;
    systemPrompt: string;
    prompt: string;
    model: string;
    effort: string;
    outputSchema: Record<string, unknown>;
    authorization: ModelAuthorization;
    advisorContext: AdvisorStartContext;
    timeoutMs: number;
    sessionId?: string;
  }): Promise<{
    text: string;
    structuredOutput?: unknown;
    sessionId?: string | null;
    usage: { input: number; cachedInput: number; output: number; reasoning: number };
  }>;
  guardStarted(): number;
  toolRequests(): number;
  close?(): Promise<void>;
}

export interface AdvisorServiceOptions {
  stateRoot: string;
  publish?: (runId: string) => void;
  resourceState?: () => { admitHeavyWork: boolean; degraded: boolean };
  /** Deterministic tests inject fake ports; production uses realAdvisorPorts. */
  ports: (provider: ProviderRole, runtimeDirectory: string) => AdvisorProviderPort;
  /** Injectable timer for fake-clock tests. Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
  /** Shared with the worker runner to make provider exclusion bidirectional. */
  executionGate?: ProviderExecutionGate;
}

interface WorkerEpoch {
  state: WorkerStateName;
  epochEventId: string;
  epochStartMs: number;
  lastActivityMs: number;
  cancelTimer?: () => void;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref?.();
  return () => clearTimeout(timer);
}

function normalizeFailureCode(message: string): string {
  return /^[A-Z0-9_]{3,80}/.exec(message)?.[0] ?? "UNTYPED_FAILURE";
}

/**
 * The advisory supervisor: typed, debounced, event-driven triggers; durable
 * epochs with restart-rehydrated timers (never polling); low-priority causal
 * wakes through the shared durable ready queue; and a kernel-sidecar-only
 * output surface. The adviser can never author a core event, packet,
 * candidate, signoff, goal change, billing change, permission, lease, or
 * worker message, and an adviser failure never fails, blocks, or
 * terminalizes the worker run.
 */
export class AdvisorService {
  readonly queue: ReadyQueue;
  readonly sidecar: AdvisorSidecar;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly now: () => number;
  private readonly workerEpochs = new Map<string, WorkerEpoch>();
  private readonly previousWorkerStates = new Map<string, WorkerStateName>();
  private readonly failureStreaks = new Map<
    string,
    { stage: string; code: string; count: number }
  >();
  private readonly browserDegradationEpisodes = new Set<string>();
  private readonly lastActivityAppend = new Map<string, number>();
  private readonly degradationTimers = new Map<string, () => void>();
  private readonly processing = new Set<string>();
  private readonly sessionByRun = new Map<string, string>();
  private readonly portByRun = new Map<string, AdvisorProviderPort>();
  private degradedSince: number | null = null;
  private workerBurstProbe: (provider: ProviderRole) => boolean = () => false;

  constructor(
    private readonly store: EventStore,
    private readonly options: AdvisorServiceOptions,
  ) {
    this.queue = new ReadyQueue(store.db);
    this.sidecar = new AdvisorSidecar(store.db);
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.rehydrate();
  }

  /** Set by the runner owner so adviser claims defer to active worker bursts. */
  setWorkerBurstProbe(probe: (provider: ProviderRole) => boolean): void {
    this.workerBurstProbe = probe;
  }

  /** Closes every provider port and cancels timers (service shutdown). */
  async shutdown(): Promise<void> {
    for (const [key, epoch] of this.workerEpochs) {
      epoch.cancelTimer?.();
      this.workerEpochs.delete(key);
    }
    for (const [key, cancel] of this.degradationTimers) {
      cancel();
      this.degradationTimers.delete(key);
    }
    for (const [runId, port] of this.portByRun) {
      this.portByRun.delete(runId);
      try {
        await port.close?.();
      } catch {
        // Shutdown best-effort; the adviser never blocks service close.
      }
    }
  }

  private config(runId: string): AdvisorConfig | null {
    const goal = this.store.projection(runId).goal;
    return goal?.advisor?.enabled ? goal.advisor : null;
  }

  // ---------------------------------------------------------------- events

  noteEvent(event: StoredEvent): void {
    const runId = event.runId;
    const config = this.config(runId);
    if (!config) return; // disabled adviser causes zero metadata/model work
    switch (event.type) {
      case "disagreement_declared":
        this.fireTrigger(runId, "disagreement_declared", `disagreement:${event.id}`, event);
        break;
      case "needs_input": {
        const kind = (event.payload as { card?: { kind?: string } }).card?.kind;
        if (kind === "budget_exhausted") {
          this.fireTrigger(runId, "budget_exhausted", `budget:${event.id}`, event);
        }
        break;
      }
      case "overhead_gate_breached":
        this.fireTrigger(
          runId,
          "overhead_gate_breach",
          `overhead:${String((event.payload as { boundary?: string }).boundary ?? "")}:${event.id}`,
          event,
        );
        break;
      case "advisor_requested":
        // The user-authored event is itself the typed trigger fact; each
        // click is a new condition instance, subject to the wake budget.
        this.enqueueWake(runId, event, "user_action");
        break;
      case "completed": {
        const outcome = String((event.payload as { outcome?: string }).outcome ?? "");
        if (outcome === "completed_consensus" || outcome === "completed_disagreement") {
          // Non-cancel terminal retrospective: the terminal core event is the
          // causal durable record; no core event can follow it.
          this.enqueueWake(runId, event, "addressed_event");
        }
        this.clearRunTimers(runId);
        break;
      }
      case "cancelled": {
        // Cancellation never starts a new model call; the retrospective is a
        // deterministic skip record.
        this.clearRunTimers(runId);
        try {
          new AdvisorNotes(this.options.stateRoot, runId).writeRetrospective({
            kind: "skipped",
            reason: "the run was cancelled",
          });
        } catch {
          // A notes failure never affects the worker run.
        }
        break;
      }
      default:
        break;
    }
    this.trackWorkerEpochs(runId, event);
  }

  /** Coalesced, text-free provider runtime activity (at most one per 30 s). */
  noteProviderRuntimeActivity(runId: string, role: ProviderRole): StoredEvent | null {
    if (!this.config(runId)) return null;
    const key = `${runId}:${role}`;
    const nowMs = this.now();
    const last = this.lastActivityAppend.get(key) ?? 0;
    if (nowMs - last < RUNTIME_ACTIVITY_COALESCE_MS) return null;
    this.lastActivityAppend.set(key, nowMs);
    const projection = this.store.projection(runId);
    if (!projection.goal || projection.completedAt) return null;
    const event = this.store.append({
      runId,
      actor: "system",
      type: "runtime_activity",
      idempotencyKey: `activity:${role}:${nowMs}`,
      payload: { role, coalesced: true },
      ts: new Date(nowMs).toISOString(),
    });
    this.options.publish?.(runId);
    return event;
  }

  noteProviderFailure(runId: string, role: ProviderRole, stage: string, message: string): void {
    if (!this.config(runId)) return;
    const code = normalizeFailureCode(message);
    const key = `${runId}:${role}`;
    const streak = this.failureStreaks.get(key);
    if (streak && streak.stage === stage && streak.code === code) {
      streak.count += 1;
      if (streak.count === 2) {
        this.fireTrigger(
          runId,
          "repeated_failure",
          `repeated_failure:${role}:${stage}:${code}:${this.store.projection(runId).seq}`,
          null,
          { role, stage, code },
        );
      }
    } else {
      this.failureStreaks.set(key, { stage, code, count: 1 });
    }
  }

  noteProviderSuccess(runId: string, role: ProviderRole): void {
    this.failureStreaks.delete(`${runId}:${role}`);
  }

  /** A trusted classifier/registry result degraded a browser claim to global. */
  noteBrowserIdentityDegraded(runId: string, role: ProviderRole, burstKey: string): void {
    if (!this.config(runId)) return;
    const episode = `${runId}:${role}:${burstKey}`;
    if (this.browserDegradationEpisodes.has(episode)) return;
    this.browserDegradationEpisodes.add(episode);
    this.fireTrigger(
      runId,
      "unknown_resource_identity",
      `unknown_resource:${episode}`,
      null,
      { role, burstKey },
    );
  }

  /** Called on resource-governor sample edges; degradation epochs are durable. */
  noteResourceState(state: { degraded: boolean; admitHeavyWork: boolean }): void {
    const nowMs = this.now();
    if (state.degraded && this.degradedSince === null) {
      this.degradedSince = nowMs;
      const epochKey = new Date(nowMs).toISOString();
      for (const runId of this.store.listRunIds()) {
        if (!this.config(runId)) continue;
        if (this.store.projection(runId).completedAt) continue;
        this.armDegradationEpoch(runId, epochKey, nowMs + RESOURCE_DEGRADATION_TRIGGER_MS);
      }
    } else if (!state.degraded && this.degradedSince !== null) {
      this.degradedSince = null;
      for (const [key, cancel] of this.degradationTimers) {
        cancel();
        this.degradationTimers.delete(key);
        const [runId, epochKey] = key.split("|") as [string, string];
        this.sidecar.clearEpoch(runId, "resource_degradation", epochKey);
      }
      // Heavy work is admitted again: enqueued adviser work may now claim.
      for (const runId of this.store.listRunIds()) void this.pump(runId);
    }
  }

  /** Provider-safe boundary: a worker burst finished on some provider. */
  noteWorkerBurstSettled(runId: string): void {
    void this.pump(runId);
  }

  private armDegradationEpoch(runId: string, epochKey: string, deadlineMs: number): void {
    this.sidecar.upsertEpoch({
      runId,
      kind: "resource_degradation",
      epochKey,
      startedAt: new Date(this.now()).toISOString(),
      deadlineAt: new Date(deadlineMs).toISOString(),
    });
    const timerKey = `${runId}|${epochKey}`;
    this.degradationTimers.get(timerKey)?.();
    this.degradationTimers.set(
      timerKey,
      this.schedule(() => {
        this.degradationTimers.delete(timerKey);
        if (this.degradedSince === null) return;
        if (!this.sidecar.markEpochFired(runId, "resource_degradation", epochKey, new Date(this.now()).toISOString())) {
          return;
        }
        this.fireTrigger(
          runId,
          "resource_degradation_persisted",
          `resdeg:${runId}:${epochKey}`,
          null,
          { epochKey },
        );
      }, deadlineMs - this.now()),
    );
  }

  // ---------------------------------------------------------------- stalls

  private trackWorkerEpochs(runId: string, event: StoredEvent): void {
    const projection = this.store.projection(runId);
    if (projection.completedAt) {
      this.clearRunTimers(runId);
      return;
    }
    for (const role of ["codex", "claude"] as const) {
      const key = `${runId}:${role}`;
      const state = projection.workers[role].state;
      const previous = this.previousWorkerStates.get(key);
      if (previous !== state) {
        this.previousWorkerStates.set(key, state);
        this.workerEpochs.get(key)?.cancelTimer?.();
        this.workerEpochs.delete(key);
        const threshold = STALL_THRESHOLDS_MS[state];
        if (threshold !== undefined) {
          const epoch: WorkerEpoch = {
            state,
            epochEventId: event.id,
            epochStartMs: Date.parse(event.ts),
            lastActivityMs: Date.parse(event.ts),
          };
          this.workerEpochs.set(key, epoch);
          this.armStallTimer(runId, role, epoch, threshold);
        }
      } else if (event.type === "runtime_activity") {
        const payloadRole = (event.payload as { role?: string }).role;
        const epoch = this.workerEpochs.get(key);
        if (epoch && payloadRole === role && epoch.state === "working") {
          // Trusted structured activity extends a working epoch; "working"
          // means no trusted activity, not merely no public packet.
          epoch.lastActivityMs = Date.parse(event.ts);
          epoch.cancelTimer?.();
          this.armStallTimer(runId, role, epoch, STALL_THRESHOLDS_MS.working!);
        }
      }
    }
  }

  private armStallTimer(
    runId: string,
    role: ProviderRole,
    epoch: WorkerEpoch,
    thresholdMs: number,
  ): void {
    const reference = epoch.state === "working" ? Math.max(epoch.epochStartMs, epoch.lastActivityMs) : epoch.epochStartMs;
    const fireIn = reference + thresholdMs - this.now();
    epoch.cancelTimer = this.schedule(() => {
      // Re-verify against the durable record before firing.
      const projection = this.store.projection(runId);
      if (projection.completedAt) return;
      const worker = projection.workers[role];
      if (worker.state !== epoch.state) return;
      if (epoch.state === "working") {
        const lastActivity = worker.lastRuntimeActivity
          ? Date.parse(worker.lastRuntimeActivity)
          : epoch.epochStartMs;
        if (this.now() - Math.max(lastActivity, epoch.epochStartMs) < thresholdMs) {
          return;
        }
      }
      this.fireTrigger(
        runId,
        "stall",
        `stall:${runId}:${role}:${epoch.state}:${epoch.epochEventId}`,
        null,
        { role, state: epoch.state, epochEventId: epoch.epochEventId },
      );
    }, fireIn);
  }

  private clearRunTimers(runId: string): void {
    for (const [key, epoch] of this.workerEpochs) {
      if (key.startsWith(`${runId}:`)) {
        epoch.cancelTimer?.();
        this.workerEpochs.delete(key);
      }
    }
    for (const [key, cancel] of this.degradationTimers) {
      if (key.startsWith(`${runId}|`)) {
        cancel();
        this.degradationTimers.delete(key);
      }
    }
  }

  // -------------------------------------------------------------- triggers

  private fireTrigger(
    runId: string,
    kind: AdvisorTriggerKind,
    conditionInstanceId: string,
    referenceEvent: StoredEvent | null,
    detail: Record<string, unknown> = {},
  ): void {
    const config = this.config(runId);
    if (!config) return;
    const projection = this.store.projection(runId);
    if (!projection.goal || projection.completedAt) return;
    // The condition instance id is the idempotency key: the core event store
    // debounces the typed trigger fact, and the ready queue's uniqueness on
    // (run, role, trigger event, reason) debounces the wake itself.
    const event = this.store.append({
      runId,
      actor: "system",
      type: "advisor_trigger",
      idempotencyKey: `advtrig:${conditionInstanceId}`,
      payload: {
        trigger: kind,
        conditionInstanceId,
        ...(referenceEvent ? { referenceEventId: referenceEvent.id } : {}),
        ...detail,
      },
      ts: new Date(this.now()).toISOString(),
    });
    this.options.publish?.(runId);
    this.enqueueWake(runId, event, kind === "stall" || kind === "resource_degradation_persisted" ? "trusted_timer" : "addressed_event");
  }

  private enqueueWake(
    runId: string,
    triggerEvent: StoredEvent,
    reason: "addressed_event" | "user_action" | "trusted_timer",
  ): void {
    this.queue.enqueueAdvisor({
      runId,
      triggerEventId: triggerEvent.id,
      triggerSeq: triggerEvent.seq,
      reason,
    });
    void this.pump(runId);
  }

  // ------------------------------------------------------------------ pump

  /**
   * Low-priority claim loop. Adviser work is claimed only at a provider-safe
   * boundary: never while a worker burst is active on the selected provider
   * and never while the resource governor refuses heavy work. Unclaimed work
   * waits durably; there is no polling.
   */
  async pump(runId: string): Promise<void> {
    if (this.processing.has(runId)) return;
    this.processing.add(runId);
    try {
      for (;;) {
        const config = this.config(runId);
        if (!config) return;
        if (this.queue.size("advisor") === 0) return;
        const resource = this.options.resourceState?.();
        if (resource && !resource.admitHeavyWork) return;
        if (this.workerBurstProbe(config.provider)) return;
        const releaseAdvisor =
          this.options.executionGate?.tryAcquireAdvisor(config.provider);
        if (this.options.executionGate && !releaseAdvisor) return;
        const claimed = this.queue.claimAdvisor(new Date(this.now()).toISOString(), runId);
        if (!claimed) {
          releaseAdvisor?.();
          return;
        }
        try {
          await this.processWake(runId, config, claimed);
        } catch (error) {
          // An adviser failure never fails, blocks, or terminalizes the
          // worker run — contain it as a visible sidecar failure.
          try {
            this.sidecar.append(runId, "failure", null, {
              code: "ADVISOR_WAKE_PIPELINE_ERROR",
              detail:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : String(error).slice(0, 300),
              readyWorkId: claimed.id,
            });
            this.queue.complete(
              claimed.id,
              "pipeline_error",
              new Date(this.now()).toISOString(),
            );
          } catch {
            // Even sidecar trouble must not escape the pump.
          }
        } finally {
          releaseAdvisor?.();
        }
      }
    } finally {
      this.processing.delete(runId);
    }
  }

  private triggerSummary(
    runId: string,
    claimed: ReadyWorkItem,
  ): { kind: AdvisorTriggerKind; conditionInstanceId: string; eventId: string } {
    const trigger = this.store
      .events(runId)
      .find((event) => event.id === claimed.triggerEventId);
    if (!trigger) {
      throw new Error(`ADVISOR_TRIGGER_EVENT_MISSING:${claimed.triggerEventId}`);
    }
    if (trigger.seq !== claimed.triggerSeq) {
      throw new Error(
        `ADVISOR_TRIGGER_SEQUENCE_MISMATCH:${claimed.triggerSeq}:${trigger.seq}`,
      );
    }
    if (trigger.type === "advisor_trigger") {
      if (trigger.actor !== "system") {
        throw new Error(`ADVISOR_TRIGGER_ACTOR_INVALID:${trigger.actor}`);
      }
      const payload = trigger.payload as {
        trigger?: AdvisorTriggerKind;
        conditionInstanceId?: string;
      };
      const kind = payload.trigger;
      if (
        !kind ||
        !ADVISOR_TRIGGER_KINDS.includes(kind) ||
        kind === "user_request" ||
        kind === "terminal_retrospective"
      ) {
        throw new Error(`ADVISOR_TRIGGER_KIND_INVALID:${String(kind)}`);
      }
      if (
        typeof payload.conditionInstanceId !== "string" ||
        payload.conditionInstanceId.length === 0
      ) {
        throw new Error("ADVISOR_TRIGGER_CONDITION_INSTANCE_INVALID");
      }
      return {
        kind,
        conditionInstanceId: payload.conditionInstanceId,
        eventId: trigger.id,
      };
    }
    if (trigger.type === "advisor_requested") {
      if (trigger.actor !== "user") {
        throw new Error(`ADVISOR_REQUEST_ACTOR_INVALID:${trigger.actor}`);
      }
      return {
        kind: "user_request",
        conditionInstanceId: `user_request:${trigger.id}`,
        eventId: trigger.id,
      };
    }
    if (trigger.type === "completed") {
      const outcome = String(
        (trigger.payload as { outcome?: string }).outcome ?? "",
      );
      if (
        trigger.actor !== "coordinator" ||
        (outcome !== "completed_consensus" &&
          outcome !== "completed_disagreement")
      ) {
        throw new Error(
          `ADVISOR_RETROSPECTIVE_TRIGGER_INVALID:${trigger.actor}:${outcome}`,
        );
      }
      return {
        kind: "terminal_retrospective",
        conditionInstanceId: `retro:${trigger.id}`,
        eventId: trigger.id,
      };
    }
    throw new Error(`ADVISOR_TRIGGER_EVENT_TYPE_INVALID:${trigger.type}`);
  }

  private consumedWakeUnits(runId: string): { reactive: number; retrospective: number } {
    let reactive = 0;
    let retrospective = 0;
    for (const row of this.sidecar.rows(runId)) {
      if (row.kind !== "wake_outcome") continue;
      const payload = row.payload as { modelStarted?: boolean; purpose?: string };
      if (payload.modelStarted !== true) continue;
      if (payload.purpose === "advisor_retrospective") retrospective += 1;
      else reactive += 1;
    }
    return { reactive, retrospective };
  }

  private async processWake(
    runId: string,
    config: AdvisorConfig,
    claimed: ReadyWorkItem,
  ): Promise<void> {
    const wakeId = `wake_${randomUUID()}`;
    const trigger = this.triggerSummary(runId, claimed);
    const purpose =
      trigger.kind === "terminal_retrospective"
        ? ("advisor_retrospective" as const)
        : ("advisor_observation" as const);
    const finishWake = (
      outcome: string,
      modelStarted: boolean,
      extra: Record<string, unknown> = {},
    ) => {
      this.sidecar.append(runId, "wake_outcome", wakeId, {
        outcome,
        modelStarted,
        purpose,
        ...extra,
      });
      this.queue.complete(claimed.id, outcome, new Date(this.now()).toISOString());
      this.options.publish?.(runId);
    };
    const rows = this.sidecar.rows(runId);
    const lastObservation = [...rows]
      .reverse()
      .find((row) => row.kind === "observation");
    const sinceSeq = Number(
      (lastObservation?.payload as { observedThroughSeq?: number } | undefined)
        ?.observedThroughSeq ?? 0,
    );
    this.sidecar.append(runId, "wake_claimed", wakeId, {
      provider: config.provider,
      effort: config.effort,
      readyWorkId: claimed.id,
      triggerEventId: trigger.eventId,
      triggerKind: trigger.kind,
      conditionInstanceId: trigger.conditionInstanceId,
      purpose,
      wakeReason: claimed.reason,
      sinceSeq,
    });

    // Wake-unit budget: a failed preflight consumes no unit; a guarded model
    // start consumes one. The retrospective unit is reserved and reactive
    // wakes can never consume it (nor the reverse).
    const consumed = this.consumedWakeUnits(runId);
    const extension = this.store.projection(runId).advisor?.extendedReactiveWakeUnits ?? 0;
    if (
      purpose === "advisor_observation" &&
      consumed.reactive >= config.reactiveWakeUnits + extension
    ) {
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_WAKE_BUDGET_EXHAUSTED",
        detail: `reactive wake budget ${config.reactiveWakeUnits}+${extension} consumed`,
      });
      finishWake("budget_exhausted", false);
      return;
    }
    if (
      purpose === "advisor_retrospective" &&
      consumed.retrospective >= config.retrospectiveWakeUnits
    ) {
      try {
        new AdvisorNotes(this.options.stateRoot, runId).writeRetrospective({
          kind: "skipped",
          reason: "the reserved retrospective wake budget was unavailable",
        });
      } catch {
        // Notes failures never affect the run.
      }
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_RETROSPECTIVE_BUDGET_EXHAUSTED",
        detail: "reserved retrospective unit already consumed",
      });
      finishWake("budget_exhausted", false);
      return;
    }

    let port = this.portByRun.get(runId);
    if (!port) {
      const runtimeDirectory = join(
        this.options.stateRoot,
        "runs",
        runId,
        "advisor",
        "runtime",
      );
      mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
      port = this.options.ports(config.provider, runtimeDirectory);
      this.portByRun.set(runId, port);
    }

    // Full selected-provider metadata preflight before every wake.
    let preflight: PreflightResult;
    try {
      preflight = await port.metadataPreflight();
    } catch (error) {
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_PREFLIGHT_ERROR",
        detail: normalizeFailureCode(error instanceof Error ? error.message : String(error)),
      });
      finishWake("preflight_blocked", false);
      return;
    }
    if (!preflight.ok) {
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_PREFLIGHT_BLOCKED",
        detail: preflight.predicate ?? "blocked",
      });
      finishWake("preflight_blocked", false);
      return;
    }

    // Catalog resolution before every wake: the provider's current default
    // row ("auto"), with the chosen effort verified against that row.
    let model: string;
    let effortValue: string;
    try {
      const catalog = await port.listModels();
      ({ model, effortValue } = resolveDefaultAdvisorProfile(
        config.provider,
        config.effort,
        catalog,
      ));
    } catch (error) {
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_MODEL_PROFILE_UNAVAILABLE",
        detail:
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      finishWake("model_profile_unavailable", false);
      return;
    }

    const input = buildAdvisorInput(
      this.store.events(runId),
      this.store.projection(runId),
      sinceSeq,
      trigger,
    );
    const advisorContext: AdvisorStartContext = {
      readyWorkId: claimed.id,
      triggerEventId: trigger.eventId,
      purpose,
    };
    const authorization: ModelAuthorization = {
      id: `advauth_${randomUUID()}`,
      kind: "advisor_observation",
      runId,
      providers: [config.provider],
      recordedAt: new Date(this.now()).toISOString(),
      readyWorkId: claimed.id,
      triggerEventId: trigger.eventId,
      purpose,
    };
    const startedBefore = port.guardStarted();
    let result: Awaited<ReturnType<AdvisorProviderPort["runAdvisorBurst"]>>;
    try {
      result = await port.runAdvisorBurst({
        runId,
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
        model,
        effort: effortValue,
        outputSchema: ADVISOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        authorization,
        advisorContext,
        timeoutMs: ADVISOR_WAKE_TIMEOUT_MS,
        ...(this.sessionByRun.has(runId)
          ? { sessionId: this.sessionByRun.get(runId)! }
          : {}),
      });
    } catch (error) {
      const modelStarted = port.guardStarted() > startedBefore;
      this.sidecar.append(runId, "failure", wakeId, {
        code: normalizeFailureCode(error instanceof Error ? error.message : String(error)),
        detail:
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      finishWake("failure", modelStarted);
      return;
    }
    const modelStarted = port.guardStarted() > startedBefore;
    if (result.sessionId) this.sessionByRun.set(runId, result.sessionId);
    const counters = [
      result.usage.input,
      result.usage.cachedInput,
      result.usage.output,
      result.usage.reasoning,
    ];
    this.sidecar.recordUsage({
      runId,
      wakeId,
      provider: config.provider,
      ...result.usage,
      complete:
        counters.every((value) => Number.isSafeInteger(value) && value >= 0) &&
        counters.some((value) => value > 0),
    });

    let parsed: unknown = result.structuredOutput;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = undefined;
      }
    }
    const validation = validateAdvisorOutput(
      parsed,
      new Set(
        this.store
          .events(runId)
          .filter((event) => event.seq <= input.observedThroughSeq)
          .map((event) => event.id),
      ),
    );
    if (!validation.ok) {
      // Malformed output is one adviser failure; nothing is partially applied.
      this.sidecar.append(runId, "failure", wakeId, {
        code: "ADVISOR_OUTPUT_MALFORMED",
        detail: validation.error,
      });
      finishWake("malformed_output", modelStarted);
      return;
    }

    const output = validation.output;
    this.sidecar.append(runId, "observation", wakeId, {
      trigger,
      purpose,
      inputDigest: input.inputDigest,
      observedThroughSeq: input.observedThroughSeq,
      omittedEvents: input.omittedEvents,
      output,
      model,
      effort: effortValue,
    });
    try {
      const notes = new AdvisorNotes(this.options.stateRoot, runId);
      notes.appendObservation({
        wakeId,
        trigger: trigger.kind,
        conditionInstanceId: trigger.conditionInstanceId,
        observedThroughSeq: input.observedThroughSeq,
        observations: output.observations,
      });
      notes.writeNotes(this.renderNotes(runId, output));
      if (purpose === "advisor_retrospective") {
        notes.writeRetrospective({
          kind: "retrospective",
          markdown: this.renderNotes(runId, output),
        });
      }
    } catch {
      // File-system trouble is an adviser-side concern only.
    }
    finishWake(
      purpose === "advisor_retrospective" ? "retrospective" : "observation",
      modelStarted,
    );
  }

  /** Service-authored rendering: the model supplies data and codes only. */
  private renderNotes(
    runId: string,
    output: { observations: Array<{ severity: string; summary: string; eventIds: string[]; recommendationCode?: string }>; notes: string },
  ): string {
    const lines = [
      `# Adviser notes for ${runId}`,
      "",
      ...output.observations.flatMap((observation) => [
        `- [${observation.severity}] ${observation.summary}`,
        `  events: ${observation.eventIds.join(", ") || "none"}`,
        ...(observation.recommendationCode
          ? [
              `  suggestion: ${
                ADVISOR_RECOMMENDATION_COPY[
                  observation.recommendationCode as keyof typeof ADVISOR_RECOMMENDATION_COPY
                ] ?? observation.recommendationCode
              }`,
            ]
          : []),
      ]),
      "",
      output.notes,
    ];
    return lines.join("\n");
  }

  // -------------------------------------------------------------- recovery

  private rehydrate(): void {
    for (const runId of this.store.listRunIds()) {
      const config = this.config(runId);
      if (!config) continue;
      // A claimed wake whose process outcome is unknown after restart is a
      // visible adviser failure and is never replayed.
      for (const claim of this.queue.unresolvedAdvisorClaims(runId)) {
        this.sidecar.append(runId, "failure", null, {
          code: "ADVISOR_WAKE_OUTCOME_UNKNOWN_AFTER_RESTART",
          detail: `ready item ${claim.id} was claimed before a restart; it is failed, not replayed`,
          readyWorkId: claim.id,
        });
        this.queue.complete(claim.id, "unknown_crash_outcome", new Date(this.now()).toISOString());
      }
      const projection = this.store.projection(runId);
      if (projection.completedAt) continue;
      // Rebuild durable state epochs from the event log and re-arm timers.
      this.rehydrateWorkerEpochs(runId);
      for (const epoch of this.sidecar.epochs(runId)) {
        if (epoch.kind !== "resource_degradation" || epoch.firedAt) continue;
        const deadlineMs = Date.parse(epoch.deadlineAt);
        this.armDegradationEpoch(runId, epoch.epochKey, deadlineMs);
      }
      // Unclaimed adviser ready work survives restart; try a pump.
      void this.pump(runId);
    }
  }

  private rehydrateWorkerEpochs(runId: string): void {
    const events = this.store.events(runId);
    let projection = initialProjection(runId);
    const entry: Record<ProviderRole, { eventId: string; ts: string } | null> = {
      codex: null,
      claude: null,
    };
    for (const event of events) {
      const before = {
        codex: projection.workers.codex.state,
        claude: projection.workers.claude.state,
      };
      projection = applyEvent(projection, event);
      for (const role of ["codex", "claude"] as const) {
        if (projection.workers[role].state !== before[role]) {
          entry[role] = { eventId: event.id, ts: event.ts };
        }
      }
    }
    for (const role of ["codex", "claude"] as const) {
      const key = `${runId}:${role}`;
      const state = projection.workers[role].state;
      this.previousWorkerStates.set(key, state);
      const threshold = STALL_THRESHOLDS_MS[state];
      if (threshold === undefined || !entry[role]) continue;
      const lastActivity = projection.workers[role].lastRuntimeActivity;
      const epoch: WorkerEpoch = {
        state,
        epochEventId: entry[role]!.eventId,
        epochStartMs: Date.parse(entry[role]!.ts),
        lastActivityMs: lastActivity ? Date.parse(lastActivity) : Date.parse(entry[role]!.ts),
      };
      this.workerEpochs.set(key, epoch);
      this.armStallTimer(runId, role, epoch, threshold);
    }
  }
}

/**
 * Production adviser ports. They reuse the exact guarded adapter
 * model-bearing sites (`CodexAppServerClient.runBurst` /
 * `ClaudeAgentAdapter.startBurst`) with the advisor execution profile: the
 * cwd is the service-owned run-state runtime directory (never the user
 * workspace), Codex runs read-only and declines every server request,
 * Claude runs with tools: [], dontAsk, maxTurns 1, and no permission
 * callback, and neither can reach a lease route.
 */
export function realAdvisorPorts(options: {
  codexBinary: string;
  environment?: NodeJS.ProcessEnv;
}): (provider: ProviderRole, runtimeDirectory: string) => AdvisorProviderPort {
  return (provider, runtimeDirectory) => {
    const guard = new ModelStartGuard();
    const scrubbed = scrubProviderEnvironment(options.environment ?? process.env);
    let toolRequests = 0;
    if (provider === "codex") {
      const client = new CodexAppServerClient({
        binary: options.codexBinary,
        cwd: runtimeDirectory,
        env: scrubbed.env,
        guard,
        advisorToolIsolation: true,
        onServerRequest: async (message) => {
          toolRequests += 1;
          // Decline-all: the adviser never executes a tool or acquires any
          // lease; the default decline responses are returned unchanged.
          if (String(message.method) === "item/permissions/requestApproval") {
            return { permissions: {}, scope: "turn", strictAutoReview: true };
          }
          if (String(message.method) === "item/tool/requestUserInput") {
            return { answers: {} };
          }
          return { decision: "decline" };
        },
      });
      return {
        metadataPreflight: () =>
          client.metadataPreflight({
            versionMatches: true,
            schemaMatches: true,
            forbiddenEnvironment: scrubbed.forbiddenPresent,
            spawnArgs: client.spawnArgs(),
            effectiveProviderOverride: false,
            subscriptionsRegistered: true,
          }),
        listModels: () => client.listModels(),
        runAdvisorBurst: async (input) => {
          const result = await client.runBurst({
            runId: input.runId,
            systemPrompt: input.systemPrompt,
            prompt: input.prompt,
            authorization: input.authorization,
            executionProfile: "advisor",
            model: input.model,
            effort: input.effort,
            outputSchema: input.outputSchema,
            advisorContext: input.advisorContext,
            timeoutMs: input.timeoutMs,
            ...(input.sessionId ? { threadId: input.sessionId } : {}),
          });
          return {
            text: result.text,
            sessionId: result.threadId,
            usage: result.usage,
          };
        },
        guardStarted: () => guard.started,
        toolRequests: () => toolRequests,
        close: () => client.close(),
      };
    }
    const adapter = new ClaudeAgentAdapter({
      cwd: runtimeDirectory,
      env: scrubbed.env,
      guard,
      // No canUseTool option: the advisor profile has no permission path.
    });
    return {
      metadataPreflight: () =>
        adapter.metadataPreflight({
          versionMatches: true,
          sdkMatches: true,
          forbiddenEnvironment: scrubbed.forbiddenPresent,
          spawnArgs: [],
          apiKeyHelperPresent: false,
          effectiveProviderOverride: false,
          subscriptionsRegistered: true,
        }),
      listModels: () => adapter.listModels(),
      runAdvisorBurst: async (input) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
        timer.unref?.();
        try {
          const result = await adapter.startBurst({
            runId: input.runId,
            systemPrompt: input.systemPrompt,
            prompt: input.prompt,
            authorization: input.authorization,
            executionProfile: "advisor",
            model: input.model,
            effort: input.effort,
            outputSchema: input.outputSchema,
            advisorContext: input.advisorContext,
            abortController,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          });
          return {
            text: result.text,
            structuredOutput: result.structuredOutput,
            sessionId: result.sessionId,
            usage: result.usage,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      guardStarted: () => guard.started,
      toolRequests: () => toolRequests,
    };
  };
}
