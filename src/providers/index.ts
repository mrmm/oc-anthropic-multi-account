/**
 * Provider exports.
 *
 * This module provides a provider abstraction layer that allows the multi-account
 * auth plugin to work with different AI providers (Anthropic, OpenCode, OpenRouter, etc.)
 */

export type {
  IProvider,
  ProviderAuth,
  ProviderConfig,
  RateLimits,
  RateLimitMetric,
  Model,
  ModelPricing,
  ProviderTestResult,
} from "./types.js";

export { ProviderRegistry } from "./types.js";
export {
  AnthropicProvider,
  anthropicProvider,
  ANTHROPIC_CONFIG,
} from "./anthropic.js";
