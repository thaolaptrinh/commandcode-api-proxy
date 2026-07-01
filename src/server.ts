import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";
import type { Config } from "@/config.js";
import { toCCRequest, OpenAIStreamEncoder, buildNonStreamingResponse } from "@/translate/openai.js";
import {
  toCCRequest as anToCCRequest,
  AnthropicStreamEncoder,
  buildAnthropicResponse,
} from "@/translate/anthropic.js";
import { getDefaultModels, fetchModelList } from "@/translate/models.js";
import type { CCEvent } from "@/translate/types.js";
import { formatSSE, formatSSEDone, formatAnthropicSSE } from "@/stream.js";
import { sendToCC, collectEvents, UpstreamError } from "@/upstream.js";
import { logger } from "@/logger.js";
import {
  validateOpenAIChatRequest,
  validateAnthropicRequest,
  ValidationError,
} from "@/translate/validation.js";
import type { AnthropicRequest } from "@/translate/anthropic-types.js";

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
  let key: string | null = null;
  const auth = req.headers.authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) key = m[1];
  }
  if (!key) {
    const xApiKey = req.headers["x-api-key"] as string | undefined;
    if (xApiKey) key = xApiKey;
  }
  // If the client sent "proxy-managed" or no key, fall back to the proxy's configured key

  if (!key || key === "proxy-managed" || key === "placeholder") {
    logger.debug(`client key sentinel, using config key (prefix: "${config.apiKey?.slice(0, 8)}")`);
    return config.apiKey;
  }
  logger.debug(`using client's own key (prefix: "${key.slice(0, 8)}")`);
  return key;
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

function sendOpenAIError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: "proxy_error" } });
}

const ANTHROPIC_STATUS_ERROR_MAP: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

function sendAnthropicError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
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

function handleModels(req: http.IncomingMessage, res: http.ServerResponse): void {
  const isAnthropic = req.headers["anthropic-version"] !== undefined;

  if (isAnthropic) {
    const items = modelList;
    const data = {
      data: items.map((id: string) => ({
        id,
        type: "model" as const,
        display_name: id,
        created_at: new Date().toISOString(),
        max_input_tokens: null as number | null,
        max_tokens: null as number | null,
        capabilities: null,
      })),
      has_more: false,
      first_id: items.length > 0 ? items[0] : null,
      last_id: items.length > 0 ? items[items.length - 1] : null,
    };
    sendJson(res, 200, data);
    return;
  }

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
    return sendOpenAIError(res, 400, "Invalid JSON body");
  }

  let openAIReq;
  try {
    openAIReq = validateOpenAIChatRequest(rawBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      return sendOpenAIError(res, 400, err.message);
    }
    return sendOpenAIError(res, 400, "Invalid request body");
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return sendOpenAIError(res, 401, "Unauthorized");
  }

  const isStream = openAIReq.stream === true;
  const model = openAIReq.model ?? "default";
  const encoder = new OpenAIStreamEncoder(model);

  logger.info(`[Incoming Request] Model: ${model}`);
  logger.info(`[Incoming Request] Tools count: ${openAIReq.tools ? openAIReq.tools.length : 0}`);
  if (openAIReq.tools && openAIReq.tools.length > 0) {
    logger.info(
      `[Incoming Request] Tools list: ${openAIReq.tools.map((t) => t.function.name).join(", ")}`,
    );
  } else {
    logger.info(`[Incoming Request] No tools were sent by the client!`);
  }

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
        for (const chunk of encoder.emit(event)) {
          res.write(formatSSE(chunk));
        }
      });
      stream.on("end", () => {
        res.write(formatSSEDone());
        res.end();
      });
      stream.on("error", (err: Error) => {
        logger.error("[stream] OpenAI streaming error:", err.message);
        if (!res.destroyed) {
          res.write(formatSSE(encoder.errorChunk(err)));
          res.write(formatSSEDone());
          res.end();
        }
      });
      destroyStreamOnClientDisconnect(req, stream);
    } else {
      const events = await collectEvents(stream);
      const response = buildNonStreamingResponse(events, model, encoder.id);
      sendJson(res, 200, response);
    }
  } catch (err) {
    handleUpstreamError(res, err, "openai");
  }
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await parseBody(req);
  } catch {
    return sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
  }

  let anthropicReq: AnthropicRequest;
  try {
    anthropicReq = validateAnthropicRequest(rawBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      return sendAnthropicError(res, 400, "invalid_request_error", err.message);
    }
    return sendAnthropicError(res, 400, "invalid_request_error", "Invalid request body");
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return sendAnthropicError(res, 401, "authentication_error", "Missing API key");
  }

  const isStream = anthropicReq.stream === true;
  const model = anthropicReq.model;

  const encoder = new AnthropicStreamEncoder(model);
  const ccBody = anToCCRequest(anthropicReq);

  const abort = abortOnClientDisconnect(req, res);

  try {
    const result = await sendToCC(
      ccBody,
      { apiBase: config.ccApiBase, apiKey, ccVersion: config.ccVersion },
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
        for (const record of encoder.emit(event)) {
          res.write(formatAnthropicSSE(record.event, record.data));
        }
      });
      stream.on("end", () => res.end());
      stream.on("error", (err: Error) => {
        logger.error("[stream] Anthropic streaming error:", err.message);
        if (!res.destroyed) {
          res.write(
            formatAnthropicSSE("error", {
              type: "error",
              error: { type: "api_error", message: err.message },
            }),
          );
          res.end();
        }
      });
      destroyStreamOnClientDisconnect(req, stream);
    } else {
      const events = await collectEvents(stream);
      const response = buildAnthropicResponse(events, model, encoder.messageId);
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders() });
      res.end(JSON.stringify(response));
    }
  } catch (err) {
    handleUpstreamError(res, err, "anthropic");
  }
}

async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await parseBody(req);
  } catch {
    return sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
  }

  const body = rawBody as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(body.system);
  else if (Array.isArray(body.system)) {
    for (const b of body.system as { text?: string }[]) {
      if (b.text) parts.push(b.text);
    }
  }
  const msgs = body.messages as { content?: unknown }[] | undefined;
  if (msgs) {
    for (const msg of msgs) {
      parts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  const tools = body.tools as
    | { name?: string; description?: string; input_schema?: unknown }[]
    | undefined;
  if (tools) {
    for (const t of tools) {
      parts.push(t.name ?? "", t.description ?? "", JSON.stringify(t.input_schema ?? {}));
    }
  }

  const allText = parts.join("");
  let cjk = 0;
  let nonCjk = 0;
  for (const ch of allText) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      nonCjk++;
    }
  }

  const estimated = Math.ceil(cjk + nonCjk / 4);

  sendJson(res, 200, { input_tokens: estimated });
}

// ──────────────────────────────────────────
// Error handling
// ──────────────────────────────────────────

function handleUpstreamError(
  res: http.ServerResponse,
  err: unknown,
  format: "openai" | "anthropic",
): void {
  if (format === "anthropic") {
    if (err instanceof UpstreamError) {
      const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
      const type = ANTHROPIC_STATUS_ERROR_MAP[status] ?? "api_error";
      sendAnthropicError(res, status, type, err.message);
    } else {
      sendAnthropicError(res, 502, "api_error", (err as Error).message);
    }
    return;
  }

  if (err instanceof UpstreamError) {
    const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
    sendOpenAIError(res, status, err.message);
  } else {
    sendOpenAIError(res, 502, (err as Error).message);
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
    { method: "POST", path: "/v1/messages/count_tokens", handler: handleCountTokens },
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
          logger.error("[route] handler promise error:", err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal server error" });
          }
        });
      }
    } catch (err) {
      logger.error("[route] handler error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  return server;
}
