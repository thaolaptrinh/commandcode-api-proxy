import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupOpenCodeConfig } from "@/setup/opencode.js";
import fs from "node:fs";

describe("setupOpenCodeConfig", () => {
  let written: string | null = null;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = null;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as unknown as string);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((_path, data) => {
      written = data.toString();
    }) as typeof fs.writeFileSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("writes a commandcode provider with all builtin models", async () => {
    await setupOpenCodeConfig("local");
    expect(written).not.toBeNull();
    const config = JSON.parse(written as string);
    const cc = config.provider.commandcode;
    expect(cc.npm).toBe("@ai-sdk/openai-compatible");
    expect(cc.options.baseURL).toBe("http://127.0.0.1:8787/v1");
    expect(Object.keys(cc.models).length).toBeGreaterThan(10);
  });

  test("emits reasoning variants for effort-capable models (powers /variants)", async () => {
    await setupOpenCodeConfig("local");
    const config = JSON.parse(written as string);
    const models = config.provider.commandcode.models;

    // deepseek-v4-pro supports {high, max}
    expect(models["deepseek-v4-pro"].variants).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    });
    expect(models["deepseek-v4-pro"].reasoning).toBe(true);
    // grok-4.5 supports {low, medium, high}
    expect(models["grok-4.5"].variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    });

    // models without discrete efforts get no variants field
    expect(models["Qwen3.7-Max"].variants).toBeUndefined();
  });
});
