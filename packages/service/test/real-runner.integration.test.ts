import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, ReadyQueue, reportOverhead } from "@collab/kernel";
import { Coordinator } from "../src/coordinator.ts";
import {
  RealCollaborationRunner,
  type RealClaudePort,
  type RealCodexPort,
} from "../src/real-runner.ts";

const expectedContent = "collaboration canary passed.";
const expectedSha256 = createHash("sha256")
  .update(expectedContent)
  .digest("hex");

function billing(provider: "codex" | "claude") {
  return {
    ok: true as const,
    provider,
    trace: [
      "1:pins",
      "2:environment",
      "3:spawn_args",
      "4:subscription_auth",
      "5:billing_route",
      "6:provider_credit_policy",
      "7:subscriptions",
    ],
    billing: {
      provider,
      route: "subscription_allowance" as const,
      authenticatedBy:
        provider === "codex"
          ? ("chatgpt" as const)
          : ("claude.ai" as const),
      plan: provider === "codex" ? "plus" : "max",
      proof: ["deterministic fixture"],
      usage: {
        subscriptionUsedPercent: 20,
        providerManagedCreditsPresent: provider === "codex",
        providerManagedCreditBalanceAvailable: provider === "codex",
        providerManagedCreditBalanceChangedSincePrevious: false,
        extraUsageEnabled: provider === "claude" ? false : null,
        existingCreditsRemaining: provider === "codex",
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

// Realistic burst volumes: under the real-burst-v2 attribution the duplicate
// restatements are charged in bytes, so an engineered trace must carry
// realistic token volumes for the ≤1.05 gate to be meaningful.
const usage = {
  input: 40_000,
  cachedInput: 0,
  output: 500,
  reasoning: 100,
};

describe("real collaboration runner with deterministic provider ports", () => {
  it("routes every full-flow model wake through the durable causal queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-real-runner-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const store = new EventStore(join(root, "events.sqlite"));
    const coordinator = new Coordinator(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
    });
    const runId = coordinator.createRun(
      {
        goal: "Create and independently verify the exact canary artifact.",
        workspace,
        constraints: ["No network"],
        completionEvidence: [expectedSha256],
        mode: "real",
        budgets: { perProvider: 8, perMaterialChallenge: 2 },
      },
      true,
    );
    let codexBursts = 0;
    let claudeBursts = 0;
    let closedBeforeCompletion = false;
    const codexPrompts: string[] = [];
    const claudePrompts: string[] = [];
    let runner!: RealCollaborationRunner;
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async (input) => {
        codexBursts += 1;
        codexPrompts.push(input.prompt);
        if (codexBursts === 2) {
          (runner as any).emitActivity(
            runId,
            "codex",
            "tool",
            "Codex candidate activity",
          );
          writeFileSync(join(workspace, "canary-output.txt"), expectedContent);
        }
        const text =
          codexBursts === 1
            ? JSON.stringify({
                rationale: "Independent Codex opening",
                evidence: ["workspace inspected"],
                risks: ["exact bytes required"],
              })
            : codexBursts === 2
              ? JSON.stringify({
                  artifacts: [
                    {
                      path: "canary-output.txt",
                      sha256: expectedSha256,
                      mediaType: "text/plain",
                    },
                  ],
                  evidenceLedger: ["created exact bytes"],
                  verification: [
                    {
                      command: "sha256",
                      outcome: "passed",
                      evidence: expectedSha256,
                    },
                  ],
                  knownLimitations: [],
                  unresolvedNonMaterial: [],
                })
              : JSON.stringify({
                  sign: true,
                  rationale: "Exact shared digests verified",
                });
        return {
          threadId: "codex-session",
          turnId: `codex-turn-${codexBursts}`,
          text,
          turn: { status: "completed" },
          usage,
        };
      },
      close: async () => {
        closedBeforeCompletion = store.projection(runId).completedAt === null;
      },
    };
    const manifest = {
      artifacts: [
        {
          path: "canary-output.txt",
          sha256: expectedSha256,
          mediaType: "text/plain",
        },
      ],
      evidenceLedger: ["independently verified exact bytes"],
      verification: [
        {
          command: "sha256",
          outcome: "passed",
          evidence: expectedSha256,
        },
      ],
      knownLimitations: [],
      unresolvedNonMaterial: [],
    };
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async (input) => {
        claudeBursts += 1;
        claudePrompts.push(input.prompt);
        if (claudeBursts === 2) {
          (runner as any).emitActivity(
            runId,
            "claude",
            "status",
            "Claude review activity",
          );
          (runner as any).emitActivity(
            runId,
            "codex",
            "status",
            "Codex post-review activity",
          );
        }
        const structuredOutput =
          claudeBursts === 1
            ? {
                rationale: "Independent Claude opening",
                evidence: ["workspace inspected independently"],
                risks: ["peer bytes remain hidden"],
              }
            : claudeBursts === 2
              ? { rationale: "Candidate verified", manifest }
              : {
                  sign: true,
                  rationale: "Exact shared digests verified",
                };
        return {
          sessionId: "claude-session",
          messages: [],
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage,
        };
      },
    };
    runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      environment: { PATH: process.env.PATH },
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });
    (runner as any).emitActivity(
      runId,
      "claude",
      "status",
      "Claude activity before openings",
    );
    (runner as any).emitActivity(
      runId,
      "codex",
      "status",
      "Codex activity before openings",
    );

    try {
      await runner.run(runId, true, "real_canary");
      const projection = store.projection(runId);
      const events = store.events(runId);
      const wakes = events.filter(
        (event) =>
          event.type === "work_claimed" &&
          (event.payload as any).modelWake === true,
      );

      expect(projection.state).toBe("completed_consensus");
      expect(closedBeforeCompletion).toBe(true);
      expect(codexBursts).toBe(3);
      expect(claudeBursts).toBe(3);
      expect(wakes).toHaveLength(6);
      expect(
        wakes.every(
          (event) =>
            typeof (event.payload as any).readyWorkId === "string" &&
            typeof (event.payload as any).triggerEventId === "string" &&
            (event.payload as any).wakeLatencyMs >= 0,
        ),
      ).toBe(true);
      expect(new ReadyQueue(store.db).size()).toBe(0);
      const usageRecords = store.usageRecords(runId);
      expect(usageRecords).toHaveLength(6);
      expect(reportOverhead(usageRecords).passed).toBe(true);
      const postOpeningAttributions = usageRecords.filter((record) =>
        ["candidate", "review", "signoff"].includes(
          String((record.coordinatorOwnedContent as any)?.stage),
        ),
      );
      expect(postOpeningAttributions).toHaveLength(4);
      expect(
        postOpeningAttributions.every((record) =>
          (
            (record.coordinatorOwnedContent as any)
              ?.duplicatedRestatements as unknown[]
          ).some((value) => String(value).includes("PEER ACTIVITY DIGEST")),
        ),
      ).toBe(true);
      expect(store.verifyHashChain(runId).ok).toBe(true);
      expect(codexPrompts[0]).not.toContain("Independent Claude opening");
      expect(claudePrompts[0]).not.toContain("Independent Codex opening");
      expect(codexPrompts[0]).not.toContain("PEER ACTIVITY DIGEST");
      expect(claudePrompts[0]).not.toContain("PEER ACTIVITY DIGEST");
      expect(codexPrompts[1]).toContain("Claude opening:");
      expect(codexPrompts[1]).toContain("PEER ACTIVITY DIGEST");
      expect(codexPrompts[1]).toContain("Claude activity before openings");
      expect(claudePrompts[1]).toContain("Codex candidate:");
      expect(claudePrompts[1]).toContain("PEER ACTIVITY DIGEST");
      expect(claudePrompts[1]).toContain("Codex candidate activity");
      expect(codexPrompts[2]).toContain("PEER ACTIVITY DIGEST");
      expect(codexPrompts[2]).toContain("Claude review activity");
      expect(claudePrompts[2]).toContain("PEER ACTIVITY DIGEST");
      expect(claudePrompts[2]).toContain("Codex post-review activity");
    } finally {
      store.close();
    }
  });
});
