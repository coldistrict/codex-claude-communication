import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  ModelAuthorization,
  PreflightResult,
} from "@collab/adapters";
import type { BillingStatus, ProviderRole } from "@collab/contracts";
import {
  digest,
  reportOverhead,
  type OverheadReport,
  type UsageRecord,
} from "@collab/kernel";

const ROLES = ["codex", "claude"] as const;
const ALLOWED_ROUTES = new Set(["subscription_allowance", "existing_credits"]);

export interface SmokeUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface SmokeBurstInput {
  runId: string;
  prompt: string;
  expectedMarker: string;
  authorization: ModelAuthorization;
  sessionId?: string;
  timeoutMs: number;
}

export interface SmokeBurstResult {
  sessionId: string | null;
  text: string;
  usage: SmokeUsage;
}

export interface SmokeProvider {
  role: ProviderRole;
  metadataPreflight(): Promise<PreflightResult>;
  burst(input: SmokeBurstInput): Promise<SmokeBurstResult>;
  guardSnapshot(): {
    attempts: number;
    started: number;
    forbiddenBillingMethods: number;
  };
}

export interface WorkspaceSnapshot {
  digest: string;
  entries: number;
}

export interface RealSmokeReport {
  passed: boolean;
  failures: string[];
  billingBefore: Record<ProviderRole, BillingStatus | null>;
  billingAfter: Record<ProviderRole, BillingStatus | null>;
  sessions: Record<
    ProviderRole,
    { initial: string | null; resumed: string | null; stable: boolean }
  >;
  usage: Array<UsageRecord & { burst: "initial" | "resume" }>;
  overhead: OverheadReport;
  workspace: {
    before: WorkspaceSnapshot;
    after: WorkspaceSnapshot;
    unchanged: boolean;
  };
  modelAttemptsByProvider: Record<ProviderRole, number>;
  modelStartsByProvider: Record<ProviderRole, number>;
  modelStarts: number;
  forbiddenBillingMethods: number;
  noOpInvocations: number;
}

function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const rows: Array<Record<string, unknown>> = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        rows.push({ path: relativePath, type: "directory", mode: stat.mode & 0o777 });
        walk(path);
      } else if (stat.isFile()) {
        rows.push({
          path: relativePath,
          type: "file",
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      } else if (stat.isSymbolicLink()) {
        rows.push({
          path: relativePath,
          type: "symlink",
          target: readlinkSync(path),
        });
      } else {
        rows.push({ path: relativePath, type: "other", mode: stat.mode & 0o777 });
      }
    }
  };
  walk(root);
  return { digest: digest(rows), entries: rows.length };
}

function completeUsage(usage: SmokeUsage): boolean {
  const values = [usage.input, usage.cachedInput, usage.output, usage.reasoning];
  return (
    values.every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) && values.reduce((sum, value) => sum + value, 0) > 0
  );
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1_000);
}

export async function runRealSmoke(input: {
  runId: string;
  workspace: string;
  authorization: ModelAuthorization;
  providers: Record<ProviderRole, SmokeProvider>;
  nonce: string;
  timeoutMs?: number;
}): Promise<RealSmokeReport> {
  const failures: string[] = [];
  const billingBefore = { codex: null, claude: null } as Record<
    ProviderRole,
    BillingStatus | null
  >;
  const billingAfter = { codex: null, claude: null } as Record<
    ProviderRole,
    BillingStatus | null
  >;
  const sessions = {
    codex: { initial: null, resumed: null, stable: false },
    claude: { initial: null, resumed: null, stable: false },
  } as RealSmokeReport["sessions"];
  const usage: RealSmokeReport["usage"] = [];
  const modelAttemptsByProvider = { codex: 0, claude: 0 };
  let noOpInvocations = 0;
  const before = snapshotWorkspace(input.workspace);
  const timeoutMs = input.timeoutMs ?? 3 * 60_000;

  const preflight = async (
    phase: "before" | "after",
    role: ProviderRole,
  ): Promise<PreflightResult | null> => {
    try {
      const result = await input.providers[role].metadataPreflight();
      const target = phase === "before" ? billingBefore : billingAfter;
      target[role] = result.billing;
      if (
        result.provider !== role ||
        !result.ok ||
        !ALLOWED_ROUTES.has(result.billing.route)
      ) {
        failures.push(
          `${phase}:${role}:preflight:${result.predicate ?? result.billing.route}`,
        );
      }
      return result;
    } catch (error) {
      failures.push(`${phase}:${role}:preflight_error:${safeError(error)}`);
      return null;
    }
  };

  const initialPreflights = await Promise.all(
    ROLES.map((role) => preflight("before", role)),
  );
  const beforeReady = initialPreflights.every(
    (result, index) =>
      result?.ok === true &&
      result.provider === ROLES[index] &&
      ALLOWED_ROUTES.has(result.billing.route),
  );

  const invoke = async (
    role: ProviderRole,
    burst: "initial" | "resume",
    sessionId?: string,
  ): Promise<SmokeBurstResult> => {
    if (modelAttemptsByProvider[role] >= 2) {
      throw new Error(`SMOKE_MODEL_BUDGET_EXCEEDED:${role}`);
    }
    modelAttemptsByProvider[role] += 1;
    const expectedMarker = `COLLAB_SMOKE_${burst.toUpperCase()}_${input.nonce}`;
    const prompt = [
      "This is a bounded, read-only provider connection smoke test.",
      "Do not use tools, inspect files, modify the workspace, access the network, or delegate.",
      `Reply with exactly this marker and nothing else: ${expectedMarker}`,
    ].join("\n");
    const result = await input.providers[role].burst({
      runId: input.runId,
      prompt,
      expectedMarker,
      authorization: input.authorization,
      ...(sessionId ? { sessionId } : {}),
      timeoutMs,
    });
    if (!result.sessionId) {
      failures.push(`${burst}:${role}:session_id_missing`);
    }
    if (!result.text.includes(expectedMarker)) {
      noOpInvocations += 1;
      failures.push(`${burst}:${role}:marker_missing`);
    }
    if (!completeUsage(result.usage)) {
      noOpInvocations += 1;
      failures.push(`${burst}:${role}:usage_incomplete`);
    } else {
      usage.push({
        provider: role,
        ...result.usage,
        burst,
        classification: "useful",
        attributionComplete: true,
        uncaused: false,
        nestedUsageComplete: true,
      });
    }
    return result;
  };

  if (beforeReady) {
    try {
      const [codexInitial, claudeInitial] = await Promise.all([
        invoke("codex", "initial"),
        invoke("claude", "initial"),
      ]);
      sessions.codex.initial = codexInitial.sessionId;
      sessions.claude.initial = claudeInitial.sessionId;
      if (codexInitial.sessionId && claudeInitial.sessionId) {
        const [codexResume, claudeResume] = await Promise.all([
          invoke("codex", "resume", codexInitial.sessionId),
          invoke("claude", "resume", claudeInitial.sessionId),
        ]);
        sessions.codex.resumed = codexResume.sessionId;
        sessions.claude.resumed = claudeResume.sessionId;
        for (const role of ROLES) {
          sessions[role].stable =
            sessions[role].initial !== null &&
            sessions[role].initial === sessions[role].resumed;
          if (!sessions[role].stable) {
            failures.push(`resume:${role}:session_id_changed`);
          }
        }
      }
    } catch (error) {
      failures.push(`model_path:${safeError(error)}`);
    }

    await Promise.all(ROLES.map((role) => preflight("after", role)));
  }

  const after = snapshotWorkspace(input.workspace);
  const workspaceUnchanged = before.digest === after.digest;
  if (!workspaceUnchanged) failures.push("workspace:mutated");

  const guardSnapshots = Object.fromEntries(
    ROLES.map((role) => [role, input.providers[role].guardSnapshot()]),
  ) as Record<ProviderRole, ReturnType<SmokeProvider["guardSnapshot"]>>;
  for (const role of ROLES) {
    const guard = guardSnapshots[role];
    if (guard.attempts !== modelAttemptsByProvider[role]) {
      failures.push(
        `guard:${role}:attempt_mismatch:${guard.attempts}:${modelAttemptsByProvider[role]}`,
      );
    }
    if (guard.started > 2 || modelAttemptsByProvider[role] > 2) {
      failures.push(`guard:${role}:two_turn_limit_exceeded`);
    }
    if (guard.forbiddenBillingMethods !== 0) {
      failures.push(`guard:${role}:forbidden_billing_method`);
    }
  }
  if (
    beforeReady &&
    failures.length === 0 &&
    ROLES.some(
      (role) =>
        modelAttemptsByProvider[role] !== 2 ||
        guardSnapshots[role].started !== 2,
    )
  ) {
    failures.push("smoke:did_not_complete_exactly_two_turns_per_provider");
  }

  const overhead = reportOverhead(usage);
  if (beforeReady && !overhead.passed) failures.push("usage:overhead_or_coverage_failed");
  const modelStartsByProvider = {
    codex: guardSnapshots.codex.started,
    claude: guardSnapshots.claude.started,
  };
  const forbiddenBillingMethods =
    guardSnapshots.codex.forbiddenBillingMethods +
    guardSnapshots.claude.forbiddenBillingMethods;

  return {
    passed: failures.length === 0,
    failures,
    billingBefore,
    billingAfter,
    sessions,
    usage,
    overhead,
    workspace: { before, after, unchanged: workspaceUnchanged },
    modelAttemptsByProvider,
    modelStartsByProvider,
    modelStarts: modelStartsByProvider.codex + modelStartsByProvider.claude,
    forbiddenBillingMethods,
    noOpInvocations,
  };
}
