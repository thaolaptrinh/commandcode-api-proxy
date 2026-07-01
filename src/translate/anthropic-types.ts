// Anthropic request/response/event types for the Messages API.
// Verified against @anthropic-ai/sdk TypeScript types.

// ── Request ──

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | TextBlockParam[];
  stream?: boolean;
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: "enabled"; budget_tokens: number };
  service_tier?: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export type AnthropicTool =
  | { name: string; description?: string; input_schema: Record<string, unknown> }
  | { type: string; name: string; description?: string; input_schema: Record<string, unknown> };

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

// ── Content blocks (input) ──

export type AnthropicContentBlock =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | DocumentBlockParam
  | SearchResultBlockParam
  | ServerToolParam;

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ImageBlockParam {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

export interface ToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlockParam | ImageBlockParam>;
  is_error?: boolean;
}

export interface ThinkingBlockParam {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlockParam {
  type: "redacted_thinking";
  data: string;
}

export interface DocumentBlockParam {
  type: "document";
  source: Record<string, unknown>;
}

export interface SearchResultBlockParam {
  type: "search_result";
}

export interface ServerToolParam {
  type:
    | "web_search_tool_result"
    | "web_fetch_tool_result"
    | "code_execution_tool_result"
    | "mcp_tool_result"
    | "container_upload"
    | "server_tool_use"
    | "mid_conversation_system";
}

// ── Response ──

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: OutputContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export type OutputContentBlock = OutputTextBlock | OutputThinkingBlock | OutputToolUseBlock;

export interface OutputTextBlock {
  type: "text";
  text: string;
}

export interface OutputThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface OutputToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  service_tier?: string;
}

// ── Streaming events ──

export type AnthropicSSEEventType =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "ping"
  | "error"
  | "signature_delta";

export interface AnthropicSSERecord {
  event: AnthropicSSEEventType;
  data: Record<string, unknown>;
}

// ── Delta shapes ──

export interface TextDelta {
  type: "text_delta";
  text: string;
}
export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}
export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}
export interface SignatureDelta {
  type: "signature_delta";
  signature: string;
}

export type DeltaShape = TextDelta | ThinkingDelta | InputJsonDelta | SignatureDelta;

// ── Content block start shapes ──

export interface TextBlockStart {
  type: "text";
  text: string;
}
export interface ThinkingBlockStart {
  type: "thinking";
  thinking: string;
}
export interface ToolUseBlockStart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlockStartShape = TextBlockStart | ThinkingBlockStart | ToolUseBlockStart;
