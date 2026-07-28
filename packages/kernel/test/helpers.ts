import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalPacket, OutcomeManifest, PublicPacket } from "@collab/contracts";
import { digest, EventStore } from "../src/index.ts";

export function tempStore(prefix = "collab-kernel-"): {
  directory: string;
  file: string;
  store: EventStore;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const file = join(directory, "events.sqlite");
  return { directory, file, store: new EventStore(file) };
}

export function goal(runId = "run_test", overrides: Partial<GoalPacket> = {}): GoalPacket {
  const base = {
    goal: "Produce one verified result together.",
    workspace: "/tmp/collab-workspace",
    constraints: ["No network"],
    authority: {
      writableRoots: ["/tmp/collab-workspace"],
      network: "off" as const,
      permissionPreset: "default" as const,
    },
    completionEvidence: ["tests"],
    usefulWorkBudget: {
      perMaterialChallenge: 4,
      perProvider: 24,
    },
  };
  return {
    id: "goal_test",
    runId,
    ...base,
    digest: digest(base),
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

export function packet(
  runId: string,
  from: "codex" | "claude",
  id: string,
  overrides: Partial<PublicPacket> = {},
): PublicPacket {
  return {
    id,
    runId,
    type: "claim",
    from,
    to: "both",
    parentIds: [],
    affectedCriteria: [],
    provenance: ["fixture"],
    rationale: `${from} public rationale`,
    body: { value: from },
    material: true,
    createdAt: "2026-07-26T00:00:01.000Z",
    ...overrides,
  };
}

export function manifest(runId: string, goalDigest: string): OutcomeManifest {
  return {
    runId,
    goalDigest,
    artifacts: [{ path: "result.md", sha256: "a".repeat(64), mediaType: "text/markdown" }],
    evidenceLedger: ["ev-1"],
    verification: [{ command: "npm test", outcome: "passed", evidence: "all passed" }],
    knownLimitations: [],
    unresolvedNonMaterial: [],
  };
}

export function openBarrier(store: EventStore, runId: string): void {
  for (const role of ["codex", "claude"] as const) {
    const opening = packet(runId, role, `pkt_${role}`);
    store.append({
      runId,
      actor: role,
      type: "opening_committed",
      idempotencyKey: `opening:${role}`,
      payload: { packetId: opening.id },
    });
    store.append({
      runId,
      actor: role,
      type: "packet_posted",
      idempotencyKey: `packet:${role}`,
      payload: { packet: opening },
    });
  }
  store.append({
    runId,
    actor: "coordinator",
    type: "barrier_released",
    idempotencyKey: "barrier",
    payload: {},
  });
}
