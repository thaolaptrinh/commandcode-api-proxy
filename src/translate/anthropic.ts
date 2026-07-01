import crypto from "node:crypto";
import type {
  AnthropicRequest,
  AnthropicContentBlock,
  ImageBlockParam,
  ToolResultBlockParam,
  OutputContentBlock,
  OutputToolUseBlock,
  AnthropicSSERecord,
  AnthropicStopReason,
  AnthropicResponse,
  ContentBlockStartShape,
  DeltaShape,
} from "@/translate/anthropic-types.js";
import type { CCMessage, CCContentPart, CCRequestBody, CCEvent } from "@/translate/types.js";
import { resolveAnthropicModel } from "@/translate/anthropic-models.js";
import {
  extractUsage,
  pruneDanglingTools,
  buildCCConfig,
  applyNoToolsSafeguard,
} from "@/translate/util.js";
import { logger } from "@/logger.js";

// ── Constants ──

const REASONING_THRESHOLDS = { LOW: 2000, MEDIUM: 8000 } as const;
const ANTHROPIC_STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  "tool-call": "tool_use",
  "tool-calls": "tool_use",
  tool_call: "tool_use",
  content_filtered: "stop_sequence",
  pause_turn: "pause_turn",
  refusal: "refusal",
  model_context_window_exceeded: "model_context_window_exceeded",
};
const INITIAL_OUTPUT_TOKENS = 1;

// ── Request translator ──

function toCCMessages(messages: AnthropicRequest["messages"]): {
  ccMessages: CCMessage[];
  systemPrompt: string | undefined;
} {
  const toolUseIdToName = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as AnthropicContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseIdToName.set(block.id, block.name);
      }
    }
  }

  const ccMessages: CCMessage[] = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    const content = msg.content;

    if (msg.role === "system") {
      if (typeof content === "string") {
        systemParts.push(content);
      }
      continue;
    }

    if (msg.role === "user") {
      if (typeof content === "string") {
        ccMessages.push({ role: "user", content });
      } else {
        const parts = (content as AnthropicContentBlock[]).map(toCCPartFn(toolUseIdToName));
        ccMessages.push({ role: "user", content: parts });
      }
      continue;
    }

    // assistant
    if (typeof content === "string") {
      ccMessages.push({ role: "assistant", content });
    } else if (Array.isArray(content)) {
      const parts: CCContentPart[] = [];
      for (const block of content as AnthropicContentBlock[]) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          });
        }
        // thinking, redacted_thinking: dropped from history
      }
      if (parts.length > 0) {
        ccMessages.push({ role: "assistant", content: parts });
      }
    }
  }

  return {
    ccMessages: pruneDanglingTools(ccMessages),
    systemPrompt:
      systemParts.length > 0
        ? systemParts.join("\n\n")
        : undefined,
  };
}

function toCCPartFn(
  toolUseIdToName: Map<string, string>,
): (block: AnthropicContentBlock) => CCContentPart {
  return (block: AnthropicContentBlock): CCContentPart => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const src = (block as ImageBlockParam).source;
      if (src.type === "base64") {
        return { type: "image", image: `data:${src.media_type};base64,${src.data}` };
      }
      return { type: "image", image: src.url };
    }
    if (block.type === "tool_result") {
      const trb = block as ToolResultBlockParam;
      const name = toolUseIdToName.get(trb.tool_use_id) ?? "";
      const resultText =
        typeof trb.content === "string"
          ? trb.content
          : (trb.content as Array<{ type: string; text?: string }>)
              .map((p) => p.text ?? "")
              .join("");
      return {
        type: "tool-result",
        toolCallId: trb.tool_use_id,
        toolName: name,
        output: { type: "text", value: resultText },
        isError: trb.is_error,
      };
    }
    return { type: "text", text: "" };
  };
}

function resolveReasoningEffort(thinking: AnthropicRequest["thinking"]): string | undefined {
  if (!thinking) return undefined;
  if (thinking.budget_tokens <= REASONING_THRESHOLDS.LOW) return "low";
  if (thinking.budget_tokens <= REASONING_THRESHOLDS.MEDIUM) return "medium";
  return "high";
}

function resolveToolChoice(anthropic: AnthropicRequest): string | undefined {
  const tc = anthropic.tool_choice;
  if (!tc) return undefined;
  if (tc.type === "auto") return undefined;
  if (tc.type === "any") return "required";
  if (tc.type === "tool") return tc.name;
  if (tc.type === "none") return "none";
  return undefined;
}

export function toCCRequest(
  req: AnthropicRequest,
  configOverrides?: Partial<CCRequestBody["config"]>,
): CCRequestBody {
  const { ccMessages, systemPrompt } = toCCMessages(req.messages);

  let systemText: string | undefined;
  if (typeof req.system === "string") {
    systemText = req.system;
  } else if (Array.isArray(req.system)) {
    systemText = req.system
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }

  const resolvedModel = resolveAnthropicModel(req.model);

  const ccTools = req.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const finalSystem = systemText
    ? systemPrompt != null
      ? `${systemPrompt}\n\n${systemText}`
      : systemText
    : systemPrompt;

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
      stop: req.stop_sequences,
      tools: ccTools,
      tool_choice: resolveToolChoice(req),
      reasoning_effort: resolveReasoningEffort(req.thinking),
    },
    threadId: crypto.randomUUID(),
  };

  if (finalSystem) {
    body.params.system = finalSystem;
  }

  const hasTools = req.tools != null && req.tools.length > 0;
  applyNoToolsSafeguard(body, ccMessages, hasTools);

  return body;
}

// ── Streaming encoder ──

export class AnthropicStreamEncoder {
  readonly messageId: string;
  private blockIndex = 0;
  private currentBlockType: "text" | "thinking" | "tool_use" | null = null;
  private pendingStart: CCEvent | null = null;
  private started = false;
  private pinged = false;

  constructor(private readonly model: string) {
    this.messageId = `msg_${crypto.randomUUID()}`;
  }

  emit(event: CCEvent): AnthropicSSERecord[] {
    if (event.type === "start") {
      this.blockIndex = 0;
      this.currentBlockType = null;
      this.pendingStart = event;
      return [];
    }

    if (event.type === "error") {
      const msg =
        (event.data.message as string) ??
        (event.data.error as { message?: string } | undefined)?.message ??
        JSON.stringify(event.data);
      logger.error(`[CC upstream error] ${msg}`);

      const records: AnthropicSSERecord[] = [];
      if (!this.started) {
        records.push(this.makeMessageStart(0));
      }
      this.closeCurrentBlock(records);
      records.push({
        event: "error",
        data: { type: "error", error: { type: "api_error", message: msg } },
      });
      records.push({ event: "message_stop", data: {} });
      return records;
    }

    if (event.type === "finish") {
      return this.handleFinish(event);
    }

    // Content event
    if (!this.started) {
      const records: AnthropicSSERecord[] = [];
      const startInputTokens = this.pendingStart
        ? (
            this.pendingStart.data.totalUsage as Record<string, unknown> as
              | {
                  inputTokens?: number;
                }
              | undefined
          )?.inputTokens
        : undefined;

      records.push(this.makeMessageStart(startInputTokens ?? 0));
      this.started = true;
      return [...records, ...this.handleContent(event)];
    }

    return this.handleContent(event);
  }

  private handleFinish(event: CCEvent): AnthropicSSERecord[] {
    const records: AnthropicSSERecord[] = [];

    this.closeCurrentBlock(records);

    const finishReason = (event.data.finishReason as string) ?? "stop";
    const usage = extractUsage(event.data as Record<string, unknown>);

    records.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: ANTHROPIC_STOP_REASON_MAP[finishReason] ?? "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage?.completionTokens ?? 0,
        },
      },
    });

    records.push({ event: "message_stop", data: {} });
    return records;
  }

  private handleContent(event: CCEvent): AnthropicSSERecord[] {
    const records: AnthropicSSERecord[] = [];

    switch (event.type) {
      case "text-delta":
        this.ensureBlockOpen(records, "text", () => ({ type: "text", text: "" }));
        records.push(
          this.makeDelta({ type: "text_delta", text: (event.data.text as string) ?? "" }),
        );
        break;

      case "reasoning-delta":
        this.ensureBlockOpen(records, "thinking", () => ({
          type: "thinking",
          thinking: "",
        }));
        records.push(
          this.makeDelta({ type: "thinking_delta", thinking: (event.data.text as string) ?? "" }),
        );
        break;

      case "tool-call-delta": {
        const tcId = (event.data.toolCallId as string) ?? "";
        const tcName = (event.data.name as string) ?? "";
        if (this.currentBlockType !== "tool_use") {
          this.closeCurrentBlock(records);
          this.ensureBlockOpenWith(records, "tool_use", {
            type: "tool_use",
            id: tcId,
            name: tcName,
            input: {},
          });
        }
        records.push(
          this.makeDelta({
            type: "input_json_delta",
            partial_json: (event.data.arguments as string) ?? "",
          }),
        );
        break;
      }

      case "tool-call": {
        const tcId = (event.data.toolCallId as string) ?? "";
        const tcName = (event.data.toolName as string) ?? (event.data.name as string) ?? "";
        const input = event.data.input ?? event.data.arguments;
        const argsStr =
          typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
        this.closeCurrentBlock(records);
        this.ensureBlockOpenWith(records, "tool_use", {
          type: "tool_use",
          id: tcId,
          name: tcName,
          input: {},
        });
        if (argsStr) {
          records.push(this.makeDelta({ type: "input_json_delta", partial_json: argsStr }));
        }
        this.closeCurrentBlock(records);
        break;
      }
    }

    return records;
  }

  private ensureBlockOpen(
    records: AnthropicSSERecord[],
    type: "text" | "thinking" | "tool_use",
    blockFactory: () => ContentBlockStartShape,
  ): void {
    if (this.currentBlockType === type) return;
    this.closeCurrentBlock(records);

    this.ensureBlockOpenWith(records, type, blockFactory());
  }

  private ensureBlockOpenWith(
    records: AnthropicSSERecord[],
    type: "text" | "thinking" | "tool_use",
    block: ContentBlockStartShape,
  ): void {
    this.currentBlockType = type;
    records.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: block,
      },
    });

    if (!this.pinged) {
      this.pinged = true;
      records.push({ event: "ping", data: { type: "ping" } });
    }
  }

  private closeCurrentBlock(records: AnthropicSSERecord[]): void {
    if (this.currentBlockType === null) return;

    if (this.currentBlockType === "thinking") {
      records.push({
        event: "signature_delta",
        data: { type: "signature_delta", signature: "_cc_proxy_placeholder" },
      } as AnthropicSSERecord);
    }

    records.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: this.blockIndex },
    });

    this.blockIndex++;
    this.currentBlockType = null;
  }

  private makeDelta(delta: DeltaShape): AnthropicSSERecord {
    return {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: this.blockIndex, delta },
    };
  }

  private makeMessageStart(inputTokens: number): AnthropicSSERecord {
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: INITIAL_OUTPUT_TOKENS,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            service_tier: "standard",
          },
        },
      },
    };
  }
}

// ── Non-streaming response builder ──

export function buildAnthropicResponse(
  events: CCEvent[],
  model: string,
  messageId: string,
): AnthropicResponse {
  let textContent = "";
  let thinkingContent = "";
  const toolUseBlocks: OutputToolUseBlock[] = [];

  for (const event of events) {
    switch (event.type) {
      case "text-delta":
        textContent += (event.data.text as string) ?? "";
        break;
      case "reasoning-delta":
        thinkingContent += (event.data.text as string) ?? "";
        break;
      case "tool-call": {
        const input = event.data.input ?? event.data.arguments;
        toolUseBlocks.push({
          type: "tool_use",
          id: (event.data.toolCallId as string) ?? "",
          name: (event.data.toolName as string) ?? (event.data.name as string) ?? "",
          input:
            typeof input === "object" && input != null ? (input as Record<string, unknown>) : {},
        });
        break;
      }
      case "finish":
        break;
    }
  }

  const content: OutputContentBlock[] = [];
  if (thinkingContent) {
    content.push({
      type: "thinking",
      thinking: thinkingContent,
      signature: "_cc_proxy_placeholder",
    });
  }
  content.push(...toolUseBlocks);
  if (textContent || content.length === 0) {
    content.unshift({ type: "text", text: textContent });
  }

  const finishEvent = events.find((e) => e.type === "finish");
  const finishReason = (finishEvent?.data.finishReason as string) ?? "stop";
  const usage = finishEvent ? extractUsage(finishEvent.data as Record<string, unknown>) : undefined;

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: ANTHROPIC_STOP_REASON_MAP[finishReason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.promptTokens ?? 0,
      output_tokens: usage?.completionTokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
