import type { BillingStatus, ProviderRole } from "@collab/contracts";

export const FORBIDDEN_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
] as const;

export const FORBIDDEN_FLAGS = [
  "--bare",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--fallback-model",
  "--no-session-persistence",
  "--ephemeral",
  "bypassPermissions",
] as const;

export const FORBIDDEN_CODEX_METHODS = new Set([
  "account/rateLimitResetCredit/consume",
  "account/sendAddCreditsNudgeEmail",
  "account/login/start:apiKey",
]);

export interface ScrubbedEnvironment {
  env: NodeJS.ProcessEnv;
  forbiddenPresent: string[];
}

export function scrubProviderEnvironment(source: NodeJS.ProcessEnv): ScrubbedEnvironment {
  const env = { ...source };
  const forbiddenPresent: string[] = [];
  for (const name of FORBIDDEN_ENV_NAMES) {
    if (env[name] !== undefined) forbiddenPresent.push(name);
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (
      (upper.includes("OPENAI") || upper.includes("ANTHROPIC") || upper.includes("CLAUDE")) &&
      (upper.includes("BASE_URL") || upper.includes("MODEL_PROVIDER"))
    ) {
      forbiddenPresent.push(name);
      delete env[name];
    }
  }
  return { env, forbiddenPresent: [...new Set(forbiddenPresent)].sort() };
}

export function auditSpawnArgs(args: readonly string[]): string[] {
  return args.filter((arg) =>
    FORBIDDEN_FLAGS.some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`)),
  );
}

export interface PreflightResult {
  ok: boolean;
  provider: ProviderRole;
  trace: string[];
  billing: BillingStatus;
  predicate?: string;
  remedy?: string;
}

export interface CodexPreflightInput {
  versionMatches: boolean;
  schemaMatches: boolean;
  forbiddenEnvironment: readonly string[];
  spawnArgs: readonly string[];
  effectiveProviderOverride: boolean;
  effectiveProviderOverrideDetails?: readonly string[];
  account: {
    type: string;
    planType?: string | null;
    requiresOpenaiAuth: boolean;
  } | null;
  rateLimits: {
    structurallyTrusted: boolean;
    planType?: string | null;
    primary?: {
      usedPercent?: number | null;
      resetsAt?: number | null;
    } | null;
    secondary?: {
      usedPercent?: number | null;
      resetsAt?: number | null;
    } | null;
    credits?: {
      hasCredits: boolean;
      unlimited: boolean;
      balance?: string | null;
    } | null;
    rateLimitReachedType?: string | null;
    spendControlReached?: boolean | null;
  } | null;
  subscriptionsRegistered: boolean;
}

export interface ClaudePreflightInput {
  versionMatches: boolean;
  sdkMatches: boolean;
  forbiddenEnvironment: readonly string[];
  spawnArgs: readonly string[];
  apiKeyHelperPresent: boolean;
  effectiveProviderOverride: boolean;
  auth: {
    loggedIn: boolean;
    authMethod: string;
    apiProvider: string;
    subscriptionType?: string | null;
    apiKeySource?: string | null;
    tokenSource?: string | null;
  } | null;
  billing: {
    includedUsageRemaining?: boolean | null;
    extraUsageEnabled?: boolean | null;
    existingCreditsRemaining?: boolean | null;
    currentRoute?: "subscription_allowance" | "existing_credits" | null;
  };
  subscriptionsRegistered: boolean;
}

const PAID_CODEX_PLANS = new Set(["plus", "pro", "prolite", "team", "business", "enterprise", "edu"]);
const PAID_CLAUDE_PLANS = new Set(["pro", "max", "team", "enterprise"]);

function block(
  provider: ProviderRole,
  trace: string[],
  predicate: string,
  remedy: string,
  plan: string | null,
): PreflightResult {
  return {
    ok: false,
    provider,
    trace,
    predicate,
    remedy,
    billing: {
      provider,
      route: "blocked",
      authenticatedBy: "unknown",
      plan,
      proof: [...trace],
      checkedAt: new Date().toISOString(),
      blockingPredicate: predicate,
      remedy,
    },
  };
}

export function evaluateCodexPreflight(input: CodexPreflightInput): PreflightResult {
  const trace: string[] = [];
  trace.push("1:pins");
  if (!input.versionMatches || !input.schemaMatches) {
    return block("codex", trace, "codex.pin_drift", "Install or approve the pinned Codex adapter version.", null);
  }
  trace.push("2:environment");
  if (input.forbiddenEnvironment.length || input.effectiveProviderOverride) {
    const result = block(
      "codex",
      trace,
      `codex.forbidden_environment:${
        [
          ...input.forbiddenEnvironment,
          ...(input.effectiveProviderOverrideDetails ?? []),
          ...(input.effectiveProviderOverride &&
          !(input.effectiveProviderOverrideDetails?.length)
            ? ["provider_override"]
            : []),
        ].join(",")
      }`,
      "Remove API-key and custom-provider routing from the launch environment, then retry preflight.",
      null,
    );
    result.billing.authenticatedBy = "forbidden";
    return result;
  }
  trace.push("3:spawn_args");
  const forbiddenArgs = auditSpawnArgs(input.spawnArgs);
  if (forbiddenArgs.length) {
    return block("codex", trace, `codex.forbidden_flags:${forbiddenArgs.join(",")}`, "Use the pinned standard-tier spawn arguments.", null);
  }
  trace.push("4:subscription_auth");
  if (
    !input.account ||
    input.account.type !== "chatgpt" ||
    !input.account.requiresOpenaiAuth
  ) {
    const result = block("codex", trace, "codex.subscription_auth_unproven", "Complete official `codex login` with a paid ChatGPT plan, then retry preflight.", input.account?.planType ?? null);
    result.billing.authenticatedBy =
      input.account && input.account.type !== "chatgpt" ? "forbidden" : "none";
    return result;
  }
  if (!input.account.planType || !PAID_CODEX_PLANS.has(input.account.planType)) {
    const result = block('codex', trace, 'codex.unknown_subscription_plan', 'The account is signed in, but this plan identifier has not been validated for subscription billing. Update the adapter compatibility policy using official plan/schema evidence; logging in again is not the default remedy.', input.account.planType ?? null);
    result.billing.authenticatedBy = 'chatgpt'; return result;
  }
  trace.push("5:billing_route");
  const limits = input.rateLimits;
  const windowComplete = (
    window: { usedPercent?: number | null } | null | undefined,
  ): window is { usedPercent: number } =>
    Boolean(
      window &&
        typeof window.usedPercent === "number" &&
        Number.isFinite(window.usedPercent),
    );
  // The pinned schema defines both windows; the secondary window is optional
  // in responses, but when present it must be structurally complete and is
  // evaluated exactly like the primary window.
  if (
    !limits ||
    !limits.structurallyTrusted ||
    !windowComplete(limits.primary) ||
    (limits.secondary !== null &&
      limits.secondary !== undefined &&
      !windowComplete(limits.secondary)) ||
    limits.spendControlReached === true
  ) {
    return block(
      "codex",
      trace,
      "codex.billing_route_unproven",
      "Retry when structurally complete account/rate-limit metadata is available.",
      input.account.planType,
    );
  }
  if (limits.planType && limits.planType !== input.account.planType) return block('codex', trace, 'codex.billing_metadata_changed', 'Account and rate-limit plans disagree. Refresh provider metadata before starting a turn.', input.account.planType);
  const secondary = windowComplete(limits.secondary) ? limits.secondary : null;
  const includedLimitReached =
    limits.primary.usedPercent >= 100 ||
    (secondary !== null && secondary.usedPercent >= 100) ||
    Boolean(limits.rateLimitReachedType);
  let route: "subscription_allowance" | "existing_credits";
  if (!includedLimitReached) {
    route = "subscription_allowance";
  } else if (limits.credits?.hasCredits === true) {
    route = "existing_credits";
  } else {
    return block(
      "codex",
      trace,
      "codex.subscription_limit_reached_without_existing_credits",
      "Wait for the structured subscription reset time; the product will not purchase or reset credits.",
      input.account.planType,
    );
  }
  trace.push("6:provider_credit_policy");
  // The provider documents subscription allowance first, then existing credits.
  // Presence of credits is intentionally not a block under the user's updated policy.
  trace.push("7:subscriptions");
  if (!input.subscriptionsRegistered) {
    return block("codex", trace, "codex.account_subscriptions_missing", "Reconnect app-server and retry the full preflight.", input.account.planType);
  }
  return {
    ok: true,
    provider: "codex",
    trace,
    billing: {
      provider: "codex",
      route,
      authenticatedBy: "chatgpt",
      plan: input.account.planType,
      proof: [
        "account/read type=chatgpt",
        `paid plan=${input.account.planType}`,
        `primary.usedPercent=${limits.primary.usedPercent}`,
        secondary === null
          ? "secondary window absent in provider response"
          : `secondary.usedPercent=${secondary.usedPercent}`,
        `credits.hasCredits=${String(limits.credits?.hasCredits ?? false)}`,
        "provider policy: subscription allowance is consumed before existing credits",
        "purchase, top-up, add-credits, and reset-credit methods are absent from the adapter",
      ],
      usage: {
        subscriptionUsedPercent: limits.primary.usedPercent,
        providerManagedCreditsPresent: limits.credits?.hasCredits ?? false,
        providerManagedCreditBalanceAvailable:
          limits.credits?.balance !== null &&
          limits.credits?.balance !== undefined,
        providerManagedCreditBalanceChangedSincePrevious: null,
        extraUsageEnabled: null,
        existingCreditsRemaining: limits.credits?.hasCredits ?? false,
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

export function evaluateClaudePreflight(input: ClaudePreflightInput): PreflightResult {
  const trace: string[] = [];
  trace.push("1:pins");
  if (!input.versionMatches || !input.sdkMatches) {
    return block("claude", trace, "claude.pin_drift", "Use the pinned official Agent SDK and bundled CLI.", null);
  }
  trace.push("2:environment");
  if (
    input.forbiddenEnvironment.length ||
    input.apiKeyHelperPresent ||
    input.effectiveProviderOverride
  ) {
    const result = block(
      "claude",
      trace,
      `claude.forbidden_auth_route:${[
        ...input.forbiddenEnvironment,
        ...(input.apiKeyHelperPresent ? ["apiKeyHelper"] : []),
        ...(input.effectiveProviderOverride ? ["provider_override"] : []),
      ].join(",")}`,
      "Remove API-key, Console, helper, cloud, and custom-provider routing, then retry preflight.",
      input.auth?.subscriptionType ?? null,
    );
    result.billing.authenticatedBy = "forbidden";
    return result;
  }
  trace.push("3:spawn_args");
  const forbiddenArgs = auditSpawnArgs(input.spawnArgs);
  if (forbiddenArgs.length) {
    return block("claude", trace, `claude.forbidden_flags:${forbiddenArgs.join(",")}`, "Use the SDK runtime with pinned safe options.", input.auth?.subscriptionType ?? null);
  }
  trace.push("4:subscription_auth");
  // Plan §5.1.4 approves exactly authMethod === "claude.ai". This machine's
  // pinned runtime reports "claude.ai" when logged in and "none" when logged
  // out; no primary evidence exists that it emits any other subscription
  // value, so anything else fails closed.
  if (
    !input.auth?.loggedIn ||
    input.auth.authMethod !== "claude.ai" ||
    input.auth.apiProvider !== "firstParty" ||
    (input.auth.apiKeySource !== undefined &&
      input.auth.apiKeySource !== null &&
      !["none", "subscription"].includes(input.auth.apiKeySource))
  ) {
    const result = block(
      "claude",
      trace,
      "claude.subscription_oauth_unavailable",
      "Complete the official Claude subscription login flow, then select Retry preflight. No API key is accepted.",
      input.auth?.subscriptionType ?? null,
    );
    result.billing.authenticatedBy =
      input.auth?.loggedIn &&
      (input.auth.authMethod !== "claude.ai" ||
        input.auth.apiProvider !== "firstParty")
        ? "forbidden"
        : "none";
    return result;
  }
  if (!input.auth.subscriptionType || !PAID_CLAUDE_PLANS.has(input.auth.subscriptionType.toLowerCase())) {
    const result = block('claude', trace, 'claude.unknown_subscription_plan', 'The account is signed in but the plan identifier is absent or unknown. Refresh metadata or validate the changed provider schema.', input.auth.subscriptionType ?? null);
    result.billing.authenticatedBy = 'claude.ai'; return result;
  }
  trace.push("5:billing_route");
  if (input.billing.includedUsageRemaining === false && input.billing.currentRoute !== 'existing_credits') return block('claude', trace, 'claude.subscription_limit_reached', 'Wait for the subscription allowance to reset. No paid fallback or reset credits will be used.', input.auth.subscriptionType);
  let route: "subscription_allowance" | "existing_credits";
  if (
    input.billing.currentRoute === "subscription_allowance" &&
    input.billing.includedUsageRemaining === true
  ) {
    route = "subscription_allowance";
  } else if (
    input.billing.currentRoute === "existing_credits" &&
    input.billing.extraUsageEnabled === true &&
    input.billing.includedUsageRemaining === false &&
    input.billing.existingCreditsRemaining === true
  ) {
    route = "existing_credits";
  } else {
    return block(
      "claude",
      trace,
      "claude.billing_route_unproven",
      "Retry when structured metadata distinguishes subscription allowance from existing credits.",
      input.auth.subscriptionType,
    );
  }
  trace.push("6:documented_plan_posture");
  trace.push("7:subscriptions");
  if (!input.subscriptionsRegistered) {
    return block("claude", trace, "claude.rate_limit_subscription_missing", "Restart the SDK runtime and retry the full preflight.", input.auth.subscriptionType);
  }
  return {
    ok: true,
    provider: "claude",
    trace,
    billing: {
      provider: "claude",
      route,
      authenticatedBy: "claude.ai",
      plan: input.auth.subscriptionType,
      proof: [
        "official SDK bundled CLI auth status loggedIn=true",
        "authMethod=claude.ai",
        "apiProvider=firstParty",
        `subscriptionType=${input.auth.subscriptionType}`,
        `includedUsageRemaining=${String(input.billing.includedUsageRemaining)}`,
        `extraUsageEnabled=${String(input.billing.extraUsageEnabled ?? false)}`,
        `existingCreditsRemaining=${String(input.billing.existingCreditsRemaining)}`,
        "API-key, Console, cloud, and custom-provider routes removed",
        "product never purchases credits or enables top-ups",
      ],
      usage: {
        subscriptionUsedPercent: null,
        providerManagedCreditsPresent:
          input.billing.existingCreditsRemaining ?? null,
        providerManagedCreditBalanceAvailable: null,
        providerManagedCreditBalanceChangedSincePrevious: null,
        extraUsageEnabled: input.billing.extraUsageEnabled ?? null,
        existingCreditsRemaining:
          input.billing.existingCreditsRemaining ?? null,
      },
      checkedAt: new Date().toISOString(),
    },
  };
}
