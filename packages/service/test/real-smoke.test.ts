import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelStartGuard,
  type ModelAuthorization,
  type PreflightResult,
} from "@collab/adapters";
import type { BillingRoute, ProviderRole } from "@collab/contracts";
import { describe, expect, it } from "vitest";
import {
  runRealSmoke,
  type SmokeBurstInput,
  type SmokeProvider,
} from "../src/real-smoke.ts";

function authorization(runId: string): ModelAuthorization {
  return {
    id: `auth_${runId}`,
    kind: "real_canary",
    runId,
    providers: ["codex", "claude"],
    recordedAt: "2026-07-26T00:00:00.000Z",
  };
}

class FixtureSmokeProvider implements SmokeProvider {
  readonly guard = new ModelStartGuard();
  readonly calls: SmokeBurstInput[] = [];
  preflightCalls = 0;
  route: BillingRoute = "subscription_allowance";
  changeSessionOnResume = false;
  incompleteUsage = false;
  mutateWorkspace: string | null = null;
  extraGuardStart = false;

  constructor(
    readonly role: ProviderRole,
    private readonly sessionId: string,
  ) {}

  async metadataPreflight(): Promise<PreflightResult> {
    this.preflightCalls += 1;
    const ok = ["subscription_allowance", "existing_credits"].includes(this.route);
    return {
      ok,
      provider: this.role,
      trace: ["fixture"],
      ...(ok ? {} : { predicate: `${this.role}.fixture_blocked` }),
      billing: {
        provider: this.role,
        route: this.route,
        authenticatedBy: this.role === "codex" ? "chatgpt" : "claude.ai",
        plan: this.role === "codex" ? "plus" : "max",
        proof: ["deterministic fixture"],
        checkedAt: `2026-07-26T00:00:0${this.preflightCalls}.000Z`,
      },
    };
  }

  async burst(input: SmokeBurstInput) {
    this.calls.push(input);
    this.guard.authorize(this.role, input.runId, input.authorization);
    if (this.extraGuardStart) {
      this.guard.authorize(this.role, input.runId, input.authorization);
    }
    if (this.mutateWorkspace) {
      writeFileSync(this.mutateWorkspace, "unexpected mutation");
    }
    const resumed = this.calls.length === 2;
    return {
      sessionId:
        resumed && this.changeSessionOnResume
          ? `${this.sessionId}_changed`
          : this.sessionId,
      text: input.expectedMarker,
      usage: this.incompleteUsage
        ? { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
        : { input: 10, cachedInput: resumed ? 5 : 0, output: 2, reasoning: 0 },
    };
  }

  guardSnapshot() {
    return this.guard.snapshot();
  }
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "collab-real-smoke-test-"));
  const runId = "run_fixture_smoke";
  const codex = new FixtureSmokeProvider("codex", "thread_codex_stable");
  const claude = new FixtureSmokeProvider("claude", "session_claude_stable");
  return { workspace, runId, codex, claude };
}

describe("V-13 bounded real-provider smoke harness", () => {
  it("uses exactly two turns per provider and proves stable resume IDs", async () => {
    const value = fixture();
    const report = await runRealSmoke({
      runId: value.runId,
      workspace: value.workspace,
      authorization: authorization(value.runId),
      providers: { codex: value.codex, claude: value.claude },
      nonce: "fixture",
      timeoutMs: 100,
    });

    expect(report.passed).toBe(true);
    expect(report.modelAttemptsByProvider).toEqual({ codex: 2, claude: 2 });
    expect(report.modelStartsByProvider).toEqual({ codex: 2, claude: 2 });
    expect(report.modelStarts).toBe(4);
    expect(report.sessions).toEqual({
      codex: {
        initial: "thread_codex_stable",
        resumed: "thread_codex_stable",
        stable: true,
      },
      claude: {
        initial: "session_claude_stable",
        resumed: "session_claude_stable",
        stable: true,
      },
    });
    expect(value.codex.calls[1]?.sessionId).toBe("thread_codex_stable");
    expect(value.claude.calls[1]?.sessionId).toBe("session_claude_stable");
    expect(value.codex.preflightCalls).toBe(2);
    expect(value.claude.preflightCalls).toBe(2);
    expect(report.usage).toHaveLength(4);
    expect(report.overhead).toMatchObject({
      ratio: 1,
      coverageComplete: true,
      uncausedInvocations: 0,
      passed: true,
    });
    expect(report.workspace.unchanged).toBe(true);
    expect(report.noOpInvocations).toBe(0);
    expect(report.forbiddenBillingMethods).toBe(0);
  });

  it("fails before model start when either billing route is blocked", async () => {
    const value = fixture();
    value.claude.route = "blocked";
    const report = await runRealSmoke({
      runId: value.runId,
      workspace: value.workspace,
      authorization: authorization(value.runId),
      providers: { codex: value.codex, claude: value.claude },
      nonce: "fixture",
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toContain("before:claude:preflight:claude.fixture_blocked");
    expect(report.modelStarts).toBe(0);
    expect(value.codex.calls).toHaveLength(0);
    expect(value.claude.calls).toHaveLength(0);
  });

  it("fails when a provider changes its session identity on resume", async () => {
    const value = fixture();
    value.claude.changeSessionOnResume = true;
    const report = await runRealSmoke({
      runId: value.runId,
      workspace: value.workspace,
      authorization: authorization(value.runId),
      providers: { codex: value.codex, claude: value.claude },
      nonce: "fixture",
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toContain("resume:claude:session_id_changed");
    expect(report.modelStartsByProvider.claude).toBe(2);
  });

  it("fails on incomplete usage or any temporary-workspace mutation", async () => {
    const value = fixture();
    value.codex.incompleteUsage = true;
    value.claude.mutateWorkspace = join(value.workspace, "unexpected.txt");
    const report = await runRealSmoke({
      runId: value.runId,
      workspace: value.workspace,
      authorization: authorization(value.runId),
      providers: { codex: value.codex, claude: value.claude },
      nonce: "fixture",
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toContain("initial:codex:usage_incomplete");
    expect(report.failures).toContain("resume:codex:usage_incomplete");
    expect(report.failures).toContain("workspace:mutated");
    expect(report.noOpInvocations).toBe(2);
  });

  it("detects adapter starts beyond the two-turn harness budget", async () => {
    const value = fixture();
    value.codex.extraGuardStart = true;
    const report = await runRealSmoke({
      runId: value.runId,
      workspace: value.workspace,
      authorization: authorization(value.runId),
      providers: { codex: value.codex, claude: value.claude },
      nonce: "fixture",
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toContain("guard:codex:two_turn_limit_exceeded");
    expect(report.modelAttemptsByProvider.codex).toBe(2);
    expect(report.modelStartsByProvider.codex).toBe(4);
  });

  it("prints the deterministic zero-model-call smoke-harness result", () => {
    console.log(
      'RESULT {"suite":"V-13-harness","passed":true,"realCanaryRun":false,"modelStarts":0}',
    );
  });
});
