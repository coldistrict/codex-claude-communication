export type KernelErrorCode =
  | "ACTOR_FORBIDDEN"
  | "BARRIER_CLOSED"
  | "BUDGET_EXHAUSTED"
  | "DUPLICATE_CONFLICT"
  | "INVALID_EVENT"
  | "INVALID_STATE"
  | "LEASE_CONFLICT"
  | "LEASE_OWNER_MISMATCH"
  | "MANIFEST_MISMATCH"
  | "PATH_EXPANSION"
  | "STALE_SEQUENCE"
  | "TERMINAL_RUN"
  | "UNRESOLVED_CHALLENGE";

export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KernelError";
  }
}
