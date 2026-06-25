import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import modelsData from "@/models.json" with { type: "json" };

function buildProviderConfig(): Record<string, unknown> {
  const models: Record<string, { name: string }> = {};
  for (const id of modelsData.builtin) {
    const short = id.split("/").pop() ?? id;
    models[id] = { name: short };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Command Code",
    options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "placeholder" },
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

function promptScope(): Promise<"local" | "global"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log("\n? Select config scope:\n");
    console.log("  1) Local  — ./opencode.json (project root)");
    console.log("  2) Global — ~/.config/opencode/opencode.json\n");
    rl.question("> ", (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === "1") return resolve("local");
      return resolve("global");
    });
  });
}

export async function setupOpenCodeConfig(scope?: "local" | "global"): Promise<void> {
  const chosen = scope ?? (await promptScope());
  const filePath = getConfigPath(chosen);
  const config = readConfig(filePath);

  const providers = (config.provider ?? {}) as Record<string, unknown>;
  providers.commandcode = buildProviderConfig();
  config.provider = providers;

  writeConfig(filePath, config);

  console.log(`\n✓ Config written to ${filePath}`);
  console.log("  Restart OpenCode to use Command Code.\n");
}
