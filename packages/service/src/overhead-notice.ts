import type { RunProjection, StoredEvent } from "@collab/contracts";
import { reportOverhead, type EventStore, type UsageRecord } from "@collab/kernel";

/**
 * The dashboard's overhead view. While the run is active the result is
 * explicitly provisional: failing styling is allowed but it is never an
 * ActionCard, never interrupts, and clears as soon as a later report passes.
 */
export function composeOverheadView(
  projection: RunProjection,
  usage: UsageRecord[],
): NonNullable<RunProjection["overhead"]> | null {
  if (!usage.length) return null;
  const overhead = reportOverhead(usage);
  return {
    ratio: overhead.ratio,
    coverageComplete: overhead.coverageComplete,
    uncausedInvocations: overhead.uncausedInvocations,
    passed: overhead.passed,
    gateVersion: overhead.gateVersion,
    passedBy: overhead.passedBy,
    total: overhead.total,
    coordinationUpper: overhead.coordinationUpper,
    usefulLower: overhead.usefulLower,
    workerBurstCount: overhead.workerBurstCount,
    coordinationTokenUpper: overhead.coordinationTokenUpper,
    mixedCoordinatorBytes: overhead.mixedCoordinatorBytes,
    absoluteAllowanceBytes: overhead.absoluteAllowanceBytes,
    absoluteEligible: overhead.absoluteEligible,
    provisional: projection.completedAt === null,
  };
}

export type StableOverheadBoundary =
  | "terminal_consensus"
  | "terminal_disagreement"
  | "disagreement_declared"
  | "waiting_user_budget"
  | "cancellation";

/**
 * Persists at most one typed, non-blocking `overhead_gate_breached` system
 * notice per stable boundary kind when the worker-loop gate is still failing
 * there. A live in-progress result is provisional and never persisted: later
 * useful work can repair the ratio and later calls raise the aggregate
 * allowance. The notice is not an ActionCard, never uses `needs_input`, and
 * never changes the core run state; callers at a terminal boundary must
 * invoke this before committing the terminal event.
 */
export function persistStableOverheadBreach(
  store: EventStore,
  runId: string,
  boundary: StableOverheadBoundary,
  publish?: (runId: string) => void,
): StoredEvent | null {
  const records = store.usageRecords(runId);
  if (!records.length) return null;
  const report = reportOverhead(records);
  if (report.passed) return null;
  const projection = store.projection(runId);
  if (!projection.goal || projection.completedAt) return null;
  const alreadyRecorded = store
    .events(runId)
    .some(
      (event) =>
        event.type === "overhead_gate_breached" &&
        (event.payload as { boundary?: unknown }).boundary === boundary,
    );
  if (alreadyRecorded) return null;
  const event = store.append({
    runId,
    actor: "system",
    type: "overhead_gate_breached",
    idempotencyKey: `overhead:breach:${boundary}`,
    payload: {
      boundary,
      gateVersion: report.gateVersion,
      ratio: report.ratio,
      total: report.total,
      coordinationUpper: report.coordinationUpper,
      usefulLower: report.usefulLower,
      workerBurstCount: report.workerBurstCount,
      coordinationTokenUpper: report.coordinationTokenUpper,
      mixedCoordinatorBytes: report.mixedCoordinatorBytes,
      absoluteAllowanceBytes: report.absoluteAllowanceBytes,
      absoluteEligible: report.absoluteEligible,
      coverageComplete: report.coverageComplete,
      uncausedInvocations: report.uncausedInvocations,
    },
  });
  publish?.(runId);
  return event;
}
