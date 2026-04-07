/**
 * Provider types for multi-provider support.
 * This abstraction allows the CLI to work with Anthropic, OpenCode, OpenRouter, etc.
 */

/**
 * Model identifier with provider-specific naming.
 */
export interface Model {
  /** Internal ID used by the provider (e.g., "claude-3-5-sonnet-20241022") */
  id: string;
  /** Display name for UI (e.g., "Claude 3.5 Sonnet") */
  name: string;
  /** Model family for grouping (e.g., "haiku", "sonnet", "opus") */
  family: string;
}

/**
 * Pricing information per million tokens.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Rate limit information for a single metric window.
 */
export interface RateLimitMetric {
  utilization: number; // 0-1
  reset: number | null; // Unix timestamp or null
  status: "allowed" | "limited";
}

/**
 * Rate limits across multiple windows.
 */
export interface RateLimits {
  session5h?: RateLimitMetric;
  weekly7d?: RateLimitMetric;
  weekly7dSonnet?: RateLimitMetric;
  timestamp?: string;
}

/**
 * Authentication configuration for a provider.
 */
export interface ProviderAuth {
  /** OAuth tokens */
  access?: string;
  refresh?: string;
  expires?: number;
  /** API key auth */
  apiKey?: string;
}

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  /** OAuth configuration */
  oauth?: {
    authorizeUrls: Record<string, string>;
    tokenUrl: string;
    callbackUrl: string;
    scopes: string[];
    clientId: string;
  };
  /** API configuration */
  api?: {
    baseUrl: string;
    version: string;
    betas?: string[];
  };
  /** Available models with pricing */
  models: Record<string, ModelPricing>;
}

/**
 * Result of a provider test/ping operation.
 */
export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  rateLimits?: RateLimits;
  latencyMs?: number;
}

/**
 * Abstract provider interface.
 * Each provider (Anthropic, OpenCode, OpenRouter) implements this.
 */
export interface IProvider {
  /** Provider identifier (e.g., "anthropic", "opencode", "openrouter") */
  readonly id: string;

  /** Human-readable name (e.g., "Anthropic", "OpenCode", "OpenRouter") */
  readonly name: string;

  /** Provider configuration */
  readonly config: ProviderConfig;

  /**
   * Build authorization URL for OAuth flow.
   * @param pkceChallenge - The PKCE code challenge
   * @param state - OAuth state parameter
   * @returns URL to open in browser
   */
  buildAuthorizationUrl(pkceChallenge: string, state: string): URL;

  /**
   * Exchange authorization code for tokens.
   * @param code - Authorization code from callback
   * @param verifier - PKCE code verifier
   * @param state - OAuth state parameter
   * @returns Tokens and expiration
   */
  exchangeCodeForTokens(
    code: string,
    verifier: string,
    state: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;

  /**
   * Refresh an expired access token.
   * @param refreshToken - The refresh token
   * @returns New tokens and expiration
   */
  refreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;

  /**
   * Build authentication headers for API requests.
   * @param auth - Authentication configuration
   * @returns Headers object for fetch
   */
  buildAuthHeaders(auth: ProviderAuth): Record<string, string>;

  /**
   * Test account connectivity.
   * @param auth - Authentication configuration
   * @param model - Model to use for test
   * @returns Test result with rate limits if available
   */
  testConnectivity(
    auth: ProviderAuth,
    model?: string,
  ): Promise<ProviderTestResult>;

  /**
   * Fetch rate limit usage from provider API.
   * @param auth - Authentication configuration
   * @returns Current rate limits
   */
  fetchUsage(auth: ProviderAuth): Promise<RateLimits>;

  /**
   * Calculate cost for a request.
   * @param model - Model family (e.g., "haiku", "sonnet", "opus")
   * @param inputTokens - Input token count
   * @param outputTokens - Output token count
   * @param cacheReadTokens - Cache read token count
   * @param cacheWriteTokens - Cache write token count
   * @returns Estimated cost in USD
   */
  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ): number;

  /**
   * Parse rate limit headers from API response.
   * @param headers - Response headers
   * @returns Parsed rate limits
   */
  parseRateLimitHeaders(headers: Headers): RateLimits | null;
}

/**
 * Provider registry - allows dynamic provider registration.
 */
export class ProviderRegistry {
  private providers: Map<string, IProvider> = new Map();

  register(provider: IProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  list(): IProvider[] {
    return Array.from(this.providers.values());
  }
}
