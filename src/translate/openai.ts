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

// ──────────────────────────────────────────
// OpenAI request → CC request
// ──────────────────────────────────────────

function toCCMessages(messages: OpenAIMessage[]): {
  ccMessages: CCMessage[];
  systemPrompt: string | undefined;
} {
  const systemParts: string[] = [];
  const ccMessages: CCMessage[] = [];

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
      ccMessages.push({
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id ?? "",
            result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
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
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
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
  const hasTools = req.tools && req.tools.length > 0;

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

  const noToolsInstruction =
    "CRITICAL: You are running in a chat-only environment. Tool execution is disabled. Do not generate or call any tools (e.g. Build, ReadFile, grep, Search, etc.). Respond only with plain text.";
  const finalSystemPrompt = hasTools
    ? systemPrompt
    : systemPrompt
      ? `${systemPrompt}\n\n${noToolsInstruction}`
      : noToolsInstruction;

  if (finalSystemPrompt) {
    body.params.system = finalSystemPrompt;
  }

  return body;
}

// ──────────────────────────────────────────
// CC events → OpenAI streaming chunks
// ──────────────────────────────────────────

export function toOpenAIStreamChunk(event: CCEvent): object[] {
  const chunks: object[] = [];
  const id = getMessageId();
  const created = Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "start": {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: (event.data.model as string) ?? "unknown",
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
          model: "unknown",
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
          model: "unknown",
          choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
        });
      }
      break;
    }

    case "tool-call-delta": {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: "unknown",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: (event.data.index as number) ?? 0,
                  id: event.data.toolCallId as string,
                  function: {
                    name: event.data.name as string,
                    arguments: event.data.arguments as string,
                  },
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
        tool_call: "tool_calls",
        error: "stop",
      };
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: finishMap[finishReason] ?? "stop" }],
        ...(usage ? { usage } : {}),
      });
      break;
    }

    case "error":
      // Handled at the stream level, not emitted as a chunk.
      break;
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
      case "tool-call":
        toolCalls.push({
          id: (event.data.toolCallId as string) ?? "",
          type: "function",
          function: {
            name: (event.data.name as string) ?? "",
            arguments: (event.data.arguments as string) ?? "",
          },
        });
        break;
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

  if (finish?.usage) response.usage = finish.usage;

  return response;
}
