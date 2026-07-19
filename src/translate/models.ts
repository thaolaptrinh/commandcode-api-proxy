// Model resolution, aliasing, and discovery against the CC provider API.

import modelsData from "@/models.json" with { type: "json" };

const BUILTIN_MODELS: string[] = modelsData.builtin;
const SHORT_ALIASES: Record<string, string> = modelsData.shortAliases;
/** Canonical model id → the discrete reasoning-effort levels CC accepts for it. */
const REASONING_EFFORTS: Record<string, string[]> = modelsData.reasoningEfforts ?? {};

/** Rank ordering of effort levels (low → max). Used to clip to the nearest valid. */
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/**
 * Fetch available models from CC provider API. Returns the model list (used by
 * the /v1/models endpoint). Failures yield an empty list — the caller falls
 * back to the built-in defaults.
 */
export async function fetchModelList(apiBase: string, apiKey: string): Promise<string[]> {
  try {
    const url = `${apiBase}/provider/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id: string }[] };
    return json.data?.map((m) => m.id) ?? [];
  } catch {
    return [];
  }
}

export function getDefaultModels(): string[] {
  return BUILTIN_MODELS;
}

export function resolveModel(model: string): string {
  if (!model || model === "default") {
    return BUILTIN_MODELS[0];
  }
  const aliased = SHORT_ALIASES[model];
  if (aliased) return aliased;
  // Already a full model ID (contains "/") — pass through untouched.
  if (model.includes("/")) return model;
  return model;
}

/**
 * Resolve a requested reasoning effort for a specific (canonical) model.
 *
 * CC accepts `params.reasoning_effort` but each model supports a different set
 * of levels, and CC silently coerces unsupported values (it does not 400). To
 * honor caller intent without sending a value the model can't use:
 *   - If the model isn't catalogued (no known effort set), pass the request
 *     through unchanged — we don't know better, so don't regress.
 *   - If the model has a known effort set, clip an unsupported request to the
 *     nearest valid level (highest supported rank ≤ requested, else the lowest
 *     supported). E.g. deepseek-v4-pro supports only {high, max}, so a request
 *     for "low"/"medium" becomes "high", and "max" stays reachable.
 *   - If no effort was requested, return undefined and let CC pick its default.
 */
export function resolveEffortForModel(
  canonicalModel: string,
  requested?: string,
): string | undefined {
  const supported = REASONING_EFFORTS[canonicalModel];
  // Uncatalogued model, or nothing requested → preserve as-is (undefined or the value).
  if (!supported || !requested) return requested;

  if (supported.includes(requested)) return requested;

  const rank = (e: string): number => EFFORT_RANK[e] ?? 2;
  const reqRank = rank(requested);
  const atOrBelow = supported.filter((e) => rank(e) <= reqRank);
  if (atOrBelow.length > 0) {
    return atOrBelow.reduce((best, e) => (rank(e) > rank(best) ? e : best));
  }
  // Requested rank is below every supported level → use the lowest supported.
  return supported.reduce((best, e) => (rank(e) < rank(best) ? e : best));
}
