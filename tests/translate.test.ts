import { describe, it, expect, beforeEach } from "vitest";
import { toCCRequest, buildNonStreamingResponse, toOpenAIStreamChunk } from "@/translate/openai.js";
import { resolveModel, getDefaultModels } from "@/translate/models.js";
import { resetMessageId } from "@/translate/util.js";
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

  it("maps Claude model IDs", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("deepseek/deepseek-v4-pro");
    expect(resolveModel("claude-opus-4-7")).toBe("deepseek/deepseek-v4-pro");
    expect(resolveModel("claude-haiku-4")).toBe("deepseek/deepseek-v4-flash");
  });

  it("maps GPT model IDs", () => {
    expect(resolveModel("gpt-4")).toBe("deepseek/deepseek-v4-pro");
    expect(resolveModel("gpt-4o")).toBe("deepseek/deepseek-v4-pro");
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
// toOpenAIStreamChunk
// ──────────────────────────────────────────

describe("toOpenAIStreamChunk", () => {
  beforeEach(() => resetMessageId());

  it("converts start event to role chunk", () => {
    const chunks = toOpenAIStreamChunk({
      type: "start",
      data: { model: "deepseek/deepseek-v4-pro" },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveProperty("choices");
    expect((chunks[0] as any).choices[0].delta.role).toBe("assistant");
  });

  it("converts text-delta to content chunk", () => {
    const chunks = toOpenAIStreamChunk({
      type: "text-delta",
      data: { text: "Hello" },
    });
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).choices[0].delta.content).toBe("Hello");
  });

  it("converts reasoning-delta to reasoning_content chunk", () => {
    const chunks = toOpenAIStreamChunk({
      type: "reasoning-delta",
      data: { text: "thinking..." },
    });
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).choices[0].delta.reasoning_content).toBe("thinking...");
  });

  it("converts finish event with usage", () => {
    const chunks = toOpenAIStreamChunk({
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
      const chunks = toOpenAIStreamChunk({
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
  beforeEach(() => resetMessageId());

  it("builds response from text-delta events", () => {
    const events: CCEvent[] = [
      { type: "start", data: { model: "deepseek/deepseek-v4-pro" } },
      { type: "text-delta", data: { text: "Hello" } },
      { type: "text-delta", data: { text: " world" } },
      { type: "finish", data: { finishReason: "stop", usage: { totalTokens: 5 } } },
    ];

    const resp = buildNonStreamingResponse(events, "deepseek/deepseek-v4-pro") as any;
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

    const resp = buildNonStreamingResponse(events, "model") as any;
    expect(resp.choices[0].message.reasoning_content).toBe("thinking");
    expect(resp.choices[0].message.content).toBe("Answer");
  });
});
