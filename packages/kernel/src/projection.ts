import {
  PROVIDER_ROLES,
  TERMINAL_RUN_STATES,
  type ActionCard,
  type GoalPacket,
  type ProviderRole,
  type PublicPacket,
  type RunProjection,
  type StoredEvent,
} from "@collab/contracts";
import { initialPlanning, assessDocument } from './documents.ts';

export const DEFAULT_CHALLENGE_BUDGET = 4;
export const DEFAULT_PROVIDER_BUDGET = 24;

export function initialProjection(runId: string): RunProjection {
  return {
    runId,
    seq: 0,
    state: "draft",
    goal: null,
    workers: {
      codex: {
        role: "codex",
        state: "not_started",
        activity: null,
        sessionId: null,
        incarnation: 0,
        startedAt: null,
        lastRuntimeActivity: null,
      },
      claude: {
        role: "claude",
        state: "not_started",
        activity: null,
        sessionId: null,
        incarnation: 0,
        startedAt: null,
        lastRuntimeActivity: null,
      },
    },
    openings: { codex: null, claude: null },
    barrierReleased: false,
    packets: [],
    candidate: null,
    signoffs: {},
    materialChallenges: {},
    actions: [],
    budgets: {
      provider: {
        codex: { consumed: 0, limit: DEFAULT_PROVIDER_BUDGET },
        claude: { consumed: 0, limit: DEFAULT_PROVIDER_BUDGET },
      },
      issues: {},
    },
    billing: {},
    completedAt: null,
  };
}

function provider(actor: string): actor is ProviderRole {
  return PROVIDER_ROLES.includes(actor as ProviderRole);
}

function replaceAction(actions: ActionCard[], card: ActionCard): ActionCard[] {
  return [...actions.filter((action) => action.id !== card.id), card];
}

export function applyEvent(current: RunProjection, event: StoredEvent): RunProjection {
  const next = structuredClone(current);
  next.seq = event.seq;
  const payload = event.payload as Record<string, any>;

  switch (event.type) {
    case "goal_set": {
      next.goal = payload.goal as GoalPacket;
      if (next.goal.workflow === 'planning') next.planning = initialPlanning();
      const budget = next.goal.usefulWorkBudget;
      for (const role of PROVIDER_ROLES) next.budgets.provider[role].limit = budget.perProvider;
      next.state = "starting";
      break;
    }
    case "preflight_passed":
      if (payload.billing && provider(payload.billing.provider)) {
        const role = payload.billing.provider as ProviderRole;
        next.billing[role] = payload.billing;
      }
      next.actions = next.actions.filter(
        (action) => !(action.kind === "preflight" && action.agent === payload.provider),
      );
      next.state = next.actions.some((action) => action.kind === "preflight")
        ? "preflight_blocked"
        : "starting";
      break;
    case "preflight_blocked":
      next.state = "preflight_blocked";
      next.actions = replaceAction(next.actions, payload.card as ActionCard);
      if (payload.billing && provider(payload.billing.provider)) {
        const role = payload.billing.provider as ProviderRole;
        next.billing[role] = payload.billing;
      }
      break;
    case "billing_route_updated":
      if (provider(payload.status?.provider)) {
        const role = payload.status.provider as ProviderRole;
        next.billing[role] = payload.status;
      }
      break;
    case "billing_integrity_unknown":
      next.state = "billing_integrity_unknown";
      next.actions = replaceAction(next.actions, payload.card as ActionCard);
      break;
    case "worker_started": {
      const role = payload.role as ProviderRole;
      next.state = next.barrierReleased ? "negotiating" : "investigating";
      next.workers[role] = {
        ...next.workers[role],
        state: "working",
        activity: payload.activity ?? "analysing",
        sessionId: payload.sessionId ?? null,
        startedAt: event.ts,
        lastRuntimeActivity: event.ts,
        incarnation: payload.incarnation ?? next.workers[role].incarnation + 1,
      };
      break;
    }
    case "opening_committed": {
      const role = event.actor as ProviderRole;
      next.openings[role] = payload.packetId;
      next.workers[role].state = "waiting_handoff";
      break;
    }
    case "barrier_released":
      next.barrierReleased = true;
      next.state = "negotiating";
      break;
    case "packet_posted": {
      const packet = payload.packet as PublicPacket;
      next.packets.push(packet);
      if (packet.type === "challenge" && packet.material) {
        next.materialChallenges[packet.id] = { status: "open", positions: [packet.rationale] };
        next.budgets.issues[packet.id] = {
          consumed: 0,
          limit: next.goal?.usefulWorkBudget.perMaterialChallenge ?? DEFAULT_CHALLENGE_BUDGET,
        };
      }
      if (packet.type === "decision" && payload.resolvesChallengeId) {
        const challenge = next.materialChallenges[payload.resolvesChallengeId];
        if (challenge) challenge.status = "resolved";
      }
      break;
    }
    case "work_claimed": {
      const role = payload.role as ProviderRole;
      if (payload.chargeBudget) {
        next.budgets.provider[role].consumed += 1;
        if (payload.issueId) next.budgets.issues[payload.issueId]!.consumed += 1;
      }
      next.workers[role].state = "working";
      next.workers[role].activity = payload.activity ?? "working";
      next.workers[role].lastRuntimeActivity = event.ts;
      break;
    }
    case "lease_waiting": {
      const role = payload.role as ProviderRole;
      next.workers[role].state = "waiting_lease";
      next.workers[role].waitingLease = {
        holder: payload.holder,
        reason: payload.reason,
        ...(Array.isArray(payload.resources) && payload.resources.length
          ? { resources: payload.resources }
          : {}),
      };
      break;
    }
    case "permission_requested":
    case "needs_input":
    case "uncertain_effect":
      next.state = "waiting_user";
      next.actions = replaceAction(next.actions, payload.card as ActionCard);
      if (provider(payload.role)) {
        next.workers[payload.role].state =
          event.type === "permission_requested" ? "waiting_permission" : "waiting_user_input";
      }
      break;
    case "permission_decided":
      next.actions = next.actions.filter((action) => action.id !== payload.cardId);
      if (provider(payload.role)) next.workers[payload.role].state = "waiting_handoff";
      break;
    case "paused_limit": {
      const role = payload.role as ProviderRole;
      next.state = "paused";
      next.workers[role].state = payload.resetsAt ? "paused_limit_known" : "paused_limit_unknown";
      next.actions = replaceAction(next.actions, payload.card as ActionCard);
      break;
    }
    case "resumed": {
      const role = payload.role as ProviderRole;
      next.workers[role].state = "working";
      next.workers[role].lastRuntimeActivity = event.ts;
      next.state = "negotiating";
      break;
    }
    case "candidate_posted":
      next.signoffs = {};
      next.candidate = {
        manifest: payload.manifest,
        digest: payload.digest,
        verificationDigest: payload.verificationDigest,
      };
      next.state = "verifying";
      break;
    case 'planning_context':
      next.planning!.context = payload.context;
      next.planning!.contextNotes = payload.notes;
      break;
    case 'planning_step':
      next.planning!.steps.push(payload.step);
      next.workers[payload.step.role as ProviderRole].state = 'waiting_handoff';
      break;
    case 'document_posted':
      next.planning!.documents.push(payload.document);
      next.planning!.status = 'working';
      next.planning!.agreement = 'pending';
      next.planning!.fulfillment = 'pending';
      next.signoffs = {};
      next.state = 'verifying';
      break;
    case 'document_reviewed':
      next.planning!.reviews.push(payload.review);
      Object.assign(next.planning!, assessDocument(next.planning!, next.goal!.completionEvidence));
      break;
    case 'clarification_answered':
      next.planning!.answers.push({ cardId: payload.cardId, question: payload.question, answer: payload.answer });
      next.planning!.status = 'working'; next.planning!.agreement = 'pending'; next.planning!.fulfillment = 'pending';
      next.openings = { codex: null, claude: null }; next.barrierReleased = false;
      next.actions = next.actions.filter(a => a.id !== payload.cardId);
      next.state = 'negotiating';
      break;
    case 'planning_extension':
      next.planning!.extensionFocus = payload.focus;
      next.actions = next.actions.filter(a => a.id !== payload.cardId);
      next.state = 'negotiating';
      break;
    case 'planning_finished':
      Object.assign(next.planning!, assessDocument(next.planning!, next.goal!.completionEvidence));
      next.state = next.planning!.status === 'ready' ? 'completed_consensus' : 'completed_disagreement';
      next.completedAt = event.ts;
      break;
    case "signoff": {
      const role = event.actor as ProviderRole;
      next.signoffs[role] = {
        manifestDigest: payload.manifestDigest,
        verificationDigest: payload.verificationDigest,
        ...(payload.rationale ? { rationale: String(payload.rationale) } : {}),
      };
      next.workers[role].state = "signed";
      break;
    }
    case "disagreement_declared":
      next.state = "waiting_user";
      next.actions = replaceAction(next.actions, payload.card as ActionCard);
      break;
    case "budget_extended": {
      if (payload.issueId) next.budgets.issues[payload.issueId]!.limit += payload.units;
      if (payload.role) next.budgets.provider[payload.role as ProviderRole].limit += payload.units;
      next.actions = next.actions.filter((action) => action.id !== payload.cardId);
      next.state = "negotiating";
      break;
    }
    case "incarnation_replaced": {
      const role = payload.role as ProviderRole;
      next.workers[role].incarnation += 1;
      next.workers[role].state = "replacing_context";
      if (payload.cardId) {
        next.actions = next.actions.filter((action) => action.id !== payload.cardId);
      }
      break;
    }
    case "cancelled":
      next.state = "cancelled";
      for (const role of PROVIDER_ROLES) next.workers[role].state = "cancelled";
      next.completedAt = event.ts;
      break;
    case "completed":
      next.state = payload.outcome;
      next.completedAt = event.ts;
      break;
    case "human_override":
      if (payload.cardId) {
        next.actions = next.actions.filter((action) => action.id !== payload.cardId);
      }
      if (payload.decision === "retry_collaboration") {
        // Retrying is the user's reconciliation of the workspace state as a
        // whole. A stale sibling reconciliation card (e.g. one from restart
        // recovery for the same lease) must not survive to cancel the
        // healthy resumed run with a later click.
        next.actions = next.actions.filter(
          (action) => action.kind !== "uncertain_effect",
        );
      }
      if (!TERMINAL_RUN_STATES.has(next.state)) next.state = "negotiating";
      break;
    case "runtime_activity": {
      // Coalesced, text-free provider activity fact (at most one per 30 s per
      // provider). It proves liveness for the stall detector; it changes no
      // state and carries no message content.
      const role = payload.role as ProviderRole;
      if (provider(role)) next.workers[role].lastRuntimeActivity = event.ts;
      break;
    }
    case "advisor_trigger": {
      const advisor = (next.advisor ??= {
        triggerCount: 0,
        requestedCount: 0,
        extendedReactiveWakeUnits: 0,
        lastTrigger: null,
      });
      advisor.triggerCount += 1;
      advisor.lastTrigger = {
        kind: String(payload.trigger ?? "unknown"),
        conditionInstanceId: String(payload.conditionInstanceId ?? ""),
        at: event.ts,
      };
      break;
    }
    case "advisor_requested": {
      const advisor = (next.advisor ??= {
        triggerCount: 0,
        requestedCount: 0,
        extendedReactiveWakeUnits: 0,
        lastTrigger: null,
      });
      advisor.requestedCount += 1;
      break;
    }
    case "advisor_budget_extended": {
      const advisor = (next.advisor ??= {
        triggerCount: 0,
        requestedCount: 0,
        extendedReactiveWakeUnits: 0,
        lastTrigger: null,
      });
      advisor.extendedReactiveWakeUnits += Number(payload.units ?? 0);
      break;
    }
    case "overhead_gate_breached":
      // A typed, non-blocking notice: it never creates an ActionCard, never
      // uses needs_input, and never changes the core run or worker states.
      next.overheadNotice = {
        boundary: String(payload.boundary ?? "unknown"),
        gateVersion: String(payload.gateVersion ?? ""),
        ratio: typeof payload.ratio === "number" ? payload.ratio : null,
        total: Number(payload.total ?? 0),
        coordinationUpper: Number(payload.coordinationUpper ?? 0),
        usefulLower: Number(payload.usefulLower ?? 0),
        workerBurstCount: Number(payload.workerBurstCount ?? 0),
        coordinationTokenUpper: Number(payload.coordinationTokenUpper ?? 0),
        mixedCoordinatorBytes: Number(payload.mixedCoordinatorBytes ?? 0),
        absoluteAllowanceBytes: Number(payload.absoluteAllowanceBytes ?? 0),
        absoluteEligible: Boolean(payload.absoluteEligible),
        recordedAt: event.ts,
      };
      break;
    case "resume_scheduled":
    case "retry_scheduled":
    case "verification_run":
    case "exported":
      break;
  }

  if (TERMINAL_RUN_STATES.has(next.state)) {
    next.actions = [];
  }
  return next;
}

export function replay(runId: string, events: StoredEvent[]): RunProjection {
  return events.reduce(applyEvent, initialProjection(runId));
}
