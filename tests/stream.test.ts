import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  parseCCLine,
  formatSSE,
  formatSSEDone,
  formatAnthropicSSE,
  NDJSONParser,
} from "@/stream.js";

describe("parseCCLine", () => {
  it("parses a CC event with data: prefix", () => {
    const result = parseCCLine('data: {"type":"text-delta","data":{"text":"Hello"}}');
    expect(result.type).toBe("event");
    expect(result.event?.type).toBe("text-delta");
    expect(result.event?.data.text).toBe("Hello");
  });

  it("parses a CC event without prefix", () => {
    const result = parseCCLine('{"type":"start","data":{"model":"test"}}');
    expect(result.type).toBe("event");
    expect(result.event?.type).toBe("start");
  });

  it("returns ping for empty lines", () => {
    expect(parseCCLine("").type).toBe("ping");
    expect(parseCCLine("  ").type).toBe("ping");
  });

  it("returns done for [DONE]", () => {
    const result = parseCCLine("data: [DONE]");
    expect(result.type).toBe("done");
  });

  it("returns ping for unparseable lines", () => {
    const result = parseCCLine("data: not-json");
    expect(result.type).toBe("ping");
  });

  it("handles finish event with usage data", () => {
    const line =
      'data: {"type":"finish","data":{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":20,"totalTokens":30}}}';
    const result = parseCCLine(line);
    expect(result.type).toBe("event");
    expect(result.event?.type).toBe("finish");
    expect(result.event?.data.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("handles error events", () => {
    const result = parseCCLine('{"type":"error","data":{"message":"Rate limit exceeded"}}');
    expect(result.type).toBe("event");
    expect(result.event?.type).toBe("error");
    expect(result.event?.data.message).toBe("Rate limit exceeded");
  });
});

describe("formatSSE", () => {
  it("formats an object as SSE data", () => {
    const sse = formatSSE({ key: "value" });
    expect(sse).toBe('data: {"key":"value"}\n\n');
  });

  it("formats nested objects correctly", () => {
    const obj = { id: "123", choices: [{ delta: { content: "hi" } }] };
    const sse = formatSSE(obj);
    expect(sse).toContain('"id":"123"');
    expect(sse).toContain('"content":"hi"');
    expect(sse.endsWith("\n\n")).toBe(true);
  });
});

describe("formatSSEDone", () => {
  it("returns [DONE] signal", () => {
    expect(formatSSEDone()).toBe("data: [DONE]\n\n");
  });
});

describe("NDJSONParser", () => {
  it("parses NDJSON lines into CCEvent objects", async () => {
    const input = Buffer.from(
      '{"type":"start","data":{"model":"test"}}\n{"type":"text-delta","data":{"text":"Hi"}}\n',
    );
    const stream = Readable.from([input]);
    const parser = stream.pipe(new NDJSONParser());

    const events: any[] = [];
    for await (const event of parser) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("text-delta");
    expect(events[1].data.text).toBe("Hi");
  });

  it("handles data: prefix", async () => {
    const input = Buffer.from('data: {"type":"text-delta","data":{"text":"Hello"}}\n');
    const stream = Readable.from([input]);
    const parser = stream.pipe(new NDJSONParser());

    const events: any[] = [];
    for await (const event of parser) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text-delta");
  });

  it("skips empty lines and [DONE]", async () => {
    const input = Buffer.from(
      '{"type":"start","data":{}}\n\ndata: [DONE]\n{"type":"finish","data":{}}\n',
    );
    const stream = Readable.from([input]);
    const parser = stream.pipe(new NDJSONParser());

    const events: any[] = [];
    for await (const event of parser) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("finish");
  });

  it("handles fragmented chunks (partial lines)", async () => {
    const parser = new NDJSONParser();
    const events: any[] = [];
    parser.on("data", (event: any) => events.push(event));

    // Push partial line, then the rest
    parser.write(Buffer.from('{"type":"text-delta","data":{"tex'));
    parser.write(Buffer.from('t":"World"}}\n'));
    parser.end();

    await new Promise<void>((resolve) => parser.on("end", resolve));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text-delta");
    expect(events[0].data.text).toBe("World");
  });

  it("handles multiple events in a single chunk", async () => {
    const input = Buffer.from(
      '{"type":"start","data":{}}\n{"type":"text-delta","data":{"text":"A"}}\n{"type":"finish","data":{}}\n',
    );
    const stream = Readable.from([input]);
    const parser = stream.pipe(new NDJSONParser());

    const events: any[] = [];
    for await (const event of parser) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
  });

  it("flushes remaining buffer on end", async () => {
    const parser = new NDJSONParser();
    const events: any[] = [];
    parser.on("data", (event: any) => events.push(event));

    // Push a line without newline — should be flushed on end
    parser.write(Buffer.from('{"type":"text-delta","data":{"text":"flushed"}}'));
    parser.end();

    await new Promise<void>((resolve) => parser.on("end", resolve));

    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe("flushed");
  });
});

describe("formatAnthropicSSE", () => {
  it("emits event + data lines", () => {
    const result = formatAnthropicSSE("message_start", {
      type: "message_start",
      message: { id: "msg_1", model: "claude" },
    });
    expect(result).toContain("event: message_start");
    expect(result).toContain("data: ");
    expect(result).toContain("\n\n");
  });

  it("message_stop uses empty data", () => {
    const result = formatAnthropicSSE("message_stop", {});
    expect(result).toContain("event: message_stop");
    expect(result).toContain("data: {}");
  });

  it("content_block_delta formats correctly", () => {
    const result = formatAnthropicSSE("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    expect(result).toContain("event: content_block_delta");
    const parsed = JSON.parse(result.split("data: ")[1].trimEnd());
    expect(parsed.delta.text).toBe("Hello");
  });
});
