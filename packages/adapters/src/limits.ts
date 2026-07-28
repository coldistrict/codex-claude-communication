import type { ProviderRole } from "@collab/contracts";

export type LimitClassification =
  | { state: "paused_limit_known"; resetsAt: number; source: string; untrustedHint?: string }
  | { state: "paused_limit_unknown"; source: string; untrustedHint?: string }
  | { state: "retry_scheduled"; delayMs: number; source: "supervisor-policy"; attempt: number }
  | { state: "needs_human"; source: string }
  | { state: "context_replacement"; source: string };

export interface LimitSignal {
  provider: ProviderRole;
  kind:
    | "usage_limit"
    | "rate_limit"
    | "overloaded"
    | "server_error"
    | "billing_error"
    | "authentication_failed"
    | "oauth_org_not_allowed"
    | "unauthorized"
    | "context_exhausted";
  structuredResetAt?: number | null;
  renderedText?: string;
  source: string;
}

const RETRY_DELAYS = [30_000, 120_000, 480_000];

export function classifyLimit(signal: LimitSignal, attempt = 0): LimitClassification {
  if (signal.kind === "context_exhausted") {
    return { state: "context_replacement", source: signal.source };
  }
  if (signal.kind === "usage_limit" && typeof signal.structuredResetAt === "number") {
    return {
      state: "paused_limit_known",
      resetsAt: signal.structuredResetAt,
      source: signal.source,
      ...(signal.renderedText ? { untrustedHint: signal.renderedText } : {}),
    };
  }
  if (["rate_limit", "overloaded", "server_error"].includes(signal.kind)) {
    const delayMs = RETRY_DELAYS[attempt];
    if (delayMs !== undefined) {
      return {
        state: "retry_scheduled",
        delayMs,
        source: "supervisor-policy",
        attempt,
      };
    }
    return { state: "needs_human", source: signal.source };
  }
  return {
    state: "paused_limit_unknown",
    source: signal.source,
    ...(signal.renderedText ? { untrustedHint: signal.renderedText } : {}),
  };
}
