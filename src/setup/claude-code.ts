import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getClaudeProxySettingsPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "claude-settings.json");
}

export async function setupClaudeCodeConfig(force: boolean): Promise<void> {
  const settingsPath = getClaudeProxySettingsPath();

  if (fs.existsSync(settingsPath) && !force) {
    console.log(`\n  ⚠ Settings already exists at ${settingsPath}\n`);
    console.log("  Run: commandcode-api-proxy --setup-claude-code --force\n");
    return;
  }

  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });

  const settings = {
    model: "sonnet",
    skipDangerousModePermissionPrompt: true,
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_API_KEY: "proxy-managed",
      ANTHROPIC_AUTH_TOKEN: "",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek/deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek/deepseek-v4-flash",
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`\n  ✓ Settings written to ${settingsPath}\n`);
  console.log("  To use with Claude Code, run:\n");
  console.log(`    claude --settings ${settingsPath}\n`);
  console.log("  Or set it as an alias:\n");
  console.log(`    alias claude-proxy="claude --settings ${settingsPath}"\n`);
}
