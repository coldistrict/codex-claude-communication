import type { PlanningModelSelection, ProviderRole } from '@collab/contracts';
import { resolveDefaultAdvisorProfile, type ResolvedAdvisorProfile } from './advisor/profile.ts';

/** Resolve only an advertised model and effort. Never silently substitute. */
export function resolvePlanningProfile(
  provider: ProviderRole,
  selection: PlanningModelSelection,
  rows: any[],
): ResolvedAdvisorProfile {
  if (selection.model === 'default') return resolveDefaultAdvisorProfile(provider, selection.effort, rows);
  const row = rows.find(candidate => candidate && candidate.hidden !== true && (
    provider === 'codex'
      ? candidate.model === selection.model
      : candidate.value === selection.model || candidate.resolvedModel === selection.model
  ));
  const model = provider === 'codex' ? row?.model : row?.resolvedModel;
  if (!model) throw new Error(`PLANNING_MODEL_UNAVAILABLE:${provider}:${selection.model}. Start a new collaboration with an available model.`);
  const efforts = provider === 'codex'
    ? (row.supportedReasoningEfforts ?? []).map((entry: any) => entry?.reasoningEffort ?? entry)
    : row.supportedEffortLevels ?? [];
  if (!efforts.includes(selection.effort)) throw new Error(`PLANNING_EFFORT_UNAVAILABLE:${provider}:${model}:${selection.effort}. Start a new collaboration with an available effort.`);
  return { model, effortValue: selection.effort };
}
