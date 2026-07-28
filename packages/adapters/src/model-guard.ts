import type { ProviderRole } from "@collab/contracts";

export type AdvisorPurpose = "advisor_observation" | "advisor_retrospective";

export interface ModelAuthorization {
  id: string;
  kind: "user_goal" | "real_canary" | "advisor_observation";
  runId: string;
  providers: ProviderRole[];
  recordedAt: string;
  /**
   * advisor_observation only: the exact durable ready-work claim, trigger
   * event, and purpose this one-use authorization is bound to.
   */
  readyWorkId?: string;
  triggerEventId?: string;
  purpose?: AdvisorPurpose;
}

/**
 * The adapter passes this exactly when (and only when) it is executing an
 * adviser-profile burst. A worker authorization on an adviser call, an
 * adviser authorization on a worker call, any binding mismatch, and any
 * reuse of an adviser authorization id all fail before a model starts.
 */
export interface AdvisorStartContext {
  readyWorkId: string;
  triggerEventId: string;
  purpose: AdvisorPurpose;
}

export class ModelStartGuard {
  private _attempts = 0;
  private _started = 0;
  private _forbiddenBillingMethods = 0;
  private readonly consumedAdvisorAuthorizations = new Set<string>();

  get attempts(): number {
    return this._attempts;
  }

  get started(): number {
    return this._started;
  }

  get forbiddenBillingMethods(): number {
    return this._forbiddenBillingMethods;
  }

  authorize(
    provider: ProviderRole,
    runId: string,
    authorization?: ModelAuthorization,
    advisorContext?: AdvisorStartContext,
  ): void {
    this._attempts += 1;
    if (
      !authorization ||
      authorization.runId !== runId ||
      !authorization.providers.includes(provider)
    ) {
      throw new Error(
        `MODEL_START_BLOCKED: no recorded ${provider} authorization for run ${runId}`,
      );
    }
    if (advisorContext) {
      if (authorization.kind !== "advisor_observation") {
        throw new Error(
          `MODEL_START_BLOCKED: adviser start requires an advisor_observation authorization, got ${authorization.kind}`,
        );
      }
      if (
        authorization.providers.length !== 1 ||
        authorization.providers[0] !== provider
      ) {
        throw new Error(
          `MODEL_START_BLOCKED: adviser authorization must bind exactly one provider (${provider})`,
        );
      }
      if (
        authorization.readyWorkId !== advisorContext.readyWorkId ||
        authorization.triggerEventId !== advisorContext.triggerEventId ||
        authorization.purpose !== advisorContext.purpose
      ) {
        throw new Error(
          "MODEL_START_BLOCKED: advisor authorization binding mismatch (ready work, trigger, or purpose)",
        );
      }
      if (this.consumedAdvisorAuthorizations.has(authorization.id)) {
        throw new Error(
          `MODEL_START_BLOCKED: advisor authorization ${authorization.id} was already used`,
        );
      }
      this.consumedAdvisorAuthorizations.add(authorization.id);
    } else if (authorization.kind === "advisor_observation") {
      throw new Error(
        "MODEL_START_BLOCKED: an advisor_observation authorization can never start worker model work",
      );
    }
    this._started += 1;
  }

  recordForbiddenBillingMethod(method: string): never {
    this._forbiddenBillingMethods += 1;
    throw new Error(`FORBIDDEN_BILLING_METHOD:${method}`);
  }

  snapshot(): { attempts: number; started: number; forbiddenBillingMethods: number } {
    return {
      attempts: this._attempts,
      started: this._started,
      forbiddenBillingMethods: this._forbiddenBillingMethods,
    };
  }
}

export const globalModelStartGuard = new ModelStartGuard();
