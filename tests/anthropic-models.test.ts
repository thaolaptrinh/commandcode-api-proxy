import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { resolveAnthropicModel } from "@/translate/anthropic-models.js";

describe("resolveAnthropicModel", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("claude-* uses ANTHROPIC_DEFAULT_MODEL env", () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("deepseek/deepseek-v4-pro");
  });

  test("claude-* without env falls back gracefully", () => {
    const result = resolveAnthropicModel("claude-opus-4-1");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("non-claude model passes through", () => {
    expect(resolveAnthropicModel("custom-model")).toBe("custom-model");
  });
});
