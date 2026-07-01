import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupClaudeCodeConfig } from "@/setup/claude-code.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "anthropic-models.json");
}

describe("setupClaudeCodeConfig", () => {
  let snapshot: Record<string, unknown>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let writtenPath: string | null = null;
  let writtenContent: string | null = null;
  let appendedPath: string | null = null;
  let appendedContent: string | null = null;
  let rcContent: string = "";

  function saveFs(): void {
    snapshot = {
      existsSync: fs.existsSync as unknown as Record<string, unknown>,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      appendFileSync: fs.appendFileSync,
      readFileSync: fs.readFileSync,
    };
  }

  function restoreFs(): void {
    fs.existsSync = snapshot.existsSync as typeof fs.existsSync;
    fs.mkdirSync = snapshot.mkdirSync as typeof fs.mkdirSync;
    fs.writeFileSync = snapshot.writeFileSync as typeof fs.writeFileSync;
    fs.appendFileSync = snapshot.appendFileSync as typeof fs.appendFileSync;
    fs.readFileSync = snapshot.readFileSync as typeof fs.readFileSync;
  }

  beforeEach(() => {
    writtenPath = null;
    writtenContent = null;
    appendedPath = null;
    appendedContent = null;
    rcContent = "";
    process.env.SHELL = "/usr/bin/zsh";
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    saveFs();

    fs.existsSync = ((p: fs.PathLike) => {
      if (p === getConfigPath()) return false;
      return true;
    }) as typeof fs.existsSync;
    fs.mkdirSync = (() => undefined) as typeof fs.mkdirSync;
    fs.writeFileSync = ((p: fs.PathLike, data: string) => {
      if (p === getConfigPath()) {
        writtenPath = p as string;
        writtenContent = data;
      }
    }) as typeof fs.writeFileSync;
    fs.appendFileSync = ((p: fs.PathLike, data: string) => {
      appendedPath = p as string;
      appendedContent = data;
    }) as typeof fs.appendFileSync;
    fs.readFileSync = (() => "") as typeof fs.readFileSync;
  });

  afterEach(() => {
    restoreFs();
    consoleLogSpy.mockRestore();
    delete process.env.SHELL;
  });

  test("creates config file with defaults", async () => {
    await setupClaudeCodeConfig(false);
    expect(writtenPath).toBe(getConfigPath());
    const parsed = JSON.parse(writtenContent!);
    expect(parsed.default).toBeDefined();
    expect(parsed.mappings["claude-sonnet-*"]).toBeDefined();
  });

  test("appends proxy env vars to zshrc", async () => {
    process.env.SHELL = "/usr/bin/zsh";
    await setupClaudeCodeConfig(false);
    expect(appendedPath).toContain(".zshrc");
    expect(appendedContent).toContain("ANTHROPIC_BASE_URL");
    expect(appendedContent).toContain("ANTHROPIC_API_KEY");
    expect(appendedContent).toContain("proxy-managed");
  });

  test("appends to bashrc for bash", async () => {
    process.env.SHELL = "/usr/bin/bash";
    await setupClaudeCodeConfig(false);
    expect(appendedPath).toContain(".bashrc");
    expect(appendedContent).toContain("export ANTHROPIC");
  });

  test("uses fish syntax for fish shell", async () => {
    process.env.SHELL = "/usr/bin/fish";
    await setupClaudeCodeConfig(false);
    expect(appendedContent).toContain("set -gx ANTHROPIC");
  });

  test("does not duplicate ANTHROPIC_BASE_URL", async () => {
    fs.readFileSync = (() =>
      'export ANTHROPIC_BASE_URL="http://localhost:8787"') as typeof fs.readFileSync;
    await setupClaudeCodeConfig(false);
    expect(appendedContent).toContain("ANTHROPIC_API_KEY");
    expect(appendedContent).not.toContain("ANTHROPIC_BASE_URL");
  });

  test("does not append if both vars already in RC", async () => {
    fs.readFileSync = (() =>
      'export ANTHROPIC_BASE_URL="http://localhost:8787"\nexport ANTHROPIC_API_KEY="x"') as typeof fs.readFileSync;
    await setupClaudeCodeConfig(false);
    expect(appendedPath).toBeNull();
  });

  test("existing file without force warns", async () => {
    fs.existsSync = ((p: fs.PathLike) => true) as typeof fs.existsSync;
    await setupClaudeCodeConfig(false);
    expect(writtenPath).toBeNull();
    expect(appendedPath).toBeNull();
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already exists");
  });

  test("existing file with force overwrites", async () => {
    fs.existsSync = ((p: fs.PathLike) => true) as typeof fs.existsSync;
    await setupClaudeCodeConfig(true);
    expect(writtenPath).toBe(getConfigPath());
    expect(appendedPath).toBeTruthy();
  });
});
