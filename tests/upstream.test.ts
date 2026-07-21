import { describe, it, expect, vi, afterEach } from "vitest";
import { Readable } from "node:stream";
import { buildHeaders, collectEvents, sendToCC, UpstreamError } from "@/upstream.js";
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

// Minimal fake Response for sendToCC retry tests.
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  text?: string;
  bodyLines?: string[];
}): Response {
  const enc = new TextEncoder();
  const lines = opts.bodyLines ?? [];
  let i = 0;
  const reader = {
    read: async () =>
      i < lines.length
        ? { done: false, value: enc.encode(lines[i++]) }
        : { done: true, value: undefined },
  };
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: "",
    text: async () => opts.text ?? "",
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("sendToCC retry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries on 5xx then succeeds", async () => {
    const mock = vi.fn();
    mock.mockResolvedValueOnce(fakeResponse({ ok: false, status: 503, text: "down" }));
    mock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        bodyLines: [
          '{"type":"start","data":{}}\n',
          '{"type":"finish","data":{"finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}}\n',
        ],
      }),
    );
    globalThis.fetch = mock as unknown as typeof fetch;

    const { stream } = await sendToCC(sampleBody(), {
      apiBase: "https://example.test",
      apiKey: "k",
      ccVersion: "0.0.0",
    });
    expect(mock).toHaveBeenCalledTimes(2);
    const events = await collectEvents(stream);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("does not retry on non-retryable 4xx", async () => {
    const mock = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 400, text: "bad" }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(
      sendToCC(sampleBody(), { apiBase: "https://example.test", apiKey: "k", ccVersion: "0.0.0" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on persistent 5xx", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 502, text: "bad gw" }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(
      sendToCC(sampleBody(), { apiBase: "https://example.test", apiKey: "k", ccVersion: "0.0.0" }),
    ).rejects.toBeInstanceOf(UpstreamError);
    // 1 initial + 2 retries = 3 attempts.
    expect(mock).toHaveBeenCalledTimes(3);
  });

  // Regression: when a single upstream chunk carries many NDJSON lines and the
  // consumer applies backpressure (push() returns false), the proxy used to
  // drop all remaining lines in that chunk. Tool-call deltas typically arrive
  // bundled this way, so the symptom was "tool calls truncated mid-stream".
  it("does not drop events when the consumer applies backpressure", async () => {
    // 50 events packed into ONE upstream chunk.
    const bodyLines: string[] = [];
    for (let i = 0; i < 50; i++) {
      bodyLines.push(JSON.stringify({ type: "text-delta", data: { text: `t${i}` } }) + "\n");
    }
    bodyLines.push(JSON.stringify({ type: "finish", data: { finishReason: "stop" } }) + "\n");

    const mock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 200, bodyLines }),
    );
    globalThis.fetch = mock as unknown as typeof fetch;

    const { stream } = await sendToCC(sampleBody(), {
      apiBase: "https://example.test",
      apiKey: "k",
      ccVersion: "0.0.0",
    });

    // Consume slowly to force the Readable's internal buffer to fill.
    // pause()/resume() gives us deterministic backpressure.
    const events: CCEvent[] = [];
    stream.on("data", (e: CCEvent) => events.push(e));
    (stream as Readable).pause();

    // Allow a tick for the producer to attempt stuffing the internal buffer.
    await new Promise((r) => setImmediate(r));
    (stream as Readable).resume();
    await new Promise<void>((resolve) => stream.on("end", () => resolve()));

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas.length).toBe(50);
    // First and last deltas specifically — these are the ones most likely to
    // be lost at the boundary.
    expect(textDeltas[0].data.text).toBe("t0");
    expect(textDeltas[49].data.text).toBe("t49");
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  // Regression: when the consumer stream is destroyed (client disconnect),
  // the underlying upstream reader must be cancelled so the upstream TCP
  // connection closes and CC stops generating tokens nobody will read.
  it("cancels the upstream reader when the consumer is destroyed", async () => {
    // Reader fake that supports cancel() and produces an unbounded stream.
    const enc = new TextEncoder();
    let cancelCalled = false;
    const reader = {
      read: async () => ({
        done: false,
        value: enc.encode('{"type":"text-delta","data":{"text":"x"}}\n'),
      }),
      cancel: async () => {
        cancelCalled = true;
      },
    };
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => "",
      body: { getReader: () => reader },
    } as unknown as Response);
    globalThis.fetch = mock as unknown as typeof fetch;

    const { stream } = await sendToCC(sampleBody(), {
      apiBase: "https://example.test",
      apiKey: "k",
      ccVersion: "0.0.0",
    });

    // Read one event so the producer is up, then destroy (client disconnect).
    await new Promise<void>((resolve) => {
      stream.once("data", () => {
        (stream as Readable).destroy();
        resolve();
      });
    });

    // cancel() is called synchronously from destroy().
    expect(cancelCalled).toBe(true);
  });

  // Regression: a stalled upstream (TCP open, no chunks arriving) used to
  // hang the consumer forever — no idle timeout was wired during streaming.
  // Now nodeReaderToStream aborts the reader after `idleTimeoutMs` of no data.
  it("aborts the upstream reader after the idle timeout elapses with no data", async () => {
    // Reader that never produces data and never returns done.
    let cancelReason: unknown = undefined;
    let cancelCallCount = 0;
    const pendingReadRejectors: Array<(e: unknown) => void> = [];
    const reader = {
      // read() never resolves on its own — simulates a stalled upstream.
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
          pendingReadRejectors.push(reject);
        }),
      // cancel(reason) rejects the pending read() — matches the
      // ReadableStreamDefaultReader spec, which propagates the cancel
      // reason through any in-flight read().
      cancel: async (reason?: unknown) => {
        // Only capture the FIRST cancel call's reason — the proxy calls
        // cancel() again from releaseReader() with no arg, which would
        // otherwise overwrite our assertion.
        if (cancelCallCount === 0) cancelReason = reason;
        cancelCallCount++;
        for (const reject of pendingReadRejectors.splice(0)) {
          reject(reason);
        }
      },
    };
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => "",
      body: { getReader: () => reader },
    } as unknown as Response);
    globalThis.fetch = mock as unknown as typeof fetch;

    const { stream } = await sendToCC(sampleBody(), {
      apiBase: "https://example.test",
      apiKey: "k",
      ccVersion: "0.0.0",
      idleTimeoutMs: 50, // very short for the test
    });

    // Resume so the Readable actually starts calling read() — otherwise the
    // idle timer never gets a chance to arm.
    (stream as Readable).resume();

    const error: Error | undefined = await new Promise((resolve) => {
      stream.once("error", (e: Error) => resolve(e));
    });

    expect(cancelCallCount).toBeGreaterThan(0);
    expect((cancelReason as Error)?.name).toBe("IdleTimeoutError");
    // The stream should surface an error to the consumer so the SSE handler
    // synthesizes a clean finish instead of hanging the client.
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("idle timeout");
  });

  // Regression: idle timeout is disabled when idleTimeoutMs=0.
  it("does not fire idle timeout when idleTimeoutMs is 0", async () => {
    // Same stalled reader, but idle disabled.
    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
      cancel: async () => {},
    };
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => "",
      body: { getReader: () => reader },
    } as unknown as Response);
    globalThis.fetch = mock as unknown as typeof fetch;

    const { stream } = await sendToCC(sampleBody(), {
      apiBase: "https://example.test",
      apiKey: "k",
      ccVersion: "0.0.0",
      idleTimeoutMs: 0,
    });

    (stream as Readable).resume();

    // Wait long enough that an idle timer WOULD have fired.
    const errored = await Promise.race([
      new Promise<Error>((resolve) => stream.once("error", resolve)),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 80)),
    ]);
    expect(errored).toBeUndefined();
    (stream as Readable).destroy();
  });
});
