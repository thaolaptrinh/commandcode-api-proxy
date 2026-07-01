import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// ── Shell RC file detection ──

function detectShellRc(): string | null {
  const shell = process.env.SHELL || "";
  const home = os.homedir();

  if (shell.includes("zsh")) return path.join(home, ".zshrc");
  if (shell.includes("bash")) return path.join(home, ".bashrc");
  if (shell.includes("fish")) return path.join(home, ".config", "fish", "config.fish");

  return null;
}

function rcExportLines(): string[] {
  const shell = process.env.SHELL || "";
  const lines = [
    `export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"`,
    `export ANTHROPIC_API_KEY="proxy-managed"`,
  ];
  if (shell.includes("fish")) {
    return [
      `set -gx ANTHROPIC_BASE_URL "http://127.0.0.1:8787"`,
      `set -gx ANTHROPIC_API_KEY "proxy-managed"`,
    ];
  }
  return lines;
}

function appendToRc(rcPath: string, lines: string[]): boolean {
  let content = "";
  try {
    content = fs.readFileSync(rcPath, "utf-8");
  } catch {
    content = "";
  }

  const alreadyHasBaseUrl = content.includes("ANTHROPIC_BASE_URL");
  const alreadyHasApiKey = content.includes("ANTHROPIC_API_KEY");

  if (alreadyHasBaseUrl && alreadyHasApiKey) return false;

  const toAppend: string[] = [];
  if (!alreadyHasBaseUrl) toAppend.push(lines[0]);
  if (!alreadyHasApiKey) toAppend.push(lines[1]);

  const newSection = `\n# Command Code API Proxy (added by --setup-claude-code)\n${toAppend.join("\n")}\n`;
  fs.appendFileSync(rcPath, newSection);
  return true;
}

// ── Main ──

export async function setupClaudeCodeConfig(force: boolean): Promise<void> {
  const configPath = getConfigPath();

  if (fs.existsSync(configPath) && !force) {
    console.log(`\n  ⚠ Config already exists at ${configPath}\n`);
    console.log("  Edit it manually, or run: commandcode-api-proxy --setup-claude-code --force\n");
    return;
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  console.log(`\n  ✓ Config written to ${configPath}\n`);

  const rcPath = detectShellRc();
  if (rcPath) {
    const lines = rcExportLines();
    const appended = appendToRc(rcPath, lines);
    if (appended) {
      console.log(`  ✓ Added Claude Code env vars to ${rcPath}\n`);
      console.log(`  Restart your shell, then run: claude\n`);
    } else {
      console.log(`  ✓ ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY already set in ${rcPath}\n`);
    }
  } else {
    console.log("  Could not detect shell. Add these to your shell profile:\n");
    console.log(`    ${rcExportLines().join("\n    ")}\n`);
  }
}
