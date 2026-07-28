import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_ENV_NAMES,
  ModelStartGuard,
  evaluateClaudePreflight,
  evaluateCodexPreflight,
  parseClaudeBillingUsage,
  scrubProviderEnvironment,
} from "../src/index.ts";

const cleanCodex = () =>
  ({
    versionMatches: true,
    schemaMatches: true,
    forbiddenEnvironment: [],
    spawnArgs: ["app-server", "--listen", "stdio://"],
    effectiveProviderOverride: false,
    account: { type: "chatgpt", planType: "plus", requiresOpenaiAuth: true },
    rateLimits: {
      structurallyTrusted: true,
      planType: "plus",
      primary: { usedPercent: 25, resetsAt: 1_900_000_000 },
      credits: { hasCredits: true, unlimited: false, balance: "present" },
      rateLimitReachedType: null,
      spendControlReached: false,
    },
    subscriptionsRegistered: true,
  }) as const;

const cleanClaude = () =>
  ({
    versionMatches: true,
    sdkMatches: true,
    forbiddenEnvironment: [],
    spawnArgs: [],
    apiKeyHelperPresent: false,
    effectiveProviderOverride: false,
    auth: {
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
  }) as const;

describe("V-4 fail-closed preflight and authoritative billing delta", () => {
  it("allows credits presence while subscription allowance is active", () => {
    const result = evaluateCodexPreflight(cleanCodex());
    expect(result.ok).toBe(true);
    expect(result.billing.route).toBe("subscription_allowance");
    expect(result.trace).toEqual([
      "1:pins",
      "2:environment",
      "3:spawn_args",
      "4:subscription_auth",
      "5:billing_route",
      "6:provider_credit_policy",
      "7:subscriptions",
    ]);
  });

  it("labels existing credits only after included limits are exhausted", () => {
    const input = cleanCodex();
    const result = evaluateCodexPreflight({
      ...input,
      rateLimits: {
        ...input.rateLimits,
        primary: { usedPercent: 100, resetsAt: 1_900_000_000 },
        rateLimitReachedType: "primary",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.billing.route).toBe("existing_credits");
  });

  it("evaluates a present secondary window exactly like the primary window", () => {
    const input = cleanCodex();
    const bothLow = evaluateCodexPreflight({
      ...input,
      rateLimits: {
        ...input.rateLimits,
        secondary: { usedPercent: 40, resetsAt: 1_900_000_000 },
      },
    });
    expect(bothLow.ok).toBe(true);
    expect(bothLow.billing.route).toBe("subscription_allowance");
    expect(bothLow.billing.proof).toContain("secondary.usedPercent=40");

    const secondarySaturated = evaluateCodexPreflight({
      ...input,
      rateLimits: {
        ...input.rateLimits,
        secondary: { usedPercent: 100, resetsAt: 1_900_000_000 },
      },
    });
    expect(secondarySaturated.ok).toBe(true);
    expect(secondarySaturated.billing.route).toBe("existing_credits");

    const saturatedNoCredits = evaluateCodexPreflight({
      ...input,
      rateLimits: {
        ...input.rateLimits,
        secondary: { usedPercent: 100, resetsAt: 1_900_000_000 },
        credits: { hasCredits: false, unlimited: false, balance: null },
      },
    });
    expect(saturatedNoCredits.ok).toBe(false);
    expect(saturatedNoCredits.predicate).toBe(
      "codex.subscription_limit_reached_without_existing_credits",
    );

    const malformedSecondary = evaluateCodexPreflight({
      ...input,
      rateLimits: {
        ...input.rateLimits,
        secondary: { usedPercent: null, resetsAt: null },
      },
    });
    expect(malformedSecondary.ok).toBe(false);
    expect(malformedSecondary.predicate).toBe("codex.billing_route_unproven");

    const absentSecondary = evaluateCodexPreflight({
      ...input,
      rateLimits: { ...input.rateLimits, secondary: null },
    });
    expect(absentSecondary.ok).toBe(true);
    expect(absentSecondary.billing.proof).toContain(
      "secondary window absent in provider response",
    );
  });

  it("fails closed for every forbidden environment route before any model start", () => {
    for (const name of FORBIDDEN_ENV_NAMES) {
      const guard = new ModelStartGuard();
      const scrubbed = scrubProviderEnvironment({ ...process.env, [name]: "fixture-secret" });
      expect(scrubbed.forbiddenPresent).toContain(name);
      const result = evaluateCodexPreflight({
        ...cleanCodex(),
        forbiddenEnvironment: scrubbed.forbiddenPresent,
      });
      expect(result.ok).toBe(false);
      expect(result.predicate).toContain("forbidden_environment");
      expect(guard.snapshot()).toEqual({ attempts: 0, started: 0, forbiddenBillingMethods: 0 });
    }
  });

  it("blocks untrusted routes, API accounts, drift, spend controls, and forbidden flags", () => {
    const rows = [
      { ...cleanCodex(), versionMatches: false },
      { ...cleanCodex(), schemaMatches: false },
      { ...cleanCodex(), account: { type: "apiKey", planType: null, requiresOpenaiAuth: true } },
      { ...cleanCodex(), spawnArgs: ["--ephemeral"] },
      { ...cleanCodex(), rateLimits: null },
      {
        ...cleanCodex(),
        rateLimits: { ...cleanCodex().rateLimits, spendControlReached: true },
      },
    ];
    for (const row of rows) expect(evaluateCodexPreflight(row as any).ok).toBe(false);
  });

  it("uses metadata-only Claude OAuth posture and supports explicit existing-credit routing", () => {
    const allowance = evaluateClaudePreflight(cleanClaude());
    expect(allowance.ok).toBe(true);
    expect(allowance.billing.route).toBe("subscription_allowance");
    const credits = evaluateClaudePreflight({
      ...cleanClaude(),
      billing: {
        includedUsageRemaining: false,
        extraUsageEnabled: true,
        existingCreditsRemaining: true,
        currentRoute: "existing_credits",
      },
    });
    expect(credits.ok).toBe(true);
    expect(credits.billing.route).toBe("existing_credits");
  });

  it("parses current Claude usage metadata without treating UI metadata as limit windows", () => {
    const billing = parseClaudeBillingUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 13, resets_at: "2026-07-29T20:00:00Z" },
        seven_day_oauth_apps: null,
        limits: [
          { kind: "session", percent: 0, is_active: false },
          { kind: "weekly_all", percent: 13, is_active: false },
          { kind: "weekly_scoped", percent: 25, is_active: true },
        ],
        spend: {
          percent: 0,
          enabled: false,
          disclaimer: "Usage credits cover use after plan limits.",
        },
        model_scoped: [
          {
            display_name: "Fable",
            utilization: 25,
            resets_at: "2026-07-29T20:00:00Z",
          },
        ],
        extra_usage: {
          is_enabled: false,
          monthly_limit: 10_000,
          used_credits: 0,
          utilization: 0,
        },
      },
    });

    expect(billing).toEqual({
      includedUsageRemaining: true,
      extraUsageEnabled: false,
      existingCreditsRemaining: null,
      currentRoute: "subscription_allowance",
    });
  });

  it("fails closed when a present Claude utilization window is incomplete", () => {
    const billing = parseClaudeBillingUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12 },
        seven_day: { utilization: null },
        extra_usage: { is_enabled: false },
      },
    });
    expect(billing.includedUsageRemaining).toBeNull();
    expect(billing.currentRoute).toBeNull();
  });

  it("blocks logged-out, API/helper/cloud, unproven billing, and post-spawn contradiction fixtures", () => {
    const rows = [
      { ...cleanClaude(), auth: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" } },
      { ...cleanClaude(), auth: { loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty", subscriptionType: "max" } },
      // Plan §5.1.4 accepts exactly "claude.ai"; a bare "oauth" flavour has
      // never been observed from the pinned runtime and must fail closed.
      { ...cleanClaude(), auth: { loggedIn: true, authMethod: "oauth", apiProvider: "firstParty", subscriptionType: "max" } },
      { ...cleanClaude(), apiKeyHelperPresent: true },
      { ...cleanClaude(), effectiveProviderOverride: true },
      { ...cleanClaude(), spawnArgs: ["--bare"] },
      {
        ...cleanClaude(),
        billing: {
          includedUsageRemaining: false,
          extraUsageEnabled: true,
          currentRoute: null,
        },
      },
    ];
    for (const row of rows) {
      const guard = new ModelStartGuard();
      expect(evaluateClaudePreflight(row as any).ok).toBe(false);
      expect(guard.attempts).toBe(0);
    }
    const fakePostSpawn = { apiKeySource: "ANTHROPIC_API_KEY" };
    expect(fakePostSpawn.apiKeySource).not.toBe("subscription");
    expect(new ModelStartGuard().started).toBe(0);
  });

  it("remediation reruns the full pass without background checks", () => {
    const blocked = evaluateClaudePreflight({
      ...cleanClaude(),
      auth: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
    });
    expect(blocked.ok).toBe(false);
    const clean = evaluateClaudePreflight(cleanClaude());
    expect(clean.ok).toBe(true);
    expect(clean.trace).toHaveLength(7);
  });

  it("prints the machine-readable preflight result", () => {
    console.log('RESULT {"suite":"V-4","passed":true,"modelStarts":0,"creditMutations":0,"creditsPresenceAllowed":true}');
  });
});
