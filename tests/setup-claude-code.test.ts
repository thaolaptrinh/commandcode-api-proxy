import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupClaudeCodeConfig } from "@/setup/claude-code.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "anthropic-models.json");
}

describe("setupClaudeCodeConfig", () => {
  let originalExists: typeof fs.existsSync;
  let originalMkdir: typeof fs.mkdirSync;
  let originalWrite: typeof fs.writeFileSync;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let writtenPath: string | null = null;
  let writtenContent: string | null = null;

  beforeEach(() => {
    writtenPath = null;
    writtenContent = null;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    originalExists = fs.existsSync;
    originalMkdir = fs.mkdirSync;
    originalWrite = fs.writeFileSync;

    fs.existsSync = ((p: fs.PathLike) =>
      p === getConfigPath() ? false : originalExists(p)) as typeof fs.existsSync;
    fs.mkdirSync = ((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) =>
      undefined) as typeof fs.mkdirSync;
    fs.writeFileSync = ((p: fs.PathLike, data: string) => {
      if (p === getConfigPath()) {
        writtenPath = p as string;
        writtenContent = data;
      }
    }) as typeof fs.writeFileSync;
  });

  afterEach(() => {
    fs.existsSync = originalExists;
    fs.mkdirSync = originalMkdir;
    fs.writeFileSync = originalWrite;
    consoleLogSpy.mockRestore();
  });

  test("creates config file with defaults when not exists", async () => {
    await setupClaudeCodeConfig(false);
    expect(writtenPath).toBe(getConfigPath());
    expect(writtenContent).toBeTruthy();

    const parsed = JSON.parse(writtenContent!);
    expect(parsed.default).toBeDefined();
    expect(parsed.mappings).toBeDefined();
    expect(parsed.mappings["claude-sonnet-*"]).toBeDefined();
  });

  test("prints instructions with ANTHROPIC_BASE_URL", async () => {
    await setupClaudeCodeConfig(false);
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("ANTHROPIC_BASE_URL");
    expect(output).toContain("ANTHROPIC_API_KEY");
  });

  test("prints order matters hint", async () => {
    await setupClaudeCodeConfig(false);
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Order matters");
  });

  test("existing file without force warns and does not write", async () => {
    fs.existsSync = ((p: fs.PathLike) =>
      p === getConfigPath() ? true : originalExists(p)) as typeof fs.existsSync;

    await setupClaudeCodeConfig(false);

    expect(writtenPath).toBeNull();
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already exists");
    expect(output).toContain("--force");
  });

  test("existing file with force overwrites", async () => {
    fs.existsSync = ((p: fs.PathLike) =>
      p === getConfigPath() ? true : originalExists(p)) as typeof fs.existsSync;

    await setupClaudeCodeConfig(true);

    expect(writtenPath).toBe(getConfigPath());
    expect(writtenContent).toBeTruthy();
  });
});
