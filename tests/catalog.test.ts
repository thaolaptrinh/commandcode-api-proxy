import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import {
  getCatalog,
  refreshCatalog,
  isClosedModel,
  __resetCatalogForTests,
} from "@/translate/catalog.js";
import { resolveModel } from "@/translate/models.js";
import { loadConfig } from "@/config.js";
import { createServer } from "@/server.js";
import { mockCcModelsFetch } from "./helpers.js";

const API_BASE = "https://api.test-cc.example";
const API_KEY = "test-key";

const mockFetch = mockCcModelsFetch;

const API_MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", context_length: 1000000 },
  { id: "gpt-5.5", name: "GPT 5.5", context_length: 400000 },
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", context_length: 1048576 },
  // Known model: API context wins over the static value.
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (latest)", context_length: 999999 },
  // New API-only model.
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000 },
];

beforeEach(() => {
  __resetCatalogForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isClosedModel", () => {
  it("blocks closed models in both bare and org-prefixed shapes", () => {
    expect(isClosedModel("claude-opus-5")).toBe(true);
    expect(isClosedModel("gpt-5.5")).toBe(true);
    expect(isClosedModel("anthropic/claude-x")).toBe(true);
    expect(isClosedModel("google/gemini-3.7-flash")).toBe(true);
    expect(isClosedModel("openai/gpt-5")).toBe(true);
  });

  it("allows open-source models", () => {
    expect(isClosedModel("zai-org/GLM-5.2")).toBe(false);
    expect(isClosedModel("deepseek/deepseek-v4-pro")).toBe(false);
    expect(isClosedModel("xai/grok-4.6")).toBe(false);
  });
});

describe("refreshCatalog", () => {
  it("merges API models over static metadata, filtering closed models", async () => {
    const calls = { count: 0 };
    mockFetch(API_MODELS, calls);
    const catalog = await refreshCatalog(API_BASE, API_KEY);

    // Closed models dropped.
    expect(catalog.ids).not.toContain("claude-opus-5");
    expect(catalog.ids).not.toContain("gpt-5.5");
    expect(catalog.ids).not.toContain("google/gemini-3.7-flash");

    // Static-first ordering preserved (default model stability)…
    expect(catalog.ids[0]).toBe("deepseek/deepseek-v4-pro");
    // …with API-only models appended.
    expect(catalog.ids).toContain("zai-org/GLM-5.3");

    // API wins for name + context when present.
    expect(catalog.displayNames["deepseek/deepseek-v4-pro"]).toBe("DeepSeek V4 Pro (latest)");
    expect(catalog.contextWindows["deepseek/deepseek-v4-pro"]).toBe(999999);
    expect(catalog.contextWindows["zai-org/GLM-5.3"]).toBe(1000000);
  });

  it("keeps the current catalog when the upstream fetch fails", async () => {
    const before = getCatalog();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const catalog = await refreshCatalog(API_BASE, API_KEY);
    expect(catalog.ids).toEqual(before.ids);
  });

  it("respects the TTL: an immediate second refresh does not refetch", async () => {
    const calls = { count: 0 };
    mockFetch(API_MODELS, calls);
    await refreshCatalog(API_BASE, API_KEY);
    await refreshCatalog(API_BASE, API_KEY);
    expect(calls.count).toBe(1);
    // force bypasses the TTL.
    await refreshCatalog(API_BASE, API_KEY, { force: true });
    expect(calls.count).toBe(2);
  });

  it("refetches once the TTL has elapsed", async () => {
    const calls = { count: 0 };
    mockFetch(API_MODELS, calls);
    const now = vi.spyOn(Date, "now");
    await refreshCatalog(API_BASE, API_KEY);
    expect(calls.count).toBe(1);
    // Jump past the 1h TTL.
    now.mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
    try {
      await refreshCatalog(API_BASE, API_KEY);
      expect(calls.count).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps static entries the API no longer lists (retired upstream models)", async () => {
    // The payload only knows deepseek-v4-pro — every other static builtin
    // model has "disappeared" from the API.
    mockFetch([{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_length: 1 }]);
    const catalog = await refreshCatalog(API_BASE, API_KEY);
    const glm = catalog.models.find((m) => m.id === "zai-org/GLM-5.2");
    expect(glm).toBeDefined();
    expect(glm?.source).toBe("static");
    // Static fallbacks fill in name + context when the API is silent.
    expect(glm?.displayName).toBe("GLM-5.2");
    expect(glm?.contextWindow).toBe(1048576);
    // The one model the API still knows is flagged as api-sourced.
    expect(catalog.models.find((m) => m.id === "deepseek/deepseek-v4-pro")?.source).toBe("api");
  });

  it("absorbs duplicate ids within the API list itself", async () => {
    const before = getCatalog().ids;
    mockFetch([
      { id: "neworg/Dup-Model", name: "Dup Model", context_length: 111 },
      { id: "neworg/Dup-Model", name: "Dup Model", context_length: 222 },
    ]);
    const catalog = await refreshCatalog(API_BASE, API_KEY);
    expect(catalog.ids.filter((id) => id === "neworg/Dup-Model")).toHaveLength(1);
    expect(catalog.ids.length).toBe(before.length + 1);
    // First occurrence wins.
    expect(catalog.contextWindows["neworg/Dup-Model"]).toBe(111);
  });

  it("tolerates malformed API payloads without corrupting the catalog", async () => {
    const before = getCatalog().ids;

    // data: null
    mockFetch(null);
    expect((await refreshCatalog(API_BASE, API_KEY, { force: true })).ids).toEqual(before);

    // items missing id are skipped; null context_length falls back
    mockFetch([
      null,
      { name: "No Id Model" },
      { id: "neworg/No-Context", name: "No Context", context_length: null },
    ]);
    const catalog = await refreshCatalog(API_BASE, API_KEY, { force: true });
    expect(catalog.ids).toContain("neworg/No-Context");
    expect(catalog.contextWindows["neworg/No-Context"]).toBe(128_000);
    // The id-less entries never made it in.
    expect(catalog.ids.length).toBe(before.length + 1);
  });
});

describe("resolveModel against the dynamic catalog", () => {
  it("resolves bare names of API-only models after a refresh", async () => {
    // A model the static catalog doesn't know (fabricated id): passes
    // through unresolved before refresh, maps to the full id after.
    expect(resolveModel("New-Model-X")).toBe("New-Model-X");
    mockFetch([...API_MODELS, { id: "neworg/New-Model-X", name: "New Model X", context_length: 123 }]);
    await refreshCatalog(API_BASE, API_KEY);
    expect(resolveModel("New-Model-X")).toBe("neworg/New-Model-X");
  });
});

describe("/v1/models endpoint with a live catalog", () => {
  it("serves open models only, with display names for Anthropic clients", async () => {
    mockFetch(API_MODELS);
    const port = 18988;
    const config = { ...loadConfig(), port, apiKey: API_KEY, host: "127.0.0.1" };
    const server = createServer(config);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      // createServer refreshes in the background; wait for it to land.
      await refreshCatalog(API_BASE, API_KEY, { force: true });

      const openaiRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const openaiBody = (await openaiRes.json()) as any;
      const ids = openaiBody.data.map((m: any) => m.id);
      expect(ids).not.toContain("claude-opus-5");
      expect(ids).toContain("zai-org/GLM-5.3");

      const anthropicRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { "anthropic-version": "1" },
      });
      const anthropicBody = (await anthropicRes.json()) as any;
      const glm = anthropicBody.data.find((m: any) => m.id === "zai-org/GLM-5.3");
      expect(glm.display_name).toBe("GLM-5.3");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
