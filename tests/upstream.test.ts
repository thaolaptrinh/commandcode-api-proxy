import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { buildHeaders, collectEvents } from "@/upstream.js";
import type { CCEvent, CCRequestBody } from "@/translate/types.js";

const sampleBody = (overrides: Partial<CCRequestBody> = {}): CCRequestBody => ({
  config: { workingDir: "/home/me/projects/my-app" },
  memory: "",
  taste: "",
  skills: "",
  permissionMode: "standard",
  params: {
    model: "deepseek/deepseek-v4-pro",
    messages: [],
    stream: true,
  },
  threadId: "11111111-2222-3333-4444-555555555555",
  ...overrides,
});

describe("buildHeaders", () => {
  it("includes all CLI-identifying headers CC requires", () => {
    const headers = buildHeaders("user_test_key", "0.40.3", sampleBody());

    expect(headers["Authorization"]).toBe("Bearer user_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-cli-environment"]).toBe("production");
    expect(headers["x-command-code-version"]).toBe("0.40.3");
    expect(headers["User-Agent"]).toContain("commandcode-cli/0.40.3");
    expect(headers["User-Agent"]).toContain("Node.js/");
    expect(headers["x-co-flag"]).toBe("false");
    expect(headers["x-taste-learning"]).toBe("false");
    // session id mirrors the request thread id
    expect(headers["x-session-id"]).toBe("11111111-2222-3333-4444-555555555555");
    expect(headers["x-project-slug"]).toBe("my-app");
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("derives a slug from the working directory", () => {
    const headers = buildHeaders(
      "k",
      "0.40.3",
      sampleBody({
        config: { workingDir: "/Users/Bob/Code/My Cool Project" },
      }),
    );
    expect(headers["x-project-slug"]).toBe("my-cool-project");
  });

  it("falls back to a default slug when working dir is bare", () => {
    const headers = buildHeaders(
      "k",
      "0.40.3",
      sampleBody({
        config: { workingDir: "/" },
      }),
    );
    expect(headers["x-project-slug"]).toBe("commandcode-proxy");
  });
});

describe("collectEvents", () => {
  it("drains a stream into an event array", async () => {
    const events: CCEvent[] = [
      { type: "start", data: {} },
      { type: "text-delta", data: { text: "Hello" } },
      { type: "text-delta", data: { text: " world" } },
      { type: "finish", data: { finishReason: "stop" } },
    ];
    const stream = Readable.from(events);
    const collected = await collectEvents(stream);
    expect(collected).toEqual(events);
    expect(collected).toHaveLength(4);
  });

  it("resolves to an empty array for an empty stream", async () => {
    const stream = Readable.from([]);
    const collected = await collectEvents(stream);
    expect(collected).toEqual([]);
  });

  it("rejects when the stream errors", async () => {
    const stream = new Readable({ objectMode: true, read() {} });
    process.nextTick(() => stream.destroy(new Error("boom")));
    await expect(collectEvents(stream)).rejects.toThrow("boom");
  });
});
