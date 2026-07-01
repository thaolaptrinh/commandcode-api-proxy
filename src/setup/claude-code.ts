import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "anthropic-models.json");
}

function getClaudeProxySettingsPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "claude-settings.json");
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
  const configPath = getConfigPath();

  if (fs.existsSync(configPath) && !force) {
    console.log(`\n  ⚠ Config already exists at ${configPath}\n`);
    console.log("  Edit it manually, or run: commandcode-api-proxy --setup-claude-code --force\n");
    return;
  }

  // 1. Write anthropic-models.json
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  console.log(`\n  ✓ Config written to ${configPath}\n`);

  // 2. Write dedicated claude proxy settings (won't touch ~/.claude/settings.json)
  const settingsPath = getClaudeProxySettingsPath();
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_API_KEY: "proxy-managed",
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  ✓ Settings written to ${settingsPath}\n`);

  // 3. Print usage instructions
  console.log("  To use with Claude Code, run:\n");
  console.log(`    claude --settings ${settingsPath}\n`);
  console.log("  Or set it as an alias:\n");
  console.log(`    alias claude-proxy="claude --settings ${settingsPath}"\n`);
}
