import type { ProviderRole } from "@collab/contracts";

export type ReleaseProviderExecution = () => void;

interface ProviderExecutionState {
  advisorActive: boolean;
  workerActive: number;
  waitingWorkers: Array<(release: ReleaseProviderExecution) => void>;
}

/**
 * A process-local, provider-scoped readers/writer gate.
 *
 * Worker bursts may overlap one another, but an adviser wake is exclusive
 * with every worker burst on the same provider. Waiting workers have
 * priority when an adviser releases the gate, so queued advisory work cannot
 * starve normal collaboration work.
 */
export class ProviderExecutionGate {
  private readonly states = new Map<ProviderRole, ProviderExecutionState>();

  private state(provider: ProviderRole): ProviderExecutionState {
    let state = this.states.get(provider);
    if (!state) {
      state = { advisorActive: false, workerActive: 0, waitingWorkers: [] };
      this.states.set(provider, state);
    }
    return state;
  }

  acquireWorker(provider: ProviderRole): Promise<ReleaseProviderExecution> {
    const state = this.state(provider);
    if (!state.advisorActive) {
      state.workerActive += 1;
      return Promise.resolve(this.workerRelease(provider));
    }
    return new Promise((resolve) => {
      state.waitingWorkers.push(resolve);
    });
  }

  tryAcquireAdvisor(provider: ProviderRole): ReleaseProviderExecution | null {
    const state = this.state(provider);
    if (
      state.advisorActive ||
      state.workerActive > 0 ||
      state.waitingWorkers.length > 0
    ) {
      return null;
    }
    state.advisorActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.advisorActive = false;
      this.admitWaitingWorkers(provider);
      this.prune(provider);
    };
  }

  isWorkerActive(provider: ProviderRole): boolean {
    return this.state(provider).workerActive > 0;
  }

  isAdvisorActive(provider: ProviderRole): boolean {
    return this.state(provider).advisorActive;
  }

  private workerRelease(provider: ProviderRole): ReleaseProviderExecution {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = this.state(provider);
      if (state.workerActive <= 0) {
        throw new Error(`PROVIDER_EXECUTION_GATE_UNBALANCED:${provider}`);
      }
      state.workerActive -= 1;
      this.prune(provider);
    };
  }

  private admitWaitingWorkers(provider: ProviderRole): void {
    const state = this.state(provider);
    if (state.advisorActive || state.waitingWorkers.length === 0) return;
    const waiting = state.waitingWorkers.splice(0);
    // Reserve every worker slot before resolving any promise. A competing
    // adviser acquisition in the next microtask therefore still sees the
    // provider as worker-active.
    state.workerActive += waiting.length;
    for (const resolve of waiting) resolve(this.workerRelease(provider));
  }

  private prune(provider: ProviderRole): void {
    const state = this.states.get(provider);
    if (
      state &&
      !state.advisorActive &&
      state.workerActive === 0 &&
      state.waitingWorkers.length === 0
    ) {
      this.states.delete(provider);
    }
  }
}
