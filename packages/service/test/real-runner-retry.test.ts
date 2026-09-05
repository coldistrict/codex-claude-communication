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

const expectedContent = "retry accounting canary passed.";
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
        provider === "codex" ? ("chatgpt" as const) : ("claude.ai" as const),
      plan: provider === "codex" ? "plus" : "max",
      proof: ["deterministic fixture"],
      checkedAt: new Date().toISOString(),
    },
  };
}

const usage = {
  input: 40_000,
  cachedInput: 0,
  output: 500,
  reasoning: 100,
};

// Deterministic stand-in for the retry-after-recoverable-failure property the
// 2026-07-27 independent real-provider pass could not reach (zero needs_input
// states arose). It does NOT verify real-provider behaviour; it pins the
// coordinator-side contract: a recoverable Action Needed state followed by
// "Retry collaboration" must claim a NEW ready item, record the re-executed
// burst as a distinct usage row, never overwrite the pre-failure rows, and
// never charge the provider budget a second time for the re-executed stage.
describe("retry after a recoverable provider failure", () => {
  it("claims a new ready item and records a distinct, uncharged usage row", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-retry-accounting-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const store = new EventStore(join(root, "events.sqlite"));
    const coordinator = new Coordinator(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
    });
    const runId = coordinator.createRun(
      { workflow: "execution",
        goal: "Recover a failed candidate burst without double accounting.",
        workspace,
        constraints: ["No network"],
        completionEvidence: [expectedSha256],
        mode: "real",
        budgets: { perProvider: 8, perMaterialChallenge: 2 },
      },
      true,
    );

    const manifest = {
      artifacts: [
        {
          path: "canary-output.txt",
          sha256: expectedSha256,
          mediaType: "text/plain",
        },
      ],
      evidenceLedger: ["created exact bytes"],
      verification: [
        { command: "sha256", outcome: "passed", evidence: expectedSha256 },
      ],
      knownLimitations: [],
      unresolvedNonMaterial: [],
    };
    let codexCalls = 0;
    const codex: RealCodexPort = {
      metadataPreflight: async () => billing("codex"),
      runBurst: async () => {
        codexCalls += 1;
        // Call 2 is the first candidate attempt: a recoverable transport
        // failure whose message matches no limit, billing, or context
        // pattern, so it must surface as a plain retryable needs_input card.
        if (codexCalls === 2) {
          throw new Error(
            "codex burst interrupted: the app-server stream closed mid-turn",
          );
        }
        if (codexCalls === 3) {
          writeFileSync(join(workspace, "canary-output.txt"), expectedContent);
        }
        const text =
          codexCalls === 1
            ? JSON.stringify({
                rationale: "Independent Codex opening",
                evidence: ["workspace inspected"],
                risks: ["exact bytes required"],
              })
            : codexCalls === 3
              ? JSON.stringify(manifest)
              : JSON.stringify({
                  sign: true,
                  rationale: "Exact shared digests verified",
                });
        return {
          threadId: "codex-session",
          turnId: `codex-turn-${codexCalls}`,
          text,
          turn: { status: "completed" },
          usage,
        };
      },
      close: async () => undefined,
    };
    let claudeCalls = 0;
    const claude: RealClaudePort = {
      metadataPreflight: async () => billing("claude"),
      startBurst: async () => {
        claudeCalls += 1;
        const structuredOutput =
          claudeCalls === 1
            ? {
                rationale: "Independent Claude opening",
                evidence: ["workspace inspected independently"],
                risks: ["peer bytes remain hidden"],
              }
            : claudeCalls === 2
              ? { rationale: "Candidate verified", manifest }
              : { sign: true, rationale: "Exact shared digests verified" };
        return {
          sessionId: "claude-session",
          messages: [],
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage,
        };
      },
    };
    const runner = new RealCollaborationRunner(store, {
      codexBinary: "/unused/codex",
      publish: () => undefined,
      codexAdapter: codex,
      claudeAdapter: claude,
      onCodexServerRequest: async () => ({ decision: "decline" }),
      onClaudeToolRequest: async () => ({ behavior: "deny" }),
    });

    try {
      // First attempt: both openings succeed, then the candidate burst fails
      // recoverably. The run must pause on a retryable card, not terminate.
      await runner.run(runId, true);
      const paused = store.projection(runId);
      expect(paused.completedAt).toBeNull();
      const card = paused.actions.find((action) => action.kind === "needs_input");
      expect(card).toMatchObject({
        title: "Collaboration paused after a codex failure",
        agent: "codex",
        actions: ["Retry collaboration", "Cancel"],
      });
      const failedClaim = store
        .events(runId)
        .find((event) => event.idempotencyKey === "real:claim:codex:candidate");
      expect(failedClaim).toBeDefined();
      expect((failedClaim!.payload as any).chargeBudget).toBe(true);
      const failedReadyWorkId = (failedClaim!.payload as any).readyWorkId as string;
      const beforeRetry = store.usageRecords(runId);
      expect(beforeRetry).toHaveLength(2);
      expect(
        beforeRetry.some((record) => record.readyWorkId === failedReadyWorkId),
      ).toBe(false);

      // Retry exactly as the coordinator records it for "Retry collaboration"
      // before re-entering the runner.
      store.append({
        runId,
        actor: "user",
        type: "human_override",
        idempotencyKey: `retry:${card!.id}`,
        payload: { cardId: card!.id, decision: "retry_collaboration" },
      });
      await runner.run(runId, true);

      const projection = store.projection(runId);
      expect(projection.state).toBe("completed_consensus");
      expect(
        projection.actions.some((action) => action.kind === "needs_input"),
      ).toBe(false);

      // The re-executed candidate is a resumed claim on a NEW ready item and
      // is exempt from the provider budget: the stage was already charged.
      const resumed = store
        .events(runId)
        .filter(
          (event) =>
            event.type === "resumed" && (event.payload as any).modelWake === true,
        );
      expect(resumed).toHaveLength(1);
      const retryClaim = resumed[0]!;
      const retryReadyWorkId = (retryClaim.payload as any).readyWorkId as string;
      expect(retryReadyWorkId).not.toBe(failedReadyWorkId);
      expect((retryClaim.payload as any).chargeBudget).toBe(false);
      const chargedClaims = store
        .events(runId)
        .filter(
          (event) =>
            (event.payload as any).modelWake === true &&
            (event.payload as any).chargeBudget === true,
        );
      expect(chargedClaims).toHaveLength(6);

      // Exactly one new row for the re-executed burst, causally bound to the
      // retry claim; the pre-failure rows are byte-identical, and the failed
      // invocation's ready item never acquires a usage row.
      const records = store.usageRecords(runId);
      expect(records).toHaveLength(6);
      expect(records.slice(0, 2)).toEqual(beforeRetry);
      const candidateRows = records.filter(
        (record) => record.claimEventId === retryClaim.id,
      );
      expect(candidateRows).toHaveLength(1);
      expect(candidateRows[0]!.readyWorkId).toBe(retryReadyWorkId);
      expect(candidateRows[0]!.provider).toBe("codex");
      expect(
        records.some((record) => record.readyWorkId === failedReadyWorkId),
      ).toBe(false);

      const report = reportOverhead(records);
      expect(report.uncausedInvocations).toBe(0);
      expect(report.workerBurstCount).toBe(6);
      expect(report.passed).toBe(true);
      expect(new ReadyQueue(store.db).size()).toBe(0);
      expect(store.verifyHashChain(runId).ok).toBe(true);
      expect(codexCalls).toBe(4);
      expect(claudeCalls).toBe(3);
    } finally {
      store.close();
    }
  });
});
