/**
 * Anthropic provider implementation.
 * This is the reference implementation for the provider interface.
 */

import type {
  IProvider,
  ProviderAuth,
  ProviderConfig,
  RateLimits,
  ProviderTestResult,
} from "./types.js";

/**
 * Anthropic-specific constants.
 */
export const ANTHROPIC_CONFIG: ProviderConfig = {
  oauth: {
    authorizeUrls: {
      console: "https://platform.claude.com/oauth/authorize",
      max: "https://claude.ai/oauth/authorize",
    },
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    callbackUrl: "https://platform.claude.com/oauth/code/callback",
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ],
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  },
  api: {
    baseUrl: "https://api.anthropic.com",
    version: "2023-06-01",
    betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
  },
  models: {
    haiku: { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
    sonnet: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    opus: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  },
};

/**
 * Anthropic provider implementation.
 */
export class AnthropicProvider implements IProvider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  readonly config = ANTHROPIC_CONFIG;

  private generatePKCE(): Promise<{ challenge: string; verifier: string }> {
    // Dynamic import to avoid bundling issues
    return import("@openauthjs/openauth/pkce").then((m) => m.generatePKCE());
  }

  buildAuthorizationUrl(pkceChallenge: string, state: string): URL {
    const url = new URL(this.config.oauth!.authorizeUrls.max);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", this.config.oauth!.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.config.oauth!.callbackUrl);
    url.searchParams.set("scope", this.config.oauth!.scopes.join(" "));
    url.searchParams.set("code_challenge", pkceChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return url;
  }

  async exchangeCodeForTokens(
    code: string,
    verifier: string,
    state: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await fetch(this.config.oauth!.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "claude-cli/2.1.2 (external, cli)",
      },
      body: JSON.stringify({
        code,
        state,
        grant_type: "authorization_code",
        client_id: this.config.oauth!.clientId,
        redirect_uri: this.config.oauth!.callbackUrl,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in,
    };
  }

  async refreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await fetch(this.config.oauth!.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "claude-cli/2.1.2 (external, cli)",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.oauth!.clientId,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Token refresh failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in,
    };
  }

  buildAuthHeaders(auth: ProviderAuth): Record<string, string> {
    if (auth.apiKey) {
      return { "x-api-key": auth.apiKey };
    }
    return { authorization: `Bearer ${auth.access}` };
  }

  async testConnectivity(
    auth: ProviderAuth,
    model: string = "claude-haiku-4-5-20251001",
  ): Promise<ProviderTestResult> {
    const headers: Record<string, string> = {
      ...this.buildAuthHeaders(auth),
      "anthropic-version": this.config.api!.version,
      "anthropic-beta": this.config.api!.betas!.join(","),
      "content-type": "application/json",
    };

    try {
      const start = Date.now();
      const response = await fetch(
        `${this.config.api!.baseUrl}/v1/messages?beta=true`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      );

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
          latencyMs,
        };
      }

      const rateLimits = this.parseRateLimitHeaders(response.headers);
      return { ok: true, rateLimits, latencyMs };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async fetchUsage(auth: ProviderAuth): Promise<RateLimits> {
    const response = await fetch(
      `${this.config.api!.baseUrl}/api/oauth/usage`,
      {
        headers: {
          ...this.buildAuthHeaders(auth),
          "anthropic-version": this.config.api!.version,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Usage API failed (${response.status})`);
    }

    const json = (await response.json()) as any;

    // Anthropic returns utilization as percentage (0-100) or fraction (0-1)
    const normalize = (val: number) => (val > 1 ? val / 100 : val);

    const result: RateLimits = {
      timestamp: new Date().toISOString(),
    };

    if (json.five_hour) {
      result.session5h = {
        utilization: normalize(json.five_hour.utilization || 0),
        reset: json.five_hour.resets_at
          ? Math.floor(new Date(json.five_hour.resets_at).getTime() / 1000)
          : null,
        status: "allowed",
      };
    }

    if (json.seven_day) {
      result.weekly7d = {
        utilization: normalize(json.seven_day.utilization || 0),
        reset: json.seven_day.resets_at
          ? Math.floor(new Date(json.seven_day.resets_at).getTime() / 1000)
          : null,
        status: "allowed",
      };
    }

    if (json.seven_day_sonnet) {
      result.weekly7dSonnet = {
        utilization: normalize(json.seven_day_sonnet.utilization || 0),
        reset: json.seven_day_sonnet.resets_at
          ? Math.floor(
              new Date(json.seven_day_sonnet.resets_at).getTime() / 1000,
            )
          : null,
        status: "allowed",
      };
    }

    return result;
  }

  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ): number {
    const key = model.toLowerCase().includes("opus")
      ? "opus"
      : model.toLowerCase().includes("sonnet")
        ? "sonnet"
        : "haiku";

    const pricing = this.config.models[key];
    if (!pricing) return 0;

    return (
      (inputTokens * pricing.input +
        outputTokens * pricing.output +
        cacheReadTokens * pricing.cache_read +
        cacheWriteTokens * pricing.cache_write) /
      1_000_000
    );
  }

  parseRateLimitHeaders(headers: Headers): RateLimits | null {
    const result: RateLimits = {
      timestamp: new Date().toISOString(),
    };

    const parseMetric = (
      prefix: string,
    ): {
      utilization: number;
      reset: number | null;
      status: "allowed" | "limited";
    } | null => {
      const util = headers.get(`${prefix}-utilization`);
      const reset = headers.get(`${prefix}-reset`);
      const status = headers.get(`${prefix}-status`);

      if (!util) return null;

      return {
        utilization: parseFloat(util) || 0,
        reset: reset ? parseInt(reset, 10) : null,
        status: status === "rejected" ? "limited" : "allowed",
      };
    };

    const session5h = parseMetric("anthropic-ratelimit-unified-5h");
    if (session5h) result.session5h = session5h;

    const weekly7d = parseMetric("anthropic-ratelimit-unified-7d");
    if (weekly7d) result.weekly7d = weekly7d;

    const weekly7dSonnet = parseMetric("anthropic-ratelimit-unified-7d_sonnet");
    if (weekly7dSonnet) result.weekly7dSonnet = weekly7dSonnet;

    if (!result.session5h && !result.weekly7d && !result.weekly7dSonnet) {
      return null;
    }

    return result;
  }
}

// Export singleton instance
export const anthropicProvider = new AnthropicProvider();
