import type { CCMessage, CCRequestBody, UsageData } from "@/translate/types.js";

// ──────────────────────────────────────────
// Usage extraction
// ──────────────────────────────────────────

export function extractUsage(data: Record<string, unknown>): UsageData | undefined {
  // The CC upstream reports usage under `totalUsage` with AI SDK camelCase fields
  // (inputTokens/outputTokens/...). Some upstreams may use `usage` with snake_case.
  // Support both shapes.
  const u = (data.totalUsage ?? data.usage) as Record<string, unknown> | undefined;
  if (!u) return undefined;

  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  const promptTokens = num(u.promptTokens ?? u.inputTokens ?? u.prompt_tokens);
  const completionTokens = num(u.completionTokens ?? u.outputTokens ?? u.completion_tokens);
  const totalTokens =
    num(u.totalTokens ?? u.total_tokens) ??
    (promptTokens != null && completionTokens != null
      ? promptTokens + completionTokens
      : undefined);
  const cached =
    num(u.cachedInputTokens) ??
    num((u.inputTokenDetails as { cacheReadTokens?: unknown } | undefined)?.cacheReadTokens) ??
    num((u.promptTokensDetails as { cachedTokens?: unknown } | undefined)?.cachedTokens) ??
    num((u.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens);
  const reasoning =
    num(u.reasoningTokens) ??
    num((u.outputTokenDetails as { reasoningTokens?: unknown } | undefined)?.reasoningTokens) ??
    num(
      (u.completion_tokens_details as { reasoning_tokens?: unknown } | undefined)?.reasoning_tokens,
    );

  const result: UsageData = {};
  if (promptTokens != null) result.promptTokens = promptTokens;
  if (completionTokens != null) result.completionTokens = completionTokens;
  if (totalTokens != null) result.totalTokens = totalTokens;
  if (cached != null) result.promptTokensDetails = { cachedTokens: cached };
  if (reasoning != null) result.completionTokensDetails = { reasoningTokens: reasoning };

  return Object.keys(result).length > 0 ? result : undefined;
}

// ──────────────────────────────────────────
// Shared CC request config
// ──────────────────────────────────────────

export function buildCCConfig(
  overrides?: Partial<CCRequestBody["config"]>,
): CCRequestBody["config"] {
  return {
    workingDir: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    environment: `linux-x64, Node.js ${process.version}`,
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
    ...overrides,
  };
}

// ──────────────────────────────────────────
// No-tools safeguard
// ──────────────────────────────────────────

export function applyNoToolsSafeguard(
  body: CCRequestBody,
  ccMessages: CCMessage[],
  hasTools: boolean,
): void {
  if (hasTools) return;

  const noToolsInstruction =
    "CRITICAL: You are running in a chat-only environment. Tool execution is disabled. Do not generate or call any tools (e.g. Build, ReadFile, grep, Search, etc.). Respond only with plain text.";

  const existingSystem = body.params.system;
  body.params.system = existingSystem
    ? `${existingSystem}\n\n${noToolsInstruction}`
    : noToolsInstruction;

  if (ccMessages.length === 0) return;
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

// ──────────────────────────────────────────
// Tool-call / tool-result pairing
// ──────────────────────────────────────────

/**
 * CC rejects requests that contain a tool-call with no matching tool-result,
 * or a tool-result with no matching tool-call. Drop any unpaired parts so the
 * conversation always satisfies CC's pairing requirement.
 */
export function pruneDanglingTools(messages: CCMessage[]): CCMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.toolCallId) callIds.add(part.toolCallId);
      if (part.type === "tool-result" && part.toolCallId) resultIds.add(part.toolCallId);
    }
  }
  const validIds = new Set([...callIds].filter((id) => resultIds.has(id)));
  if (validIds.size === callIds.size && validIds.size === resultIds.size) {
    return messages;
  }

  const result: CCMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }
    const filtered = msg.content.filter(
      (part) =>
        (part.type !== "tool-call" && part.type !== "tool-result") ||
        (part.toolCallId != null && validIds.has(part.toolCallId)),
    );
    if (filtered.length > 0) {
      result.push({ role: msg.role, content: filtered });
    }
  }
  return result;
}
