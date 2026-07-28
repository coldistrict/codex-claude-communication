import { canonicalJson } from "./canonical.ts";

export interface UsageRecord {
  provider: "codex" | "claude";
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  classification: "useful" | "coordination" | "mixed";
  coordinatorOwnedContent?: unknown;
  attributionComplete: boolean;
  uncaused: boolean;
  nestedUsageComplete: boolean;
  /**
   * Durable causal binding of this invocation-unique row to its exact ready
   * claim. Absent on rows recorded before invocation binding existed and on
   * rows whose burst had no claim (those derive `uncaused: true`).
   */
  readyWorkId?: string | null;
  claimEventId?: string | null;
  triggerEventId?: string | null;
}

export const OVERHEAD_GATE_VERSION = "overhead-gate-v2";
export const OVERHEAD_RATIO_CEILING = 1.05;
/**
 * Pinned absolute allowance for attributable mixed-call coordinator bytes:
 * nextPowerOfTwo(3 × 15,426 reference charged bytes / 6 reference worker
 * bursts) = nextPowerOfTwo(7,713) = 8,192. The derivation, reference
 * classifier (real-burst-v2), and reference fixture digest are recorded in
 * pin-manifest.json. Re-deriving the allowance from the run being judged is
 * forbidden: added overhead must never raise its own limit.
 */
export const ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST = 8_192;

export interface OverheadReport {
  gateVersion: typeof OVERHEAD_GATE_VERSION;
  total: number;
  /** Compatibility scalar: coordinationTokenUpper + mixedCoordinatorBytes. */
  coordinationUpper: number;
  usefulLower: number;
  ratio: number | null;
  coverageComplete: boolean;
  uncausedInvocations: number;
  passed: boolean;
  byProvider: Record<string, { input: number; cachedInput: number; output: number; reasoning: number }>;
  /** Unique worker invocations with usage rows (adviser usage never counts). */
  workerBurstCount: number;
  /** Full token charges: coordination-only calls + unattributed mixed calls. */
  coordinationTokenUpper: number;
  /** UTF-8 bytes of attributable coordinator-owned content in mixed calls. */
  mixedCoordinatorBytes: number;
  absoluteAllowanceBytes: number;
  /**
   * True only when every row has complete usage and every non-useful row is a
   * byte-attributed mixed call. A pure coordination call, an unattributed
   * whole-call charge, or missing usage makes the absolute arm ineligible.
   */
  absoluteEligible: boolean;
  passedBy: "ratio" | "absolute" | null;
}

export function reportOverhead(records: UsageRecord[]): OverheadReport {
  const byProvider: OverheadReport["byProvider"] = {};
  let total = 0;
  let coordinationTokenUpper = 0;
  let mixedCoordinatorBytes = 0;
  let coverageComplete = true;
  let uncausedInvocations = 0;
  let absoluteEligible = records.length > 0;
  for (const record of records) {
    const usage = record.input + record.cachedInput + record.output + record.reasoning;
    total += usage;
    const bucket = (byProvider[record.provider] ??= {
      input: 0,
      cachedInput: 0,
      output: 0,
      reasoning: 0,
    });
    bucket.input += record.input;
    bucket.cachedInput += record.cachedInput;
    bucket.output += record.output;
    bucket.reasoning += record.reasoning;
    if (record.uncaused) uncausedInvocations += 1;
    if (!record.nestedUsageComplete) {
      coverageComplete = false;
      absoluteEligible = false;
    }
    if (record.classification === "coordination") {
      coordinationTokenUpper += usage;
      absoluteEligible = false;
    } else if (record.classification === "mixed") {
      if (!record.attributionComplete) {
        coordinationTokenUpper += usage;
        absoluteEligible = false;
      } else {
        mixedCoordinatorBytes += Buffer.byteLength(
          canonicalJson(record.coordinatorOwnedContent ?? null),
        );
      }
    } else if (!record.attributionComplete) {
      coverageComplete = false;
      absoluteEligible = false;
    }
  }
  const coordinationUpper = coordinationTokenUpper + mixedCoordinatorBytes;
  const usefulLower = total - coordinationUpper;
  const ratio = usefulLower > 0 ? total / usefulLower : null;
  const workerBurstCount = records.length;
  const absoluteAllowanceBytes =
    ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST * workerBurstCount;
  // Gate v2: coverage, zero uncaused invocations, and positive useful work
  // stay outside the OR; only then may either arm pass.
  const preconditions =
    coverageComplete && uncausedInvocations === 0 && ratio !== null;
  const passedByRatio = preconditions && ratio <= OVERHEAD_RATIO_CEILING;
  const passedByAbsolute =
    preconditions &&
    absoluteEligible &&
    coordinationTokenUpper === 0 &&
    mixedCoordinatorBytes <= absoluteAllowanceBytes;
  return {
    gateVersion: OVERHEAD_GATE_VERSION,
    total,
    coordinationUpper,
    usefulLower,
    ratio,
    coverageComplete,
    uncausedInvocations,
    passed: passedByRatio || passedByAbsolute,
    byProvider,
    workerBurstCount,
    coordinationTokenUpper,
    mixedCoordinatorBytes,
    absoluteAllowanceBytes,
    absoluteEligible,
    passedBy: passedByRatio ? "ratio" : passedByAbsolute ? "absolute" : null,
  };
}
