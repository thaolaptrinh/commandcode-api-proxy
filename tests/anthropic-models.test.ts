import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveAnthropicModel, initAnthropicModelConfig } from "@/translate/anthropic-models.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "commandcode-api-proxy", "anthropic-models.json");
}

describe("resolveAnthropicModel", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
    initAnthropicModelConfig(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    initAnthropicModelConfig(null);
  });

  test("glob wildcard matches versioned claude ID", () => {
    initAnthropicModelConfig({
      default: "fallback-model",
      mappings: { "claude-sonnet-*": "mapped-model-a" },
    });
    expect(resolveAnthropicModel("claude-sonnet-4-5-20250929")).toBe("mapped-model-a");
  });

  test("claude-* catch-all matches any claude ID", () => {
    initAnthropicModelConfig({
      mappings: { "claude-*": "mapped-model-b" },
    });
    expect(resolveAnthropicModel("claude-anything-here")).toBe("mapped-model-b");
  });

  test("FIFO ordering: specific pattern before general returns specific", () => {
    initAnthropicModelConfig({
      mappings: {
        "claude-*": "general-model",
        "claude-sonnet-*": "specific-model",
      },
    });
    // claude-* comes first → wins despite claude-sonnet-* also matching
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("general-model");
  });

  test("FIFO ordering: specific first returns specific", () => {
    initAnthropicModelConfig({
      mappings: {
        "claude-sonnet-*": "specific-model",
        "claude-*": "general-model",
      },
    });
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("specific-model");
  });

  test("exact match (no wildcard)", () => {
    initAnthropicModelConfig({
      mappings: { "claude-sonnet-4-5-20250929": "exact-model" },
    });
    expect(resolveAnthropicModel("claude-sonnet-4-5-20250929")).toBe("exact-model");
    expect(resolveAnthropicModel("claude-sonnet-4-5")).not.toBe("exact-model");
  });

  test("special chars in pattern are literal", () => {
    initAnthropicModelConfig({
      mappings: { "claude-sonnet-4.5-*": "dot-model" },
    });
    expect(resolveAnthropicModel("claude-sonnet-4.5-20250929")).toBe("dot-model");
    // dot should NOT match arbitrary char
    expect(resolveAnthropicModel("claude-sonnet-4X5-20250929")).not.toBe("dot-model");
  });

  test("no match → config default", () => {
    initAnthropicModelConfig({
      default: "default-model",
      mappings: { "claude-opus-*": "opus-model" },
    });
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("default-model");
  });

  test("no match, no config default → ANTHROPIC_DEFAULT_MODEL env", () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = "env-default-model";
    initAnthropicModelConfig({ mappings: {} });
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("env-default-model");
  });

  test("env default overrides config default", () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = "env-wins-model";
    initAnthropicModelConfig({ default: "config-default-model" });
    expect(resolveAnthropicModel("claude-unknown")).toBe("env-wins-model");
  });

  test("no config, no env → hardcoded fallback", () => {
    initAnthropicModelConfig(null);
    const result = resolveAnthropicModel("claude-sonnet-4-5");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("non-claude model passes through", () => {
    initAnthropicModelConfig({ mappings: { "claude-*": "mapped" } });
    expect(resolveAnthropicModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });

  test("empty mapping value is skipped", () => {
    initAnthropicModelConfig({
      default: "fallback-model",
      mappings: { "claude-sonnet-*": "", "claude-*": "real-model" },
    });
    expect(resolveAnthropicModel("claude-sonnet-4-5")).toBe("real-model");
  });

  test("config with only default, no mappings", () => {
    initAnthropicModelConfig({ default: "the-default-model" });
    expect(resolveAnthropicModel("claude-anything")).toBe("the-default-model");
  });

  test("config with only mappings, no default", () => {
    initAnthropicModelConfig({ mappings: { "claude-opus-*": "opus" } });
    // unmatched → hardcoded fallback (not undefined)
    const result = resolveAnthropicModel("claude-sonnet-4-5");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("null config (missing file) uses hardcoded fallback", () => {
    initAnthropicModelConfig(null);
    const result = resolveAnthropicModel("claude-sonnet-4-5");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
