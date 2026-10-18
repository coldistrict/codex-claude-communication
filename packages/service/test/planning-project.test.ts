import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@collab/kernel';
import { ClaudeAgentAdapter, CodexAppServerClient } from '@collab/adapters';
import { Coordinator } from '../src/coordinator.ts';
import { PlanningRunner, planningSessionTitle, realPlanningPort, type PlanningCall } from '../src/planning-runner.ts';
import { fixturePort } from './planning-fixture.ts';

const roots: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'planning-project-')));
  roots.push(root);
  const project = join(root, 'Learning TypeScript');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# Learning TypeScript\nOriginal context.');
  const store = new EventStore(join(root, 'events.sqlite'));
  stores.push(store);
  const coordinator = new Coordinator(store, { codexBinary: '/unused' });
  return { root, project, store, coordinator };
}

it('uses the chosen project for every provider stage and persists documents outside the sources', async () => {
  const { root, project, store, coordinator } = setup();
  const id = coordinator.createRun({ goal: 'Plan a TypeScript course.', workspace: project }, true);
  const calls: PlanningCall[] = [];
  const factory = vi.fn(() => fixturePort({ calls, reject: true }));
  await new PlanningRunner(store, { codexBinary: '/unused', portFactory: factory }).run(id);
  expect(store.projection(id).state).toBe('completed_consensus');
  expect(factory).toHaveBeenCalledWith(id, project);
  expect(new Set(calls.map(c => c.role))).toEqual(new Set(['codex', 'claude']));
  expect(calls.every(c => c.sessionTitle?.startsWith('Plan a TypeScript course. · '))).toBe(true);
  expect(calls.find(c => c.phase === 'revision')?.sessionTitle).toContain('Revision 2');
  expect(calls.filter(c => c.phase === 'review').at(-1)?.sessionTitle).toContain('Review 2');
  expect(readdirSync(project)).toEqual(['README.md']);
  expect(readFileSync(join(project, 'README.md'), 'utf8')).toContain('Original context.');
  expect(readFileSync(join(root, 'documents', id, 'current.md'), 'utf8')).toContain('Revised plan 2');
  store.rebuildAllProjections();
  expect(store.projection(id).goal?.projectContext).toBe(project);
});

it('keeps standalone collaborations in their own runtime folders', async () => {
  const { root, store, coordinator } = setup();
  const factory = vi.fn(() => fixturePort());
  const runner = new PlanningRunner(store, { codexBinary: '/unused', portFactory: factory });
  for (let n = 0; n < 2; n++) {
    const id = coordinator.createRun({ goal: 'A standalone question.' }, true);
    await runner.run(id);
    expect(factory).toHaveBeenLastCalledWith(id, join(root, 'runs', id, 'runtime'));
    expect(store.projection(id).goal?.projectContext).toBeNull();
  }
});

it('reuses the saved project after restart and stops before provider startup when the folder is gone', async () => {
  const { project, store, coordinator } = setup();
  const id = coordinator.createRun({ goal: 'Plan a course.', workspace: project }, true);
  await new PlanningRunner(store, { codexBinary: '/unused', portFactory: () => fixturePort({ clarify: true }) }).run(id);
  const card = store.projection(id).actions[0]!;
  store.append({ runId: id, actor: 'user', type: 'clarification_answered', idempotencyKey: 'answer', payload: { cardId: card.id, question: card.body, answer: 'Two hours.' } });
  store.rebuildAllProjections();
  renameSync(project, `${project}-moved`);
  const factory = vi.fn(() => fixturePort());
  await new PlanningRunner(store, { codexBinary: '/unused', portFactory: factory }).run(id);
  expect(factory).not.toHaveBeenCalled();
  expect(store.projection(id).actions[0]?.body).toContain('saved project folder is unavailable');
  renameSync(`${project}-moved`, project);
  const resumed = new Coordinator(store, { codexBinary: '/unused', planning: { portFactory: factory } });
  await resumed.decideAction(id, store.projection(id).actions[0]!.id, 'Retry collaboration');
  for (let n = 0; n < 100 && !store.projection(id).completedAt; n++) await new Promise(r => setTimeout(r, 5));
  expect(factory).toHaveBeenCalledWith(id, project);
  expect(store.projection(id).state).toBe('completed_consensus');
  await resumed.shutdown();
});

it('passes the selected cwd and task title into both real adapters without reusing sessions', async () => {
  const { project } = setup();
  const ok = { ok: true, billing: { route: 'subscription_allowance' } } as any;
  vi.spyOn(CodexAppServerClient.prototype, 'metadataPreflight').mockResolvedValue(ok);
  vi.spyOn(ClaudeAgentAdapter.prototype, 'metadataPreflight').mockResolvedValue(ok);
  vi.spyOn(CodexAppServerClient.prototype, 'listModels').mockResolvedValue([{ model: 'fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }]);
  vi.spyOn(ClaudeAgentAdapter.prototype, 'listModels').mockResolvedValue([{ value: 'default', resolvedModel: 'fixture', supportedEffortLevels: ['medium'] }]);
  vi.spyOn(CodexAppServerClient.prototype, 'close').mockResolvedValue();
  const seen: unknown[] = [];
  const result = { text: '{}', usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 } } as any;
  vi.spyOn(CodexAppServerClient.prototype, 'runBurst').mockImplementation(async function (this: any, input) { seen.push({ cwd: this.options.cwd, title: input.sessionTitle, resume: input.threadId }); return result; });
  vi.spyOn(ClaudeAgentAdapter.prototype, 'startBurst').mockImplementation(async function (this: any, input) { seen.push({ cwd: this.options.cwd, title: input.sessionTitle, resume: input.sessionId }); return result; });
  const port = realPlanningPort({ codexBinary: '/unused', environment: {} }, project);
  const input = { runId: 'run_test', phase: 'proposal', key: 'proposal', prompt: 'Shared evidence', sessionTitle: 'Course · Proposal · test', schema: {}, authorization: {}, signal: new AbortController().signal } as const;
  for (const role of ['codex', 'claude'] as const) await port.call({ ...input, role } as PlanningCall);
  expect(seen).toEqual([1, 2].map(() => ({ cwd: project, title: input.sessionTitle, resume: undefined })));
  await port.close();
});

it('keeps session labels compact and distinguishes repairs and runs', () => {
  const title = planningSessionTitle('A long\n brief '.repeat(30), 'run_12345678-1234', 'review', { document: { number: 2 } }, 2);
  expect(title).not.toContain('\n');
  expect(title.length).toBeLessThan(140);
  expect(title).toContain('Review 2 (repair) · 12345678');
  expect(planningSessionTitle('Same task', 'run_abcdef01', 'proposal')).not.toBe(planningSessionTitle('Same task', 'run_abcdef02', 'proposal'));
});
