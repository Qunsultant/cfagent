import { createWorkersAI } from "workers-ai-provider";
import { getGatewayOptions } from "../gateway/gatewayConfig";
import type { Env } from "../types";
import { resolveEnvironmentConfig } from "../config/environment";
import { getAiConfig, getAvailableAiModels, type AiModelDefinition, type AiConfig } from "../config/etapiConfig";

export { getAiConfig, getAvailableAiModels, type AiModelDefinition, type AiConfig };

/**
 * Flagship active Cloudflare Workers AI model with 131k context,
 * native tool/function calling, high-speed streaming, and reasoning support.
 *
 * Replaces deprecated @cf/meta/llama-3.1-8b-instruct (deprecated 2026-05-30).
 */
export const DEFAULT_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
// #930: failover-model constant removed — it was exported but consumed by no
// LLM call path, so it advertised a failover that did not exist.

/**
 * Resolves the appropriate model ID dynamically based on task key, explicit override,
 * environment config, or global default.
 */
export function resolveAiModelName(env?: Partial<Env>, taskOrCustomModel?: string): string {
  try {
    const aiConfig = getAiConfig(env);
    if (taskOrCustomModel) {
      if (aiConfig.taskModels && taskOrCustomModel in aiConfig.taskModels) {
        const taskModel = aiConfig.taskModels[taskOrCustomModel];
        if (taskModel) return taskModel;
      }
      return taskOrCustomModel;
    }
    // Phase 3 (#6550): AI_MODEL now resolves from
    // environment.config.json (defaults.ai.model); a still-set env var
    // wins. The etapi defaultModel below is the same value today (the
    // pre-existing duplication, not resolved here).
    return (
      resolveEnvironmentConfig(env).workerSettings.ai.model ||
      aiConfig.defaultModel ||
      DEFAULT_AI_MODEL
    );
  } catch {
    return (
      taskOrCustomModel ||
      resolveEnvironmentConfig(env).workerSettings.ai.model ||
      DEFAULT_AI_MODEL
    );
  }
}

export function getWorkersAIModel(env: Env, taskOrCustomModel?: string) {
  const modelName = resolveAiModelName(env, taskOrCustomModel);
  // #1741 Layer 1: when AI_GATEWAY_ID is configured, every model
  // built here routes through AI Gateway; unconfigured behavior
  // is byte-identical to the direct path (no gateway options).
  const gateway = getGatewayOptions(env);
  return createWorkersAI({ binding: env.AI, ...(gateway ? { gateway } : {}) })(modelName);
}

/**
 * Resolves the hard model context window limit in tokens.
 * Cloudflare Workers AI limits @cf/zai-org/glm-4.7-flash to 24,000 tokens (input + max output).
 */
export function getModelContextWindow(env?: Partial<Env>, taskOrCustomModel?: string): number {
  try {
    const modelName = resolveAiModelName(env, taskOrCustomModel);
    if (modelName.includes("glm-4.7-flash")) return 24000;
    const models = getAvailableAiModels(env);
    const found = models.find((m) => m.id === modelName);
    if (found?.contextWindow) return found.contextWindow;
    if (modelName.includes("llama-3.3-70b")) return 131072;
    return 24000;
  } catch {
    return 24000;
  }
}

