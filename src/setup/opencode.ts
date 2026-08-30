import fs from "node:fs";
import path from "node:path";
import modelsData from "@/models.json" with { type: "json" };
import { getCatalog, refreshCatalog, type ModelCatalog } from "@/translate/catalog.js";
import { readAuthKey } from "@/auth.js";
import { DEFAULT_CC_API_BASE } from "@/config.js";

/** Every reasoning-effort tier CC/OpenCode know about, ordered low → max. */
const EFFORT_UNIVERSE = ["low", "medium", "high", "xhigh", "max"] as const;

function buildProviderConfig(catalog: ModelCatalog): Record<string, unknown> {
  const maxOutputTokens: Record<string, number> =
    ((modelsData as Record<string, unknown>).maxOutputTokens as Record<string, number>) ?? {};
  const reasoningEfforts: Record<string, string[]> =
    ((modelsData as Record<string, unknown>).reasoningEfforts as Record<string, string[]>) ?? {};
  const models: Record<string, Record<string, unknown>> = {};
  for (const m of catalog.models) {
    const key = m.id.split("/").pop() ?? m.id;
    const entry: Record<string, unknown> = {
      name: m.displayName,
      limit: {
        context: m.contextWindow,
        output: maxOutputTokens[m.id] ?? 128_000,
      },
    };
    // OpenCode's `/variants` picker lists a model's `variants`. OpenCode also
    // auto-generates generic `WIDELY_SUPPORTED_EFFORTS` (low/medium/high) for any
    // reasoning-capable openai-compatible model and mergeDeep's them with our
    // config — which would surface effort levels the model doesn't actually
    // support. Declare the full effort universe and `disabled:true` the ones
    // this model rejects; OpenCode filters disabled variants out (pickBy).
    const efforts = reasoningEfforts[m.id];
    if (efforts && efforts.length > 0) {
      entry.reasoning = true;
      const variants: Record<string, Record<string, unknown>> = {};
      for (const e of EFFORT_UNIVERSE) {
        variants[e] = efforts.includes(e) ? { reasoningEffort: e } : { disabled: true };
      }
      entry.variants = variants;
    }
    models[key] = entry;
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Command Code",
    options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "proxy-managed" },
    models,
  };
}

function getConfigPath(scope: "local" | "global"): string {
  if (scope === "local") {
    return path.join(process.cwd(), "opencode.json");
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "opencode", "opencode.json");
}

function readConfig(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(filePath: string, config: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Resolve the live model catalog for the generated config. Uses the CC API
 * when a key is available (env or saved auth); otherwise falls back to the
 * static catalog from models.json.
 */
async function resolveCatalog(): Promise<ModelCatalog> {
  const apiKey = process.env.CC_API_KEY || readAuthKey();
  if (!apiKey) return getCatalog();
  const apiBase = process.env.CC_API_BASE || DEFAULT_CC_API_BASE;
  const catalog = await refreshCatalog(apiBase, apiKey);
  console.log(
    catalog.models.some((m) => m.source === "api")
      ? "  Model list fetched from Command Code API."
      : "  Using built-in model list (API unavailable).",
  );
  return catalog;
}

export async function setupOpenCodeConfig(scope?: "local" | "global"): Promise<void> {
  const chosen = scope ?? "global";
  const filePath = getConfigPath(chosen);
  const config = readConfig(filePath);

  const providers = (config.provider ?? {}) as Record<string, unknown>;
  providers.commandcode = buildProviderConfig(await resolveCatalog());
  config.provider = providers;

  writeConfig(filePath, config);

  console.log(`\n✓ Config written to ${filePath}`);
  console.log("  Restart OpenCode to use Command Code.\n");
}
