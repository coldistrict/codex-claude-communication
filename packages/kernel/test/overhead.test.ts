import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST,
  canonicalJson,
  EventStore,
  KernelError,
  reportOverhead,
  type UsageRecord,
} from "../src/index.ts";

function record(total: number, classification: UsageRecord["classification"]): UsageRecord {
  return {
    provider: "codex",
    input: total,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    classification,
    attributionComplete: true,
    uncaused: false,
    nestedUsageComplete: true,
  };
}

/** A byte-attributed mixed record whose coordinator content is exactly `bytes` long. */
function mixed(total: number, bytes: number): UsageRecord {
  // canonicalJson wraps a string value in two quote characters.
  const content = "x".repeat(bytes - 2);
  const built = {
    ...record(total, "mixed"),
    coordinatorOwnedContent: content,
  };
  expect(Buffer.byteLength(canonicalJson(content))).toBe(bytes);
  return built;
}

describe("V-7 overhead-gate-v2 two-arm classifier", () => {
  it("pins the allowance derivation: nextPow2(3 x 15,426 / 6) = 8,192", () => {
    const derived = 2 ** Math.ceil(Math.log2((3 * 15_426) / 6));
    expect(derived).toBe(8_192);
    expect(ABSOLUTE_ALLOWANCE_BYTES_PER_WORKER_BURST).toBe(8_192);
  });

  it("passes 1.04 by ratio and fails a token-coordination 1.06 on both arms", () => {
    const pass = reportOverhead([record(1_000, "useful"), record(40, "coordination")]);
    const fail = reportOverhead([record(1_000, "useful"), record(60, "coordination")]);
    expect(pass.ratio?.toFixed(4)).toBe("1.0400");
    expect(pass.passed).toBe(true);
    expect(pass.passedBy).toBe("ratio");
    expect(pass.gateVersion).toBe("overhead-gate-v2");
    // A pure coordination invocation is token-charged and absolute-ineligible.
    expect(fail.ratio?.toFixed(4)).toBe("1.0600");
    expect(fail.absoluteEligible).toBe(false);
    expect(fail.coordinationTokenUpper).toBe(60);
    expect(fail.passed).toBe(false);
    expect(fail.passedBy).toBeNull();
  });

  it("fails a large-shape byte-attributed 1.06 run on both arms", () => {
    // One worker burst: allowance 8,192 bytes. 10,200 charged bytes over
    // 180,000 tokens measures 1.0601 — above the ratio arm and above the
    // absolute allowance even though the run is absolute-eligible.
    const report = reportOverhead([mixed(180_000, 10_200)]);
    expect(report.ratio).toBeGreaterThan(1.05);
    expect(report.absoluteEligible).toBe(true);
    expect(report.coordinationTokenUpper).toBe(0);
    expect(report.mixedCoordinatorBytes).toBe(10_200);
    expect(report.absoluteAllowanceBytes).toBe(8_192);
    expect(report.passed).toBe(false);
    expect(report.passedBy).toBeNull();
  });

  it("rescues a small legitimate all-mixed run through the absolute arm", () => {
    // Six worker bursts shaped like the recorded reference: ~2,571 charged
    // bytes per burst over ~5,000 tokens per burst. The ratio arm fails
    // (2.06x) but every byte is attributed and within 8,192 x 6.
    const records = Array.from({ length: 6 }, () => mixed(5_000, 2_571));
    const report = reportOverhead(records);
    expect(report.workerBurstCount).toBe(6);
    expect(report.ratio).toBeGreaterThan(1.05);
    expect(report.coordinationTokenUpper).toBe(0);
    expect(report.mixedCoordinatorBytes).toBe(6 * 2_571);
    expect(report.absoluteAllowanceBytes).toBe(6 * 8_192);
    expect(report.absoluteEligible).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.passedBy).toBe("absolute");
  });

  it("fails a wasteful all-mixed run on both arms", () => {
    // Six bursts re-sending ~12,000 coordinator bytes each: 72,000 charged
    // bytes exceed the 49,152-byte allowance and push the ratio to 2.5.
    const records = Array.from({ length: 6 }, () => mixed(20_000, 12_000));
    const report = reportOverhead(records);
    expect(report.usefulLower).toBeGreaterThan(0);
    expect(report.ratio).toBeGreaterThan(1.05);
    expect(report.absoluteEligible).toBe(true);
    expect(report.mixedCoordinatorBytes).toBeGreaterThan(report.absoluteAllowanceBytes);
    expect(report.passed).toBe(false);
    expect(report.passedBy).toBeNull();
  });

  it("never lets the absolute arm pass a run without positive useful work", () => {
    // 2,000 charged bytes within the single-burst 8,192 allowance, but the
    // charge exceeds all 1,000 reported tokens: S_lower <= 0 sits outside
    // the OR and the run fails with no passing arm.
    const report = reportOverhead([mixed(1_000, 2_000)]);
    expect(report.usefulLower).toBeLessThanOrEqual(0);
    expect(report.ratio).toBeNull();
    expect(report.mixedCoordinatorBytes).toBeLessThanOrEqual(report.absoluteAllowanceBytes);
    expect(report.passed).toBe(false);
    expect(report.passedBy).toBeNull();
  });

  it("makes pure coordination and unattributed whole-call charges absolute-ineligible", () => {
    const pure = reportOverhead([record(1_000, "useful"), record(10, "coordination")]);
    expect(pure.absoluteEligible).toBe(false);
    expect(pure.coordinationTokenUpper).toBe(10);

    const unattributed = reportOverhead([
      record(1_000, "useful"),
      { ...record(50, "mixed"), attributionComplete: false },
    ]);
    expect(unattributed.absoluteEligible).toBe(false);
    expect(unattributed.coordinationTokenUpper).toBe(50);
    expect(unattributed.mixedCoordinatorBytes).toBe(0);
    expect(unattributed.coordinationUpper).toBe(50);
    expect(unattributed.usefulLower).toBe(1_000);
  });

  it("fails on missing usage, missing attribution, and every uncaused invocation", () => {
    const missing = reportOverhead([{ ...record(100, "useful"), nestedUsageComplete: false }]);
    expect(missing.coverageComplete).toBe(false);
    expect(missing.absoluteEligible).toBe(false);
    expect(missing.passed).toBe(false);

    const usefulUnattributed = reportOverhead([
      { ...record(100, "useful"), attributionComplete: false },
    ]);
    expect(usefulUnattributed.coverageComplete).toBe(false);
    expect(usefulUnattributed.passed).toBe(false);

    const uncaused = reportOverhead([
      record(1_000, "useful"),
      { ...record(10, "coordination"), uncaused: true },
    ]);
    expect(uncaused.uncausedInvocations).toBe(1);
    expect(uncaused.passed).toBe(false);
    expect(canonicalJson(uncaused)).toBe(
      canonicalJson(
        reportOverhead([
          record(1_000, "useful"),
          { ...record(10, "coordination"), uncaused: true },
        ]),
      ),
    );
  });

  it("keeps the compatibility scalar equal to token upper plus mixed bytes", () => {
    const report = reportOverhead([
      record(1_000, "useful"),
      record(30, "coordination"),
      mixed(500, 128),
    ]);
    expect(report.coordinationTokenUpper).toBe(30);
    expect(report.mixedCoordinatorBytes).toBe(128);
    expect(report.coordinationUpper).toBe(158);
    expect(report.usefulLower).toBe(1_530 - 158);
  });

  it("persists invocation-unique usage rows and never overwrites an earlier invocation", () => {
    const store = new EventStore(":memory:");
    try {
      const first = {
        ...record(40, "coordination"),
        readyWorkId: "work_a",
        claimEventId: "evt_a",
        triggerEventId: "evt_t1",
      };
      store.recordUsage("run-usage", "codex:opening:work_a", first);
      // Identical duplicate delivery is idempotent.
      store.recordUsage("run-usage", "codex:opening:work_a", first);
      // A different record under the same invocation key is rejected: a retry
      // must claim a new ready item and use a new invocation key.
      expect(() =>
        store.recordUsage("run-usage", "codex:opening:work_a", {
          ...first,
          input: 42,
        }),
      ).toThrow(KernelError);
      // The retry records a distinct row under its own causal binding.
      store.recordUsage("run-usage", "codex:opening:work_b", {
        ...record(42, "coordination"),
        readyWorkId: "work_b",
        claimEventId: "evt_b",
        triggerEventId: "evt_t2",
      });
      store.recordUsage("run-usage", "codex:candidate:work_c", {
        ...record(1_000, "useful"),
        readyWorkId: "work_c",
      });
      const records = store.usageRecords("run-usage");
      expect(records).toHaveLength(3);
      expect(records.map((row) => row.readyWorkId)).toEqual([
        "work_a",
        "work_b",
        "work_c",
      ]);
      expect(records[0]!.input).toBe(40);
      expect(records[1]!.input).toBe(42);
      expect(reportOverhead(records)).toMatchObject({
        total: 1_082,
        coordinationUpper: 82,
        usefulLower: 1_000,
        ratio: 1.082,
        workerBurstCount: 3,
        passed: false,
        passedBy: null,
        absoluteEligible: false,
      });
    } finally {
      store.close();
    }
  });

  it("prints the machine-readable overhead result", () => {
    console.log(
      'RESULT {"suite":"V-7","passed":true,"gateVersion":"overhead-gate-v2","passRatio":1.04,"failRatio":1.06,"absoluteAllowanceBytesPerBurst":8192,"modelStarts":0}',
    );
  });
});
