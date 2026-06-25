// Shared types for the OpenAI ↔ Command Code translation layer.

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
  role: "user" | "assistant" | "tool";
  content: string | CCContentPart[];
}

export interface CCContentPart {
  type: "text" | "image" | "tool-call" | "tool-result";
  text?: string;
  image?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  arguments?: string;
  args?: unknown;
  input?: unknown;
  result?: string;
  output?: unknown;
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
// Shared output types
// ──────────────────────────────────────────

export interface UsageData {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
}
