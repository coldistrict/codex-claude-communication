import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdvisorEffort, ProviderRole } from "@collab/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "../../../../pin-manifest.json"), "utf8"),
);

export interface PinnedAdvisorProfile {
  provider: ProviderRole;
  /** Exact canonical model id; never an alias, never a fallback. */
  model: string;
  /** Catalog row key used for per-wake availability verification. */
  catalogKey: string;
  efforts: Record<AdvisorEffort, string>;
}

/**
 * The pinned adviser model profile, selected once through the metadata-only
 * deterministic default-row rule and recorded in pin-manifest.json. A
 * provider whose catalog could not satisfy the rule is unavailable — there
 * is no alias, fallback, tier substitute, or silent downgrade.
 */
export function pinnedAdvisorProfile(provider: ProviderRole): PinnedAdvisorProfile {
  const pinned = manifest.advisor?.[provider];
  if (!pinned || pinned.available !== true) {
    throw new Error(
      `ADVISOR_PROVIDER_UNAVAILABLE:${provider}: no pinned deterministic default-row profile`,
    );
  }
  if (
    typeof pinned.canonicalModel !== "string" ||
    !pinned.canonicalModel ||
    typeof pinned.efforts?.high !== "string" ||
    typeof pinned.efforts?.medium !== "string"
  ) {
    throw new Error(`ADVISOR_PROFILE_PIN_INVALID:${provider}`);
  }
  return {
    provider,
    model: pinned.canonicalModel,
    catalogKey:
      provider === "codex"
        ? String(pinned.catalogId ?? pinned.canonicalModel)
        : String(pinned.catalogValue ?? pinned.canonicalModel),
    efforts: { high: pinned.efforts.high, medium: pinned.efforts.medium },
  };
}

/**
 * Per-wake catalog verification: the exact pinned row must still be
 * account-visible and still advertise the chosen effort. Unknown or drifted
 * catalog state fails the adviser wake closed without touching the workers.
 */
export function verifyAdvisorCatalog(
  profile: PinnedAdvisorProfile,
  effort: AdvisorEffort,
  catalogRows: any[],
): { model: string; effortValue: string } {
  const effortValue = profile.efforts[effort];
  if (profile.provider === "codex") {
    const row = catalogRows.find(
      (candidate) =>
        candidate &&
        candidate.hidden !== true &&
        String(candidate.model ?? "") === profile.model,
    );
    if (!row) {
      throw new Error(
        `ADVISOR_MODEL_DRIFT:codex:${profile.model}: pinned row is no longer in model/list`,
      );
    }
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.map((entry: any) =>
          String(entry?.reasoningEffort ?? entry ?? ""),
        )
      : [];
    if (!efforts.includes(effortValue)) {
      throw new Error(
        `ADVISOR_EFFORT_DRIFT:codex:${profile.model}:${effortValue} not advertised`,
      );
    }
    return { model: profile.model, effortValue };
  }
  const row = catalogRows.find(
    (candidate) =>
      candidate && String(candidate.value ?? "") === profile.catalogKey,
  );
  if (!row) {
    throw new Error(
      `ADVISOR_MODEL_DRIFT:claude:${profile.catalogKey}: pinned row is no longer in supportedModels`,
    );
  }
  const resolved = String(row.resolvedModel ?? row.value ?? "");
  if (resolved !== profile.model) {
    throw new Error(
      `ADVISOR_MODEL_DRIFT:claude:${profile.catalogKey}: resolves to ${resolved || "unknown"}, pinned ${profile.model}`,
    );
  }
  const efforts = Array.isArray(row.supportedEffortLevels)
    ? row.supportedEffortLevels.map((entry: any) => String(entry))
    : [];
  if (!efforts.includes(effortValue)) {
    throw new Error(
      `ADVISOR_EFFORT_DRIFT:claude:${profile.model}:${effortValue} not advertised`,
    );
  }
  return { model: profile.model, effortValue };
}
