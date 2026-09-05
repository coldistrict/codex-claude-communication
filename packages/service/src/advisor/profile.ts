import type { AdvisorEffort, ProviderRole } from "@collab/contracts";

export interface ResolvedAdvisorProfile {
  /** Exact model id resolved from the provider's current default row. */
  model: string;
  effortValue: string;
}

/**
 * Wake-time model selection for the adviser: follow the provider's current
 * default catalog row ("auto"), exactly as the workers follow each CLI's
 * default model. The selection is metadata-only and re-resolved on every
 * wake — Codex uses the non-hidden `isDefault: true` row of model/list
 * (exact `model` field); Claude uses the supportedModels() row with
 * `value: "default"` resolved through `resolvedModel`. There is still no
 * alias, tier substitute, or silent downgrade of the requested effort: a
 * provider without a resolvable default row advertising the chosen effort
 * fails the adviser wake closed without touching the workers.
 */
export function resolveDefaultAdvisorProfile(
  provider: ProviderRole,
  effort: AdvisorEffort,
  catalogRows: any[],
): ResolvedAdvisorProfile {
  if (provider === "codex") {
    const row = catalogRows.find(
      (candidate) =>
        candidate && candidate.hidden !== true && candidate.isDefault === true,
    );
    const model = String(row?.model ?? "");
    if (!row || !model) {
      throw new Error(
        "ADVISOR_DEFAULT_ROW_UNAVAILABLE:codex: model/list advertises no visible default row",
      );
    }
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.map((entry: any) =>
          String(entry?.reasoningEffort ?? entry ?? ""),
        )
      : [];
    if (!efforts.includes(effort)) {
      throw new Error(
        `ADVISOR_EFFORT_UNAVAILABLE:codex:${model}:${effort} not advertised`,
      );
    }
    return { model, effortValue: effort };
  }
  const row = catalogRows.find(
    (candidate) => candidate && String(candidate.value ?? "") === "default",
  );
  const model = String(row?.resolvedModel ?? "");
  if (!row || !model) {
    throw new Error(
      "ADVISOR_DEFAULT_ROW_UNAVAILABLE:claude: supportedModels has no resolvable default row",
    );
  }
  const efforts = Array.isArray(row.supportedEffortLevels)
    ? row.supportedEffortLevels.map((entry: any) => String(entry))
    : [];
  if (!efforts.includes(effort)) {
    throw new Error(
      `ADVISOR_EFFORT_UNAVAILABLE:claude:${model}:${effort} not advertised`,
    );
  }
  return { model, effortValue: effort };
}
