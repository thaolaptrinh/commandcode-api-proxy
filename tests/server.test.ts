import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { loadConfig } from "@/config.js";
import { createServer } from "@/server.js";

describe("Server", () => {
  let server: http.Server;
  const port = 18987;
  const baseUrl = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    // No server-held key: forces clients to send their own (keyless-passthrough
    // mode). This also lets the 401 test run without hitting the real CC API.
    const config = { ...loadConfig(), port, apiKey: null as string | null, host: "127.0.0.1" };
    server = createServer(config);

    return new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", () => resolve());
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("returns health status", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });

  it("returns model list", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBeDefined();
    expect(body.data[0].object).toBe("model");
  });

  it("returns 401 for chat completions without API key", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("supports CORS preflight", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
