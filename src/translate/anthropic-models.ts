import { resolveModel, getDefaultModels } from "@/translate/models.js";

export function resolveAnthropicModel(requestedModel: string): string {
  if (!requestedModel.startsWith("claude-")) {
    return resolveModel(requestedModel);
  }

  const envDefault = process.env.ANTHROPIC_DEFAULT_MODEL;
  if (envDefault) return resolveModel(envDefault);

  return resolveModel(getDefaultModels()[0]);
}
