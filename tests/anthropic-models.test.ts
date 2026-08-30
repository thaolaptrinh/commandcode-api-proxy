import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveAnthropicModel } from "@/translate/anthropic-models.js";
import { refreshCatalog, __resetCatalogForTests } from "@/translate/catalog.js";
import { mockCcModelsFetch } from "./helpers.js";

describe("resolveAnthropicModel", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
    __resetCatalogForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
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

  test("claude-* default stays stable even when the API returns a reordered list", async () => {
    // The API lists models in its own order (closed models first in the wild).
    // The static-first merge must keep getDefaultModels()[0] — and thus the
    // claude-* fallback — pinned to the static builtin's first entry.
    mockCcModelsFetch([
      { id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000 },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1000000 },
    ]);
    await refreshCatalog("https://api.test-cc.example", "test-key");
    expect(resolveAnthropicModel("claude-opus-4-1")).toBe("deepseek/deepseek-v4-pro");
  });
});
