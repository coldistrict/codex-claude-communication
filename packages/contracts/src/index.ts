export const PROVIDER_ROLES = ["codex", "claude"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];
export type Actor = ProviderRole | "user" | "coordinator" | "system";

/**
 * Ready-queue-only role widening. The adviser is not a provider, an actor,
 * or a consensus participant: "advisor" exists exclusively so adviser work
 * can be enqueued and claimed causally. It must never index worker, billing,
 * budget, packet, or signoff maps, all of which stay keyed by ProviderRole.
 */
export type ReadyRole = ProviderRole | "advisor";

export type AdvisorEffort = "high" | "medium";

/**
 * Immutable per-run adviser configuration recorded in the Goal Packet.
 * Off by default. The selected provider is the transport only; the adviser
 * itself has no authority surface.
 */
export interface AdvisorConfig {
  enabled: boolean;
  /** Selected transport; Claude is the default. */
  provider: ProviderRole;
  /** "high" (strong, default) or "medium" (economical). */
  effort: AdvisorEffort;
  /** Reactive/user wake units (default 2, extendable by audited user event). */
  reactiveWakeUnits: number;
  /** Reserved non-cancel terminal retrospective unit (default 1). */
  retrospectiveWakeUnits: number;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  provider: "claude",
  effort: "high",
  reactiveWakeUnits: 2,
  retrospectiveWakeUnits: 1,
};

export const ADVISOR_TRIGGER_KINDS = [
  "repeated_failure",
  "stall",
  "disagreement_declared",
  "budget_exhausted",
  "unknown_resource_identity",
  "overhead_gate_breach",
  "resource_degradation_persisted",
  "user_request",
  "terminal_retrospective",
] as const;
export type AdvisorTriggerKind = (typeof ADVISOR_TRIGGER_KINDS)[number];

/**
 * Fixed, non-permission recommendation codes an adviser observation may
 * carry. The service, never the model, maps a code to displayed copy. No
 * code can create, grant, or recommend a permission, lease, billing change,
 * signoff, goal mutation, or worker message.
 */
export const ADVISOR_RECOMMENDATION_CODES = [
  "no_action_needed",
  "consider_fix_pass",
  "consider_budget_extension",
  "consider_reviewing_disagreement",
  "consider_restating_goal_in_new_run",
  "consider_resource_relief",
] as const;
export type AdvisorRecommendationCode =
  (typeof ADVISOR_RECOMMENDATION_CODES)[number];

export const PACKET_TYPES = [
  "claim",
  "evidence",
  "artifact",
  "challenge",
  "request",
  "decision",
  "candidate",
  "signoff",
  "blocker",
] as const;
export type PacketType = (typeof PACKET_TYPES)[number];

export const RUN_STATES = [
  "draft",
  "preflight_blocked",
  "starting",
  "investigating",
  "negotiating",
  "executing",
  "verifying",
  "waiting_user",
  "paused",
  "recovering",
  "billing_integrity_unknown",
  "completed_consensus",
  "completed_disagreement",
  "cancelled",
  "failed",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = new Set<RunState>([
  "completed_consensus",
  "completed_disagreement",
  "cancelled",
  "failed",
]);

export const WORKER_STATES = [
  "not_started",
  "working",
  "waiting_handoff",
  "waiting_lease",
  "waiting_user_input",
  "waiting_permission",
  "paused_limit_known",
  "paused_limit_unknown",
  "failed_recoverable",
  "recovering",
  "replacing_context",
  "signed",
  "cancelled",
  "failed_terminal",
] as const;
export type WorkerStateName = (typeof WORKER_STATES)[number];

export type BillingRoute =
  | "subscription_allowance"
  | "existing_credits"
  | "blocked"
  | "unknown";

export interface BillingStatus {
  provider: ProviderRole;
  route: BillingRoute;
  authenticatedBy: "chatgpt" | "claude.ai" | "none" | "forbidden" | "unknown";
  plan: string | null;
  proof: string[];
  checkedAt: string;
  /**
   * True when this status was synthesised by a deterministic demo fixture
   * rather than observed from a provider. Simulated statuses must never
   * render as a proven route.
   */
  simulated?: boolean;
  usage?: {
    subscriptionUsedPercent: number | null;
    providerManagedCreditsPresent: boolean | null;
    providerManagedCreditBalanceAvailable: boolean | null;
    providerManagedCreditBalanceChangedSincePrevious: boolean | null;
    extraUsageEnabled: boolean | null;
    existingCreditsRemaining: boolean | null;
  };
  blockingPredicate?: string;
  remedy?: string;
}

export interface GoalPacket {
  id: string;
  runId: string;
  goal: string;
  workspace: string;
  constraints: string[];
  /**
   * Immutable, content-addressed references only. Attachment bytes are never
   * copied into prompts or the event store.
   */
  attachments?: Array<{
    path: string;
    sha256: string;
    size: number;
    mediaType: string;
  }>;
  authority: {
    writableRoots: string[];
    /**
     * Extra roots the agents may read (never write) without a card, beyond
     * the workspace itself. Absent on goals recorded before 2026-07-28.
     */
    readableRoots?: string[];
    network: "off" | "ask";
    /**
     * auto: workspace-contained writes and commands run without a card
     * (hazardous classes still ask). default: ask before the first
     * workspace mutation. read_only: mechanically deny all mutations.
     */
    permissionPreset: "auto" | "default" | "read_only";
  };
  stopConditions?: {
    maxDurationMinutes: number | null;
  };
  resourceMode?: "automatic" | "serialized";
  /** Immutable adviser opt-in; absent means disabled. */
  advisor?: AdvisorConfig;
  completionEvidence: string[];
  digest: string;
  createdAt: string;
  usefulWorkBudget: {
    perMaterialChallenge: number;
    perProvider: number;
  };
}

export interface PublicPacket {
  id: string;
  runId: string;
  type: PacketType;
  from: ProviderRole;
  to: ProviderRole | "both" | "user";
  parentIds: string[];
  affectedCriteria: string[];
  provenance: string[];
  rationale: string;
  body: unknown;
  material: boolean;
  createdAt: string;
}

export interface OutcomeManifest {
  runId: string;
  goalDigest: string;
  artifacts: Array<{
    path: string;
    sha256: string;
    mediaType: string;
  }>;
  evidenceLedger: string[];
  verification: Array<{
    command: string;
    outcome: "passed" | "failed" | "blocked";
    evidence: string;
  }>;
  knownLimitations: string[];
  unresolvedNonMaterial: string[];
}

export interface ActionCard {
  id: string;
  kind:
    | "preflight"
    | "permission"
    | "needs_input"
    | "limit"
    | "uncertain_effect"
    | "disagreement"
    | "budget_exhausted"
    | "billing_integrity";
  title: string;
  body: string;
  agent?: ProviderRole;
  command?: string;
  paths?: string[];
  reason?: string;
  sideEffect?: string;
  reversibility?: string;
  requiresDetailsFor?: string[];
  detailsLabel?: string;
  actions: string[];
}

/**
 * One live-observability line about what a provider is doing right now:
 * a tool invocation, a text fragment, or a lifecycle status. Entries are
 * transient (in-memory ring per run, streamed over SSE) — the durable
 * record stays the hash-chained event log; losing the feed on restart is
 * acceptable and expected.
 */
export interface AgentActivityEntry {
  seq: number;
  ts: string;
  runId: string;
  role: ProviderRole;
  kind: "tool" | "text" | "status";
  /** Redacted, length-capped human-readable line. */
  summary: string;
}

/**
 * Transient, per-run statement of which model a worker is actually running
 * on and at what reasoning effort, observed from provider responses (Codex
 * thread responses and reroute notifications; Claude session init). Same
 * lifecycle as the activity feed: in-memory, SSE-streamed, lost on restart.
 */
export interface AgentModelIdentity {
  runId: string;
  role: ProviderRole;
  model: string | null;
  /** null when the provider did not report an effort (CLI default applies). */
  effort: string | null;
  observedAt: string;
}

export type KernelEventType =
  | "goal_set"
  | "preflight_passed"
  | "preflight_blocked"
  | "worker_started"
  | "opening_committed"
  | "barrier_released"
  | "packet_posted"
  | "work_claimed"
  | "verification_run"
  | "candidate_posted"
  | "signoff"
  | "disagreement_declared"
  | "needs_input"
  | "permission_requested"
  | "permission_decided"
  | "paused_limit"
  | "resume_scheduled"
  | "resumed"
  | "retry_scheduled"
  | "incarnation_replaced"
  | "human_override"
  | "budget_extended"
  | "lease_acquired"
  | "lease_released"
  | "lease_waiting"
  | "uncertain_effect"
  | "billing_route_updated"
  | "billing_integrity_unknown"
  | "overhead_gate_breached"
  | "runtime_activity"
  | "advisor_trigger"
  | "advisor_requested"
  | "advisor_budget_extended"
  | "cancelled"
  | "completed"
  | "exported";

export interface StoredEvent<T = unknown> {
  seq: number;
  id: string;
  idempotencyKey: string;
  actor: Actor;
  type: KernelEventType;
  runId: string;
  ts: string;
  payload: T;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

export interface AppendCommand<T = unknown> {
  runId: string;
  actor: Actor;
  type: KernelEventType;
  idempotencyKey: string;
  payload: T;
  expectedSeq?: number;
  ts?: string;
}

export interface WorkerProjection {
  role: ProviderRole;
  state: WorkerStateName;
  activity: string | null;
  sessionId: string | null;
  incarnation: number;
  startedAt: string | null;
  lastRuntimeActivity: string | null;
  waitingLease?: {
    holder: string;
    reason: string;
    /** Canonical interactive-resource ids the worker is waiting for. */
    resources?: string[];
  };
}

export interface BudgetProjection {
  provider: Record<ProviderRole, { consumed: number; limit: number }>;
  issues: Record<string, { consumed: number; limit: number }>;
}

export interface RunProjection {
  runId: string;
  seq: number;
  state: RunState;
  goal: GoalPacket | null;
  workers: Record<ProviderRole, WorkerProjection>;
  openings: Record<ProviderRole, string | null>;
  barrierReleased: boolean;
  packets: PublicPacket[];
  candidate: { manifest: OutcomeManifest; digest: string; verificationDigest: string } | null;
  signoffs: Partial<
    Record<
      ProviderRole,
      {
        manifestDigest: string;
        verificationDigest: string;
        /** The model's own signing rationale; absent on pre-2026-07-29 events. */
        rationale?: string;
      }
    >
  >;
  materialChallenges: Record<string, { status: "open" | "resolved"; positions: string[] }>;
  actions: ActionCard[];
  budgets: BudgetProjection;
  billing: Partial<Record<ProviderRole, BillingStatus>>;
  overhead?: {
    ratio: number | null;
    coverageComplete: boolean;
    uncausedInvocations: number;
    passed: boolean;
    /** overhead-gate-v2 fields; absent on projections recorded before v2. */
    gateVersion?: string;
    passedBy?: "ratio" | "absolute" | null;
    total?: number;
    coordinationUpper?: number;
    usefulLower?: number;
    workerBurstCount?: number;
    coordinationTokenUpper?: number;
    mixedCoordinatorBytes?: number;
    absoluteAllowanceBytes?: number;
    absoluteEligible?: boolean;
    /**
     * True while the run is active: later useful work can repair the ratio
     * and later calls raise the aggregate allowance, so an active result is
     * never final and never blocks or interrupts anything.
     */
    provisional?: boolean;
  } | null;
  /**
   * Typed, non-blocking worker-loop overhead breach notice persisted at a
   * stable boundary. Never an ActionCard, never `needs_input`, and never a
   * run-state change.
   */
  /**
   * Adviser projection lane data derived from core trigger-fact events.
   * Adviser output itself lives only in the kernel adviser sidecar.
   */
  advisor?: {
    triggerCount: number;
    requestedCount: number;
    extendedReactiveWakeUnits: number;
    lastTrigger: { kind: string; conditionInstanceId: string; at: string } | null;
  } | null;
  overheadNotice?: {
    boundary: string;
    gateVersion: string;
    ratio: number | null;
    total: number;
    coordinationUpper: number;
    usefulLower: number;
    workerBurstCount: number;
    coordinationTokenUpper: number;
    mixedCoordinatorBytes: number;
    absoluteAllowanceBytes: number;
    absoluteEligible: boolean;
    recordedAt: string;
  } | null;
  completedAt: string | null;
}

export const ZERO_COST_WAKE_REASONS = [
  "transport_retry",
  "preflight",
  "limit_wait",
  "recovery",
  "permission_wait",
  "lease_wait",
  "context_replacement",
] as const;
export type WakeReason =
  | "addressed_event"
  | "user_action"
  | "trusted_timer"
  | "recovery_obligation"
  | (typeof ZERO_COST_WAKE_REASONS)[number];

export interface ReadyWorkItem {
  id: string;
  runId: string;
  role: ReadyRole;
  triggerEventId: string;
  triggerSeq: number;
  reason: WakeReason;
  issueId?: string;
  claimedAt?: string;
  /** Explicit completion for no-replay recovery; absent on legacy rows. */
  completedAt?: string;
  outcome?: string;
}
