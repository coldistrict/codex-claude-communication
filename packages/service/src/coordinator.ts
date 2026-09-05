import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_ADVISOR_CONFIG,
  type AdvisorConfig,
  type AppendCommand,
  type GoalPacket,
  type ProviderRole,
  type PublicPacket,
} from "@collab/contracts";
import {
  ApprovalBridge,
  type PermissionClass,
  type PermissionDecision,
  type PermissionRequest,
} from "@collab/adapters/approvals";
import type { JsonRpcMessage } from "@collab/adapters/codex-client";
import { FakeAdapter } from "@collab/adapters/fake";
import type { ModelAuthorization } from "@collab/adapters/model-guard";
import {
  evaluateClaudePreflight,
  evaluateCodexPreflight,
  type PreflightResult,
} from "@collab/adapters/policy";
import { digest, EventStore, ReadyQueue } from "@collab/kernel";
import {
  analyzeCommand,
  isContainedPath,
  isScratchPath,
  redactSecrets,
  scratchRoots,
} from "@collab/security";
import { persistStableOverheadBreach } from "./overhead-notice.ts";
import type { RealCollaborationRunner } from "./real-runner.ts";

export interface CreateRunInput {
  goal: string;
  workspace: string;
  constraints?: string[];
  completionEvidence?: string[];
  mode?: "fake" | "preflight_only" | "real";
  budgets?: { perMaterialChallenge?: number; perProvider?: number };
  attachmentPaths?: string[];
  readableRoots?: string[];
  permissionPreset?: "auto" | "default" | "read_only";
  stopConditions?: { maxDurationMinutes?: number | null };
  resourceMode?: "automatic" | "serialized";
  /** Optional per-run adviser opt-in; disabled when absent. */
  advisor?: {
    enabled?: boolean;
    provider?: ProviderRole;
    effort?: "high" | "medium";
  };
}

export interface CoordinatorOptions {
  codexBinary: string;
  publish?: (runId: string) => void;
  /** Transient live-feed line; see RealRunnerOptions.publishActivity. */
  publishActivity?: (
    runId: string,
    activity: {
      role: ProviderRole;
      kind: "tool" | "text" | "status";
      summary: string;
    },
  ) => void;
  /** Transient model/effort statement; see RealRunnerOptions.publishIdentity. */
  publishIdentity?: (
    runId: string,
    identity: { role: ProviderRole; model: string | null; effort: string | null },
  ) => void;
  environment?: NodeJS.ProcessEnv;
  resourceState?: () => {
    degraded: boolean;
    serializeAgents: boolean;
    admitHeavyWork: boolean;
    reason: string | null;
  };
  /** Optional advisory-supervisor wiring (hooks + worker-burst probe). */
  advisor?: {
    hooks: NonNullable<
      import("./real-runner.ts").RealRunnerOptions["advisorHooks"]
    >;
    setWorkerBurstProbe(probe: (provider: ProviderRole) => boolean): void;
    requestAdvisor?: (runId: string) => void;
    providerExecutionGate?: import("./advisor/execution-gate.ts").ProviderExecutionGate;
  };
}

interface PendingApproval {
  runId: string;
  role: ProviderRole;
  bridge: ApprovalBridge;
  resolve: (value: Record<string, unknown>) => void;
  translate: (decision: PermissionDecision) => Record<string, unknown>;
}

export class Coordinator {
  readonly queue: ReadyQueue;
  private readonly bridges = new Map<string, ApprovalBridge>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private runnerPromise: Promise<RealCollaborationRunner> | null = null;

  constructor(
    readonly store: EventStore,
    private readonly options: CoordinatorOptions,
  ) {
    this.queue = new ReadyQueue(store.db);
    this.recoverPersistedWaits();
  }

  createRun(input: CreateRunInput, deferExecution = false): string {
    if (!input.goal.trim()) throw new Error("GOAL_REQUIRED");
    if (!input.workspace.startsWith("/")) throw new Error("WORKSPACE_MUST_BE_ABSOLUTE");
    const workspace = realpathSync(resolve(input.workspace));
    if (!statSync(workspace).isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
    const permissionPreset = input.permissionPreset ?? "default";
    if (!["auto", "default", "read_only"].includes(permissionPreset)) {
      throw new Error("INVALID_PERMISSION_PRESET");
    }
    const resourceMode = input.resourceMode ?? "automatic";
    if (!["automatic", "serialized"].includes(resourceMode)) {
      throw new Error("INVALID_RESOURCE_MODE");
    }
    const maxDurationMinutes =
      input.stopConditions?.maxDurationMinutes === undefined ||
      input.stopConditions.maxDurationMinutes === null
        ? null
        : Number(input.stopConditions.maxDurationMinutes);
    if (
      maxDurationMinutes !== null &&
      (!Number.isFinite(maxDurationMinutes) ||
        maxDurationMinutes < 0.001 ||
        maxDurationMinutes > 1_440)
    ) {
      throw new Error("INVALID_MAX_DURATION_MINUTES");
    }
    const attachmentPaths = input.attachmentPaths ?? [];
    if (!Array.isArray(attachmentPaths) || attachmentPaths.length > 20) {
      throw new Error("INVALID_ATTACHMENTS");
    }
    const readableRootInputs = input.readableRoots ?? [];
    if (!Array.isArray(readableRootInputs) || readableRootInputs.length > 16) {
      throw new Error("INVALID_READABLE_ROOTS");
    }
    const readableRoots = [
      ...new Set(
        readableRootInputs.map((candidate) => {
          if (typeof candidate !== "string" || !candidate.trim()) {
            throw new Error("INVALID_READABLE_ROOT");
          }
          const requested = candidate.trim();
          if (!requested.startsWith("/")) {
            throw new Error("READABLE_ROOT_MUST_BE_ABSOLUTE");
          }
          const path = realpathSync(resolve(requested));
          if (!statSync(path).isDirectory()) {
            throw new Error("READABLE_ROOT_NOT_DIRECTORY");
          }
          return path;
        }),
      ),
    ].filter((root) => !isContainedPath(workspace, root));
    let advisor: AdvisorConfig | undefined;
    if (input.advisor?.enabled === true) {
      const provider = input.advisor.provider ?? DEFAULT_ADVISOR_CONFIG.provider;
      const effort = input.advisor.effort ?? DEFAULT_ADVISOR_CONFIG.effort;
      if (!["codex", "claude"].includes(provider)) {
        throw new Error("INVALID_ADVISOR_PROVIDER");
      }
      if (!["high", "medium"].includes(effort)) {
        throw new Error("INVALID_ADVISOR_EFFORT");
      }
      advisor = {
        enabled: true,
        provider,
        effort,
        reactiveWakeUnits: DEFAULT_ADVISOR_CONFIG.reactiveWakeUnits,
        retrospectiveWakeUnits: DEFAULT_ADVISOR_CONFIG.retrospectiveWakeUnits,
      };
    } else if (input.advisor !== undefined && input.advisor.enabled !== undefined && input.advisor.enabled !== false) {
      throw new Error("INVALID_ADVISOR_CONFIG");
    }
    const attachments = attachmentPaths.map((candidate) => {
      if (typeof candidate !== "string" || !candidate.trim()) {
        throw new Error("INVALID_ATTACHMENT_PATH");
      }
      const requested = candidate.trim();
      const absolute = isAbsolute(requested)
        ? resolve(requested)
        : resolve(workspace, requested);
      const path = realpathSync(absolute);
      if (!isContainedPath(workspace, path)) {
        throw new Error("ATTACHMENT_OUTSIDE_WORKSPACE");
      }
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("ATTACHMENT_NOT_FILE");
      return {
        path: relative(workspace, path),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        size: stat.size,
        mediaType: this.attachmentMediaType(path),
      };
    });
    const runId = `run_${randomUUID()}`;
    const base = {
      goal: redactSecrets(input.goal.trim()),
      workspace,
      constraints: (input.constraints ?? []).map((constraint) =>
        redactSecrets(constraint),
      ),
      attachments,
      authority: {
        writableRoots: permissionPreset === "read_only" ? [] : [workspace],
        readableRoots,
        network: "off" as const,
        permissionPreset,
      },
      stopConditions: { maxDurationMinutes },
      resourceMode,
      ...(advisor ? { advisor } : {}),
      completionEvidence: (input.completionEvidence ?? []).map((evidence) =>
        redactSecrets(evidence),
      ),
      usefulWorkBudget: {
        perMaterialChallenge: input.budgets?.perMaterialChallenge ?? 4,
        perProvider: input.budgets?.perProvider ?? 24,
      },
    };
    const goalPacket: GoalPacket = {
      id: `goal_${randomUUID()}`,
      runId,
      ...base,
      digest: digest(base),
      createdAt: new Date().toISOString(),
    };
    this.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: `goal:${goalPacket.id}`,
      payload: { goal: goalPacket },
    });
    const mode = input.mode ?? "fake";
    if (!deferExecution && mode === "fake") this.runDeterministicDemo(runId);
    if (!deferExecution && (mode === "preflight_only" || mode === "real")) {
      queueMicrotask(() => {
        void this.runReal(runId, mode === "real");
      });
    }
    return runId;
  }

  async decideAction(
    runId: string,
    cardId: string,
    label: string,
    details?: string,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(cardId);
    if (pending) {
      if (pending.runId !== runId) throw new Error("ACTION_RUN_MISMATCH");
      const decision: PermissionDecision =
        label === "Allow once"
          ? { behavior: "allow", scope: "once" }
          : label === "Allow for task"
            ? { behavior: "allow", scope: "task" }
            : label === "Defer"
              ? { behavior: "defer", scope: "once" }
              : { behavior: "deny", scope: "once" };
      // The bridge may narrow the requested scope (task scope is never
      // honored outside the workspace); the durable record and the provider
      // translation must both reflect the decision actually applied.
      const { decision: applied } = pending.bridge.decide(cardId, decision);
      if (applied.behavior === "defer") return;
      this.append({
        runId,
        actor: "user",
        type: "permission_decided",
        idempotencyKey: `permission:${cardId}:${label}`,
        payload: { cardId, role: pending.role, decision: applied },
      });
      this.pendingApprovals.delete(cardId);
      pending.resolve(pending.translate(applied));
      this.options.publish?.(runId);
      return;
    }
    const projection = this.store.projection(runId);
    const card = projection.actions.find((action) => action.id === cardId);
    if (!card) throw new Error("ACTION_CARD_NOT_FOUND");
    const suppliedDetails = redactSecrets(String(details ?? "").trim()).slice(
      0,
      12_000,
    );
    if (
      card.requiresDetailsFor?.includes(label) &&
      suppliedDetails.length === 0
    ) {
      throw new Error("ACTION_DETAILS_REQUIRED");
    }
    if (label === "Cancel") {
      await this.stopActiveRun(runId);
      const reconciled = this.store.projection(runId);
      const cancellingUncertainCard = card.kind === "uncertain_effect";
      if (
        !cancellingUncertainCard &&
        reconciled.actions.some((action) => action.kind === "uncertain_effect")
      ) {
        // Terminalizing here would wipe the reconciliation card from the
        // projection; the uncertain-effect card itself is where the user
        // decides.
        this.options.publish?.(runId);
        return;
      }
      if (cancellingUncertainCard && !reconciled.completedAt) {
        // Cancel chosen on the reconciliation card itself is the user's
        // audited resolution: they inspected the possible workspace effect
        // and accept ending the run with it unreconciled.
        this.append({
          runId,
          actor: "user",
          type: "human_override",
          idempotencyKey: `acknowledge-uncertain:${cardId}`,
          payload: { cardId, decision: "acknowledge_uncertain_effect_and_cancel" },
        });
      }
      if (!this.store.projection(runId).completedAt) {
        persistStableOverheadBreach(this.store, runId, "cancellation", this.options.publish);
        this.append({
          runId,
          actor: "user",
          type: "cancelled",
          idempotencyKey: `cancel:${cardId}`,
          payload: { cardId },
        });
      }
    } else if (label === "Accept disagreement") {
      this.append({
        runId,
        actor: "user",
        type: "human_override",
        idempotencyKey: `override:${cardId}`,
        payload: { cardId, decision: "accept_disagreement" },
      });
      persistStableOverheadBreach(
        this.store,
        runId,
        "terminal_disagreement",
        this.options.publish,
      );
      this.append({
        runId,
        actor: "coordinator",
        type: "completed",
        idempotencyKey: `completed:disagreement:${cardId}`,
        payload: { outcome: "completed_disagreement" },
      });
    } else if (label === "Extend budget" || label === "Supply information or authority") {
      // Both actions add an audited, explicit number of units and resume;
      // supplying information additionally records the user's intent so the
      // resumed providers receive their answers through permission and
      // needs-input cards rather than through a silent budget bump.
      if (label === "Supply information or authority") {
        this.append({
          runId,
          actor: "user",
          type: "human_override",
          idempotencyKey: `supply:${cardId}`,
          payload: {
            cardId,
            decision: "supply_information_or_authority",
            information: suppliedDetails,
          },
        });
      }
      for (const role of ["codex", "claude"] as const) {
        this.append({
          runId,
          actor: "user",
          type: "budget_extended",
          idempotencyKey: `budget:${cardId}:${role}`,
          payload: { cardId, role, units: 4 },
        });
      }
      queueMicrotask(() => {
        void this.runReal(runId, true);
      });
    } else if (label === "Decide") {
      // The user takes the decision away from the providers: the run ends as
      // an explicit user-decided outcome with both positions retained; no
      // consensus is manufactured.
      this.append({
        runId,
        actor: "user",
        type: "human_override",
        idempotencyKey: `decide:${cardId}`,
        payload: {
          cardId,
          decision: "user_decided_outcome",
          decisionDetails: suppliedDetails,
        },
      });
      persistStableOverheadBreach(
        this.store,
        runId,
        "terminal_disagreement",
        this.options.publish,
      );
      this.append({
        runId,
        actor: "coordinator",
        type: "completed",
        idempotencyKey: `completed:user-decision:${cardId}`,
        payload: { outcome: "completed_disagreement" },
      });
    } else if (label === "Retry collaboration") {
      this.append({
        runId,
        actor: "user",
        type: "human_override",
        idempotencyKey: `retry:${cardId}`,
        payload: { cardId, decision: "retry_collaboration" },
      });
      queueMicrotask(() => {
        void this.runReal(runId, true);
      });
    } else {
      throw new Error(`ACTION_NOT_SUPPORTED:${label}`);
    }
    this.options.publish?.(runId);
  }

  async cancelRun(runId: string): Promise<void> {
    const projection = this.store.projection(runId);
    if (!projection.goal) throw new Error("RUN_NOT_FOUND");
    if (projection.completedAt) throw new Error("RUN_ALREADY_TERMINAL");
    await this.stopActiveRun(runId);
    const reconciled = this.store.projection(runId);
    if (
      !reconciled.completedAt &&
      !reconciled.actions.some((action) => action.kind === "uncertain_effect")
    ) {
      persistStableOverheadBreach(this.store, runId, "cancellation", this.options.publish);
      this.append({
        runId,
        actor: "user",
        type: "cancelled",
        idempotencyKey: `cancel:run:${runId}`,
        payload: { reason: "user_requested" },
      });
    }
    this.options.publish?.(runId);
  }

  private async stopActiveRun(runId: string): Promise<void> {
    if (this.runnerPromise) {
      const runner = await this.runnerPromise;
      await runner.cancel(runId);
    }
  }

  /**
   * Deterministic demo preflight. The produced billing status is synthesised
   * from fixtures, never observed from a provider, so it is explicitly
   * labelled `simulated` in the durable record, the proof lines, and the
   * card; the UI renders it as a demo route, never as a proven one.
   */
  retryPreflight(runId: string, provider: ProviderRole, fixture?: "clean" | "blocked"): PreflightResult {
    const result =
      provider === "codex"
        ? evaluateCodexPreflight({
            versionMatches: true,
            schemaMatches: true,
            forbiddenEnvironment: [],
            spawnArgs: ["app-server", "--listen", "stdio://"],
            effectiveProviderOverride: false,
            account: {
              type: "chatgpt",
              planType: "plus",
              requiresOpenaiAuth: true,
            },
            rateLimits:
              fixture === "blocked"
                ? null
                : {
                    structurallyTrusted: true,
                    planType: "plus",
                    primary: { usedPercent: 35, resetsAt: 1_900_000_000 },
                    credits: { hasCredits: true, unlimited: false, balance: "present" },
                    rateLimitReachedType: null,
                    spendControlReached: false,
                  },
            subscriptionsRegistered: true,
          })
        : evaluateClaudePreflight({
            versionMatches: true,
            sdkMatches: true,
            forbiddenEnvironment: [],
            spawnArgs: [],
            apiKeyHelperPresent: false,
            effectiveProviderOverride: false,
            auth:
              fixture === "blocked"
                ? { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }
                : {
                    loggedIn: true,
                    authMethod: "claude.ai",
                    apiProvider: "firstParty",
                    subscriptionType: "max",
                  },
            billing: {
              includedUsageRemaining: true,
              extraUsageEnabled: false,
              currentRoute: "subscription_allowance",
            },
            subscriptionsRegistered: true,
          });
    result.billing.simulated = true;
    result.billing.proof = [
      "SIMULATED: deterministic demo fixture — not observed from any provider",
      ...result.billing.proof,
    ];
    const card = {
      id: `preflight_${provider}`,
      kind: "preflight" as const,
      title: result.ok
        ? `${provider} ready (demo)`
        : `${provider} preflight blocked (demo)`,
      body: result.ok
        ? `Simulated demo route: ${result.billing.route}. Not a proven billing route.`
        : `${result.predicate}: ${result.remedy}`,
      agent: provider,
      actions: result.ok ? [] : ["Retry preflight"],
    };
    this.append({
      runId,
      actor: "system",
      type: result.ok ? "preflight_passed" : "preflight_blocked",
      idempotencyKey: `preflight:${provider}:${Date.now()}:${fixture ?? "clean"}`,
      payload: {
        provider,
        billing: result.billing,
        card,
      },
    });
    return result;
  }

  retryRealPreflight(runId: string): void {
    queueMicrotask(() => {
      void this.runReal(runId, true);
    });
  }

  private runDeterministicDemo(runId: string): void {
    const authorization: ModelAuthorization = {
      id: `auth_${randomUUID()}`,
      kind: "user_goal",
      runId,
      providers: ["codex", "claude"],
      recordedAt: new Date().toISOString(),
    };
    const adapters = {
      codex: new FakeAdapter("codex", [{ type: "opening", payload: "Codex opening analysis committed." }]),
      claude: new FakeAdapter("claude", [{ type: "opening", payload: "Claude opening analysis committed." }]),
    };
    for (const role of ["codex", "claude"] as const) {
      const preflight = this.retryPreflight(runId, role);
      if (!preflight.ok) continue;
      const trigger = this.append({
        runId,
        actor: "coordinator",
        type: "worker_started",
        idempotencyKey: `worker:${role}:1`,
        payload: {
          role,
          activity: "preparing independent opening",
          sessionId: `fake_${role}_session`,
          incarnation: 1,
        },
      });
      this.queue.enqueue({
        runId,
        role,
        triggerEventId: trigger.id,
        triggerSeq: trigger.seq,
        reason: "addressed_event",
      });
      const claimed = this.queue.claim(role, new Date().toISOString(), runId);
      if (!claimed) throw new Error(`READY_QUEUE_EMPTY:${role}`);
      const step = adapters[role].start(runId, authorization);
      this.append({
        runId,
        actor: "coordinator",
        type: "work_claimed",
        idempotencyKey: `claim:${claimed.id}`,
        payload: { role, activity: "analysing", chargeBudget: true },
      });
      const packetId = `pkt_${randomUUID()}`;
      const packet: PublicPacket = {
        id: packetId,
        runId,
        type: "claim",
        from: role,
        to: "both",
        parentIds: [],
        affectedCriteria: [],
        provenance: ["deterministic fake adapter"],
        rationale: String(step?.payload ?? ""),
        body: step?.payload,
        material: true,
        createdAt: new Date().toISOString(),
      };
      this.append({
        runId,
        actor: role,
        type: "opening_committed",
        idempotencyKey: `opening:${role}`,
        payload: { packetId },
      });
      this.append({
        runId,
        actor: role,
        type: "packet_posted",
        idempotencyKey: `packet:${packetId}`,
        payload: { packet },
      });
    }
    this.append({
      runId,
      actor: "coordinator",
      type: "barrier_released",
      idempotencyKey: "barrier:released",
      payload: {},
    });
  }

  private append<T>(command: AppendCommand<T>) {
    return this.store.append(command);
  }

  private async runReal(runId: string, executeModels: boolean): Promise<void> {
    try {
      const runner = await this.realRunner();
      await runner.run(runId, executeModels);
    } catch (error) {
      // run() records its own collaboration failures durably; anything that
      // escapes it is a cleanup/termination failure (for example
      // CODEX_PROCESS_EXIT_UNCONFIRMED after a force-kill). runReal is
      // invoked fire-and-forget, so an escaping rejection here would be an
      // unhandled rejection that kills the whole service. Contain it and
      // surface it durably instead.
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      const projection = this.store.projection(runId);
      if (projection.goal && !projection.completedAt) {
        this.append({
          runId,
          actor: "system",
          type: "needs_input",
          idempotencyKey: `real:cleanup:${projection.seq}`,
          payload: {
            card: {
              id: `cleanup_${randomUUID()}`,
              kind: "needs_input",
              title: "Provider shutdown did not confirm cleanly",
              body: `Collaboration work stopped, but provider-process cleanup reported: ${message}. Verify no stray provider process remains before retrying.`,
              actions: ["Retry collaboration", "Cancel"],
            },
          },
        });
        this.options.publish?.(runId);
      }
    }
  }

  private recoverPersistedWaits(): void {
    for (const runId of this.store.listRunIds()) {
      const projection = this.store.projection(runId);
      if (projection.completedAt) continue;
      for (const card of projection.actions.filter((action) => action.kind === "permission")) {
        const role = card.agent;
        if (!role) continue;
        this.append({
          runId,
          actor: "system",
          type: "incarnation_replaced",
          idempotencyKey: `recovery:stale-permission:${card.id}`,
          payload: { role, cardId: card.id },
        });
        const recoveryCard = {
          id: `recovery_${card.id}`,
          kind: "uncertain_effect" as const,
          title: `${role} permission wait needs recovery`,
          body:
            "The local service restarted while the provider was waiting. The old request cannot be answered safely; resume from the persisted provider session and re-evaluate the operation.",
          agent: role,
          command: card.command,
          paths: card.paths,
          reason: card.reason,
          sideEffect: card.sideEffect,
          reversibility: card.reversibility,
          actions: ["Retry collaboration", "Cancel"],
        };
        this.append({
          runId,
          actor: "system",
          type: "uncertain_effect",
          idempotencyKey: `recovery:uncertain:${card.id}`,
          payload: { role, card: recoveryCard },
        });
      }
      const outstandingLeases = new Map<string, any>();
      for (const event of this.store.events(runId)) {
        const payload = event.payload as any;
        if (event.type === "lease_acquired" && payload.lease?.id) {
          outstandingLeases.set(payload.lease.id, payload);
        }
        if (event.type === "lease_released" && payload.leaseId) {
          outstandingLeases.delete(payload.leaseId);
        }
      }
      for (const [leaseId, payload] of outstandingLeases) {
        const role = payload.role as ProviderRole;
        const lease = payload.lease;
        // A reconciliation card already pending for this lease means the
        // user has the decision in front of them; re-posting under a
        // recurring lease name would collide with the earlier record.
        if (
          this.store
            .projection(runId)
            .actions.some(
              (action) =>
                action.kind === "uncertain_effect" &&
                (action.id.startsWith(`recovery_${leaseId}`) ||
                  action.id.startsWith(`uncertain_${leaseId}`)),
            )
        ) {
          continue;
        }
        const occurrence = this.store.projection(runId).seq;
        this.append({
          runId,
          actor: "system",
          type: "incarnation_replaced",
          idempotencyKey: `recovery:stale-lease:${leaseId}:${occurrence}`,
          payload: {
            role,
            leaseId,
            reason: "service restarted while a mutation lease was held",
          },
        });
        this.append({
          runId,
          actor: "system",
          type: "uncertain_effect",
          idempotencyKey: `recovery:uncertain-lease:${leaseId}:${occurrence}`,
          payload: {
            role,
            leaseId,
            card: {
              id: `recovery_${leaseId}_${occurrence}`,
              kind: "uncertain_effect",
              title: Array.isArray(lease.interactiveResources) &&
                lease.interactiveResources.length
                ? `${role} interactive-resource lease needs reconciliation`
                : `${role} workspace lease needs reconciliation`,
              body:
                Array.isArray(lease.interactiveResources) &&
                lease.interactiveResources.length
                  ? `The local service restarted while an exclusive interactive-resource lease was held (${lease.interactiveResources.join(", ")}). Inspect the desktop/browser state before retrying; the operation is never replayed automatically and the peer will not use the resource until reconciled.`
                  : "The local service restarted while a mutation lease was held. Inspect the recorded targets before retrying; the operation is never replayed automatically.",
              agent: role,
              paths: Array.isArray(lease.targets) ? lease.targets : [],
              reason: String(
                lease.reason ?? "A workspace mutation may be incomplete.",
              ),
              sideEffect:
                "The workspace may contain a partial or completed mutation.",
              reversibility:
                "Inspect and reconcile the workspace before continuing.",
              actions: ["Retry collaboration", "Cancel"],
            },
          },
        });
      }
      this.options.publish?.(runId);
    }
  }

  private realRunner(): Promise<RealCollaborationRunner> {
    this.runnerPromise ??= import("./real-runner.ts").then(
      ({ RealCollaborationRunner: Runner }) => {
        const runner = new Runner(this.store, {
          codexBinary: this.options.codexBinary,
          ...(this.options.environment
            ? { environment: this.options.environment }
            : {}),
          publish: (runId) => this.options.publish?.(runId),
          ...(this.options.publishActivity
            ? { publishActivity: this.options.publishActivity }
            : {}),
          ...(this.options.publishIdentity
            ? { publishIdentity: this.options.publishIdentity }
            : {}),
          ...(this.options.resourceState
            ? { resourceState: this.options.resourceState }
            : {}),
          ...(this.options.advisor
            ? {
                advisorHooks: this.options.advisor.hooks,
                ...(this.options.advisor.providerExecutionGate
                  ? {
                      providerExecutionGate:
                        this.options.advisor.providerExecutionGate,
                    }
                  : {}),
              }
            : {}),
          onCodexServerRequest: (runId, message) =>
            this.handleCodexServerRequest(runId, message),
          onClaudeToolRequest: (runId, toolName, input, context) =>
            this.handleClaudeToolRequest(runId, toolName, input, context),
        });
        this.options.advisor?.setWorkerBurstProbe((provider) =>
          runner.isWorkerBurstActive(provider),
        );
        return runner;
      },
    );
    return this.runnerPromise;
  }

  /**
   * "Ask the adviser": a user-authored `advisor_requested` event. Each click
   * is a new condition instance, subject to the adviser wake budget. Never
   * available on a terminal run and never on an adviser-disabled run.
   */
  requestAdvisor(runId: string): void {
    const projection = this.store.projection(runId);
    if (!projection.goal) throw new Error("RUN_NOT_FOUND");
    if (projection.completedAt) throw new Error("RUN_ALREADY_TERMINAL");
    if (projection.goal.advisor?.enabled !== true) {
      throw new Error("ADVISOR_DISABLED");
    }
    this.append({
      runId,
      actor: "user",
      type: "advisor_requested",
      idempotencyKey: `advisor-request:${randomUUID()}`,
      payload: { source: "dashboard_button" },
    });
    this.options.publish?.(runId);
  }

  private bridge(runId: string): ApprovalBridge {
    let bridge = this.bridges.get(runId);
    if (!bridge) {
      const workspace = this.store.projection(runId).goal?.workspace;
      if (!workspace) throw new Error("RUN_GOAL_MISSING");
      // Scratch directories join the read auto-allow roots so the bridge
      // agrees with the classifier; write grants stay workspace-only.
      bridge = new ApprovalBridge(workspace, [
        ...this.readableRoots(runId),
        ...scratchRoots(),
      ]);
      this.bridges.set(runId, bridge);
    }
    return bridge;
  }

  private async handleCodexServerRequest(
    runId: string,
    message: JsonRpcMessage,
  ): Promise<unknown> {
    const method = String(message.method ?? "");
    if (method === "item/tool/requestUserInput") return { answers: {} };
    const workspace = this.store.projection(runId).goal?.workspace;
    if (!workspace) throw new Error("RUN_GOAL_MISSING");
    const command = String(message.params?.command ?? "");
    const network =
      Boolean(message.params?.networkApprovalContext) ||
      Boolean(message.params?.proposedNetworkPolicyAmendments?.length);
    const id = String(
      message.params?.approvalId ??
        message.params?.itemId ??
        `codex_permission_${randomUUID()}`,
    );
    const paths = [
      String(message.params?.grantRoot ?? message.params?.cwd ?? workspace),
    ];
    const classification = this.classifyCommand(
      command,
      network,
      workspace,
      paths,
      this.readableRoots(runId),
    );
    const permissionsRequest = method === "item/permissions/requestApproval";
    return this.requestPermission(
      runId,
      {
        id,
        role: "codex",
        tool: method,
        ...(command ? { command: redactSecrets(command) } : {}),
        paths: paths.map((path) => redactSecrets(path)),
        reason: redactSecrets(
          String(message.params?.reason ?? "Codex requested a privileged operation."),
        ),
        sideEffect:
          method.includes("fileChange")
            ? "Changes files in the selected workspace."
            : "Runs a command in the selected workspace.",
        reversibility: "Review the exact operation; workspace changes may require a manual revert.",
        classification:
          method.includes("fileChange")
            ? paths.every((path) => isContainedPath(workspace, path))
              ? "workspace_write"
              : "outside_workspace"
            : permissionsRequest
              ? message.params?.permissions?.network?.enabled
                ? "network"
                : "system_change"
              : classification,
      },
      (decision) =>
        permissionsRequest
          ? {
              permissions:
                decision.behavior === "allow"
                  ? message.params?.permissions ?? {}
                  : {},
              scope: decision.scope === "task" ? "session" : "turn",
              strictAutoReview: true,
            }
          : {
              decision:
                decision.behavior === "allow"
                  ? decision.scope === "task"
                    ? "acceptForSession"
                    : "accept"
                  : "decline",
            },
    );
  }

  private async handleClaudeToolRequest(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const workspace = this.store.projection(runId).goal?.workspace;
    if (!workspace) throw new Error("RUN_GOAL_MISSING");
    const command = String(input.command ?? "");
    const path = String(
      input.file_path ??
        input.path ??
        input.notebook_path ??
        context.blockedPath ??
        workspace,
    );
    const classification = this.classifyClaudeTool(
      toolName,
      command,
      path,
      workspace,
      this.readableRoots(runId),
    );
    const id = String(context.requestId ?? context.toolUseID ?? `claude_permission_${randomUUID()}`);
    return this.requestPermission(
      runId,
      {
        id,
        role: "claude",
        tool: toolName,
        ...(command ? { command: redactSecrets(command) } : {}),
        paths: [redactSecrets(path)],
        reason: redactSecrets(
          String(
            context.title ??
              context.decisionReason ??
              `Claude requested permission to use ${toolName}.`,
          ),
        ),
        sideEffect: redactSecrets(
          String(
            context.description ??
              (classification === "read"
                ? "Reads workspace data."
                : "May change the workspace or invoke an external capability."),
          ),
        ),
        reversibility:
          classification === "read"
            ? "No mutation."
            : "Review the exact operation; changes may require a manual revert.",
        classification,
      },
      (decision) =>
        decision.behavior === "allow"
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message: "The user denied this operation in the collaboration dashboard.",
            },
    );
  }

  private requestPermission(
    runId: string,
    request: PermissionRequest,
    translate: (decision: PermissionDecision) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const preset = this.store.projection(runId).goal?.authority.permissionPreset;
    if (preset === "read_only" && request.classification !== "read") {
      const decision: PermissionDecision = {
        behavior: "deny",
        scope: "once",
      };
      this.append({
        runId,
        // The immutable Goal Packet is the user's pre-recorded decision to
        // deny every non-read operation under this preset.
        actor: "user",
        type: "permission_decided",
        idempotencyKey: `permission:read-only:${request.id}`,
        payload: {
          cardId: request.id,
          role: request.role,
          decision,
          preset: "read_only",
          classification: request.classification,
        },
      });
      this.options.publish?.(runId);
      return Promise.resolve(translate(decision));
    }
    if (preset === "auto" && request.classification === "workspace_write") {
      // The immutable Goal Packet pre-authorizes workspace-contained writes
      // and commands under this preset; the classifier has already routed
      // anything outside the workspace or hazardous (destructive, install,
      // network, system change, …) away from workspace_write, so those
      // still surface a card. Mutation leases and the live activity feed
      // remain the audit surface for what actually ran.
      return Promise.resolve(translate({ behavior: "allow", scope: "once" }));
    }
    const bridge = this.bridge(runId);
    const evaluated = bridge.evaluate(request);
    if (evaluated.allowed) {
      return Promise.resolve(translate({ behavior: "allow", scope: "once" }));
    }
    const existing = this.pendingApprovals.get(request.id);
    if (existing) {
      return new Promise((resolve) => {
        const previousResolve = existing.resolve;
        existing.resolve = (value) => {
          previousResolve(value);
          resolve(value);
        };
      });
    }
    this.append({
      runId,
      actor: "system",
      type: "permission_requested",
      idempotencyKey: `permission:requested:${request.id}`,
      payload: { role: request.role, card: evaluated.card },
    });
    this.options.publish?.(runId);
    return new Promise((resolve) => {
      this.pendingApprovals.set(request.id, {
        runId,
        role: request.role,
        bridge,
        resolve,
        translate,
      });
    });
  }

  private classifyCommand(
    command: string,
    network: boolean,
    workspace: string,
    paths: string[],
    readableRoots: string[],
  ): PermissionClass {
    if (network) return "network";
    const analysis = analyzeCommand(command, workspace);
    const containedOrScratch = (path: string) =>
      isContainedPath(workspace, path) || isScratchPath(path);
    if (/\b(?:rm|rmdir|unlink|truncate|git\s+reset|git\s+clean)\b/i.test(command)) {
      // Deleting inside the workspace (or shared scratch) is no more
      // destructive than the unrestricted Write/Edit the same sandbox
      // already permits, so it classifies as an ordinary workspace write.
      // The always-ask destructive class is reserved for deletions whose
      // targets cannot be proven contained: any path outside workspace and
      // scratch, or any unresolvable construct (`rm $X`, substitution).
      const provablyContained =
        !analysis.unresolvable &&
        analysis.outsidePaths.every((path) => isScratchPath(path)) &&
        paths.every(containedOrScratch);
      return provablyContained ? "workspace_write" : "destructive";
    }
    if (/\b(?:npm|pnpm|yarn|pip|brew|cargo)\s+(?:i|install|add)\b/i.test(command)) {
      return "install";
    }
    if (/\b(?:curl|wget|ssh|scp|nc)\b/i.test(command)) return "network";
    if (analysis.readOnly) {
      // Reads may roam the user-declared readable roots and scratch;
      // anything beyond them still always asks.
      const readRoots = [workspace, ...readableRoots];
      const withinRead = (path: string) =>
        readRoots.some((root) => isContainedPath(root, path)) ||
        isScratchPath(path);
      const outside =
        analysis.outsidePaths.some((path) => !withinRead(path)) ||
        paths.some((path) => !withinRead(path));
      return outside ? "outside_workspace" : "read";
    }
    // A possibly-writing command touching anything outside the workspace
    // (scratch excepted) must never be offered as a task-wide grant;
    // outside_workspace is in the always-ask set.
    const outside =
      analysis.outsidePaths.some((path) => !isScratchPath(path)) ||
      paths.some((path) => !containedOrScratch(path));
    return outside ? "outside_workspace" : "workspace_write";
  }

  private classifyClaudeTool(
    toolName: string,
    command: string,
    path: string,
    workspace: string,
    readableRoots: string[],
  ): PermissionClass {
    if (["Read", "Glob", "Grep", "LS"].includes(toolName)) {
      return [workspace, ...readableRoots].some((root) =>
        isContainedPath(root, path),
      )
        ? "read"
        : "outside_workspace";
    }
    if (toolName === "WebFetch" || toolName === "WebSearch") return "network";
    if (toolName === "Bash") {
      return this.classifyCommand(command, false, workspace, [path], readableRoots);
    }
    if (["Write", "Edit", "NotebookEdit"].includes(toolName)) {
      return isContainedPath(workspace, path)
        ? "workspace_write"
        : "outside_workspace";
    }
    return "system_change";
  }

  private readableRoots(runId: string): string[] {
    return this.store.projection(runId).goal?.authority.readableRoots ?? [];
  }

  private attachmentMediaType(path: string): string {
    return (
      {
        ".json": "application/json",
        ".md": "text/markdown",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".tsv": "text/tab-separated-values",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      }[extname(path).toLowerCase()] ?? "application/octet-stream"
    );
  }
}
