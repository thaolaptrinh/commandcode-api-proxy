import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setupOpenCodeConfig } from "@/setup/opencode.js";
import { __resetCatalogForTests } from "@/translate/catalog.js";
import { mockCcModelsFetch } from "./helpers.js";
import fs from "node:fs";

// Never hit the real CC API or read the developer's saved auth during tests.
vi.mock("@/auth.js", () => ({ readAuthKey: () => null }));

describe("setupOpenCodeConfig", () => {
  let written: string | null = null;

  beforeEach(() => {
    written = null;
    __resetCatalogForTests();
    delete process.env.CC_API_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as unknown as string);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((_path, data) => {
      written = data.toString();
    }) as typeof fs.writeFileSync);
  });

  afterEach(() => {
    delete process.env.CC_API_BASE;
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

    // deepseek-v4-pro supports {high, max}; the other tiers are disabled so
    // OpenCode's generic low/medium/high don't leak into the picker.
    const ds = models["deepseek-v4-pro"].variants;
    expect(ds.high).toEqual({ reasoningEffort: "high" });
    expect(ds.max).toEqual({ reasoningEffort: "max" });
    expect(ds.low).toEqual({ disabled: true });
    expect(ds.medium).toEqual({ disabled: true });
    expect(models["deepseek-v4-pro"].reasoning).toBe(true);

    // grok-4.5 supports {low, medium, high}; xhigh/max disabled
    const grok = models["grok-4.5"].variants;
    expect(grok.low).toEqual({ reasoningEffort: "low" });
    expect(grok.medium).toEqual({ reasoningEffort: "medium" });
    expect(grok.high).toEqual({ reasoningEffort: "high" });
    expect(grok.max).toEqual({ disabled: true });

    // models without discrete efforts get no variants field
    expect(models["Qwen3.7-Max"].variants).toBeUndefined();
  });

  test("builds config from the live API catalog when a key is available", async () => {
    process.env.CC_API_KEY = "test-key";
    process.env.CC_API_BASE = "https://api.test-cc.example";
    mockCcModelsFetch([
      { id: "claude-opus-5", name: "Claude Opus 5", context_length: 1000000 },
      { id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000 },
    ]);

    await setupOpenCodeConfig("local");
    const config = JSON.parse(written as string);
    const models = config.provider.commandcode.models;

    // Closed model filtered out; API-only model present with API metadata.
    expect(models["claude-opus-5"]).toBeUndefined();
    expect(models["GLM-5.3"].name).toBe("GLM-5.3");
    expect(models["GLM-5.3"].limit).toEqual({ context: 1000000, output: 128000 });
  });
});
