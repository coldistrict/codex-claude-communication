import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { KernelError } from "./errors.ts";

export interface LeaseOwner {
  runId: string;
  role: "codex" | "claude";
  incarnation: number;
  workItem: string;
}

/**
 * An exclusive interactive resource claim. Identities must come from trusted
 * product/runtime state (the registered browser controller), never from a
 * model-supplied label:
 * - `computer_use` is one machine-global resource (a shared desktop cannot
 *   be partitioned).
 * - A browser identity of kind `unverified` is the fail-safe: it maps to one
 *   global browser resource that conflicts with every other browser claim.
 * - `profile` identifies an existing signed-in browser profile/session; it is
 *   exclusive per id.
 * - `isolated_context` identifies a product-created browser context whose
 *   isolation the browser controller mechanically proved; distinct isolated
 *   contexts may run concurrently.
 */
export type InteractiveResourceClaim =
  | { class: "computer_use" }
  | {
      class: "browser";
      identity:
        | { kind: "unverified" }
        | { kind: "profile"; id: string }
        | { kind: "isolated_context"; id: string };
    };

export const GLOBAL_BROWSER_RESOURCE = "interactive:browser:global";
export const COMPUTER_USE_RESOURCE = "interactive:computer_use";

export function interactiveResourceId(claim: InteractiveResourceClaim): string {
  if (claim.class === "computer_use") return COMPUTER_USE_RESOURCE;
  const identity = claim.identity;
  if (identity.kind === "unverified") return GLOBAL_BROWSER_RESOURCE;
  if (identity.kind === "profile") {
    return `interactive:browser:profile:${identity.id}`;
  }
  return `interactive:browser:isolated:${identity.id}`;
}

function isBrowserResource(id: string): boolean {
  return id.startsWith("interactive:browser");
}

export function interactiveResourcesConflict(left: string, right: string): boolean {
  if (left === right) return true;
  if (isBrowserResource(left) && isBrowserResource(right)) {
    // The global browser resource is the fail-safe superset: it conflicts
    // with every browser identity, proven-isolated or not.
    return left === GLOBAL_BROWSER_RESOURCE || right === GLOBAL_BROWSER_RESOURCE;
  }
  return false;
}

export interface LeaseRequest {
  owner: LeaseOwner;
  workspace: string;
  targets: string[];
  dynamic: boolean;
  sandboxEnforcesRoots: boolean;
  heavy: boolean;
  reason: string;
  interactiveResources?: InteractiveResourceClaim[];
}

export interface Lease {
  id: string;
  owner: LeaseOwner;
  workspace: string;
  targets: string[];
  workspaceWide: boolean;
  heavy: boolean;
  reason: string;
  interactiveResources: string[];
  status: "held" | "uncertain";
  renewedAt: string;
}

function normalizeExisting(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...suffix);
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return (
    left.runId === right.runId &&
    left.role === right.role &&
    left.incarnation === right.incarnation &&
    left.workItem === right.workItem
  );
}

export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  private nextId = 1;

  acquire(request: LeaseRequest): { acquired: true; lease: Lease } | { acquired: false; holder: Lease; reason: string } {
    const workspace = normalizeExisting(request.workspace);
    const declared = request.targets.map(normalizeExisting).sort();
    if (declared.some((target) => !contains(workspace, target))) {
      throw new KernelError("PATH_EXPANSION", "Mutation target expands beyond the declared workspace", {
        workspace,
        targets: declared,
      });
    }
    // Interactive resource ids are canonicalized and lexically sorted; a
    // multi-resource request is evaluated and granted atomically in one
    // acquisition, so there is no partial hold to deadlock on.
    const interactiveResources = [
      ...new Set(
        (request.interactiveResources ?? []).map((claim) =>
          interactiveResourceId(claim),
        ),
      ),
    ].sort();
    // A resource-only request (for example a browser read) declares no
    // mutation targets and must not take a path lease at all.
    const pathRequest = declared.length > 0;
    const workspaceWide =
      pathRequest && (request.dynamic || !request.sandboxEnforcesRoots);
    const targets = workspaceWide ? [workspace] : declared;
    for (const held of this.leases.values()) {
      const pathConflict =
        pathRequest &&
        (workspaceWide ||
          (held.workspaceWide && held.targets.length > 0) ||
          targets.some((target) =>
            held.targets.some((other) => overlaps(target, other)),
          ));
      const resourceConflict = interactiveResources.some((requested) =>
        (held.interactiveResources ?? []).some((existing) =>
          interactiveResourcesConflict(requested, existing),
        ),
      );
      const conflict =
        pathConflict || resourceConflict || (request.heavy && held.heavy);
      if (conflict && !sameOwner(request.owner, held.owner)) {
        return { acquired: false, holder: structuredClone(held), reason: request.reason };
      }
    }
    const lease: Lease = {
      id: `lease_${this.nextId++}`,
      owner: structuredClone(request.owner),
      workspace,
      targets,
      workspaceWide,
      heavy: request.heavy,
      reason: request.reason,
      interactiveResources,
      status: "held",
      renewedAt: new Date().toISOString(),
    };
    this.leases.set(lease.id, lease);
    return { acquired: true, lease: structuredClone(lease) };
  }

  renew(id: string, owner: LeaseOwner, structuredActivityAt: string): Lease {
    const lease = this.requireOwner(id, owner);
    lease.renewedAt = structuredActivityAt;
    return structuredClone(lease);
  }

  markUncertain(id: string, owner: LeaseOwner): Lease {
    const lease = this.requireOwner(id, owner);
    lease.status = "uncertain";
    return structuredClone(lease);
  }

  release(id: string, owner: LeaseOwner, reconciliation: "certain" | "uncertain"): void {
    const lease = this.requireOwner(id, owner);
    if (lease.status === "uncertain" || reconciliation === "uncertain") {
      lease.status = "uncertain";
      throw new KernelError(
        "LEASE_CONFLICT",
        "Uncertain side effects require user resolution before lease release",
      );
    }
    this.leases.delete(id);
  }

  held(): Lease[] {
    return [...this.leases.values()].map((lease) => structuredClone(lease));
  }

  private requireOwner(id: string, owner: LeaseOwner): Lease {
    const lease = this.leases.get(id);
    if (!lease || !sameOwner(lease.owner, owner)) {
      throw new KernelError("LEASE_OWNER_MISMATCH", "Stale incarnation cannot renew or release lease");
    }
    return lease;
  }
}
