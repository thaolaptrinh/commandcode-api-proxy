import type { OpenAIChatRequest } from "./types.js";

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
