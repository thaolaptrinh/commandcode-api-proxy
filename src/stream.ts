import type { CCEvent } from "@/translate/types.js";

/**
 * Result from parsing a single line of CC NDJSON data.
 */
export interface ParsedChunk {
  type: "event" | "done" | "ping" | "unknown";
  event?: CCEvent;
}

/**
 * Parse a single NDJSON line from the CC stream.
 */
export function parseCCLine(line: string): ParsedChunk {
  const trimmed = line.trim();

  if (!trimmed || trimmed === "") return { type: "ping" };

  // The CC API sends JSON lines prefixed with "data: "
  // Handle both with and without prefix
  const dataStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;

  if (dataStr === "[DONE]") return { type: "done" };

  try {
    const parsed = JSON.parse(dataStr);

    // CC API format 1 (flat): { type: "text-delta", id: "txt-0", text: "4" }
    // CC API format 2 (nested): { type: "text-delta", data: { text: "Hello" } }
    // Merge all non-type fields into data.
    if (parsed && typeof parsed === "object" && parsed.type) {
      const { type, id: _id, ...rest } = parsed;
      const data = parsed.data && typeof parsed.data === "object" ? parsed.data : rest;
      return {
        type: "event",
        event: { type, data },
      };
    }

    return { type: "unknown" };
  } catch {
    // If we can't parse as JSON, it might be a ping or keepalive
    return { type: "ping" };
  }
}

/**
 * Format an object as an SSE message string.
 */
export function formatSSE(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Format the [DONE] signal for non-streaming mode.
 */
export function formatSSEDone(): string {
  return "data: [DONE]\n\n";
}

export function formatAnthropicSSE(eventType: string, data: unknown): string {
  if (eventType === "message_stop") {
    return "event: message_stop\ndata: {}\n\n";
  }
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
