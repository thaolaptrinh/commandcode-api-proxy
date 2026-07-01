import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "@/logger.js";

function getConfigPath(): string {
  const home = os.homedir();
  return path.join(home, ".config", "commandcode-api-proxy", "anthropic-models.json");
}

const DEFAULT_CONFIG = {
  default: "deepseek/deepseek-v4-pro",
  mappings: {
    "claude-sonnet-*": "deepseek/deepseek-v4-pro",
    "claude-opus-*": "deepseek/deepseek-v4-pro",
    "claude-haiku-*": "deepseek/deepseek-v4-flash",
  },
};

export async function setupClaudeCodeConfig(force: boolean): Promise<void> {
  const filePath = getConfigPath();

  if (fs.existsSync(filePath) && !force) {
    console.log(`\n  ⚠ Config already exists at ${filePath}\n`);
    console.log("  Edit it manually, or run: commandcode-api-proxy --setup-claude-code --force\n");
    return;
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  console.log(`\n  ✓ Config written to ${filePath}\n`);
  console.log("  Edit the file to customize which CC model each Claude tier maps to.");
  console.log(
    "  Order matters — put specific patterns (claude-sonnet-*) before general (claude-*).\n",
  );
  console.log("  Then add these to your shell profile (~/.zshrc or ~/.bashrc):\n");
  console.log("    export ANTHROPIC_BASE_URL=http://127.0.0.1:8787");
  console.log("    export ANTHROPIC_API_KEY=proxy-managed\n");
  console.log("  Restart your shell, then run: claude\n");
}
