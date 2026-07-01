import crypto from "node:crypto";
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAITool,
  ContentPart,
  ToolChoice,
  ToolCall,
  CCMessage,
  CCContentPart,
  CCTool,
  CCRequestBody,
  CCEvent,
  UsageData,
} from "@/translate/types.js";
import { resolveModel } from "@/translate/models.js";
import {
  applyNoToolsSafeguard,
  extractUsage,
  pruneDanglingTools,
  buildCCConfig,
} from "@/translate/util.js";
import { logger } from "@/logger.js";

// ──────────────────────────────────────────
// OpenAI request → CC request
// ──────────────────────────────────────────

function toCCMessages(messages: OpenAIMessage[]): {
  ccMessages: CCMessage[];
  systemPrompt: string | undefined;
} {
  const systemParts: string[] = [];
  const ccMessages: CCMessage[] = [];

  // Map tool_call_id -> toolName so tool-result parts can carry the tool name
  // required by the CC upstream schema (tool-result parts need a `toolName`).
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolNameById.set(tc.id, tc.function.name);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((p) => (p.type === "text" ? p.text : ""))
              .filter(Boolean)
              .join("\n");
      systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const resultText =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      ccMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id ?? "",
            toolName: (msg.tool_call_id ? toolNameById.get(msg.tool_call_id) : undefined) ?? "",
            output: { type: "text", value: resultText },
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      const parts: CCContentPart[] = [];
      if (typeof msg.content === "string" && msg.content) {
        parts.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        let parsedInput: unknown;
        try {
          parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsedInput = tc.function.arguments;
        }
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parsedInput,
        });
      }
      ccMessages.push({ role: "assistant", content: parts });
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        ccMessages.push({ role: "user", content: msg.content });
      } else {
        const parts: CCContentPart[] = msg.content.map((p: ContentPart) => {
          if (p.type === "image_url" && p.image_url) {
            return { type: "image", image: p.image_url.url };
          }
          return { type: "text", text: p.text ?? "" };
        });
        ccMessages.push({ role: "user", content: parts });
      }
      continue;
    }

    // assistant (plain text)
    if (typeof msg.content === "string") {
      ccMessages.push({ role: "assistant", content: msg.content });
    }
  }

  return {
    ccMessages: pruneDanglingTools(ccMessages),
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function toCCTools(tools: OpenAITool[] | undefined): CCTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function resolveToolChoice(tc: ToolChoice | undefined): string | undefined {
  if (!tc || tc === "auto") return undefined;
  if (tc === "none") return "none";
  if (tc === "required") return "required";
  if (typeof tc === "object" && tc.type === "function") {
    return tc.function.name;
  }
  return undefined;
}

export function toCCRequest(
  req: OpenAIChatRequest,
  configOverrides?: Partial<CCRequestBody["config"]>,
): CCRequestBody {
  const { ccMessages, systemPrompt } = toCCMessages(req.messages);
  const resolvedModel = resolveModel(req.model);

  const body: CCRequestBody = {
    config: buildCCConfig(configOverrides),
    memory: "",
    taste: "",
    skills: "",
    permissionMode: "standard",
    params: {
      model: resolvedModel,
      messages: ccMessages,
      stream: req.stream ?? false,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      stop: req.stop,
      reasoning_effort: req.reasoning_effort,
      tools: toCCTools(req.tools),
      tool_choice: resolveToolChoice(req.tool_choice),
    },
    threadId: crypto.randomUUID(),
  };

  if (systemPrompt) body.params.system = systemPrompt;
  applyNoToolsSafeguard(body, ccMessages, req.tools != null && req.tools.length > 0);

  return body;
}

// ──────────────────────────────────────────
// CC events → OpenAI streaming chunks
// ──────────────────────────────────────────

const OPENAI_FINISH_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  content_filtered: "content_filter",
  "tool-call": "tool_calls",
  "tool-calls": "tool_calls",
  tool_call: "tool_calls",
  error: "stop",
};

function toOpenAIUsage(u: UsageData): Record<string, unknown> {
  const promptTokens = u.promptTokens ?? 0;
  const completionTokens = u.completionTokens ?? 0;
  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: u.totalTokens ?? promptTokens + completionTokens,
  };
  if (u.promptTokensDetails?.cachedTokens != null) {
    usage.prompt_tokens_details = { cached_tokens: u.promptTokensDetails.cachedTokens };
  }
  if (u.completionTokensDetails?.reasoningTokens != null) {
    usage.completion_tokens_details = {
      reasoning_tokens: u.completionTokensDetails.reasoningTokens,
    };
  }
  return usage;
}

export class OpenAIStreamEncoder {
  readonly id: string;
  private readonly created: number;
  private toolCallIndex = 0;

  constructor(private readonly model: string) {
    this.id = crypto.randomUUID();
    this.created = Math.floor(Date.now() / 1000);
  }

  emit(event: CCEvent): object[] {
    const chunks: object[] = [];
    const id = this.id;
    const created = this.created;

    switch (event.type) {
      case "start": {
        this.toolCallIndex = 0;
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        break;
      }

      case "text-delta": {
        const text = event.data.text as string;
        if (text) {
          chunks.push({
            id,
            object: "chat.completion.chunk",
            created,
            model: this.model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        }
        break;
      }

      case "reasoning-delta": {
        const text = event.data.text as string;
        if (text) {
          chunks.push({
            id,
            object: "chat.completion.chunk",
            created,
            model: this.model,
            choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
          });
        }
        break;
      }

      case "tool-call-delta": {
        const tc: {
          index: number;
          id?: string;
          type?: string;
          function: { name?: string; arguments: string };
        } = {
          index: (event.data.index as number) ?? 0,
          function: { arguments: (event.data.arguments as string) ?? "" },
        };
        if (event.data.toolCallId) {
          tc.id = event.data.toolCallId as string;
          tc.type = "function";
        }
        if (event.data.name) {
          tc.function.name = event.data.name as string;
        }
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
        });
        break;
      }

      case "tool-call": {
        const toolCallId = (event.data.toolCallId as string) ?? "";
        const toolName = (event.data.toolName as string) ?? (event.data.name as string) ?? "";
        const input = event.data.input ?? event.data.arguments;
        const args = typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: this.toolCallIndex++,
                    id: toolCallId,
                    type: "function",
                    function: { name: toolName, arguments: args },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        break;
      }

      case "finish": {
        const usage = extractUsage(event.data as Record<string, unknown>);
        const finishReason = (event.data.finishReason as string) ?? "stop";
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            { index: 0, delta: {}, finish_reason: OPENAI_FINISH_MAP[finishReason] ?? "stop" },
          ],
        });
        if (usage) {
          chunks.push({
            id,
            object: "chat.completion.chunk",
            created,
            model: this.model,
            choices: [],
            usage: toOpenAIUsage(usage),
          });
        }
        break;
      }

      case "error": {
        const errMsg =
          (event.data.message as string) ??
          (event.data.error as { message?: string } | undefined)?.message ??
          JSON.stringify(event.data);
        logger.error(`[CC upstream error] ${errMsg}`);
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            { index: 0, delta: { content: `[upstream error] ${errMsg}` }, finish_reason: null },
          ],
        });
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        break;
      }
    }

    return chunks;
  }

  errorChunk(err: Error): object {
    return {
      error: {
        message: err.message,
        type: "upstream_error",
      },
    };
  }
}

// ──────────────────────────────────────────
// CC events → OpenAI non-streaming response
// ──────────────────────────────────────────

interface FinishEvent {
  finishReason?: string;
  usage?: UsageData;
}

export function buildNonStreamingResponse(events: CCEvent[], model: string, id: string): object {
  let content = "";
  let reasoningContent = "";
  const toolCalls: ToolCall[] = [];
  let finish: FinishEvent | null = null;

  for (const event of events) {
    switch (event.type) {
      case "text-delta":
        content += (event.data.text as string) ?? "";
        break;
      case "reasoning-delta":
        reasoningContent += (event.data.text as string) ?? "";
        break;
      case "tool-call-delta": {
        const existing = toolCalls.find((tc) => tc.id === (event.data.toolCallId as string));
        if (existing) {
          existing.function.arguments += (event.data.arguments as string) ?? "";
        } else {
          toolCalls.push({
            id: (event.data.toolCallId as string) ?? "",
            type: "function",
            function: {
              name: (event.data.name as string) ?? "",
              arguments: (event.data.arguments as string) ?? "",
            },
          });
        }
        break;
      }
      case "tool-call": {
        const input = event.data.input ?? event.data.arguments;
        toolCalls.push({
          id: (event.data.toolCallId as string) ?? "",
          type: "function",
          function: {
            name: (event.data.toolName as string) ?? (event.data.name as string) ?? "",
            arguments:
              typeof input === "string" ? input : input != null ? JSON.stringify(input) : "",
          },
        });
        break;
      }
      case "finish":
        finish = {
          finishReason: event.data.finishReason as string,
          usage: extractUsage(event.data),
        };
        break;
    }
  }

  const message: Record<string, unknown> = { role: "assistant" };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls.slice();
  if (content) {
    message.content = content;
  } else if (toolCalls.length === 0) {
    message.content = "";
  }

  const finishReason = finish?.finishReason ?? "stop";

  const response: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: OPENAI_FINISH_MAP[finishReason] ?? "stop",
      },
    ],
  };

  if (finish?.usage) response.usage = toOpenAIUsage(finish.usage);

  return response;
}
