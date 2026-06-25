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
import { getMessageId, extractUsage, pruneDanglingTools, buildCCConfig } from "@/translate/util.js";
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

  const hasTools = req.tools && req.tools.length > 0;
  const noToolsInstruction =
    "CRITICAL: You are running in a chat-only environment. Tool execution is disabled. Do not generate or call any tools (e.g. Build, ReadFile, grep, Search, etc.). Respond only with plain text.";
  const withToolsInstruction = "";

  const finalSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${hasTools ? withToolsInstruction : noToolsInstruction}`
    : hasTools
      ? withToolsInstruction
      : noToolsInstruction;

  if (finalSystemPrompt) {
    body.params.system = finalSystemPrompt;
  }

  // Also append directly to the last user message as a fallback to bypass upstream overrides
  if (ccMessages.length > 0 && !hasTools) {
    for (let i = ccMessages.length - 1; i >= 0; i--) {
      if (ccMessages[i].role === "user") {
        const msg = ccMessages[i];
        const suffix =
          "\n\n[System Note: Tool execution is disabled in this environment. Do not output any tool calls (such as Build, Search, ReadFile, grep, etc.). You must answer directly in plain text.]";
        if (typeof msg.content === "string") {
          msg.content += suffix;
        } else if (Array.isArray(msg.content)) {
          const lastTextPart = [...msg.content].reverse().find((p) => p.type === "text");
          if (lastTextPart) {
            lastTextPart.text = (lastTextPart.text ?? "") + suffix;
          } else {
            msg.content.push({ type: "text", text: suffix });
          }
        }
        break;
      }
    }
  }

  return body;
}

// ──────────────────────────────────────────
// CC events → OpenAI streaming chunks
// ──────────────────────────────────────────

/**
 * Convert internal UsageData into the OpenAI `usage` object format
 * (prompt_tokens / completion_tokens / total_tokens + detail sub-objects).
 */
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

// Index counter for tool calls within a single streaming response.
let toolCallIndex = 0;

/**
 * Translate a single CC event into OpenAI streaming chunks.
 *
 * `model` is the model id requested by the downstream client (echoed back in
 * every chunk per the OpenAI spec). `responseModel` is the model reported by
 * the upstream `start` event, if any — used only to enrich the first chunk.
 */
export function toOpenAIStreamChunk(event: CCEvent, model = "unknown"): object[] {
  const chunks: object[] = [];
  const id = getMessageId();
  const created = Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "start": {
      toolCallIndex = 0;
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
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
          model,
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
          model,
          choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
        });
      }
      break;
    }

    case "tool-call-delta": {
      const tc: Record<string, any> = {
        index: (event.data.index as number) ?? 0,
        function: { arguments: (event.data.arguments as string) ?? "" },
      };
      if (event.data.toolCallId) {
        tc.id = event.data.toolCallId;
        tc.type = "function";
      }
      if (event.data.name) {
        tc.function.name = event.data.name;
      }

      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [tc],
            },
            finish_reason: null,
          },
        ],
      });
      break;
    }

    case "tool-call": {
      // CC complete tool-call event: { toolCallId, toolName, input (object) }
      // Translate to OpenAI tool_calls delta (arguments must be a JSON string).
      const toolCallId = (event.data.toolCallId as string) ?? "";
      const toolName = (event.data.toolName as string) ?? (event.data.name as string) ?? "";
      const input = event.data.input ?? event.data.arguments;
      const args = typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex++,
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
      const usage = extractUsage(event.data);
      const finishReason = (event.data.finishReason as string) ?? "stop";
      const finishMap: Record<string, string> = {
        stop: "stop",
        length: "length",
        content_filtered: "content_filter",
        "tool-call": "tool_calls",
        "tool-calls": "tool_calls",
        tool_call: "tool_calls",
        error: "stop",
      };
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishMap[finishReason] ?? "stop" }],
      });
      // OpenAI streams usage as a separate trailing chunk with an empty
      // `choices` array. We emit it whenever the upstream reports usage so
      // clients that rely on it (context-window %, billing, etc.) receive it.
      if (usage) {
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: toOpenAIUsage(usage),
        });
      }
      break;
    }

    case "error": {
      // Surface upstream errors instead of silently dropping them, so the
      // downstream client sees what went wrong (an empty stream is harder to
      // debug). Emit the message as content, then a stop finish.
      const errMsg =
        (event.data.message as string) ??
        (event.data.error as { message?: string } | undefined)?.message ??
        JSON.stringify(event.data);
      logger.error(`[CC upstream error] ${errMsg}`);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          { index: 0, delta: { content: `[upstream error] ${errMsg}` }, finish_reason: null },
        ],
      });
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      break;
    }
  }

  return chunks;
}

export function toOpenAIErrorChunk(error: Error): object {
  return {
    error: {
      message: error.message,
      type: "upstream_error",
    },
  };
}

// ──────────────────────────────────────────
// CC events → OpenAI non-streaming response
// ──────────────────────────────────────────

interface FinishEvent {
  finishReason?: string;
  usage?: UsageData;
}

const OPENAI_FINISH_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  content_filtered: "content_filter",
  "tool-call": "tool_calls",
  "tool-calls": "tool_calls",
  tool_call: "tool_calls",
  error: "stop",
};

export function buildNonStreamingResponse(events: CCEvent[], model: string): object {
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
    id: getMessageId(),
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
