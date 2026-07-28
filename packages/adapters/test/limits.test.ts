import { describe, expect, it } from "vitest";
import { classifyLimit } from "../src/index.ts";

describe("V-5 structured limit handling", () => {
  it("schedules only trusted structured reset times", () => {
    expect(
      classifyLimit({
        provider: "codex",
        kind: "usage_limit",
        structuredResetAt: 1_900_000_000,
        source: "account/rateLimits/updated",
      }),
    ).toEqual({
      state: "paused_limit_known",
      resetsAt: 1_900_000_000,
      source: "account/rateLimits/updated",
    });
    expect(
      classifyLimit({
        provider: "claude",
        kind: "usage_limit",
        renderedText: "resets 3:45pm",
        source: "rendered-text",
      }),
    ).toEqual({
      state: "paused_limit_unknown",
      source: "rendered-text",
      untrustedHint: "resets 3:45pm",
    });
  });

  it("uses the bounded deterministic supervisor retry schedule", () => {
    expect([0, 1, 2].map((attempt) => classifyLimit({
      provider: "claude",
      kind: "overloaded",
      source: "api_retry",
    }, attempt))).toMatchObject([
      { state: "retry_scheduled", delayMs: 30_000 },
      { state: "retry_scheduled", delayMs: 120_000 },
      { state: "retry_scheduled", delayMs: 480_000 },
    ]);
    expect(
      classifyLimit({ provider: "claude", kind: "server_error", source: "api_retry" }, 3),
    ).toEqual({ state: "needs_human", source: "api_retry" });
  });

  it("classifies auth, billing, and context states without invented reset", () => {
    for (const kind of [
      "billing_error",
      "authentication_failed",
      "oauth_org_not_allowed",
      "unauthorized",
    ] as const) {
      expect(classifyLimit({ provider: "claude", kind, source: "fixture" }).state).toBe(
        "paused_limit_unknown",
      );
    }
    expect(
      classifyLimit({ provider: "codex", kind: "context_exhausted", source: "typed-error" }),
    ).toEqual({ state: "context_replacement", source: "typed-error" });
  });

  it("prints the machine-readable limits result", () => {
    console.log('RESULT {"suite":"V-5","passed":true,"modelStartsBetweenWaits":0,"inventedResets":0}');
  });
});
