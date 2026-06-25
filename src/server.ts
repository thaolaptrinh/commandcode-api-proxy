import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";
import type { Config } from "@/config.js";
import {
  toCCRequest,
  toOpenAIStreamChunk,
  toOpenAIErrorChunk,
  buildNonStreamingResponse,
} from "@/translate/openai.js";
import {
  fromAnthropicToCC,
  toAnthropicSSE,
  buildAnthropicResponse,
} from "@/translate/anthropic.js";
import { getDefaultModels, fetchModelList } from "@/translate/models.js";
import { resetMessageId } from "@/translate/util.js";
import type { OpenAIChatRequest, AnthropicMessageRequest, CCEvent } from "@/translate/types.js";
import { formatSSE, formatSSEDone } from "@/stream.js";
import { sendToCC, collectEvents, UpstreamError } from "@/upstream.js";

// ──────────────────────────────────────────
// Mutable server state
// ──────────────────────────────────────────

let config: Config;
let modelList: string[] = getDefaultModels();

function updateModelList(models: string[]): void {
  if (models.length > 0) modelList = models;
}

// ──────────────────────────────────────────
// Request body parser
// ──────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ──────────────────────────────────────────
// Auth
// ──────────────────────────────────────────

function extractApiKey(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  const xApiKey = req.headers["x-api-key"] as string | undefined;
  if (xApiKey) return xApiKey;

  // If proxy has no key configured, the CC API key is the only fallback
  return config.apiKey;
}

// ──────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(data));
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
  };
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function abortOnClientDisconnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): AbortController {
  const abort = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  return abort;
}

function destroyStreamOnClientDisconnect(
  req: http.IncomingMessage,
  stream: NodeJS.ReadableStream,
): void {
  req.on("close", () => (stream as Readable).destroy());
}

// ──────────────────────────────────────────
// Route handlers
// ──────────────────────────────────────────

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
  });
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const data = {
    object: "list",
    data: modelList.map((id: string) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "commandcode",
    })),
  };
  sendJson(res, 200, data);
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await parseBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  if (!rawBody || typeof rawBody !== "object") {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const openAIReq = rawBody as unknown as OpenAIChatRequest;
  const isStream = openAIReq.stream === true;
  const model = openAIReq.model ?? "default";

  resetMessageId();
  const ccBody = toCCRequest(openAIReq);

  const abort = abortOnClientDisconnect(req, res);

  try {
    const result = await sendToCC(
      ccBody,
      {
        apiBase: config.ccApiBase,
        apiKey,
        ccVersion: config.ccVersion,
      },
      abort.signal,
    );
    const stream = result.stream;

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      });

      stream.on("data", (event: CCEvent) => {
        for (const chunk of toOpenAIStreamChunk(event)) {
          res.write(formatSSE(chunk));
        }
      });
      stream.on("end", () => {
        res.write(formatSSEDone());
        res.end();
      });
      stream.on("error", (err: Error) => {
        console.error("[stream]", err.message);
        if (!res.destroyed) {
          res.write(formatSSE(toOpenAIErrorChunk(err)));
          res.write(formatSSEDone());
          res.end();
        }
      });
      destroyStreamOnClientDisconnect(req, stream);
    } else {
      const events = await collectEvents(stream);
      const response = buildNonStreamingResponse(events, model);
      sendJson(res, 200, response);
    }
  } catch (err) {
    handleUpstreamError(res, err);
  }
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await parseBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  if (!rawBody || typeof rawBody !== "object") {
    return sendJson(res, 400, { error: "Invalid request body" });
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const anthropicReq = rawBody as unknown as AnthropicMessageRequest;
  const isStream = anthropicReq.stream === true;
  const model = anthropicReq.model ?? "default";

  resetMessageId();
  const ccBody = fromAnthropicToCC(anthropicReq);

  const abort = abortOnClientDisconnect(req, res);

  try {
    const result = await sendToCC(
      ccBody,
      {
        apiBase: config.ccApiBase,
        apiKey,
        ccVersion: config.ccVersion,
      },
      abort.signal,
    );
    const stream = result.stream;

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      });

      const flushAnthropic = (event: CCEvent) => {
        for (const sse of toAnthropicSSE(event)) {
          res.write(`event: ${sse.event}\n`);
          res.write(formatSSE(sse.data));
        }
      };

      stream.on("data", flushAnthropic);
      stream.on("end", () => res.end());
      stream.on("error", (err: Error) => {
        console.error("[anthropic-stream]", err.message);
        if (!res.destroyed) {
          res.write(`event: error\n`);
          res.write(formatSSE({ type: "error", error: { message: err.message } }));
          res.end();
        }
      });
      destroyStreamOnClientDisconnect(req, stream);
    } else {
      const events = await collectEvents(stream);
      const response = buildAnthropicResponse(events, model);
      sendJson(res, 200, response);
    }
  } catch (err) {
    handleUpstreamError(res, err);
  }
}

// ──────────────────────────────────────────
// Error handling
// ──────────────────────────────────────────

function handleUpstreamError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof UpstreamError) {
    const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
    sendJson(res, status, {
      error: { message: err.message, type: "upstream_error", code: err.statusCode },
    });
  } else {
    sendJson(res, 502, {
      error: { message: (err as Error).message, type: "proxy_error" },
    });
  }
}

// ──────────────────────────────────────────
// Server factory
// ──────────────────────────────────────────

interface RouteEntry {
  method: string;
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;
}

export function createServer(cfg: Config): http.Server {
  config = cfg;

  // Start fetching model list in background (only if we have a key to use).
  if (cfg.apiKey) {
    fetchModelList(cfg.ccApiBase, cfg.apiKey)
      .then((models) => {
        if (models.length > 0) updateModelList(models);
      })
      .catch(() => {
        /* keep defaults */
      });
  }

  const routes: RouteEntry[] = [
    { method: "GET", path: "/health", handler: handleHealth },
    { method: "GET", path: "/v1/models", handler: handleModels },
    { method: "POST", path: "/v1/chat/completions", handler: handleChatCompletions },
    { method: "POST", path: "/v1/messages", handler: handleMessages },
  ];

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    const route = routes.find((r) => r.method === req.method && r.path === pathname);

    if (!route) {
      return sendJson(res, 404, { error: "Not found" });
    }

    try {
      const result = route.handler(req, res, parsedUrl);
      if (result instanceof Promise) {
        result.catch((err) => {
          console.error("[route]", err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal server error" });
          }
        });
      }
    } catch (err) {
      console.error("[route]", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  return server;
}
