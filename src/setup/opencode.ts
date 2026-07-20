import fs from "node:fs";
import path from "node:path";
import modelsData from "@/models.json" with { type: "json" };

/** Every reasoning-effort tier CC/OpenCode know about, ordered low → max. */
const EFFORT_UNIVERSE = ["low", "medium", "high", "xhigh", "max"] as const;

function buildProviderConfig(): Record<string, unknown> {
  const contextWindows: Record<string, number> = modelsData.contextWindows ?? {};
  const maxOutputTokens: Record<string, number> =
    ((modelsData as Record<string, unknown>).maxOutputTokens as Record<string, number>) ?? {};
  const modelNames: Record<string, string> =
    ((modelsData as Record<string, unknown>).modelNames as Record<string, string>) ?? {};
  const reasoningEfforts: Record<string, string[]> =
    ((modelsData as Record<string, unknown>).reasoningEfforts as Record<string, string[]>) ?? {};
  const models: Record<string, Record<string, unknown>> = {};
  for (const id of modelsData.builtin) {
    const key = id.split("/").pop() ?? id;
    const entry: Record<string, unknown> = {
      name: modelNames[id] ?? key,
      limit: {
        context: contextWindows[id] ?? 128_000,
        output: maxOutputTokens[id] ?? 128_000,
      },
    };
    // OpenCode's `/variants` picker lists a model's `variants`. OpenCode also
    // auto-generates generic `WIDELY_SUPPORTED_EFFORTS` (low/medium/high) for any
    // reasoning-capable openai-compatible model and mergeDeep's them with our
    // config — which would surface effort levels the model doesn't actually
    // support. Declare the full effort universe and `disabled:true` the ones
    // this model rejects; OpenCode filters disabled variants out (pickBy).
    const efforts = reasoningEfforts[id];
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

export async function setupOpenCodeConfig(scope?: "local" | "global"): Promise<void> {
  const chosen = scope ?? "global";
  const filePath = getConfigPath(chosen);
  const config = readConfig(filePath);

  const providers = (config.provider ?? {}) as Record<string, unknown>;
  providers.commandcode = buildProviderConfig();
  config.provider = providers;

  writeConfig(filePath, config);

  console.log(`\n✓ Config written to ${filePath}`);
  console.log("  Restart OpenCode to use Command Code.\n");
}
