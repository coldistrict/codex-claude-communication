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

  constructor(private readonly workspace: string) {}

  evaluate(request: PermissionRequest): { allowed: true } | { allowed: false; card: ActionCard } {
    if (
      request.classification === "read" &&
      request.paths.every((path) => within(this.workspace, path))
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
    return {
      allowed: false,
      card: {
        id: request.id,
        kind: "permission",
        title: `${request.role} requests ${request.classification.replaceAll("_", " ")}`,
        body: request.reason,
        agent: request.role,
        command: request.command ?? request.tool,
        paths: [...request.paths],
        reason: request.reason,
        sideEffect: request.sideEffect,
        reversibility: request.reversibility,
        actions: ALWAYS_ASK.has(request.classification)
          ? ["Allow once", "Deny", "Defer"]
          : ["Allow once", "Allow for task", "Deny", "Defer"],
      },
    };
  }

  decide(id: string, decision: PermissionDecision): PermissionRequest {
    const request = this.pending.get(id);
    if (!request) throw new Error(`UNKNOWN_PERMISSION_REQUEST:${id}`);
    if (
      decision.behavior === "allow" &&
      decision.scope === "task" &&
      !ALWAYS_ASK.has(request.classification) &&
      request.classification === "workspace_write"
    ) {
      const grants = this.writeGrants.get(request.role) ?? new Set<string>();
      for (const path of request.paths) {
        if (!within(this.workspace, path)) throw new Error("TASK_GRANT_OUTSIDE_WORKSPACE");
        grants.add(resolve(path));
      }
      this.writeGrants.set(request.role, grants);
    }
    if (decision.behavior !== "defer") this.pending.delete(id);
    return structuredClone(request);
  }

  pendingIds(): string[] {
    return [...this.pending.keys()].sort();
  }
}
