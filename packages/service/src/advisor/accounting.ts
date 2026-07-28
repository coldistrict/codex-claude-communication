import {
  AdvisorSidecar,
  reportOverhead,
  type AdvisorUsageReport,
  type EventStore,
  type OverheadReport,
} from "@collab/kernel";

export interface ModelAccounting {
  /** The Part A worker-loop gate: adviser usage never enters it. */
  workerOverhead: OverheadReport | null;
  /** Full separate adviser bucket by selected provider. */
  advisorUsage: AdvisorUsageReport;
  combinedModelUsage: {
    workerTokens: number;
    advisorTokens: number;
    totalTokens: number;
  };
  /**
   * Informational only: all adviser usage treated as coordination over the
   * worker useful-work lower bound. Never a pass/fail predicate and never
   * able to change the worker gate, passedBy, or absolute allowance.
   */
  combinedCoordinationRatio: number | null;
  /** Global release checks cover both buckets. */
  globalChecks: {
    usageCoverageComplete: boolean;
    uncausedInvocations: number;
  };
}

export function composeModelAccounting(
  store: EventStore,
  sidecar: AdvisorSidecar,
  runId: string,
): ModelAccounting {
  const workerRecords = store.usageRecords(runId);
  const workerOverhead = workerRecords.length ? reportOverhead(workerRecords) : null;
  const advisorUsage = sidecar.usageReport(runId);
  const workerTokens = workerOverhead?.total ?? 0;
  const advisorTokens = advisorUsage.totalTokens;
  const usefulLower = workerOverhead?.usefulLower ?? 0;
  return {
    workerOverhead,
    advisorUsage,
    combinedModelUsage: {
      workerTokens,
      advisorTokens,
      totalTokens: workerTokens + advisorTokens,
    },
    combinedCoordinationRatio:
      usefulLower > 0 ? (workerTokens + advisorTokens) / usefulLower : null,
    globalChecks: {
      usageCoverageComplete:
        (workerOverhead?.coverageComplete ?? true) &&
        advisorUsage.usageCoverageComplete,
      uncausedInvocations:
        (workerOverhead?.uncausedInvocations ?? 0) + advisorUsage.uncausedWakes,
    },
  };
}
