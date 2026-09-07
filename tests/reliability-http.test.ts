import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { createServer } from "@/server.js";
import type { CCEvent } from "@/translate/types.js";

// Synthetic upstream fixtures only. Real HTTP clients use ephemeral loopback ports.
const fixtureBase = "https://upstream.invalid";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen() {
  const server = createServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: null,
    ccApiBase: fixtureBase,
    ccVersion: "0.0.0",
    logLevel: "error",
    corsOrigin: "",
    upstreamTimeoutMs: 1000,
    idleTimeoutMs: 0,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
function post(port: number, path: string, body: unknown) {
  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic-fixture-only",
    },
  });
  req.end(JSON.stringify(body));
  return req;
}
async function jsonPost(port: number, path: string, body: unknown) {
  const [res] = (await once(post(port, path, body), "response")) as [http.IncomingMessage];
  let text = "";
  for await (const chunk of res) text += chunk;
  return { status: res.statusCode, body: JSON.parse(text) };
}
const paths = ["/v1/chat/completions", "/v1/messages"];
const requestBody = (stream: boolean) => ({
  model: "fixture-model",
  max_tokens: 16,
  messages: [{ role: "user", content: "fixture" }],
  stream,
});
function fixtureFetch(body: ReadableStream<Uint8Array>, capture?: (signal: AbortSignal) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) !== `${fixtureBase}/alpha/generate`) throw new Error("Unexpected fixture URL");
    capture?.(init!.signal!);
    return new Response(body);
  });
}
const bytes = (events: CCEvent[]) =>
  new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe.each(paths)("real HTTP reliability: %s", (path) => {
  it.each([true, false])(
    "cancels upstream on a disconnected client (stream=%s)",
    async (stream) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      let signal!: AbortSignal;
      const upstream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel,
      });
      const fetchSpy = fixtureFetch(upstream, (s) => {
        signal = s;
      });
      const port = await listen();
      const req = post(port, path, requestBody(stream));
      req.on("error", () => {}); // Expected client-side socket hangup in JSON mode.
      try {
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
        // The uploaded request is complete, but generation must remain alive.
        await delay(30);
        expect(signal.aborted).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        if (stream) {
          const response = once(req, "response");
          controller.enqueue(bytes([{ type: "text-delta", data: { text: "fixture" } }]));
          const [res] = (await response) as [http.IncomingMessage];
          await once(res, "data");
          res.destroy();
        } else {
          req.destroy();
        }
        await vi.waitFor(
          () => {
            expect(signal.aborted).toBe(true);
            expect(cancel).toHaveBeenCalledOnce();
          },
          { timeout: 500 },
        );
        expect(fetchSpy).toHaveBeenCalledOnce();
      } finally {
        req.destroy();
        if (!cancel.mock.calls.length) controller.close();
      }
    },
  );

  it("settles a backpressured SSE write when the client closes", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    fixtureFetch(
      new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel,
      }),
    );
    const port = await listen();
    let response!: http.ServerResponse;
    servers[servers.length - 1].prependListener("request", (_req, res) => {
      response = res;
      const write = res.write.bind(res);
      // Synthetic backpressure; actual bytes and disconnect use real HTTP.
      res.write = ((chunk: string) => {
        write(chunk);
        return false;
      }) as typeof res.write;
    });
    const req = post(port, path, requestBody(true));
    req.on("error", () => {});
    try {
      const pending = once(req, "response");
      controller.enqueue(bytes([{ type: "text-delta", data: { text: "fixture" } }]));
      const [res] = (await pending) as [http.IncomingMessage];
      await once(res, "data");
      expect(response.listenerCount("drain")).toBe(1);
      res.destroy();
      await vi.waitFor(() => expect(response.destroyed).toBe(true));
      expect(response.listenerCount("drain")).toBe(0);
    } finally {
      req.destroy();
      if (!cancel.mock.calls.length) controller.close();
    }
  });

  it("surfaces inconsistent canonical tool arguments as a streaming error", async () => {
    fixtureFetch(
      new ReadableStream({
        start(c) {
          c.enqueue(
            bytes([
              {
                type: "tool-call-delta",
                data: { toolCallId: "a", name: "fixture_tool", arguments: '{"x":1}' },
              },
              {
                type: "tool-call",
                data: { toolCallId: "a", toolName: "fixture_tool", input: { x: 2 } },
              },
            ]),
          );
          c.close();
        },
      }),
    );
    const [res] = (await once(post(await listen(), path, requestBody(true)), "response")) as [
      http.IncomingMessage,
    ];
    let text = "";
    for await (const chunk of res) text += chunk;
    expect(text).toContain("Inconsistent upstream tool arguments");
    expect(text).toContain(path === "/v1/messages" ? "event: error" : "[upstream error]");
  });

  it.each([true, false])(
    "does not abort a normally completed response (stream=%s)",
    async (stream) => {
      let signal!: AbortSignal;
      fixtureFetch(
        new ReadableStream({
          start(c) {
            c.enqueue(
              bytes([
                { type: "text-delta", data: { text: "fixture" } },
                { type: "finish", data: { finishReason: "stop" } },
              ]),
            );
            c.close();
          },
        }),
        (s) => {
          signal = s;
        },
      );
      const port = await listen();
      const [res] = (await once(post(port, path, requestBody(stream)), "response")) as [
        http.IncomingMessage,
      ];
      let text = "";
      for await (const chunk of res) text += chunk;
      await delay(10);
      expect(res.statusCode).toBe(200);
      expect(text).toContain("fixture");
      expect(signal.aborted).toBe(false);
    },
  );

  it("returns a protocol-shaped 502 for a nonstream upstream error event", async () => {
    fixtureFetch(
      new ReadableStream({
        start(c) {
          c.enqueue(
            bytes([
              { type: "text-delta", data: { text: "partial" } },
              { type: "error", data: { message: "synthetic-private-diagnostic" } },
            ]),
          );
          c.close();
        },
      }),
    );
    const response = await jsonPost(await listen(), path, requestBody(false));
    expect(response.status).toBe(502);
    expect(response.body.error.message).toBe("CC upstream generation failed");
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private-diagnostic");
    if (path === "/v1/messages") expect(response.body.type).toBe("error");
  });
});

describe("count_tokens input shapes", () => {
  it.each([
    null,
    [],
    "text",
    1,
    { system: null },
    { system: [null] },
    { system: [{ text: 1 }] },
    { messages: {} },
    { messages: [null] },
    { messages: [{ content: null }] },
    { messages: [{ content: [null] }] },
    { tools: {} },
    { tools: [null] },
    { tools: [{ name: 1 }] },
    { tools: [{ description: [] }] },
    { tools: [{ input_schema: [] }] },
  ])("returns Anthropic 400 for invalid shape %#", async (body) => {
    const response = await jsonPost(await listen(), "/v1/messages/count_tokens", body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it.each([{}, { system: "abcd", messages: [{ content: "abcd" }], tools: [] }])(
    "preserves local estimates without requiring generation-only fields %#",
    async (body) => {
      const response = await jsonPost(await listen(), "/v1/messages/count_tokens", body);
      expect(response.status).toBe(200);
      expect(response.body.input_tokens).toBe("system" in body ? 2 : 0);
    },
  );
});
