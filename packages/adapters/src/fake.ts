import type { ProviderRole } from "@collab/contracts";
import { ModelStartGuard, type ModelAuthorization } from "./model-guard.ts";

export interface FakeScriptStep {
  type: string;
  payload: unknown;
}

export class FakeAdapter {
  readonly guard = new ModelStartGuard();
  private cursor = 0;
  sessionId: string | null = null;

  constructor(
    readonly role: ProviderRole,
    private readonly script: FakeScriptStep[],
  ) {}

  start(runId: string, authorization: ModelAuthorization): FakeScriptStep | null {
    this.guard.authorize(this.role, runId, authorization);
    this.sessionId ??= `fake_${this.role}_session`;
    return this.script[this.cursor++] ?? null;
  }

  metadata(): { role: ProviderRole; scriptedSteps: number; cursor: number } {
    return { role: this.role, scriptedSteps: this.script.length, cursor: this.cursor };
  }
}
