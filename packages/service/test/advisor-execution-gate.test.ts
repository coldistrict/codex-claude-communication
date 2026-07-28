import { describe, expect, it } from "vitest";
import { ProviderExecutionGate } from "../src/advisor/execution-gate.ts";

describe("ProviderExecutionGate", () => {
  it("excludes an adviser while any same-provider worker is active", async () => {
    const gate = new ProviderExecutionGate();
    const releaseWorkerOne = await gate.acquireWorker("claude");
    const releaseWorkerTwo = await gate.acquireWorker("claude");

    expect(gate.isWorkerActive("claude")).toBe(true);
    expect(gate.tryAcquireAdvisor("claude")).toBeNull();

    releaseWorkerOne();
    expect(gate.tryAcquireAdvisor("claude")).toBeNull();
    releaseWorkerTwo();

    const releaseAdvisor = gate.tryAcquireAdvisor("claude");
    expect(releaseAdvisor).not.toBeNull();
    releaseAdvisor!();
  });

  it("queues a worker arriving during an adviser wake and gives it priority", async () => {
    const gate = new ProviderExecutionGate();
    const releaseAdvisor = gate.tryAcquireAdvisor("codex")!;
    let workerAdmitted = false;
    const worker = gate.acquireWorker("codex").then((release) => {
      workerAdmitted = true;
      return release;
    });

    await Promise.resolve();
    expect(workerAdmitted).toBe(false);
    expect(gate.isAdvisorActive("codex")).toBe(true);

    releaseAdvisor();
    const releaseWorker = await worker;
    expect(workerAdmitted).toBe(true);
    expect(gate.isWorkerActive("codex")).toBe(true);
    expect(gate.tryAcquireAdvisor("codex")).toBeNull();

    releaseWorker();
    expect(gate.tryAcquireAdvisor("codex")).not.toBeNull();
  });

  it("does not couple different providers", async () => {
    const releaseWorker = await new ProviderExecutionGate().acquireWorker(
      "codex",
    );
    releaseWorker();

    const gate = new ProviderExecutionGate();
    const releaseCodexWorker = await gate.acquireWorker("codex");
    const releaseClaudeAdvisor = gate.tryAcquireAdvisor("claude");
    expect(releaseClaudeAdvisor).not.toBeNull();
    releaseClaudeAdvisor!();
    releaseCodexWorker();
  });
});
