import { resolveModel, getDefaultModels } from "@/translate/models.js";

/**
 * Normalize a Claude model ID into an env-var key.
 * "claude-sonnet-4-5-20250929" → "CLAUDE_SONNET_4_5"
 */
function normalizeEnvKey(claudeId: string): string {
  const stripped = claudeId.replace(/-20\d{6,}$/, "");
  return stripped.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Resolve a model ID from an Anthropic client into a CC model ID.
 * For claude-* IDs, looks up env vars; for other IDs, passes through.
 */
export function resolveAnthropicModel(requestedModel: string): string {
  if (!isClaudeModel(requestedModel)) {
    return resolveModel(requestedModel);
  }

  const key = normalizeEnvKey(requestedModel);
  const envResult = process.env[`ANTHROPIC_MODEL_${key}`];
  if (envResult) return resolveModel(envResult);

  const defaultModel = process.env["ANTHROPIC_DEFAULT_MODEL"];
  if (defaultModel) return resolveModel(defaultModel);

  return resolveModel(getDefaultModels()[0]);
}

function isClaudeModel(id: string): boolean {
  return id.startsWith("claude-");
}
