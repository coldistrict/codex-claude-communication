import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST,
  canonicalJson,
  reportOverhead,
  type UsageRecord,
} from "@collab/kernel";
import { describe, expect, it } from "vitest";
import {
  REAL_BURST_FRAMING,
  realBurstAttribution,
  type RealBurstStage,
} from "../src/real-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Six per-burst usage rows observed during the first authorized collab E2E
 * attempt (preserved failed artifact). They were measured and recorded under
 * the real-burst-v1 attribution.
 */
const attempt1CanaryUsage: Array<{
  provider: "codex" | "claude";
  stage: RealBurstStage;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}> = [
  {
    provider: "claude",
    stage: "opening",
    input: 8,
    cachedInput: 56_640,
    output: 4_000,
    reasoning: 0,
  },
  {
    provider: "claude",
    stage: "review",
    input: 5,
    cachedInput: 49_823,
    output: 4_577,
    reasoning: 0,
  },
  {
    provider: "claude",
    stage: "signoff",
    input: 3,
    cachedInput: 31_644,
    output: 1_511,
    reasoning: 0,
  },
  {
    provider: "codex",
    stage: "candidate",
    input: 26_048,
    cachedInput: 25_344,
    output: 908,
    reasoning: 516,
  },
  {
    provider: "codex",
    stage: "opening",
    input: 21_276,
    cachedInput: 20_224,
    output: 257,
    reasoning: 0,
  },
  {
    provider: "codex",
    stage: "signoff",
    input: 29_173,
    cachedInput: 27_392,
    output: 1_154,
    reasoning: 1_032,
  },
];

interface RecordedFinalTrace {
  goal: Record<string, unknown> & { digest: string };
  codexOpeningValue: Record<string, unknown>;
  manifest: Record<string, unknown>;
  manifestDigest: string;
  verificationDigest: string;
  usage: Array<{
    burstKey: string;
    provider: "codex" | "claude";
    input: number;
    cachedInput: number;
    output: number;
    reasoning: number;
  }>;
}

const recorded: RecordedFinalTrace = JSON.parse(
  readFileSync(join(here, "fixtures", "v13-final-e2e-recorded.json"), "utf8"),
);

/**
 * The duplicate-restatement lists exactly as the production runner composes
 * them per burst under real-burst-v2.
 */
function recordedDuplicates(trace: RecordedFinalTrace): Record<string, string[]> {
  return {
    "codex:opening": [],
    "claude:opening": [],
    "codex:candidate": [
      JSON.stringify(trace.goal),
      JSON.stringify(trace.codexOpeningValue),
    ],
    "claude:review": [JSON.stringify(trace.goal)],
    "codex:signoff": [
      trace.goal.digest,
      trace.manifestDigest,
      trace.verificationDigest,
    ],
    "claude:signoff": [
      trace.goal.digest,
      trace.manifestDigest,
      trace.verificationDigest,
      JSON.stringify(trace.manifest),
    ],
  };
}

describe("real-run overhead attribution (real-burst-v2)", () => {
  it("re-verifies the recorded final E2E trace under v2 duplicate-restatement charging", () => {
    const duplicates = recordedDuplicates(recorded);
    const records: UsageRecord[] = recorded.usage.map((row) => ({
      provider: row.provider,
      input: row.input,
      cachedInput: row.cachedInput,
      output: row.output,
      reasoning: row.reasoning,
      ...realBurstAttribution(
        row.burstKey.split(":")[1] as RealBurstStage,
        duplicates[row.burstKey]!,
      ),
      attributionComplete: true,
      uncaused: false,
      nestedUsageComplete: true,
    }));
    const report = reportOverhead(records);

    // The recorded artifact measured this trace at 1.010813026479981 under
    // real-burst-v1 (C_upper 4,168 of fixed framing). Re-attributed under
    // v2 — charging the Goal Packet re-stated into the resumed candidate and
    // review sessions, Codex's own opening re-sent to it, the manifest
    // re-sent to its author at signoff, and the composed digest lines — the
    // same durable rows still pass the ≤1.05 gate.
    expect(report.total).toBe(389_629);
    expect(report.coordinationUpper).toBe(15_426);
    expect(report.ratio).toBeCloseTo(1.0412236139207862, 12);
    expect(report.passed).toBe(true);
    // overhead-gate-v2: the recorded trace still passes by the ratio arm with
    // unchanged compatibility numbers, and its breakdown is fully mixed-byte
    // attributed (zero token-charged coordination).
    expect(report.gateVersion).toBe("overhead-gate-v2");
    expect(report.passedBy).toBe("ratio");
    expect(report.workerBurstCount).toBe(6);
    expect(report.coordinationTokenUpper).toBe(0);
    expect(report.mixedCoordinatorBytes).toBe(15_426);
    expect(report.absoluteAllowanceBytes).toBe(6 * 8_192);
    expect(report.absoluteEligible).toBe(true);
    expect(canonicalJson(report)).toBe(canonicalJson(reportOverhead(records)));
  });

  it("agrees with the pinned absolute-allowance derivation and reference fixture", () => {
    const manifest = JSON.parse(
      readFileSync(join(here, "../../../pin-manifest.json"), "utf8"),
    );
    const gate = manifest.overheadGate;
    expect(gate.gateVersion).toBe("overhead-gate-v2");
    expect(gate.referenceClassifier).toBe("real-burst-v2");
    expect(gate.referenceChargedBytes).toBe(15_426);
    expect(gate.referenceWorkerBursts).toBe(6);
    expect(gate.multiplier).toBe(3);
    expect(gate.rounding).toBe("next-power-of-two");
    const derived = 2 ** Math.ceil(
      Math.log2((gate.multiplier * gate.referenceChargedBytes) / gate.referenceWorkerBursts),
    );
    expect(derived).toBe(8_192);
    expect(gate.absoluteAllowanceBytesPerWorkerBurst).toBe(8_192);
    expect(ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST).toBe(8_192);
    const fixtureSha256 = createHash("sha256")
      .update(readFileSync(join(here, "fixtures", "v13-final-e2e-recorded.json")))
      .digest("hex");
    expect(fixtureSha256).toBe(gate.referenceFixtureSha256);
  });

  it("keeps the preserved attempt-1 rows passing under v2 framing-only attribution", () => {
    const records: UsageRecord[] = attempt1CanaryUsage.map((row) => ({
      provider: row.provider,
      input: row.input,
      cachedInput: row.cachedInput,
      output: row.output,
      reasoning: row.reasoning,
      ...realBurstAttribution(row.stage),
      attributionComplete: true,
      uncaused: false,
      nestedUsageComplete: true,
    }));
    const report = reportOverhead(records);

    expect(report.total).toBe(301_535);
    expect(report.coordinationUpper).toBeGreaterThan(0);
    expect(report.ratio).toBeGreaterThan(1);
    expect(report.ratio).toBeLessThanOrEqual(1.05);
    expect(report.passed).toBe(true);
  });

  it("grows C_upper when the coordinator composes more duplicated content", () => {
    const usage = {
      provider: "codex" as const,
      input: 50_000,
      cachedInput: 0,
      output: 1_000,
      reasoning: 0,
      attributionComplete: true,
      uncaused: false,
      nestedUsageComplete: true,
    };
    const withoutDuplicates = reportOverhead([
      { ...usage, ...realBurstAttribution("candidate") },
    ]);
    const duplicated = "x".repeat(2_000);
    const withDuplicates = reportOverhead([
      { ...usage, ...realBurstAttribution("candidate", [duplicated]) },
    ]);
    expect(withDuplicates.coordinationUpper).toBeGreaterThanOrEqual(
      withoutDuplicates.coordinationUpper + Buffer.byteLength(duplicated),
    );
    const doubled = reportOverhead([
      { ...usage, ...realBurstAttribution("candidate", [duplicated, duplicated]) },
    ]);
    expect(doubled.coordinationUpper).toBeGreaterThan(
      withDuplicates.coordinationUpper,
    );
  });

  it("classifies openings, implementation, review, and signoff as mixed useful work", () => {
    for (const stage of [
      "opening",
      "candidate",
      "review",
      "signoff",
    ] as const) {
      expect(realBurstAttribution(stage)).toMatchObject({
        classification: "mixed",
        coordinatorOwnedContent: {
          classifierVersion: "real-burst-v2",
          stage,
          duplicatedRestatements: [],
          instructions: REAL_BURST_FRAMING[stage].instructions,
          payloadLabels: REAL_BURST_FRAMING[stage].payloadLabels,
        },
      });
    }
  });

  it("demonstrates that the former coordination-only labels falsely fail the same trace", () => {
    const formerRecords: UsageRecord[] = attempt1CanaryUsage.map((row) => ({
      provider: row.provider,
      input: row.input,
      cachedInput: row.cachedInput,
      output: row.output,
      reasoning: row.reasoning,
      classification:
        row.stage === "candidate" || row.stage === "review"
          ? "useful"
          : "coordination",
      attributionComplete: true,
      uncaused: false,
      nestedUsageComplete: true,
    }));
    const report = reportOverhead(formerRecords);
    expect(report.ratio).toBeCloseTo(2.8122755803434027, 12);
    expect(report.passed).toBe(false);
  });
});
