import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAnthropicModel } from "@/translate/anthropic-models.js";

describe("resolveAnthropicModel", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env["ANTHROPIC_MODEL_CLAUDE_SONNET_4_5"];
    delete process.env["ANTHROPIC_DEFAULT_MODEL"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("claude-* mapped via env var", () => {
    process.env["ANTHROPIC_MODEL_CLAUDE_SONNET_4_5"] = "deepseek/deepseek-v4-pro";
    const result = resolveAnthropicModel("claude-sonnet-4-5-20250929");
    expect(result).toBe("deepseek/deepseek-v4-pro");
  });

  it("claude-* falls back to ANTHROPIC_DEFAULT_MODEL", () => {
    process.env["ANTHROPIC_DEFAULT_MODEL"] = "deepseek/deepseek-v4-flash";
    const result = resolveAnthropicModel("claude-haiku-4-5-20251001");
    expect(result).toBe("deepseek/deepseek-v4-flash");
  });

  it("claude-* falls back to first builtin when no env vars are set", () => {
    const result = resolveAnthropicModel("claude-sonnet-4-5-20250929");
    expect(typeof result).toBe("string");
    expect(result).toBeTruthy();
  });

  it("non-claude ID passed through", () => {
    const result = resolveAnthropicModel("custom-model");
    expect(result).toBe("custom-model");
  });

  it("full provider/model ID passed through", () => {
    const result = resolveAnthropicModel("openai/gpt-4");
    expect(result).toBe("openai/gpt-4");
  });
});
