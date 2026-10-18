import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentAdapter, CodexAppServerClient } from '@collab/adapters';
import { EventStore } from '@collab/kernel';
import { Coordinator } from '../src/coordinator.ts';
import { realPlanningPort } from '../src/planning-runner.ts';
import { resolvePlanningProfile } from '../src/planning-models.ts';

const codexRows = [
  { model: 'gpt-6-astra', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  { model: 'gpt-5.6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
];
const claudeRows = [{ value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['medium', 'high'] }];
const models = { codex: { model: 'gpt-5.6-luna', effort: 'high' as const }, claude: { model: 'opus[1m]', effort: 'medium' as const } };
afterEach(() => vi.restoreAllMocks());

describe('per-run planning models', () => {
  it('resolves the selected model instead of the provider default, including Claude catalog aliases', () => {
    expect(resolvePlanningProfile('codex', models.codex, codexRows)).toEqual({ model: 'gpt-5.6-luna', effortValue: 'high' });
    expect(resolvePlanningProfile('claude', models.claude, claudeRows)).toEqual({ model: 'claude-opus-5[1m]', effortValue: 'medium' });
    expect(resolvePlanningProfile('codex', { model: 'default', effort: 'medium' }, codexRows).model).toBe('gpt-6-astra');
  });
  it('rejects unavailable, hidden, and unsupported-effort choices without a fallback', () => {
    expect(() => resolvePlanningProfile('codex', { model: 'missing', effort: 'high' }, codexRows)).toThrow('MODEL_UNAVAILABLE');
    expect(() => resolvePlanningProfile('codex', models.codex, [{ ...codexRows[1], hidden: true }])).toThrow('MODEL_UNAVAILABLE');
    expect(() => resolvePlanningProfile('codex', { ...models.codex, effort: 'medium' }, codexRows)).toThrow('EFFORT_UNAVAILABLE');
    expect(() => resolvePlanningProfile('claude', models.claude, [])).toThrow('MODEL_UNAVAILABLE');
  });
  it('persists model selections through event replay and rejects malformed HTTP input before recording a goal', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'planning-models-')), 'events.sqlite');
    const store = new EventStore(file);
    const coordinator = new Coordinator(store, { codexBinary: '/unused' });
    const id = coordinator.createRun({ goal: 'Test models', planningModels: models }, true);
    models.codex.model = 'changed-after-creation';
    expect(store.projection(id).goal?.planningModels?.codex?.model).toBe('gpt-5.6-luna');
    models.codex.model = 'gpt-5.6-luna';
    for (const bad of [null, [], { other: models.codex }, { codex: { model: '--bad', effort: 'high' } }, { codex: { model: 'gpt-5.6-luna', effort: 'ultra' } }]) {
      expect(() => coordinator.createRun({ goal: 'Invalid', planningModels: bad as any }, true)).toThrow('INVALID_PLANNING_MODELS');
    }
    store.close();
    const reopened = new EventStore(file);
    reopened.rebuildAllProjections();
    expect(reopened.projection(id).goal?.planningModels).toEqual(models);
    expect(reopened.verifyHashChain(id).ok).toBe(true);
    reopened.close();
  });
  it('passes Luna/high and resolved Opus to the real adapters and reports completed-call identity', async () => {
    const ok = { ok: true, billing: { route: 'subscription_allowance' } } as any;
    vi.spyOn(CodexAppServerClient.prototype, 'metadataPreflight').mockResolvedValue(ok);
    vi.spyOn(ClaudeAgentAdapter.prototype, 'metadataPreflight').mockResolvedValue(ok);
    vi.spyOn(CodexAppServerClient.prototype, 'listModels').mockResolvedValue(codexRows);
    vi.spyOn(ClaudeAgentAdapter.prototype, 'listModels').mockResolvedValue(claudeRows);
    vi.spyOn(CodexAppServerClient.prototype, 'close').mockResolvedValue();
    const usage = { input: 50, cachedInput: 0, output: 10, reasoning: 0 };
    const codex = vi.spyOn(CodexAppServerClient.prototype, 'runBurst').mockResolvedValue({ text: '{}', usage } as any);
    const claude = vi.spyOn(ClaudeAgentAdapter.prototype, 'startBurst').mockResolvedValue({ text: '{}', usage } as any);
    const port = realPlanningPort({ codexBinary: '/unused', models, environment: {} }, tmpdir());
    const input = { runId: 'test', phase: 'proposal', key: 'proposal', prompt: 'test', schema: {}, authorization: {}, signal: new AbortController().signal } as any;
    expect((await port.call({ ...input, role: 'codex' })).identity).toEqual({ model: 'gpt-5.6-luna', effort: 'high' });
    expect((await port.call({ ...input, role: 'claude' })).identity).toEqual({ model: 'claude-opus-5[1m]', effort: 'medium' });
    expect(codex).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna', effort: 'high', executionProfile: 'planning', sandbox: 'read-only' }));
    expect(claude).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5[1m]', effort: 'medium', executionProfile: 'planning', readOnly: true }));
    await port.close();
    const unavailable = realPlanningPort({ codexBinary: '/unused', models: { codex: { model: 'missing', effort: 'high' } }, environment: {} }, tmpdir());
    await expect(unavailable.call({ ...input, role: 'codex' })).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(codex).toHaveBeenCalledTimes(1);
    expect(claude).toHaveBeenCalledTimes(1);
    await unavailable.close();
  });
});
