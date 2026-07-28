import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { digest } from "@collab/kernel";

export type CanaryScope = "smoke" | "collab-e2e";
export type CanarySuite = "V-13-smoke" | "V-13-collab-e2e";

export interface CanaryAuthorizationRecord {
  kind: "real_canary";
  scope: CanaryScope;
  confirmed: true;
  providers: ["codex", "claude"] | ["claude", "codex"];
  issuedAt: string;
  expiresAt: string;
}

export interface CanaryEvidence {
  schemaVersion: 1;
  kind: "collaboration_product_canary_evidence";
  suite: CanarySuite;
  observedAt: string;
  authorization: CanaryAuthorizationRecord;
  authorizationDigest: string;
  result: Record<string, any>;
  evidenceDigest: string;
}

export interface CanaryEvidenceValidation {
  valid: boolean;
  errors: string[];
  evidence: CanaryEvidence | null;
  /**
   * Present when the artifact was accepted despite lacking a one-use
   * authorization claim, via the exact-digest grandfather list below.
   */
  grandfatheredClaim?: string;
}

/**
 * Exactly two historical artifacts predate the one-use authorization-claim
 * mechanism and are accepted without `result.authorizationClaim`, keyed by
 * their exact recomputed canonical evidence digest so only those two semantic
 * histories qualify (serialization whitespace and object-key order are not
 * evidence). Every artifact produced after 2026-07-26T16:00Z must carry a
 * structurally complete claim recorded before the observation.
 */
export const GRANDFATHERED_CLAIMLESS_EVIDENCE: Readonly<Record<string, string>> = {
  "8a7301d497640749eb5515495649b4d9906ca018426d928e928204a0d533cea5":
    "v13-smoke.json (observed 2026-07-26T15:29:10Z) predates the claim mechanism; " +
    "its authorization was marked consumed retroactively at 15:42Z.",
  "80c13bdf7343966baef7c9819442a1c2206c8210b2b77cc3ef606d690212af04":
    "v13-collab-e2e-attempt-1.json (observed 2026-07-26T15:35:45Z, preserved failed " +
    "attempt) predates the claim mechanism; its authorization was marked consumed " +
    "retroactively at 15:42Z.",
};

export async function claimCanaryAuthorization(input: {
  authorizationPath: string;
  authorization: CanaryAuthorizationRecord;
  evidenceOutputPath: string;
  claimedAt: string;
}): Promise<{
  markerPath: string;
  authorizationDigest: string;
  evidenceOutputPath: string;
  claimedAt: string;
}> {
  const markerPath = `${input.authorizationPath}.consumed`;
  const claim = {
    kind: "collaboration_product_canary_authorization_claim",
    scope: input.authorization.scope,
    authorizationDigest: authorizationDigest(input.authorization),
    evidenceOutputPath: input.evidenceOutputPath,
    claimedAt: input.claimedAt,
    pid: process.pid,
  };
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("REAL_CANARY_AUTHORIZATION_ALREADY_CONSUMED");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return {
    markerPath,
    authorizationDigest: claim.authorizationDigest,
    evidenceOutputPath: input.evidenceOutputPath,
    claimedAt: input.claimedAt,
  };
}

export interface V13EvidenceSummary {
  status: "passed" | "failed" | "unavailable/unauthorized";
  authorizationRecorded: boolean;
  modelStarts: number;
  blockingPredicate?: string;
  smoke: {
    supplied: boolean;
    source: string | null;
    valid: boolean;
    errors: string[];
    evidenceDigest: string | null;
    authorizationDigest: string | null;
    result: Record<string, any> | null;
    grandfatheredClaim?: string;
  };
  collaborationE2e: {
    supplied: boolean;
    source: string | null;
    valid: boolean;
    errors: string[];
    evidenceDigest: string | null;
    authorizationDigest: string | null;
    result: Record<string, any> | null;
    grandfatheredClaim?: string;
  };
}

function suiteScope(suite: CanarySuite): CanaryScope {
  return suite === "V-13-smoke" ? "smoke" : "collab-e2e";
}

function authorizationDigest(authorization: CanaryAuthorizationRecord): string {
  return digest(authorization);
}

function evidenceDigest(evidence: Omit<CanaryEvidence, "evidenceDigest">): string {
  return digest(evidence);
}

function isAllowedRoute(value: unknown): boolean {
  return value === "subscription_allowance" || value === "existing_credits";
}

function finiteNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function createCanaryEvidence(input: {
  suite: CanarySuite;
  observedAt: string;
  authorization: CanaryAuthorizationRecord;
  result: Record<string, any>;
}): CanaryEvidence {
  const base: Omit<CanaryEvidence, "evidenceDigest"> = {
    schemaVersion: 1,
    kind: "collaboration_product_canary_evidence",
    suite: input.suite,
    observedAt: input.observedAt,
    authorization: input.authorization,
    authorizationDigest: authorizationDigest(input.authorization),
    result: input.result,
  };
  return { ...base, evidenceDigest: evidenceDigest(base) };
}

export function validateCanaryEvidence(
  value: unknown,
  expectedSuite: CanarySuite,
): CanaryEvidenceValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["evidence:not_object"], evidence: null };
  }
  const evidence = value as CanaryEvidence;
  if (evidence.schemaVersion !== 1) errors.push("evidence:schema_version");
  if (evidence.kind !== "collaboration_product_canary_evidence") {
    errors.push("evidence:kind");
  }
  if (evidence.suite !== expectedSuite) errors.push("evidence:suite");
  if (!evidence.authorization || typeof evidence.authorization !== "object") {
    errors.push("authorization:missing");
  } else {
    const authorization = evidence.authorization;
    if (
      authorization.kind !== "real_canary" ||
      authorization.confirmed !== true
    ) {
      errors.push("authorization:kind_or_confirmation");
    }
    if (authorization.scope !== suiteScope(expectedSuite)) {
      errors.push("authorization:scope");
    }
    if (
      !Array.isArray(authorization.providers) ||
      authorization.providers.length !== 2 ||
      !authorization.providers.includes("codex") ||
      !authorization.providers.includes("claude")
    ) {
      errors.push("authorization:providers");
    }
    const issuedAt = Date.parse(authorization.issuedAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    const observedAt = Date.parse(evidence.observedAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(observedAt)
    ) {
      errors.push("authorization:timestamps");
    } else {
      if (observedAt < issuedAt - 60_000 || observedAt - issuedAt > 15 * 60_000) {
        errors.push("authorization:not_current_at_observation");
      }
      if (observedAt >= expiresAt || expiresAt > observedAt + 60 * 60_000) {
        errors.push("authorization:expired_or_overbroad");
      }
    }
    if (evidence.authorizationDigest !== authorizationDigest(authorization)) {
      errors.push("authorization:digest");
    }
  }

  const { evidenceDigest: suppliedDigest, ...base } = evidence;
  const digestValid = suppliedDigest === evidenceDigest(base);
  if (!digestValid) errors.push("evidence:digest");
  let grandfatheredClaim: string | undefined;
  if (!evidence.result || typeof evidence.result !== "object") {
    errors.push("result:missing");
  } else {
    const result = evidence.result;
    if (result.suite !== expectedSuite) errors.push("result:suite");

    // A one-use authorization claim recorded before the observation is
    // required for every artifact; the exact-digest grandfather list admits
    // only the two pre-mechanism histories.
    const claim = result.authorizationClaim;
    if (!claim || typeof claim !== "object") {
      const reason = digestValid
        ? GRANDFATHERED_CLAIMLESS_EVIDENCE[suppliedDigest]
        : undefined;
      if (reason) {
        grandfatheredClaim = reason;
      } else {
        errors.push("authorization_claim:missing");
      }
    } else {
      const claimedAt = Date.parse(String(claim.claimedAt));
      const observedAt = Date.parse(evidence.observedAt);
      const issuedAt = Date.parse(evidence.authorization?.issuedAt ?? "");
      if (
        typeof claim.markerPath !== "string" ||
        !isAbsolute(claim.markerPath) ||
        !claim.markerPath.endsWith(".consumed")
      ) {
        errors.push("authorization_claim:marker_path");
      }
      if (
        typeof claim.evidenceOutputPath !== "string" ||
        !isAbsolute(claim.evidenceOutputPath)
      ) {
        errors.push("authorization_claim:evidence_output_path");
      }
      if (!Number.isFinite(claimedAt)) {
        errors.push("authorization_claim:timestamps");
      } else {
        if (Number.isFinite(observedAt) && claimedAt >= observedAt) {
          errors.push("authorization_claim:not_before_observation");
        }
        if (Number.isFinite(issuedAt) && claimedAt < issuedAt - 60_000) {
          errors.push("authorization_claim:before_issuance");
        }
      }
      if (claim.authorizationDigest !== evidence.authorizationDigest) {
        errors.push("authorization_claim:digest");
      }
    }
    if (typeof result.passed !== "boolean") errors.push("result:passed");
    if (typeof result.status !== "string") errors.push("result:status");
    if (!finiteNonNegativeInteger(result.modelStarts)) {
      errors.push("result:model_starts");
    }
    if (result.passed === true && result.status !== "passed") {
      errors.push("result:passed_status");
    }

    // Adviser bucket (backward compatible): preserved artifacts predate the
    // adviser and carry no bucket — they remain valid and are reported as a
    // zero/absent adviser bucket. Any future adviser-enabled canary must
    // prove the selected profile, per-wake trigger/claim/authorization/usage
    // binding, usage coverage, and a zero no-op wake count. No such canary
    // is run or authorized here.
    const advisor = result.advisor;
    if (advisor !== undefined) {
      if (!advisor || typeof advisor !== "object") {
        errors.push("advisor:not_object");
      } else if (advisor.enabled === true) {
        if (
          !["codex", "claude"].includes(String(advisor.provider)) ||
          !["high", "medium"].includes(String(advisor.effort)) ||
          typeof advisor.model !== "string" ||
          advisor.model.length === 0
        ) {
          errors.push("advisor:selected_profile");
        }
        if (
          !finiteNonNegativeInteger(advisor.wakeCount) ||
          !finiteNonNegativeInteger(advisor.modelStarts) ||
          advisor.modelStarts > advisor.wakeCount
        ) {
          errors.push("advisor:wake_counts");
        }
        if (advisor.usageCoverageComplete !== true) {
          errors.push("advisor:usage_coverage");
        }
        if (advisor.uncausedWakes !== 0) errors.push("advisor:uncaused_wakes");
        if (advisor.noOpWakes !== 0) errors.push("advisor:no_op_wakes");
        if (
          !Array.isArray(advisor.wakes) ||
          advisor.wakes.length !== advisor.wakeCount ||
          advisor.wakes.some(
            (wake: any) =>
              !wake ||
              typeof wake.wakeId !== "string" ||
              typeof wake.readyWorkId !== "string" ||
              typeof wake.triggerEventId !== "string" ||
              typeof wake.triggerKind !== "string" ||
              typeof wake.authorizationId !== "string" ||
              typeof wake.usageRecorded !== "boolean",
          )
        ) {
          errors.push("advisor:wake_binding");
        }
      } else if (advisor.enabled !== false) {
        errors.push("advisor:enabled_flag");
      }
    }

    if (expectedSuite === "V-13-smoke" && result.passed === true) {
      for (const role of ["codex", "claude"] as const) {
        if (result.modelStartsByProvider?.[role] !== 2) {
          errors.push(`smoke:${role}:model_starts`);
        }
        if (result.modelAttemptsByProvider?.[role] !== 2) {
          errors.push(`smoke:${role}:model_attempts`);
        }
        if (result.sessions?.[role]?.stable !== true) {
          errors.push(`smoke:${role}:session_resume`);
        }
        if (
          !isAllowedRoute(result.billingBefore?.[role]?.route) ||
          !isAllowedRoute(result.billingAfter?.[role]?.route)
        ) {
          errors.push(`smoke:${role}:billing_route`);
        }
      }
      if (result.modelStarts !== 4) errors.push("smoke:model_starts_total");
      if (result.workspace?.unchanged !== true) errors.push("smoke:workspace");
      if (result.noOpInvocations !== 0) errors.push("smoke:no_op_invocations");
      if (result.forbiddenBillingMethods !== 0) {
        errors.push("smoke:forbidden_billing_methods");
      }
      if (result.overhead?.passed !== true) errors.push("smoke:overhead");
    }

    if (expectedSuite === "V-13-collab-e2e" && result.passed === true) {
      if (
        !["completed_consensus", "completed_disagreement"].includes(
          result.terminalOutcome,
        )
      ) {
        errors.push("e2e:terminal_outcome");
      }
      if (result.eventChain?.ok !== true || !finiteNonNegativeInteger(result.eventChain?.count)) {
        errors.push("e2e:event_chain");
      }
      if (result.artifact?.exact !== true) errors.push("e2e:artifact");
      if (result.overhead?.passed !== true) errors.push("e2e:overhead");
      if (result.noOpInvocations !== 0) errors.push("e2e:no_op_invocations");
      if (
        result.usageCoverageComplete !== true ||
        result.forbiddenBillingMethods !== 0
      ) {
        errors.push("e2e:usage_or_forbidden_billing");
      }
      if (
        result.duration?.passed !== true ||
        !finiteNonNegativeInteger(result.duration?.durationMs) ||
        result.duration.durationMs > 30 * 60_000
      ) {
        errors.push("e2e:duration");
      }
      if (
        result.wakeLatency?.passed !== true ||
        result.wakeLatency?.coverageComplete !== true ||
        !finiteNonNegativeInteger(result.wakeLatency?.sampleCount) ||
        !finiteNonNegativeInteger(result.wakeLatency?.p95Ms) ||
        result.wakeLatency.p95Ms > 5_000
      ) {
        errors.push("e2e:wake_latency");
      }
      if (
        result.codexCreditBalance?.complete !== true ||
        result.codexCreditBalance?.changedWhileSubscription !== false
      ) {
        errors.push("e2e:codex_credit_balance");
      }
      if (
        result.claudePosture?.authenticatedByUnchanged !== true ||
        result.claudePosture?.planUnchanged !== true ||
        result.claudePosture?.extraUsageSettingUnchanged !== true
      ) {
        errors.push("e2e:claude_posture");
      }
      if (
        !isAllowedRoute(result.billingBefore?.codex?.route) ||
        !isAllowedRoute(result.billingBefore?.claude?.route) ||
        !isAllowedRoute(result.billingAfter?.codex?.route) ||
        !isAllowedRoute(result.billingAfter?.claude?.route)
      ) {
        errors.push("e2e:billing_route");
      }
      if (
        !finiteNonNegativeInteger(result.modelStartsByProvider?.codex) ||
        !finiteNonNegativeInteger(result.modelStartsByProvider?.claude) ||
        result.modelStartsByProvider.codex > 8 ||
        result.modelStartsByProvider.claude > 8 ||
        result.modelStarts <= 0 ||
        result.modelStarts !==
          result.modelStartsByProvider.codex +
            result.modelStartsByProvider.claude
      ) {
        errors.push("e2e:model_starts");
      }
      if (
        result.modelAttemptsByProvider?.codex !==
          result.modelStartsByProvider?.codex ||
        result.modelAttemptsByProvider?.claude !==
          result.modelStartsByProvider?.claude ||
        result.wakeLatency?.sampleCount !== result.modelStarts
      ) {
        errors.push("e2e:model_attempts_or_wake_coverage");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    evidence,
    ...(grandfatheredClaim ? { grandfatheredClaim } : {}),
  };
}

export function summarizeV13Evidence(input: {
  smoke?: { source: string; value: unknown } | null;
  collaborationE2e?: { source: string; value: unknown } | null;
}): V13EvidenceSummary {
  const smokeValidation = input.smoke
    ? validateCanaryEvidence(input.smoke.value, "V-13-smoke")
    : { valid: false, errors: ["evidence:not_supplied"], evidence: null };
  const e2eValidation = input.collaborationE2e
    ? validateCanaryEvidence(
        input.collaborationE2e.value,
        "V-13-collab-e2e",
      )
    : { valid: false, errors: ["evidence:not_supplied"], evidence: null };
  const summarize = (
    supplied: boolean,
    source: string | null,
    validation: CanaryEvidenceValidation,
  ) => ({
    supplied,
    source,
    valid: validation.valid,
    errors: validation.errors,
    evidenceDigest: validation.evidence?.evidenceDigest ?? null,
    authorizationDigest: validation.evidence?.authorizationDigest ?? null,
    result: validation.evidence?.result ?? null,
    ...(validation.grandfatheredClaim
      ? { grandfatheredClaim: validation.grandfatheredClaim }
      : {}),
  });
  const smoke = summarize(
    Boolean(input.smoke),
    input.smoke?.source ?? null,
    smokeValidation,
  );
  const collaborationE2e = summarize(
    Boolean(input.collaborationE2e),
    input.collaborationE2e?.source ?? null,
    e2eValidation,
  );
  const invalidSupplied =
    (smoke.supplied && !smoke.valid) ||
    (collaborationE2e.supplied && !collaborationE2e.valid);
  const bothSuppliedAndValid =
    smoke.supplied &&
    collaborationE2e.supplied &&
    smoke.valid &&
    collaborationE2e.valid;
  const anyObservedFailure =
    smoke.result?.passed === false || collaborationE2e.result?.passed === false;
  const status = invalidSupplied || anyObservedFailure
    ? "failed"
    : bothSuppliedAndValid &&
        smoke.result?.passed === true &&
        collaborationE2e.result?.passed === true
      ? "passed"
      : "unavailable/unauthorized";
  const blockingPredicate =
    status === "passed"
      ? undefined
      : invalidSupplied
        ? "one or more supplied V-13 evidence artifacts failed integrity or scope validation"
        : anyObservedFailure
          ? "one or more V-13 canaries reported a failed observed result"
          : !smoke.supplied
            ? "V-13 smoke evidence was not supplied"
            : "V-13 collaboration E2E evidence was not supplied";
  const modelStarts =
    Number(smoke.result?.modelStarts ?? 0) +
    Number(collaborationE2e.result?.modelStarts ?? 0);

  return {
    status,
    authorizationRecorded:
      smoke.valid &&
      collaborationE2e.valid &&
      Boolean(smoke.authorizationDigest) &&
      Boolean(collaborationE2e.authorizationDigest),
    modelStarts,
    ...(blockingPredicate ? { blockingPredicate } : {}),
    smoke,
    collaborationE2e,
  };
}
