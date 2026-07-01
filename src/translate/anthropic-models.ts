import { resolveModel, getDefaultModels } from "@/translate/models.js";
import { logger } from "@/logger.js";

export interface AnthropicModelConfig {
  default?: string;
  mappings?: Record<string, string>;
}

let cachedConfig: AnthropicModelConfig | null = null;

export function initAnthropicModelConfig(config: AnthropicModelConfig | null): void {
  cachedConfig = config;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\\\*/g, ".*") + "$");
}

export function resolveAnthropicModel(requestedModel: string): string {
  if (!requestedModel.startsWith("claude-")) {
    return resolveModel(requestedModel);
  }

  if (cachedConfig?.mappings) {
    for (const [pattern, ccModel] of Object.entries(cachedConfig.mappings)) {
      if (!ccModel) continue;
      try {
        if (globToRegex(pattern).test(requestedModel)) {
          return resolveModel(ccModel);
        }
      } catch {
        logger.debug(`Invalid glob pattern in config: "${pattern}"`);
      }
    }
  }

  const envDefault = process.env.ANTHROPIC_DEFAULT_MODEL;
  if (envDefault) return resolveModel(envDefault);

  if (cachedConfig?.default) return resolveModel(cachedConfig.default);

  return resolveModel(getDefaultModels()[0]);
}
