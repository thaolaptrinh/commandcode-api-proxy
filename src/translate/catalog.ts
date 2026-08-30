// Dynamic model catalog: merges the CC provider API's live model list with the
// hand-maintained metadata in models.json. The API is the source of truth for
// which models exist, their display names, and context windows; models.json
// supplies what the API never returns (aliases, reasoning efforts, max output
// tokens) and doubles as the offline fallback.

import modelsData from "@/models.json" with { type: "json" };

export interface CatalogModel {
  id: string;
  displayName: string;
  contextWindow: number;
  source: "static" | "api";
}

export interface ModelCatalog {
  models: CatalogModel[];
  ids: string[];
  displayNames: Record<string, string>;
  contextWindows: Record<string, number>;
}

const STATIC_BUILTIN: string[] = modelsData.builtin;
const STATIC_CONTEXT: Record<string, number> = modelsData.contextWindows ?? {};
const STATIC_NAMES: Record<string, string> = modelsData.modelNames ?? {};
const CLOSED_MODEL_ORGS: string[] = modelsData.closedModelOrgs ?? [
  "anthropic",
  "openai",
  "google",
  "gemini",
];

const CLOSED_ORG_SET = new Set(CLOSED_MODEL_ORGS.map((o) => o.toLowerCase()));

/** New models land on the API long before anyone updates models.json, so the
 * catalog refreshes much more aggressively than the CLI version check. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

function buildCatalog(models: CatalogModel[]): ModelCatalog {
  return {
    models,
    ids: models.map((m) => m.id),
    displayNames: Object.fromEntries(models.map((m) => [m.id, m.displayName])),
    contextWindows: Object.fromEntries(models.map((m) => [m.id, m.contextWindow])),
  };
}

export function getStaticCatalog(): ModelCatalog {
  return buildCatalog(
    STATIC_BUILTIN.map((id) => ({
      id,
      displayName: STATIC_NAMES[id] ?? id.split("/").pop() ?? id,
      contextWindow: STATIC_CONTEXT[id] ?? 128_000,
      source: "static" as const,
    })),
  );
}

/**
 * CC serves closed models (Anthropic/OpenAI/Google) that this proxy
 * deliberately does not target. They appear in two shapes: bare ids
 * ("claude-opus-5", "gpt-5.5") and org-prefixed ("google/gemini-3.7-flash").
 */
export function isClosedModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith("claude-") || lower.startsWith("gpt-")) return true;
  return CLOSED_ORG_SET.has(lower.split("/")[0]);
}

let current: ModelCatalog = getStaticCatalog();
let lastFetchAt = 0;
let inflight: Promise<ModelCatalog> | null = null;

export function getCatalog(): ModelCatalog {
  return current;
}

interface ApiModel {
  id: string;
  name?: string;
  context_length?: number;
}

async function fetchApiModels(apiBase: string, apiKey: string): Promise<ApiModel[]> {
  const url = `${apiBase}/provider/v1/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: ApiModel[] };
  return json.data ?? [];
}

/**
 * Refresh the catalog from the CC provider API (TTL-guarded, deduped).
 * Merge rule: union of static builtin + API open models, static entries keep
 * their order first (preserves the default model), API wins for name/context
 * window when present. On failure or an empty filtered result the current
 * catalog is returned unchanged — never throws to the caller.
 */
export async function refreshCatalog(
  apiBase: string,
  apiKey: string,
  opts?: { force?: boolean },
): Promise<ModelCatalog> {
  if (!opts?.force && Date.now() - lastFetchAt < CATALOG_TTL_MS) return current;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const apiModels = await fetchApiModels(apiBase, apiKey);
      const open = apiModels.filter((m) => m.id && !isClosedModel(m.id));
      if (open.length > 0) {
        const apiById = new Map(open.map((m) => [m.id, m]));
        const merged: CatalogModel[] = [];
        const seen = new Set<string>();
        // Static builtin order first — keeps getDefaultModels()[0] stable.
        for (const id of STATIC_BUILTIN) {
          const api = apiById.get(id);
          merged.push({
            id,
            displayName: api?.name ?? STATIC_NAMES[id] ?? id.split("/").pop() ?? id,
            contextWindow: api?.context_length ?? STATIC_CONTEXT[id] ?? 128_000,
            source: api ? "api" : "static",
          });
          seen.add(id);
        }
        for (const m of open) {
          if (seen.has(m.id)) continue;
          merged.push({
            id: m.id,
            displayName: m.name ?? m.id.split("/").pop() ?? m.id,
            contextWindow: m.context_length ?? 128_000,
            source: "api",
          });
        }
        current = buildCatalog(merged);
        lastFetchAt = Date.now();
      }
    } catch {
      // Upstream failure → keep current catalog (static fallback).
    } finally {
      inflight = null;
    }
    return current;
  })();

  return inflight;
}

export function __resetCatalogForTests(): void {
  current = getStaticCatalog();
  lastFetchAt = 0;
  inflight = null;
}
