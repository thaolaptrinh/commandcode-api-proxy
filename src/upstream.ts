import crypto from "node:crypto";
import { Readable } from "node:stream";
import { parseCCLine } from "@/stream.js";
import type { CCEvent, CCRequestBody } from "@/translate/types.js";
import { logger } from "@/logger.js";

interface UpstreamOptions {
  apiBase: string;
  apiKey: string;
  ccVersion: string;
  timeoutMs?: number;
}

/**
 * Build the header set the official Command Code CLI sends. CC's server
 * inspects these and rejects requests that look like a proxy ("Proxy use
 * detected") if any of the CLI-identifying headers are missing/stale.
 */
export function buildHeaders(
  apiKey: string,
  ccVersion: string,
  body: CCRequestBody,
): Record<string, string> {
  const sessionId = body.threadId;
  logger.debug(`Sending Authorization header (key length: ${apiKey.length})`);
  return {
    "Content-Type": "application/json",
    Accept: "application/json, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    Connection: "keep-alive",
    "User-Agent": `commandcode-cli/${ccVersion} Node.js/${process.version}`,
    Authorization: `Bearer ${apiKey}`,
    "x-cli-environment": "production",
    "x-command-code-version": ccVersion,
    "x-session-id": sessionId,
    "x-co-flag": "false",
    "x-taste-learning": "false",
    "x-project-slug": slugifyWorkingDir(body.config.workingDir as string),
    traceparent: generateTraceparent(),
  };
}

function slugifyWorkingDir(workingDir: string): string {
  const base =
    (workingDir || process.cwd()).split(/[/\\]/).filter(Boolean).pop() ?? "commandcode-proxy";
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 40) || "commandcode-proxy"
  );
}

function generateTraceparent(): string {
  const traceId = crypto.randomBytes(16).toString("hex");
  const parentId = crypto.randomBytes(8).toString("hex");
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Send a request to the Command Code /alpha/generate endpoint and parse
 * the NDJSON response into CCEvent objects.
 *
 * CC's upstream is always streaming; we force `params.stream = true` here
 * regardless of the downstream client's `stream` flag. For non-streaming
 * downstream requests, the caller drains the returned `stream` into events.
 *
 * Retryable failures (HTTP 5xx/429, timeouts, network errors) are retried up
 * to MAX_RETRIES times with linear backoff — but ONLY before the stream starts.
 * A client-initiated abort (caller already disconnected) is never retried.
 *
 * Returns a Readable of parsed CCEvents. Callers MUST consume or destroy it.
 */
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export async function sendToCC(
  body: CCRequestBody,
  options: UpstreamOptions,
  signal?: AbortSignal,
): Promise<{ stream: NodeJS.ReadableStream }> {
  const { apiBase, apiKey, ccVersion, timeoutMs = 300_000 } = options;

  const url = `${apiBase}/alpha/generate`;
  // CC's API is always streaming — force it on so the upstream stays a stream.
  body.params.stream = true;

  let lastError: UpstreamError | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    // Per-attempt timeout so one dead connection can't burn the whole budget.
    const controller = new AbortController();
    const combinedSignal = signal ? combineSignals(signal, controller.signal) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error("Upstream timeout")), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(apiKey, ccVersion, body),
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const retryable = response.status >= 500 || response.status === 429;
        lastError = new UpstreamError(
          `CC API ${response.status}: ${errorText || response.statusText}`,
          response.status,
          retryable,
        );
        if (retryable && attempt <= MAX_RETRIES) {
          logger.warn(`CC upstream ${response.status}, retrying ${attempt}/${MAX_RETRIES}...`);
          await sleep(RETRY_BACKOFF_MS * attempt, signal);
          continue;
        }
        throw lastError;
      }

      if (!response.body) {
        throw new UpstreamError("CC API returned no body", 0, true);
      }

      return { stream: nodeReaderToStream(response.body.getReader()) };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof UpstreamError) throw err;

      // Distinguish a client-initiated abort (caller is gone — never retry, it
      // only wastes a request) from a timeout/network blip (retryable).
      const aborted = (err as Error).name === "AbortError";
      if (aborted && signal?.aborted) {
        throw new UpstreamError("Request aborted", 0, true);
      }
      lastError = new UpstreamError(
        aborted ? "Upstream timeout" : `Upstream request failed: ${(err as Error).message}`,
        0,
        true,
      );
      if (attempt <= MAX_RETRIES) {
        logger.warn(
          `CC upstream ${aborted ? "timeout" : "error"}, retrying ${attempt}/${MAX_RETRIES}...`,
        );
        await sleep(RETRY_BACKOFF_MS * attempt, signal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new UpstreamError("Upstream request failed after retries", 0, true);
}

/**
 * Drain a CCEvent stream into an array. Used for non-streaming downstream
 * requests where we need the full response before replying.
 */
export function collectEvents(stream: NodeJS.ReadableStream): Promise<CCEvent[]> {
  const events: CCEvent[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (event: CCEvent) => events.push(event));
    stream.on("end", () => resolve(events));
    stream.on("error", reject);
  });
}

/**
 * Error class for upstream CC API errors.
 */
export class UpstreamError extends Error {
  public statusCode: number;
  public isRetryable: boolean;

  constructor(message: string, statusCode: number, isRetryable: boolean) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
  }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function nodeReaderToStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): NodeJS.ReadableStream {
  const decoder = new TextDecoder();
  let buffer = "";

  return new Readable({
    objectMode: true,
    async read() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush remaining buffer
            if (buffer.trim()) {
              const result = parseCCLine(buffer);
              if (result.type === "event" && result.event) {
                this.push(result.event);
              }
            }
            this.push(null);
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const result = parseCCLine(line);
            if (result.type === "event" && result.event) {
              const canContinue = this.push(result.event);
              if (!canContinue) return;
            }
          }
        }
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });
}
