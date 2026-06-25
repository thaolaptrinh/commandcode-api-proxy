import { describe, it, expect } from "vitest";
import { modelMessageSchema } from "ai";
import { toCCRequest } from "@/translate/openai.js";
import { buildNonStreamingResponse } from "@/translate/openai.js";
import { extractUsage } from "@/translate/util.js";
import type { OpenAIChatRequest } from "@/translate/types.js";
import type { CCEvent } from "@/translate/types.js";

/**
 * The Command Code upstream validates `params.messages` against the Vercel AI
 * SDK v5 `ModelMessage[]` schema (it rejects with "The messages do not match
 * the ModelMessage[] schema"). These tests lock in that the OpenAI → CC
 * translation always produces schema-conformant messages.
 */
function expectSchemaValid(req: OpenAIChatRequest): void {
  const cc = toCCRequest(req);
  const result = modelMessageSchema.array().safeParse(cc.params.messages);
  expect(result.success).toBe(true);
  if (!result.success) {
    const leafErrors: string[] = [];
    const walk = (obj: unknown, path: string): void => {
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown> & { _errors?: string[] };
        if (o._errors && o._errors.length) leafErrors.push(`${path}: ${o._errors.join("; ")}`);
        for (const k of Object.keys(o)) if (k !== "_errors") walk(o[k], `${path}.${k}`);
      }
    };
    walk((result.error as { format: () => unknown }).format(), "");
    throw new Error("messages do not match ModelMessage[] schema:\n" + leafErrors.join("\n"));
  }
}

describe("toCCRequest — ModelMessage[] schema conformance", () => {
  it("text-only user message", () => {
    expectSchemaValid({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("system + user text messages", () => {
    expectSchemaValid({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("assistant tool-call + tool result round-trip (round 2)", () => {
    expectSchemaValid({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "user", content: "list files in /tmp" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_files", arguments: '{"path":"/tmp"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "a\nb\nc" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "list_files",
            description: "list",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
  });

  it("multiple parallel tool calls + results", () => {
    expectSchemaValid({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "user", content: "read both files" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "read", arguments: '{"path":"a"}' },
            },
            {
              id: "call_b",
              type: "function",
              function: { name: "read", arguments: '{"path":"b"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "AAA" },
        { role: "tool", tool_call_id: "call_b", content: "BBB" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
  });

  it("assistant message with text + tool-call, then result", () => {
    expectSchemaValid({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "user", content: "search then explain" },
        {
          role: "assistant",
          content: "Let me search.",
          tool_calls: [
            {
              id: "call_x",
              type: "function",
              function: { name: "grep", arguments: '{"pattern":"foo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_x", content: "no matches" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "grep",
            description: "search",
            parameters: { type: "object", properties: { pattern: { type: "string" } } },
          },
        },
      ],
    });
  });
});

describe("usage extraction — CC totalUsage → OpenAI format", () => {
  // Real shape emitted by the CC upstream `finish` event.
  const ccFinishData = {
    finishReason: "tool-calls",
    totalUsage: {
      inputTokens: 145217,
      inputTokenDetails: { noCacheTokens: 72756, cacheReadTokens: 72461 },
      outputTokens: 1387,
      outputTokenDetails: { textTokens: 1387, reasoningTokens: 0 },
      totalTokens: 146604,
      reasoningTokens: 0,
      cachedInputTokens: 72461,
    },
  };

  it("maps CC totalUsage fields to UsageData", () => {
    const u = extractUsage(ccFinishData)!;
    expect(u.promptTokens).toBe(145217);
    expect(u.completionTokens).toBe(1387);
    expect(u.totalTokens).toBe(146604);
    expect(u.promptTokensDetails?.cachedTokens).toBe(72461);
    expect(u.completionTokensDetails?.reasoningTokens).toBe(0);
  });

  it("buildNonStreamingResponse emits OpenAI-format usage", () => {
    const events: CCEvent[] = [
      { type: "text-delta", data: { text: "hi" } },
      { type: "finish", data: ccFinishData },
    ];
    const res = buildNonStreamingResponse(events, "deepseek/deepseek-v4-flash") as {
      usage?: Record<string, unknown>;
    };
    expect(res.usage).toBeDefined();
    expect(res.usage).toMatchObject({
      prompt_tokens: 145217,
      completion_tokens: 1387,
      total_tokens: 146604,
      prompt_tokens_details: { cached_tokens: 72461 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("returns undefined when no usage is present", () => {
    expect(extractUsage({ finishReason: "stop" })).toBeUndefined();
  });
});
