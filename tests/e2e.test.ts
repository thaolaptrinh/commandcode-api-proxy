import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { Readable } from "node:stream";
import { loadConfig } from "@/config.js";
import { createServer } from "@/server.js";
import type { CCEvent } from "@/translate/types.js";

// ──────────────────────────────────────────
// Mock sendToCC — factory must be self-contained (vi.mock is hoisted)
// ──────────────────────────────────────────

const { sendToCCSpy } = vi.hoisted(() => ({
  sendToCCSpy: vi.fn(),
}));

vi.mock("@/upstream.js", () => ({
  sendToCC: sendToCCSpy,
  collectEvents: vi.fn().mockImplementation(async (stream: NodeJS.ReadableStream) => {
    const events: CCEvent[] = [];
    return new Promise((resolve, reject) => {
      stream.on("data", (e: CCEvent) => events.push(e));
      stream.on("end", () => resolve(events));
      stream.on("error", reject);
    });
  }),
  UpstreamError: class UpstreamError extends Error {
    statusCode: number;
    isRetryable: boolean;
    constructor(message: string, statusCode: number, isRetryable: boolean) {
      super(message);
      this.name = "UpstreamError";
      this.statusCode = statusCode;
      this.isRetryable = isRetryable;
    }
  },
}));

const MOCK_CC_EVENTS: CCEvent[] = [
  { type: "start", data: { model: "deepseek/deepseek-v4-flash" } },
  { type: "text-delta", data: { text: "Hello world" } },
  {
    type: "finish",
    data: {
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    },
  },
];

function fakeStream(): NodeJS.ReadableStream {
  return Readable.from(MOCK_CC_EVENTS);
}

// ──────────────────────────────────────────
// E2E: OpenAI /v1/chat/completions
// ──────────────────────────────────────────

describe("E2E: OpenAI /v1/chat/completions", () => {
  let server: http.Server;
  let baseUrl: string;
  const port = 19001;

  beforeAll(async () => {
    const config = { ...loadConfig(), port, apiKey: "test-key", host: "127.0.0.1" };
    server = createServer(config);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => {
    sendToCCSpy.mockReset();
  });

  it("non-streaming: returns full chat completion", async () => {
    sendToCCSpy.mockResolvedValue({ stream: fakeStream() });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(5);
    expect(body.usage.completion_tokens).toBe(10);
    expect(sendToCCSpy).toHaveBeenCalledOnce();
  });

  it("streaming: returns SSE chunks", async () => {
    sendToCCSpy.mockResolvedValue({ stream: fakeStream() });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    expect(lines.length).toBeGreaterThan(0);

    const parsed = lines.map((l) => JSON.parse(l.replace("data: ", "")));

    const firstChunk = parsed[0];
    expect(firstChunk.object).toBe("chat.completion.chunk");
    expect(firstChunk.choices[0].delta.role).toBe("assistant");

    // The finish chunk carries finish_reason (a trailing usage chunk has empty choices).
    const finishChunk = parsed.find((c) => c.choices?.[0]?.finish_reason);
    expect(finishChunk).toBeDefined();
    expect(finishChunk.choices[0].finish_reason).toBe("stop");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("Invalid JSON body");
  });
});

// ──────────────────────────────────────────
// E2E: Auth (keyless passthrough mode)
// ──────────────────────────────────────────

describe("E2E: Auth", () => {
  let server: http.Server;
  let baseUrl: string;
  const port = 19004;

  beforeAll(async () => {
    const config = { ...loadConfig(), port, apiKey: null, host: "127.0.0.1" };
    server = createServer(config);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("returns 401 for /v1/chat/completions without API key", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────────────────
// E2E: health and models
// ──────────────────────────────────────────

describe("E2E: health and models", () => {
  let server: http.Server;
  let baseUrl: string;
  const port = 19003;

  beforeAll(async () => {
    const config = { ...loadConfig(), port, apiKey: null, host: "127.0.0.1" };
    server = createServer(config);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });

  it("GET /v1/models returns model list", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`);
    expect(res.status).toBe(404);
  });

  it("supports CORS preflight", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
