import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { digest } from "@collab/kernel";
import {
  claimCanaryAuthorization,
  createCanaryEvidence,
  summarizeV13Evidence,
  validateCanaryEvidence,
  type CanaryAuthorizationRecord,
} from "../src/canary-evidence.ts";

const observedAt = "2026-07-26T15:00:05.000Z";
const artifactsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../artifacts",
);

function authorization(
  scope: "smoke" | "collab-e2e",
): CanaryAuthorizationRecord {
  return {
    kind: "real_canary",
    scope,
    confirmed: true,
    providers: ["codex", "claude"],
    issuedAt: "2026-07-26T15:00:00.000Z",
    expiresAt: "2026-07-26T15:30:00.000Z",
  };
}

function claimFor(scope: "smoke" | "collab-e2e", claimedAt = "2026-07-26T15:00:01.000Z") {
  return {
    markerPath: `/tmp/${scope}-authorization.json.consumed`,
    authorizationDigest: digest(authorization(scope)),
    evidenceOutputPath: `/tmp/${scope}-evidence.json`,
    claimedAt,
  };
}

function billing(provider: "codex" | "claude") {
  return {
    provider,
    route: "subscription_allowance",
    authenticatedBy: provider === "codex" ? "chatgpt" : "claude.ai",
    plan: provider === "codex" ? "plus" : "max",
    proof: ["fixture"],
    checkedAt: observedAt,
  };
}

function smokeResult() {
  return {
    suite: "V-13-smoke",
    passed: true,
    status: "passed",
    authorizationClaim: claimFor("smoke"),
    modelStarts: 4,
    modelStartsByProvider: { codex: 2, claude: 2 },
    modelAttemptsByProvider: { codex: 2, claude: 2 },
    sessions: {
      codex: { initial: "codex-1", resumed: "codex-1", stable: true },
      claude: { initial: "claude-1", resumed: "claude-1", stable: true },
    },
    billingBefore: { codex: billing("codex"), claude: billing("claude") },
    billingAfter: { codex: billing("codex"), claude: billing("claude") },
    workspace: { unchanged: true },
    noOpInvocations: 0,
    forbiddenBillingMethods: 0,
    overhead: { passed: true },
  };
}

function e2eResult() {
  return {
    suite: "V-13-collab-e2e",
    passed: true,
    status: "passed",
    authorizationClaim: claimFor("collab-e2e"),
    terminalOutcome: "completed_consensus",
    modelStarts: 6,
    modelStartsByProvider: { codex: 3, claude: 3 },
    modelAttemptsByProvider: { codex: 3, claude: 3 },
    eventChain: { ok: true, count: 42 },
    artifact: { exact: true },
    overhead: { passed: true },
    noOpInvocations: 0,
    usageCoverageComplete: true,
    forbiddenBillingMethods: 0,
    duration: { passed: true, durationMs: 120_000 },
    wakeLatency: {
      passed: true,
      coverageComplete: true,
      sampleCount: 6,
      p95Ms: 12,
    },
    codexCreditBalance: {
      complete: true,
      changedWhileSubscription: false,
    },
    claudePosture: {
      authenticatedByUnchanged: true,
      planUnchanged: true,
      extraUsageSettingUnchanged: true,
    },
    billingBefore: { codex: billing("codex"), claude: billing("claude") },
    billingAfter: { codex: billing("codex"), claude: billing("claude") },
  };
}

describe("V-13 canary evidence and aggregate ingestion", () => {
  it("atomically consumes each authorization file at most once", async () => {
    const root = await mkdtemp(join(tmpdir(), "collab-canary-auth-"));
    const authorizationPath = join(root, "authorization.json");
    const record = authorization("collab-e2e");
    const claim = await claimCanaryAuthorization({
      authorizationPath,
      authorization: record,
      evidenceOutputPath: join(root, "evidence.json"),
      claimedAt: observedAt,
    });

    expect(claim.markerPath).toBe(`${authorizationPath}.consumed`);
    expect(JSON.parse(await readFile(claim.markerPath, "utf8"))).toMatchObject({
      kind: "collaboration_product_canary_authorization_claim",
      scope: "collab-e2e",
      authorizationDigest: claim.authorizationDigest,
      evidenceOutputPath: join(root, "evidence.json"),
      claimedAt: observedAt,
    });
    expect((await stat(claim.markerPath)).mode & 0o777).toBe(0o600);

    await expect(
      claimCanaryAuthorization({
        authorizationPath,
        authorization: record,
        evidenceOutputPath: join(root, "second-evidence.json"),
        claimedAt: observedAt,
      }),
    ).rejects.toThrow("REAL_CANARY_AUTHORIZATION_ALREADY_CONSUMED");
  });

  it("validates scoped, current, tamper-evident smoke and E2E artifacts", () => {
    const smoke = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("smoke"),
      result: smokeResult(),
    });
    const e2e = createCanaryEvidence({
      suite: "V-13-collab-e2e",
      observedAt,
      authorization: authorization("collab-e2e"),
      result: e2eResult(),
    });

    expect(validateCanaryEvidence(smoke, "V-13-smoke")).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(validateCanaryEvidence(e2e, "V-13-collab-e2e")).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(
      summarizeV13Evidence({
        smoke: { source: "smoke.json", value: smoke },
        collaborationE2e: { source: "e2e.json", value: e2e },
      }),
    ).toMatchObject({
      status: "passed",
      authorizationRecorded: true,
      modelStarts: 10,
    });
  });

  it("detects result tampering and wrong authorization scope", () => {
    const smoke = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("collab-e2e"),
      result: smokeResult(),
    });
    smoke.result.modelStarts = 99;
    const validation = validateCanaryEvidence(smoke, "V-13-smoke");
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("authorization:scope");
    expect(validation.errors).toContain("evidence:digest");
    expect(validation.errors).toContain("smoke:model_starts_total");
  });

  it("rejects authorization that was stale or expired when observed", () => {
    const record = authorization("smoke");
    record.issuedAt = "2026-07-26T14:00:00.000Z";
    record.expiresAt = "2026-07-26T14:30:00.000Z";
    const smoke = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: record,
      result: smokeResult(),
    });
    expect(validateCanaryEvidence(smoke, "V-13-smoke").errors).toEqual(
      expect.arrayContaining([
        "authorization:not_current_at_observation",
        "authorization:expired_or_overbroad",
      ]),
    );
  });

  it("records partial evidence as unavailable and observed failures as failed", () => {
    const smoke = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("smoke"),
      result: smokeResult(),
    });
    expect(
      summarizeV13Evidence({
        smoke: { source: "smoke.json", value: smoke },
      }),
    ).toMatchObject({
      status: "unavailable/unauthorized",
      blockingPredicate: "V-13 collaboration E2E evidence was not supplied",
    });

    const failed = createCanaryEvidence({
      suite: "V-13-collab-e2e",
      observedAt,
      authorization: authorization("collab-e2e"),
      result: {
        suite: "V-13-collab-e2e",
        passed: false,
        status: "failed",
        authorizationClaim: claimFor("collab-e2e"),
        modelStarts: 2,
      },
    });
    expect(
      summarizeV13Evidence({
        smoke: { source: "smoke.json", value: smoke },
        collaborationE2e: { source: "e2e.json", value: failed },
      }),
    ).toMatchObject({
      status: "failed",
      blockingPredicate: "one or more V-13 canaries reported a failed observed result",
    });
  });

  it("rejects false-success E2E evidence with missing runtime invariants", () => {
    const result = e2eResult();
    result.artifact.exact = false;
    const evidence = createCanaryEvidence({
      suite: "V-13-collab-e2e",
      observedAt,
      authorization: authorization("collab-e2e"),
      result,
    });
    const validation = validateCanaryEvidence(
      evidence,
      "V-13-collab-e2e",
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("e2e:artifact");
  });

  it("requires a one-use authorization claim recorded before the observation", () => {
    const { authorizationClaim: _omitted, ...claimless } = smokeResult();
    const missing = validateCanaryEvidence(
      createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: claimless,
      }),
      "V-13-smoke",
    );
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("authorization_claim:missing");
    expect(missing.grandfatheredClaim).toBeUndefined();

    const late = validateCanaryEvidence(
      createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: {
          ...smokeResult(),
          authorizationClaim: claimFor("smoke", "2026-07-26T15:00:06.000Z"),
        },
      }),
      "V-13-smoke",
    );
    expect(late.valid).toBe(false);
    expect(late.errors).toContain("authorization_claim:not_before_observation");

    const wrongDigest = validateCanaryEvidence(
      createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: {
          ...smokeResult(),
          authorizationClaim: {
            ...claimFor("smoke"),
            authorizationDigest: "0".repeat(64),
          },
        },
      }),
      "V-13-smoke",
    );
    expect(wrongDigest.valid).toBe(false);
    expect(wrongDigest.errors).toContain("authorization_claim:digest");

    const incomplete = validateCanaryEvidence(
      createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: {
          ...smokeResult(),
          authorizationClaim: {
            authorizationDigest: digest(authorization("smoke")),
            claimedAt: "2026-07-26T15:00:01.000Z",
          },
        },
      }),
      "V-13-smoke",
    );
    expect(incomplete.valid).toBe(false);
    expect(incomplete.errors).toEqual(
      expect.arrayContaining([
        "authorization_claim:marker_path",
        "authorization_claim:evidence_output_path",
      ]),
    );

    const beforeIssuance = validateCanaryEvidence(
      createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: {
          ...smokeResult(),
          authorizationClaim: claimFor(
            "smoke",
            "2026-07-26T14:58:59.000Z",
          ),
        },
      }),
      "V-13-smoke",
    );
    expect(beforeIssuance.valid).toBe(false);
    expect(beforeIssuance.errors).toContain(
      "authorization_claim:before_issuance",
    );
  });

  it("accepts the recorded artifacts: strict claim for the final E2E, exact-digest grandfathering for the two pre-mechanism histories", async () => {
    const load = async (name: string) =>
      JSON.parse(await readFile(join(artifactsDirectory, name), "utf8"));

    const finalE2e = validateCanaryEvidence(
      await load("v13-collab-e2e.json"),
      "V-13-collab-e2e",
    );
    expect(finalE2e.valid).toBe(true);
    expect(finalE2e.errors).toEqual([]);
    expect(finalE2e.grandfatheredClaim).toBeUndefined();

    const smoke = validateCanaryEvidence(await load("v13-smoke.json"), "V-13-smoke");
    expect(smoke.valid).toBe(true);
    expect(smoke.errors).toEqual([]);
    expect(smoke.grandfatheredClaim).toContain("predates the claim mechanism");

    const attempt1 = validateCanaryEvidence(
      await load("v13-collab-e2e-attempt-1.json"),
      "V-13-collab-e2e",
    );
    expect(attempt1.valid).toBe(true);
    expect(attempt1.errors).toEqual([]);
    expect(attempt1.grandfatheredClaim).toContain("preserved failed");
    expect(attempt1.evidence?.result.passed).toBe(false);
  });

  it("grandfathers only the two exact canonical histories across harmless serialization changes", async () => {
    const smoke = JSON.parse(
      await readFile(join(artifactsDirectory, "v13-smoke.json"), "utf8"),
    );
    const reverseObjectKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseObjectKeys);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
      );
    };
    const reordered = JSON.parse(
      ` \n${JSON.stringify(reverseObjectKeys(smoke), null, 7)}\n `,
    );
    const reorderedValidation = validateCanaryEvidence(
      reordered,
      "V-13-smoke",
    );
    expect(reorderedValidation.valid).toBe(true);
    expect(reorderedValidation.grandfatheredClaim).toContain(
      "predates the claim mechanism",
    );

    const semanticTamper = structuredClone(smoke);
    semanticTamper.result.workspace.unchanged = false;
    const semanticValidation = validateCanaryEvidence(
      semanticTamper,
      "V-13-smoke",
    );
    expect(semanticValidation.valid).toBe(false);
    expect(semanticValidation.errors).toEqual(
      expect.arrayContaining([
        "evidence:digest",
        "authorization_claim:missing",
        "smoke:workspace",
      ]),
    );
    expect(semanticValidation.grandfatheredClaim).toBeUndefined();
  });

  it("cannot relabel the preserved failed E2E as passing, even with a recomputed digest", async () => {
    const prior = JSON.parse(
      await readFile(
        join(artifactsDirectory, "v13-collab-e2e-attempt-1.json"),
        "utf8",
      ),
    );
    const relabeled = createCanaryEvidence({
      suite: "V-13-collab-e2e",
      observedAt: prior.observedAt,
      authorization: prior.authorization,
      result: {
        ...prior.result,
        passed: true,
        status: "passed",
      },
    });
    const validation = validateCanaryEvidence(
      relabeled,
      "V-13-collab-e2e",
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("authorization_claim:missing");
    expect(validation.grandfatheredClaim).toBeUndefined();
  });

  it("keeps adviser-free historical artifacts valid and reports a zero/absent adviser bucket", () => {
    // The preserved artifacts predate the adviser; validation must not
    // require or invent a bucket for them.
    const evidence = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("smoke"),
      result: smokeResult(),
    });
    const validation = validateCanaryEvidence(evidence, "V-13-smoke");
    expect(validation.valid).toBe(true);
    expect((validation.evidence!.result as any).advisor).toBeUndefined();
  });

  it("requires a future adviser-enabled canary to prove profile, binding, coverage, and no-op count", () => {
    const advisorBucket = {
      enabled: true,
      provider: "claude",
      effort: "high",
      model: "claude-opus-5[1m]",
      wakeCount: 1,
      modelStarts: 1,
      usageCoverageComplete: true,
      uncausedWakes: 0,
      noOpWakes: 0,
      wakes: [
        {
          wakeId: "wake_1",
          readyWorkId: "work_1",
          triggerEventId: "evt_1",
          triggerKind: "user_request",
          authorizationId: "advauth_1",
          usageRecorded: true,
        },
      ],
    };
    const valid = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("smoke"),
      result: { ...smokeResult(), advisor: advisorBucket },
    });
    expect(validateCanaryEvidence(valid, "V-13-smoke").valid).toBe(true);

    const disabled = createCanaryEvidence({
      suite: "V-13-smoke",
      observedAt,
      authorization: authorization("smoke"),
      result: { ...smokeResult(), advisor: { enabled: false } },
    });
    expect(validateCanaryEvidence(disabled, "V-13-smoke").valid).toBe(true);

    const brokenCases: Array<[string, Record<string, unknown>]> = [
      ["advisor:selected_profile", { ...advisorBucket, model: "" }],
      ["advisor:wake_counts", { ...advisorBucket, modelStarts: 2 }],
      ["advisor:usage_coverage", { ...advisorBucket, usageCoverageComplete: false }],
      ["advisor:uncaused_wakes", { ...advisorBucket, uncausedWakes: 1 }],
      ["advisor:no_op_wakes", { ...advisorBucket, noOpWakes: 1 }],
      ["advisor:wake_binding", { ...advisorBucket, wakes: [] }],
      [
        "advisor:wake_binding",
        {
          ...advisorBucket,
          wakes: [{ ...advisorBucket.wakes[0], authorizationId: undefined }],
        },
      ],
    ];
    for (const [expectedError, bucket] of brokenCases) {
      const broken = createCanaryEvidence({
        suite: "V-13-smoke",
        observedAt,
        authorization: authorization("smoke"),
        result: { ...smokeResult(), advisor: bucket },
      });
      const validation = validateCanaryEvidence(broken, "V-13-smoke");
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(expectedError);
    }
  });
});
