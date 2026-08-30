// Model resolution, aliasing, and discovery against the CC provider API.

import modelsData from "@/models.json" with { type: "json" };
import { getCatalog, refreshCatalog } from "@/translate/catalog.js";

const BUILTIN_MODELS: string[] = modelsData.builtin;
const SHORT_ALIASES: Record<string, string> = modelsData.shortAliases;
/** Canonical model id → the discrete reasoning-effort levels CC accepts for it. */
const REASONING_EFFORTS: Record<string, string[]> = modelsData.reasoningEfforts ?? {};

/** Rank ordering of effort levels (low → max). Used to clip to the nearest valid. */
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/**
 * Fetch available open-source models from the CC provider API (closed models
 * are filtered out) and merge them into the catalog. Returns the merged model
 * list. Failures keep the current (static fallback) catalog.
 */
export async function fetchModelList(apiBase: string, apiKey: string): Promise<string[]> {
  const catalog = await refreshCatalog(apiBase, apiKey);
  return catalog.ids;
}

export function getDefaultModels(): string[] {
  return getCatalog().ids;
}

export function resolveModel(model: string): string {
  if (!model || model === "default") {
    return getCatalog().ids[0] ?? BUILTIN_MODELS[0];
  }
  // Alias lookup is case-insensitive so callers can pass the bare model name
  // with original casing (e.g. "GLM-5.2") as well as the lowercase short alias.
  const aliased = SHORT_ALIASES[model] ?? SHORT_ALIASES[model.toLowerCase()];
  if (aliased) return aliased;
  // Already a full model ID (contains "/") — pass through untouched.
  if (model.includes("/")) return model;
  // Bare name without an org prefix (e.g. "GLM-5.2", "Kimi-K3", or
  // "nemotron-3-ultra-550b-a55b" — which has no short alias). Match it against
  // the (dynamic) catalog by last path segment so it still resolves to a full ID.
  const lower = model.toLowerCase();
  for (const id of getCatalog().ids) {
    const last = id.split("/").pop() ?? id;
    if (last.toLowerCase() === lower) return id;
  }
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
  // Uncatalogued/empty effort set, or nothing requested → preserve as-is
  // (undefined or the value). The empty-array guard matters: `[]` is truthy,
  // and reduce() on it below would otherwise throw.
  if (!supported || supported.length === 0 || !requested) return requested;

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
