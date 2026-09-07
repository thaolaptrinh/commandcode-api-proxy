import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { collectEvents, sendToCC } from "@/upstream.js";
import { toCCRequest } from "@/translate/openai.js";

// All fetches are synthetic fixtures; no provider requests or real keys.
const body = () => toCCRequest({ model: "fixture", messages: [] });
const options = {
  apiBase: "https://upstream.invalid",
  apiKey: "synthetic-fixture-key",
  ccVersion: "0.0.0",
};
afterEach(() => vi.restoreAllMocks());

describe("native upstream stream reliability", () => {
  it("propagates an idle timeout as an error, not native reader cancellation EOF", async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const { stream } = await sendToCC(body(), { ...options, idleTimeoutMs: 30 });
    await expect(collectEvents(stream)).rejects.toMatchObject({ name: "IdleTimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0][0]).toMatchObject({ name: "IdleTimeoutError" });
  });

  it("bounds the non-2xx body wait by the per-attempt deadline", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel,
        }),
        { status: 400 },
      ),
    );
    const result = sendToCC(body(), { ...options, timeoutMs: 30 }).catch((err) => err);
    try {
      const value = await Promise.race([
        result,
        new Promise((r) => setTimeout(() => r("still pending"), 200)),
      ]);
      expect(value).toMatchObject({ statusCode: 400 });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      if (!cancel.mock.calls.length) controller.close();
      await result;
    }
  });

  it("caps an oversized non-2xx body and cancels the unread remainder", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("x".repeat(128 * 1024)));
          },
          cancel,
        }),
        { status: 400 },
      ),
    );
    const result = sendToCC(body(), { ...options, timeoutMs: 1000 }).catch((err) => err);
    try {
      const value = await Promise.race([
        result,
        new Promise((r) => setTimeout(() => r("still pending"), 200)),
      ]);
      expect(value).toMatchObject({ statusCode: 400 });
      expect(value.message.length).toBeLessThanOrEqual(16 * 1024 + 80);
      expect(value.message).toContain("truncated");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      if (!cancel.mock.calls.length) controller.close();
      await result;
    }
  });

  it("redacts the supplied fixture key and control characters in HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`bad\u001b[31m ${options.apiKey}`, { status: 400 }),
    );
    const error = await sendToCC(body(), options).catch((err) => err);
    expect(error.statusCode).toBe(400);
    expect(error.message).not.toContain(options.apiKey);
    expect(error.message).not.toContain("\u001b");
    expect(error.message).toContain("bad");
  });

  it("does not start an upstream request for an already disconnected caller", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fixture must not run"));
    const abort = new AbortController();
    abort.abort();
    await expect(sendToCC(body(), options, abort.signal)).rejects.toThrow("Request aborted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not retry after disconnect while reading a retryable error body", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(new ReadableStream({ cancel }), { status: 503 });
    });
    const result = sendToCC(body(), { ...options, timeoutMs: 100 }, abort.signal).catch(
      (err) => err,
    );
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    expect(await result).toMatchObject({ message: "Request aborted" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not retry a caller abort with a custom Error reason", async () => {
    const abort = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      abort.abort(new Error("synthetic disconnect"));
      throw abort.signal.reason;
    });
    await expect(sendToCC(body(), options, abort.signal)).rejects.toThrow("Request aborted");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects instead of returning silent EOF if the caller aborts as headers arrive", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      abort.abort();
      return new Response(new ReadableStream({ cancel }));
    });
    const result = sendToCC(body(), options, abort.signal).then(({ stream }) =>
      collectEvents(stream),
    );
    await expect(result).rejects.toThrow(/Request aborted|Client disconnected/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not apply the header deadline to a successful generation body", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
      ),
    );
    const { stream } = await sendToCC(body(), { ...options, timeoutMs: 10, idleTimeoutMs: 0 });
    const result = collectEvents(stream);
    await new Promise((r) => setTimeout(r, 40));
    controller.enqueue(
      new TextEncoder().encode('{"type":"finish","data":{"finishReason":"stop"}}\n'),
    );
    controller.close();
    expect(await result).toMatchObject([{ type: "finish" }]);
    expect((stream as Readable).destroyed).toBe(true);
  });
});
