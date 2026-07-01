import { describe, it, expect } from "vitest";
import {
  toCCRequest,
  AnthropicStreamEncoder,
  buildAnthropicResponse,
} from "@/translate/anthropic.js";
import type { AnthropicRequest, AnthropicSSERecord } from "@/translate/anthropic-types.js";
import type { CCEvent } from "@/translate/types.js";

describe("toCCRequest", () => {
  it("basic text request maps correctly", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = toCCRequest(req);
    expect(result.params.max_tokens).toBe(100);
    expect(result.params.messages).toHaveLength(1);
    expect(result.params.messages[0].role).toBe("user");
    expect(result.params.messages[0].content).toContain("Hello");
  });

  it("system as string is injected", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = toCCRequest(req);
    expect(result.params.system).toContain("You are helpful.");
  });

  it("system as array joins text blocks", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      system: [
        { type: "text", text: "Be helpful." },
        { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = toCCRequest(req);
    expect(result.params.system).toContain("Be helpful.");
    expect(result.params.system).toContain("Be concise.");
  });

  it("tool_use and tool_result translation", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      tools: [{ name: "weather", input_schema: { type: "object", properties: {} } }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "Sunny",
              is_error: false,
            },
          ],
        },
      ],
    };
    const result = toCCRequest(req);

    const toolResultMsg = result.params.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => (p as Record<string, unknown>).type === "tool-result"),
    );
    expect(toolResultMsg).toBeDefined();
    const parts = toolResultMsg!.content;
    expect(Array.isArray(parts)).toBe(true);
    const part = (parts as Array<Record<string, unknown>>)[0];
    expect(part.type).toBe("tool-result");
    expect(part.toolName).toBe("weather");
  });

  it("thinking maps to reasoning_effort", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4000,
      thinking: { type: "enabled", budget_tokens: 3000 },
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = toCCRequest(req);
    expect(result.params.reasoning_effort).toBe("medium");
  });

  it("thinking with low budget maps to low", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4000,
      thinking: { type: "enabled", budget_tokens: 1500 },
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = toCCRequest(req);
    expect(result.params.reasoning_effort).toBe("low");
  });

  it("thinking with high budget maps to high", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = toCCRequest(req);
    expect(result.params.reasoning_effort).toBe("high");
  });

  it("thinking not set = no reasoning_effort", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = toCCRequest(req);
    expect(result.params.reasoning_effort).toBeUndefined();
  });

  it("image base64 conversion", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc123" },
            },
          ],
        },
      ],
    };
    const result = toCCRequest(req);
    const part = (result.params.messages[0].content as { type: string; image: string }[])[0];
    expect(part.image).toBe("data:image/png;base64,abc123");
  });

  it("image URL passthrough", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/img.png" },
            },
          ],
        },
      ],
    };
    const result = toCCRequest(req);
    const part = (result.params.messages[0].content as { type: string; image: string }[])[0];
    expect(part.image).toBe("https://example.com/img.png");
  });

  it("thinking dropped from assistant history", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Hmm...", signature: "sig123" },
            { type: "redacted_thinking", data: "redacted content" },
            { type: "text", text: "The answer is 42" },
          ],
        },
      ],
    };
    const result = toCCRequest(req);
    const msg = result.params.messages[0];
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toBe("The answer is 42");
  });

  it("tool_choice mapping", () => {
    const base: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ name: "calc", input_schema: {} }],
    };

    expect(
      toCCRequest({ ...base, tool_choice: { type: "auto" } }).params.tool_choice,
    ).toBeUndefined();
    expect(toCCRequest({ ...base, tool_choice: { type: "any" } }).params.tool_choice).toBe(
      "required",
    );
    expect(
      toCCRequest({ ...base, tool_choice: { type: "tool", name: "calc" } }).params.tool_choice,
    ).toBe("calc");
    expect(toCCRequest({ ...base, tool_choice: { type: "none" } }).params.tool_choice).toBe("none");
  });

  it("no-tools safeguard injected", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = toCCRequest(req);
    expect(result.params.system).toContain("chat-only environment");
  });

  it("stream is passed through", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    };
    expect(toCCRequest(req).params.stream).toBe(true);
  });
});

describe("AnthropicStreamEncoder", () => {
  it("text-only stream", () => {
    const encoder = new AnthropicStreamEncoder("test-model");

    const start = encoder.emit({ type: "start", data: {} });
    expect(start).toHaveLength(0);

    const chunks = encoder.emit({ type: "text-delta", data: { text: "Hello" } });
    const events = chunks.map((c: AnthropicSSERecord) => c.event);
    expect(events).toContain("message_start");
    expect(events).toContain("content_block_start");
    expect(events).toContain("ping");
    expect(events).toContain("content_block_delta");

    const delta = chunks.find((c) => c.event === "content_block_delta");
    expect((delta!.data.delta as { text: string })?.text).toBe("Hello");

    const finish = encoder.emit({ type: "finish", data: { finishReason: "stop" } });
    const finishEvents = finish.map((c) => c.event);
    expect(finishEvents).toContain("content_block_stop");
    expect(finishEvents).toContain("message_delta");
    expect(finishEvents).toContain("message_stop");
  });

  it("stop reason mapping", () => {
    const cases: [string, string][] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool-call", "tool_use"],
      ["tool-calls", "tool_use"],
      ["pause_turn", "pause_turn"],
      ["refusal", "refusal"],
      ["model_context_window_exceeded", "model_context_window_exceeded"],
    ];

    for (const [ccReason, expected] of cases) {
      const encoder = new AnthropicStreamEncoder("m");
      encoder.emit({ type: "start", data: {} });
      encoder.emit({ type: "text-delta", data: { text: "." } });
      const finish = encoder.emit({ type: "finish", data: { finishReason: ccReason } });
      const md = finish.find((c) => c.event === "message_delta");
      expect((md!.data.delta as { stop_reason: string })?.stop_reason).toBe(expected);
    }
  });

  it("thinking block emits signature_delta on close", () => {
    const encoder = new AnthropicStreamEncoder("m");
    encoder.emit({ type: "start", data: {} });

    const chunks = encoder.emit({ type: "reasoning-delta", data: { text: "Let me think..." } });
    // After reasoning-delta, current block type is "thinking"
    // But no signature_delta yet — that only comes on close
    expect(chunks.every((c) => c.event !== "signature_delta")).toBe(true);

    const finish = encoder.emit({ type: "finish", data: { finishReason: "stop" } });
    const sig = finish.find((c) => c.event === "signature_delta");
    expect(sig).toBeDefined();
    expect((sig!.data as { signature: string })?.signature).toBe("_cc_proxy_placeholder");
  });

  it("error before content emits message_start then error", () => {
    const encoder = new AnthropicStreamEncoder("m");
    const records = encoder.emit({ type: "error", data: { message: "Boom!" } });
    const events = records.map((r) => r.event);
    expect(events).toContain("message_start");
    expect(events).toContain("error");
    expect(events).toContain("message_stop");
  });

  it("message_start includes full usage shape", () => {
    const encoder = new AnthropicStreamEncoder("m");
    encoder.emit({
      type: "start",
      data: { totalUsage: { inputTokens: 42 } },
    });
    const chunks = encoder.emit({ type: "text-delta", data: { text: "x" } });
    const ms = chunks.find((c) => c.event === "message_start");
    const msg = ms!.data.message as Record<string, unknown>;
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBeNull();
    expect(msg.stop_sequence).toBeNull();
    const usage = msg.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(42);
    expect(usage.output_tokens).toBe(1);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.service_tier).toBe("standard");
  });

  it("two encoders are independent (concurrency fix)", () => {
    const a = new AnthropicStreamEncoder("a");
    const b = new AnthropicStreamEncoder("b");
    expect(a.messageId).not.toBe(b.messageId);

    a.emit({ type: "start", data: {} });
    b.emit({ type: "start", data: {} });

    const chunksA = a.emit({ type: "text-delta", data: { text: "A" } });
    const chunksB = b.emit({ type: "text-delta", data: { text: "B" } });

    const startA = chunksA.find((c) => c.event === "message_start");
    const startB = chunksB.find((c) => c.event === "message_start");
    expect((startA!.data.message as { id: string })?.id).not.toBe(
      (startB!.data.message as { id: string })?.id,
    );
  });

  it("tool-call-delta emits content_block_start and input_json_delta", () => {
    const encoder = new AnthropicStreamEncoder("m");
    encoder.emit({ type: "start", data: {} });

    const chunks = encoder.emit({
      type: "tool-call-delta",
      data: { toolCallId: "tc1", name: "weather", arguments: '{"city":' },
    });
    const events = chunks.map((c) => c.event);
    expect(events).toContain("message_start");
    expect(events).toContain("content_block_start");
    const cbs = chunks.find((c) => c.event === "content_block_start");
    expect((cbs!.data.content_block as { type: string }).type).toBe("tool_use");
    expect(events).toContain("content_block_delta");
    const cbd = chunks.find((c) => c.event === "content_block_delta");
    expect((cbd!.data.delta as { type: string; partial_json: string }).partial_json).toBe(
      '{"city":',
    );
  });

  it("tool-call emits content_block_start and input_json_delta with JSON args", () => {
    const encoder = new AnthropicStreamEncoder("m");
    encoder.emit({ type: "start", data: {} });

    const chunks = encoder.emit({
      type: "tool-call",
      data: { toolCallId: "tc1", toolName: "weather", input: { city: "Paris" } },
    });
    const events = chunks.map((c) => c.event);
    expect(events).toContain("content_block_start");
    const cbd = chunks.find((c) => c.event === "content_block_delta");
    expect((cbd!.data.delta as { type: string; partial_json: string }).partial_json).toBe(
      '{"city":"Paris"}',
    );
    expect(events).toContain("content_block_stop");
  });
});

describe("buildAnthropicResponse", () => {
  it("builds response from text events", () => {
    const events: CCEvent[] = [
      { type: "text-delta", data: { text: "Hello" } },
      { type: "text-delta", data: { text: " world" } },
      {
        type: "finish",
        data: {
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ];
    const resp = buildAnthropicResponse(events, "test-model", "msg-123");
    expect(resp.id).toBe("msg-123");
    expect(resp.type).toBe("message");
    expect(resp.role).toBe("assistant");
    expect(resp.model).toBe("test-model");
    expect(resp.content).toHaveLength(1);
    expect((resp.content[0] as { text: string }).text).toBe("Hello world");
    expect(resp.stop_reason).toBe("end_turn");
    expect(resp.usage.input_tokens).toBe(5);
    expect(resp.usage.output_tokens).toBe(2);
  });

  it("includes thinking block when reasoning-delta received", () => {
    const events: CCEvent[] = [
      { type: "reasoning-delta", data: { text: "thinking..." } },
      { type: "text-delta", data: { text: "Answer" } },
      { type: "finish", data: { finishReason: "stop" } },
    ];
    const resp = buildAnthropicResponse(events, "m", "id");
    expect(resp.content).toHaveLength(2);
    expect(resp.content[0].type).toBe("text");
    expect(resp.content[1].type).toBe("thinking");
    expect((resp.content[1] as { signature: string }).signature).toBe("_cc_proxy_placeholder");
  });

  it("includes tool_use blocks (no text means no empty text block)", () => {
    const events: CCEvent[] = [
      {
        type: "tool-call",
        data: { toolCallId: "tc1", toolName: "weather", input: { city: "Paris" } },
      },
      {
        type: "tool-call",
        data: { toolCallId: "tc2", toolName: "search", input: { q: "test" } },
      },
      { type: "finish", data: { finishReason: "tool-call" } },
    ];
    const resp = buildAnthropicResponse(events, "m", "id");
    expect(resp.stop_reason).toBe("tool_use");
    expect(resp.content).toHaveLength(2);
    expect(resp.content[0].type).toBe("tool_use");
    expect(resp.content[1].type).toBe("tool_use");
  });

  it("includes empty text block when no content", () => {
    const events: CCEvent[] = [{ type: "finish", data: { finishReason: "stop" } }];
    const resp = buildAnthropicResponse(events, "m", "id");
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("text");
    expect((resp.content[0] as { text: string }).text).toBe("");
  });

  it("defaults to end_turn stop reason on missing finish event", () => {
    const events: CCEvent[] = [{ type: "text-delta", data: { text: "Hi" } }];
    const resp = buildAnthropicResponse(events, "m", "id");
    expect(resp.stop_reason).toBe("end_turn");
  });
});
