// Shared types for the OpenAI / Anthropic ↔ Command Code translation layer.

// ──────────────────────────────────────────
// OpenAI request types
// ──────────────────────────────────────────

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: ToolChoice;
  reasoning_effort?: "low" | "medium" | "high";
}

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ──────────────────────────────────────────
// Command Code request / event types
// ──────────────────────────────────────────

export interface CCMessage {
  role: "user" | "assistant";
  content: string | CCContentPart[];
}

export interface CCContentPart {
  type: "text" | "image" | "tool-call" | "tool-result";
  text?: string;
  image?: string;
  toolCallId?: string;
  name?: string;
  arguments?: string;
  result?: string;
  isError?: boolean;
}

export interface CCTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface CCRequestBody {
  config: Record<string, unknown>;
  memory: string;
  taste: string;
  skills: string;
  permissionMode: string;
  params: {
    model: string;
    messages: CCMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    stream: boolean;
    reasoning_effort?: string;
    tools?: CCTool[];
    tool_choice?: string;
  };
  threadId: string;
}

export type CCEventType =
  | "start"
  | "text-delta"
  | "reasoning-delta"
  | "tool-call-delta"
  | "tool-call"
  | "tool-result"
  | "finish"
  | "error";

export interface CCEvent {
  type: CCEventType;
  data: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Anthropic request types
// ──────────────────────────────────────────

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  thinking?: { budget_tokens: number };
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  source?: { type: "base64"; media_type: string; data: string };
  tool_use_id?: string;
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Shared output types
// ──────────────────────────────────────────

export interface AnthropicSSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface UsageData {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptTokensDetails?: { cachedTokens?: number };
}
