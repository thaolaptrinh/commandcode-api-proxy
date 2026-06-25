import crypto from "node:crypto";
import type { CCMessage, CCRequestBody, UsageData } from "@/translate/types.js";

// ──────────────────────────────────────────
// Message ID
// ──────────────────────────────────────────

// One id per downstream request, shared by the OpenAI and Anthropic encoders.
let _messageId = crypto.randomUUID();

export function getMessageId(): string {
  return _messageId;
}

export function resetMessageId(): void {
  _messageId = crypto.randomUUID();
}

// ──────────────────────────────────────────
// Usage extraction
// ──────────────────────────────────────────

export function extractUsage(data: Record<string, unknown>): UsageData | undefined {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens as number | undefined,
    completionTokens: usage.completionTokens as number | undefined,
    totalTokens: usage.totalTokens as number | undefined,
    promptTokensDetails: usage.promptTokensDetails as { cachedTokens?: number } | undefined,
  };
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
