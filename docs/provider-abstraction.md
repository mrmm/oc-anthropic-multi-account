# Provider Abstraction Design

## Overview

This document describes the provider abstraction layer for the `oc-anthropic-multi-account` plugin. This abstraction enables support for multiple AI providers (Anthropic, OpenCode, OpenRouter, etc.) while keeping the existing functionality intact.

## Current State (Provider-Specific Code)

Currently, the following are hardcoded to Anthropic:

| Component          | Location                      | Anthropic-Specific                                             |
| ------------------ | ----------------------------- | -------------------------------------------------------------- |
| OAuth URLs         | `constants.ts`                | `AUTHORIZE_URLS`, `TOKEN_URL`, `CODE_CALLBACK_URL`             |
| API endpoints      | `commands.ts`                 | `USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"` |
| API version        | `commands.ts`                 | `"anthropic-version": "2023-06-01"`                            |
| Beta headers       | `constants.ts`                | `REQUIRED_BETAS`                                               |
| Model names        | `commands.ts`, `index.mjs`    | `"claude-haiku-4-5-20251001"`                                  |
| Pricing            | `rate-limits.ts`, `index.mjs` | `MODEL_PRICING`                                                |
| Rate limit headers | `index.mjs`, `rate-limits.ts` | `anthropic-ratelimit-unified-*`                                |
| Scopes             | `constants.ts`                | `OAUTH_SCOPES`                                                 |
| Client ID          | `constants.ts`                | `CLIENT_ID`                                                    |

## Target Architecture

```
src/
├── providers/
│   ├── types.ts          # IProvider interface, types
│   ├── index.ts           # Exports
│   ├── anthropic.ts       # Anthropic implementation
│   ├── opencode.ts        # (future) OpenCode implementation
│   └── openrouter.ts      # (future) OpenRouter implementation
├── constants.ts           # Generic constants (DATA_FILE, DEFAULTS)
├── index.mjs              # Plugin (uses provider abstraction)
└── ... (other files)
```

## Migration Path

### Phase 1: Create Abstraction (Current PR)

- ✅ Create `src/providers/types.ts` with `IProvider` interface
- ✅ Create `src/providers/anthropic.ts` implementing Anthropic
- ✅ Export from `src/providers/index.ts`

### Phase 2: Refactor to Use Abstraction (Future)

- Replace direct OAuth usage with `provider.buildAuthorizationUrl()`
- Replace direct token exchange with `provider.exchangeCodeForTokens()`
- Replace direct refresh with `provider.refreshToken()`
- Replace `MODEL_PRICING` with `provider.config.models`
- Replace rate limit parsing with `provider.parseRateLimitHeaders()`
- Replace usage API with `provider.fetchUsage()`
- Replace test/ping with `provider.testConnectivity()`

### Phase 3: Multi-Provider Support (Future)

- Add `provider` field to account schema
- Add provider selection to `add` command
- Support provider-specific endpoints in `index.mjs`
- Add OpenCode provider implementation
- Add OpenRouter provider implementation

## IProvider Interface

```typescript
interface IProvider {
  readonly id: string; // "anthropic", "opencode", "openrouter"
  readonly name: string; // "Anthropic", "OpenCode", "OpenRouter"
  readonly config: ProviderConfig;

  // OAuth
  buildAuthorizationUrl(pkceChallenge: string, state: string): URL;
  exchangeCodeForTokens(
    code: string,
    verifier: string,
    state: string,
  ): Promise<Tokens>;
  refreshToken(refreshToken: string): Promise<Tokens>;

  // API
  buildAuthHeaders(auth: ProviderAuth): Record<string, string>;
  testConnectivity(
    auth: ProviderAuth,
    model?: string,
  ): Promise<ProviderTestResult>;
  fetchUsage(auth: ProviderAuth): Promise<RateLimits>;

  // Pricing
  calculateCost(
    model: string,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  ): number;

  // Rate limits
  parseRateLimitHeaders(headers: Headers): RateLimits | null;
}
```

## Usage Example

```typescript
import { anthropicProvider } from "./providers/index.js";

// OAuth flow
const pkce = await generatePKCE();
const state = crypto.randomUUID();
const url = anthropicProvider.buildAuthorizationUrl(pkce.challenge, state);
// ... user authorizes in browser ...
const tokens = await anthropicProvider.exchangeCodeForTokens(
  code,
  pkce.verifier,
  state,
);

// Build auth headers
const headers = anthropicProvider.buildAuthHeaders({
  access: tokens.accessToken,
});

// Test connectivity
const result = await anthropicProvider.testConnectivity({
  access: tokens.accessToken,
});
console.log(result.rateLimits);

// Calculate cost
const cost = anthropicProvider.calculateCost("sonnet", 1000, 500, 0, 0);
console.log(`Cost: $${cost.toFixed(4)}`);
```

## Benefits

1. **Extensibility**: Add new providers by implementing `IProvider`
2. **Testability**: Mock providers for testing
3. **Isolation**: Provider-specific code is contained in one file
4. **Type safety**: TypeScript interface ensures consistency
5. **Documentation**: Self-documenting via interface

## Backwards Compatibility

- Existing `index.mjs` continues to work with Anthropic
- Gradual migration: can mix hardcoded and provider-based code
- No breaking changes to CLI commands or data formats

## Future Providers

### OpenCode Provider

- Would implement same interface
- Different OAuth endpoints
- Different API base URL
- Different pricing structure

### OpenRouter Provider

- Would implement same interface
- API key authentication only (no OAuth)
- Different model IDs
- Unified pricing endpoint
