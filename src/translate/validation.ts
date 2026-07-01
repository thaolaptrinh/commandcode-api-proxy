import type { OpenAIChatRequest } from "./types.js";
import type { AnthropicRequest } from "./anthropic-types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateOpenAIChatRequest(body: unknown): OpenAIChatRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }

  const req = body as Record<string, unknown>;

  if (req.model !== undefined && typeof req.model !== "string") {
    throw new ValidationError("Field 'model' must be a string");
  }

  if (!Array.isArray(req.messages)) {
    throw new ValidationError("Field 'messages' must be an array");
  }

  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (!msg || typeof msg !== "object") {
      throw new ValidationError(`messages[${i}] must be an object`);
    }
    const m = msg as Record<string, unknown>;
    const validRoles = ["system", "developer", "user", "assistant", "tool"];
    if (typeof m.role !== "string" || !validRoles.includes(m.role)) {
      throw new ValidationError(`messages[${i}].role must be one of: ${validRoles.join(", ")}`);
    }
    if (m.content === undefined && m.tool_calls === undefined) {
      throw new ValidationError(`messages[${i}] must contain either 'content' or 'tool_calls'`);
    }
  }

  return body as OpenAIChatRequest;
}

// ── Anthropic validation ──

const UNSUPPORTED_CONTENT_TYPES = new Set([
  "document",
  "search_result",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "mcp_tool_result",
  "container_upload",
  "server_tool_use",
  "mid_conversation_system",
]);

const BUILT_IN_TOOL_TYPES = new Set([
  "computer_20241022",
  "bash_20241022",
  "text_editor_20241022",
  "web_search_20250305",
]);

export function validateAnthropicRequest(body: unknown): AnthropicRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }

  const req = body as Record<string, unknown>;

  if (typeof req.model !== "string") {
    throw new ValidationError("Field 'model' must be a string");
  }

  if (typeof req.max_tokens !== "number") {
    throw new ValidationError("Field 'max_tokens' must be a number");
  }

  if (!Array.isArray(req.messages)) {
    throw new ValidationError("Field 'messages' must be an array");
  }

  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i] as Record<string, unknown>;
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") {
      throw new ValidationError(`messages[${i}].role must be "user" or "assistant"`);
    }
    if (msg.content === undefined) {
      throw new ValidationError(`messages[${i}] must contain 'content'`);
    }
    validateContentBlocks(msg.content, i);
  }

  if (Array.isArray(req.tools)) {
    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i] as Record<string, unknown>;
      const type = tool.type as string | undefined;
      if (type && BUILT_IN_TOOL_TYPES.has(type)) {
        throw new ValidationError(
          `tools[${i}]: built-in tool type "${type}" is not supported. Only custom tools ({name, description, input_schema}) are allowed.`,
        );
      }
    }
  }

  if (req.thinking && typeof req.thinking === "object") {
    const t = req.thinking as Record<string, unknown>;
    if (typeof t.budget_tokens === "number" && t.budget_tokens >= (req.max_tokens as number)) {
      throw new ValidationError("thinking.budget_tokens must be less than max_tokens");
    }
  }

  return body as AnthropicRequest;
}

function validateContentBlocks(content: unknown, msgIdx: number): void {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) {
    throw new ValidationError(`messages[${msgIdx}].content must be a string or array of blocks`);
  }
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as Record<string, unknown>;
    if (typeof block.type !== "string") continue;
    if (UNSUPPORTED_CONTENT_TYPES.has(block.type)) {
      throw new ValidationError(
        `messages[${msgIdx}].content[${i}]: block type "${block.type}" is not supported`,
      );
    }
  }
}
