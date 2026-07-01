import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupClaudeCodeConfig } from "@/setup/claude-code.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function settingsPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "claude-settings.json");
}

describe("setupClaudeCodeConfig", () => {
  let originalFs: Record<string, unknown>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let written: string | null = null;

  function saveFs(): void {
    originalFs = {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
    };
  }

  function restoreFs(): void {
    fs.existsSync = originalFs.existsSync as typeof fs.existsSync;
    fs.mkdirSync = originalFs.mkdirSync as typeof fs.mkdirSync;
    fs.writeFileSync = originalFs.writeFileSync as typeof fs.writeFileSync;
  }

  beforeEach(() => {
    written = null;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    saveFs();

    fs.existsSync = ((p: fs.PathLike) => {
      if (p.toString() === settingsPath()) return false;
      return true;
    }) as typeof fs.existsSync;

    fs.mkdirSync = (() => undefined) as typeof fs.mkdirSync;

    fs.writeFileSync = ((p: fs.PathLike, data: string) => {
      if (p.toString() === settingsPath()) written = data;
    }) as typeof fs.writeFileSync;
  });

  afterEach(() => {
    restoreFs();
    consoleLogSpy.mockRestore();
  });

  test("creates settings file with env vars", async () => {
    await setupClaudeCodeConfig(false);
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written!);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(parsed.env.ANTHROPIC_API_KEY).toBe("proxy-managed");
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek/deepseek-v4-pro");
    expect(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek/deepseek-v4-pro");
    expect(parsed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek/deepseek-v4-flash");
  });

  test("does not overwrite existing without --force", async () => {
    fs.existsSync = (() => true) as typeof fs.existsSync;

    await setupClaudeCodeConfig(false);
    expect(written).toBeNull();
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already exists");
  });

  test("existing with --force overwrites", async () => {
    fs.existsSync = (() => true) as typeof fs.existsSync;

    await setupClaudeCodeConfig(true);
    expect(written).toBeTruthy();
  });

  test("prints claude --settings instruction", async () => {
    await setupClaudeCodeConfig(false);
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("claude --settings");
    expect(output).toContain(settingsPath());
  });
});
