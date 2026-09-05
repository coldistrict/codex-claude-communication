import { resolve, sep } from "node:path";
import type { ActionCard, ProviderRole } from "@collab/contracts";

export type PermissionClass =
  | "read"
  | "workspace_write"
  | "destructive"
  | "install"
  | "network"
  | "external_communication"
  | "outside_workspace"
  | "system_change"
  | "payment"
  | "public_action"
  | "uncertain_replay";

export interface PermissionRequest {
  id: string;
  role: ProviderRole;
  tool: string;
  command?: string;
  paths: string[];
  domains?: string[];
  reason: string;
  sideEffect: string;
  reversibility: string;
  classification: PermissionClass;
}

export interface PermissionDecision {
  behavior: "allow" | "deny" | "modify" | "defer";
  scope: "once" | "task";
  modifiedInput?: Record<string, unknown>;
}

function within(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

const ALWAYS_ASK = new Set<PermissionClass>([
  "destructive",
  "install",
  "network",
  "external_communication",
  "outside_workspace",
  "system_change",
  "payment",
  "public_action",
  "uncertain_replay",
]);

export class ApprovalBridge {
  private readonly writeGrants = new Map<string, Set<string>>();
  private readonly pending = new Map<string, PermissionRequest>();

  constructor(
    private readonly workspace: string,
    /** Read-only auto-allow extends to these; write grants never do. */
    private readonly readableRoots: string[] = [],
  ) {}

  evaluate(request: PermissionRequest): { allowed: true } | { allowed: false; card: ActionCard } {
    if (
      request.classification === "read" &&
      request.paths.every((path) =>
        [this.workspace, ...this.readableRoots].some((root) => within(root, path)),
      )
    ) {
      return { allowed: true };
    }
    if (
      request.classification === "workspace_write" &&
      request.paths.every((path) => within(this.workspace, path)) &&
      request.paths.every((path) => this.writeGrants.get(request.role)?.has(resolve(path)))
    ) {
      return { allowed: true };
    }
    this.pending.set(request.id, structuredClone(request));
    // Task scope must never be offered when it could not be honored: a
    // task-wide write grant is only meaningful for paths inside the
    // workspace, whatever classification the caller supplied.
    const taskScopeUnavailable =
      ALWAYS_ASK.has(request.classification) ||
      !request.paths.every((path) => within(this.workspace, path));
    return {
      allowed: false,
      card: {
        id: request.id,
        kind: "permission",
        title: `${request.role} requests ${request.classification.replaceAll("_", " ")}`,
        body:
          request.classification === "outside_workspace"
            ? `${request.reason}\n\nTip: if you trust this location, add its folder to “Additional read-only folders” when creating a run and reads there will proceed without asking.`
            : request.reason,
        agent: request.role,
        command: request.command ?? request.tool,
        paths: [...request.paths],
        reason: request.reason,
        sideEffect: request.sideEffect,
        reversibility: request.reversibility,
        actions: taskScopeUnavailable
          ? ["Allow once", "Deny", "Defer"]
          : ["Allow once", "Allow for task", "Deny", "Defer"],
      },
    };
  }

  decide(
    id: string,
    decision: PermissionDecision,
  ): { request: PermissionRequest; decision: PermissionDecision } {
    const request = this.pending.get(id);
    if (!request) throw new Error(`UNKNOWN_PERMISSION_REQUEST:${id}`);
    // Task scope is only honored where a task-wide grant is meaningful:
    // a workspace_write whose every path is inside the workspace. Anything
    // else silently narrows to a one-time allowance — including requests
    // arriving through the API with a scope the card never offered.
    const effective: PermissionDecision =
      decision.scope === "task" &&
      (ALWAYS_ASK.has(request.classification) ||
        request.classification !== "workspace_write" ||
        !request.paths.every((path) => within(this.workspace, path)))
        ? { ...decision, scope: "once" }
        : decision;
    if (effective.behavior === "allow" && effective.scope === "task") {
      const grants = this.writeGrants.get(request.role) ?? new Set<string>();
      for (const path of request.paths) {
        grants.add(resolve(path));
      }
      this.writeGrants.set(request.role, grants);
    }
    if (effective.behavior !== "defer") this.pending.delete(id);
    return { request: structuredClone(request), decision: effective };
  }

  pendingIds(): string[] {
    return [...this.pending.keys()].sort();
  }
}
