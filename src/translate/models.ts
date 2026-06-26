// Model resolution, aliasing, and discovery against the CC provider API.

import modelsData from "@/models.json" with { type: "json" };

const BUILTIN_MODELS: string[] = modelsData.builtin;
const SHORT_ALIASES: Record<string, string> = modelsData.shortAliases;

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
