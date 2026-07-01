import { describe, it, expect, beforeEach } from "vitest";
import { toCCRequest, buildNonStreamingResponse, OpenAIStreamEncoder } from "@/translate/openai.js";
import { resolveModel, getDefaultModels } from "@/translate/models.js";
import type { OpenAIChatRequest, CCEvent } from "@/translate/types.js";

// ──────────────────────────────────────────
// resolveModel
// ──────────────────────────────────────────

describe("resolveModel", () => {
  it("returns default model for empty string", () => {
    expect(resolveModel("")).toBe(getDefaultModels()[0]);
  });

  it('returns default model for "default"', () => {
    expect(resolveModel("default")).toBe(getDefaultModels()[0]);
  });

  it("passes unknown model IDs through", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModel("gpt-4")).toBe("gpt-4");
  });

  it("maps short aliases", () => {
    expect(resolveModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(resolveModel("deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(resolveModel("kimi-k2.5")).toBe("moonshotai/Kimi-K2.5");
    expect(resolveModel("qwen-3.6-max")).toBe("Qwen/Qwen3.6-Max-Preview");
  });

  it("passes through full model IDs", () => {
    expect(resolveModel("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
    expect(resolveModel("custom/model-name")).toBe("custom/model-name");
  });
});

// ──────────────────────────────────────────
// toCCRequest
// ──────────────────────────────────────────

describe("toCCRequest", () => {
  it("converts basic chat request", () => {
    const req: OpenAIChatRequest = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    const cc = toCCRequest(req);

    expect(cc.params.model).toBe("deepseek/deepseek-v4-pro");
    expect(cc.params.system).toContain("You are a helpful assistant.");
    expect(cc.params.messages).toHaveLength(1);
    expect(cc.params.messages[0].role).toBe("user");
    expect(cc.params.messages[0].content).toContain("Hello");
    expect(cc.threadId).toBeDefined();
    expect(cc.config.workingDir).toBeDefined();
  });

  it("extracts system prompt from messages", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [
        { role: "developer", content: "Dev instructions" },
        { role: "user", content: "Hi" },
      ],
    };

    const cc = toCCRequest(req);
    expect(cc.params.system).toContain("Dev instructions");
  });

  it("converts tool messages", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            },
          ],
        },
        {
          role: "tool",
          content: "72°F",
          tool_call_id: "call_123",
        },
      ],
    };

    const cc = toCCRequest(req);

    const assistantMsg = cc.params.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      const toolCallPart = assistantMsg.content.find((p: any) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
      expect(toolCallPart?.toolCallId).toBe("call_123");
      expect(toolCallPart?.toolName).toBe("get_weather");
    }

    const toolResultMsg = cc.params.messages.find((m) => {
      const content = m.content;
      return Array.isArray(content) && content.some((p: any) => p.type === "tool-result");
    });
    expect(toolResultMsg).toBeDefined();
  });

  it("converts tools array to CC format", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    };

    const cc = toCCRequest(req);
    expect(cc.params.tools).toHaveLength(1);
    expect(cc.params.tools![0].name).toBe("get_weather");
    expect(cc.params.tools![0].input_schema).toBeDefined();
  });

  it("handles image content parts", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
    };

    const cc = toCCRequest(req);
    const userMsg = cc.params.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    if (Array.isArray(userMsg.content)) {
      expect(userMsg.content[0].type).toBe("text");
      expect(userMsg.content[1].type).toBe("image");
      expect((userMsg.content[1] as any).image).toBe("data:image/jpeg;base64,/9j/");
    }
  });

  it("prunes dangling assistant tool-calls that have no matching tool result", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [
        { role: "user", content: "check weather then stocks" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_paired",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
            {
              id: "call_orphan",
              type: "function",
              function: { name: "get_stocks", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "72°F", tool_call_id: "call_paired" },
      ],
    };

    const cc = toCCRequest(req);

    const toolCallIds = cc.params.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: any) => p.type === "tool-call")
      .map((p: any) => p.toolCallId);

    expect(toolCallIds).toContain("call_paired");
    expect(toolCallIds).not.toContain("call_orphan");
  });

  it("prunes dangling tool results that have no matching assistant tool-call", () => {
    const req: OpenAIChatRequest = {
      model: "default",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "orphan result", tool_call_id: "call_missing" },
      ],
    };

    const cc = toCCRequest(req);

    const toolResultIds = cc.params.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: any) => p.type === "tool-result")
      .map((p: any) => p.toolCallId);

    expect(toolResultIds).not.toContain("call_missing");
  });
});

// ──────────────────────────────────────────
// OpenAIStreamEncoder
// ──────────────────────────────────────────

describe("OpenAIStreamEncoder", () => {
  let encoder: OpenAIStreamEncoder;

  beforeEach(() => {
    encoder = new OpenAIStreamEncoder("test-model");
  });

  it("converts start event to role chunk", () => {
    const chunks = encoder.emit({
      type: "start",
      data: { model: "deepseek/deepseek-v4-pro" },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveProperty("choices");
    expect((chunks[0] as any).choices[0].delta.role).toBe("assistant");
  });

  it("converts text-delta to content chunk", () => {
    const chunks = encoder.emit({
      type: "text-delta",
      data: { text: "Hello" },
    });
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).choices[0].delta.content).toBe("Hello");
  });

  it("converts reasoning-delta to reasoning_content chunk", () => {
    const chunks = encoder.emit({
      type: "reasoning-delta",
      data: { text: "thinking..." },
    });
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).choices[0].delta.reasoning_content).toBe("thinking...");
  });

  it("converts finish event with usage", () => {
    const chunks = encoder.emit({
      type: "finish",
      data: {
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    });
    // finish chunk + separate OpenAI usage chunk (empty choices)
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).choices[0].finish_reason).toBe("stop");
    expect((chunks[1] as any).choices).toEqual([]);
    expect((chunks[1] as any).usage.prompt_tokens).toBe(10);
    expect((chunks[1] as any).usage.completion_tokens).toBe(20);
    expect((chunks[1] as any).usage.total_tokens).toBe(30);
  });

  it("maps finish reasons correctly", () => {
    const map: Record<string, string> = {
      stop: "stop",
      length: "length",
      content_filtered: "content_filter",
      tool_call: "tool_calls",
      error: "stop",
    };

    for (const [from, to] of Object.entries(map)) {
      const chunks = encoder.emit({
        type: "finish",
        data: { finishReason: from as string },
      });
      expect((chunks[0] as any).choices[0].finish_reason).toBe(to);
    }
  });
});

// ──────────────────────────────────────────
// buildNonStreamingResponse
// ──────────────────────────────────────────

describe("buildNonStreamingResponse", () => {
  it("builds response from text-delta events", () => {
    const events: CCEvent[] = [
      { type: "start", data: { model: "deepseek/deepseek-v4-pro" } },
      { type: "text-delta", data: { text: "Hello" } },
      { type: "text-delta", data: { text: " world" } },
      { type: "finish", data: { finishReason: "stop", usage: { totalTokens: 5 } } },
    ];

    const resp = buildNonStreamingResponse(
      events,
      "deepseek/deepseek-v4-pro",
      "test-id-123",
    ) as any;
    expect(resp.id).toBe("test-id-123");
    expect(resp.choices[0].message.content).toBe("Hello world");
    expect(resp.choices[0].finish_reason).toBe("stop");
    expect(resp.usage.total_tokens).toBe(5);
  });

  it("includes reasoning content", () => {
    const events: CCEvent[] = [
      { type: "start", data: {} },
      { type: "reasoning-delta", data: { text: "thinking" } },
      { type: "text-delta", data: { text: "Answer" } },
      { type: "finish", data: { finishReason: "stop" } },
    ];

    const resp = buildNonStreamingResponse(events, "model", "test-id-456") as any;
    expect(resp.id).toBe("test-id-456");
    expect(resp.choices[0].message.reasoning_content).toBe("thinking");
    expect(resp.choices[0].message.content).toBe("Answer");
  });
});

// ──────────────────────────────────────────
// validateAnthropicRequest
// ──────────────────────────────────────────

import { validateAnthropicRequest, ValidationError } from "@/translate/validation.js";

describe("validateAnthropicRequest", () => {
  it("rejects non-object body", () => {
    expect(() => validateAnthropicRequest(null)).toThrow(ValidationError);
    expect(() => validateAnthropicRequest("string")).toThrow(ValidationError);
  });

  it("rejects missing model", () => {
    expect(() => validateAnthropicRequest({ max_tokens: 10, messages: [] })).toThrow(
      ValidationError,
    );
  });

  it("rejects missing max_tokens", () => {
    expect(() =>
      validateAnthropicRequest({ model: "x", messages: [{ role: "user", content: "Hi" }] }),
    ).toThrow(ValidationError);
  });

  it("rejects missing messages", () => {
    expect(() => validateAnthropicRequest({ model: "x", max_tokens: 10 })).toThrow(ValidationError);
  });

  it("rejects invalid message role", () => {
    expect(() =>
      validateAnthropicRequest({
        model: "x",
        max_tokens: 10,
        messages: [{ role: "system", content: "Hi" }],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects message missing content", () => {
    expect(() =>
      validateAnthropicRequest({
        model: "x",
        max_tokens: 10,
        messages: [{ role: "user" }],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects document content block", () => {
    expect(() =>
      validateAnthropicRequest({
        model: "x",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: {} }],
          },
        ],
      }),
    ).toThrow(/document.*not supported/);
  });

  it("rejects built-in tool type", () => {
    expect(() =>
      validateAnthropicRequest({
        model: "x",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "computer_20241022", name: "computer", input_schema: {} }],
      }),
    ).toThrow(/computer_20241022.*not supported/);
  });

  it("rejects thinking.budget_tokens >= max_tokens", () => {
    expect(() =>
      validateAnthropicRequest({
        model: "x",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hi" }],
        thinking: { type: "enabled", budget_tokens: 200 },
      }),
    ).toThrow(/budget_tokens.*less than max_tokens/);
  });

  it("accepts valid request", () => {
    const req = validateAnthropicRequest({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(req.model).toBe("claude-sonnet-4-5-20250929");
    expect(req.max_tokens).toBe(4096);
  });
});

describe("concurrency", () => {
  it("two encoders produce independent IDs and toolCallIndex sequences", () => {
    const encoderA = new OpenAIStreamEncoder("model-a");
    const encoderB = new OpenAIStreamEncoder("model-b");

    expect(encoderA.id).not.toBe(encoderB.id);

    encoderA.emit({ type: "start", data: {} });
    encoderB.emit({ type: "start", data: {} });

    const tcA1 = encoderA.emit({
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "fnA", input: {} },
    });
    const tcB1 = encoderB.emit({
      type: "tool-call",
      data: { toolCallId: "c2", toolName: "fnB", input: {} },
    });
    const tcA2 = encoderA.emit({
      type: "tool-call",
      data: { toolCallId: "c3", toolName: "fnA2", input: {} },
    });

    const getIndex = (chunks: object[]) => {
      const toolCallChunks = chunks.filter((c: Record<string, unknown>) => {
        const choices = c.choices as Record<string, unknown>[] | undefined;
        return (
          choices?.[0]?.delta != null &&
          (choices[0].delta as Record<string, unknown>).tool_calls != null
        );
      });
      const indices: number[] = [];
      for (const chunk of toolCallChunks) {
        const tc = (chunk as { choices: { delta: { tool_calls: { index: number }[] } }[] })
          .choices[0].delta.tool_calls;
        for (const t of tc) indices.push(t.index);
      }
      return indices;
    };

    const indicesA = getIndex([...tcA1, ...tcA2]);
    expect(indicesA).toEqual([0, 1]);

    const indicesB = getIndex(tcB1);
    expect(indicesB).toEqual([0]);
  });
});
