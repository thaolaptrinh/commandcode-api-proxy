import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupClaudeCodeConfig } from "@/setup/claude-code.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function proxySettingsPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "claude-settings.json");
}

function modelConfigPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "anthropic-models.json");
}

describe("setupClaudeCodeConfig", () => {
  let snapshot: Record<string, unknown>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let writtenFiles: Map<string, string>;

  function saveFs(): void {
    snapshot = {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
    };
  }

  function restoreFs(): void {
    fs.existsSync = snapshot.existsSync as typeof fs.existsSync;
    fs.mkdirSync = snapshot.mkdirSync as typeof fs.mkdirSync;
    fs.writeFileSync = snapshot.writeFileSync as typeof fs.writeFileSync;
  }

  beforeEach(() => {
    writtenFiles = new Map();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    saveFs();

    fs.existsSync = ((p: fs.PathLike) => {
      const s = p.toString();
      if (s === modelConfigPath()) return false;
      if (s === proxySettingsPath()) return false;
      return true;
    }) as typeof fs.existsSync;

    fs.writeFileSync = ((p: fs.PathLike, data: string) => {
      writtenFiles.set(p.toString(), data);
    }) as typeof fs.writeFileSync;

    fs.mkdirSync = (() => undefined) as typeof fs.mkdirSync;
  });

  afterEach(() => {
    restoreFs();
    consoleLogSpy.mockRestore();
  });

  test("creates model config file with defaults", async () => {
    await setupClaudeCodeConfig(false);
    const raw = writtenFiles.get(modelConfigPath());
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    expect(parsed.mappings["claude-sonnet-*"]).toBeDefined();
  });

  test("creates proxy settings file with env vars", async () => {
    await setupClaudeCodeConfig(false);
    const raw = writtenFiles.get(proxySettingsPath());
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(parsed.env.ANTHROPIC_API_KEY).toBe("proxy-managed");
  });

  test("does not overwrite existing config without --force", async () => {
    writtenFiles.set(modelConfigPath(), JSON.stringify({ default: "old" }));
    fs.existsSync = (() => true) as typeof fs.existsSync;

    await setupClaudeCodeConfig(false);

    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already exists");
    expect(writtenFiles.has(proxySettingsPath())).toBe(false);
  });

  test("existing config with --force overwrites", async () => {
    writtenFiles.set(modelConfigPath(), JSON.stringify({ default: "old" }));
    fs.existsSync = (() => true) as typeof fs.existsSync;

    await setupClaudeCodeConfig(true);

    const parsed = JSON.parse(writtenFiles.get(modelConfigPath())!);
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    expect(writtenFiles.has(proxySettingsPath())).toBe(true);
  });

  test("prints claude --settings instruction", async () => {
    await setupClaudeCodeConfig(false);
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("claude --settings");
    expect(output).toContain(proxySettingsPath());
    expect(output).toContain("alias");
  });
});
