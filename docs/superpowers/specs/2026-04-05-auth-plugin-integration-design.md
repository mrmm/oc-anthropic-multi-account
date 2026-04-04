# Design Specification: Auth-Plugin Integration with Multi-Account Support

**Date:** 2026-04-05  
**Status:** Draft  
**Author:** AI Assistant  
**Replaces:** N/A (new feature)

## Executive Summary

Enhance `oc-anthropic-multi-account` to adopt all authentication improvements from `opencode-anthropic-auth` while preserving sophisticated multi-account management, threshold-based switching, and usage tracking capabilities.

## Problem Statement

The current `oc-anthropic-multi-account` plugin provides excellent multi-account management but uses:

- Older OAuth endpoints (claude.ai vs platform.claude.com)
- Non-standard token request format (form-encoded vs JSON)
- Limited OAuth scopes
- Basic CSRF protection (PKCE as state vs UUID state)
- Manual token refresh without retry logic

The `opencode-anthropic-auth` plugin demonstrates best practices:

- Modern endpoints
- Proper OAuth implementation
- Comprehensive scopes
- Robust error handling
- Clean modular structure

We need to **combine** the best of both worlds.

## Goals

1. **Adopt all auth-plugin improvements** - endpoints, formats, scopes, error handling
2. **Preserve multi-account features** - threshold switching, usage tracking, state management
3. **Maintain file-based account storage** - don't use OpenCode's built-in auth storage
4. **Improve CLI tooling** - better UI/UX for account management and diagnostics
5. **Ensure backward compatibility** - smooth migration path for existing users

## Non-Goals

1. **Modular refactoring** - keep monolithic structure per user preference
2. **OpenCode built-in auth integration** - continue using file-based storage for all accounts
3. **API key management** - focus on OAuth, minimal changes to API key support

## Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                   Enhanced Plugin                            │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  OpenCode Plugin Interface                                    │
│  ─────────────────────────────────────────────               │
│  • auth.loader() - Multi-account aware fetch wrapper         │
│  • auth.methods[] - 3 methods: Pro/Max, API Key, Manual      │
│  • experimental.chat.system.transform                         │
│                                                               │
│  Multi-Account Layer                                          │
│  ─────────────────────────────────────────────               │
│  • File-based account storage (accounts.json)                │
│  • Threshold-based account selection                          │
│  • Rate limit tracking & usage metrics (state.json)          │
│  • CLI for account management                                 │
│                                                               │
│  Auth Improvements (from auth-plugin)                        │
│  ─────────────────────────────────────────────               │
│  • platform.claude.com endpoints                             │
│  • JSON token requests                                        │
│  • Comprehensive OAuth scopes                                 │
│  • Proper CSRF (UUID state + PKCE)                          │
│  • Retry logic with exponential backoff                      │
│  • Request/response transformation                           │
│                                                               │
│  State Management                                              │
│  ─────────────────────────────────────────────               │
│  • accounts.json - OAuth tokens (multi-account)              │
│  • state.json - Usage metrics, current account, thresholds  │
│  • Atomic writes with backup fallback                        │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

#### 1. OAuth Constants (Update)

**Current:**

```javascript
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
// Scopes: org:create_api_key user:profile user:inference
```

**New (from auth-plugin):**

```javascript
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Same

const AUTHORIZE_URLS = {
  console: "https://platform.claude.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize", // Keep for Max users
};

const CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code", // NEW
  "user:mcp_servers", // NEW
  "user:file_upload", // NEW
];

const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

const TOOL_PREFIX = "mcp_";
```

#### 2. Token Exchange (Update)

**Current:** Form-encoded requests, no retry logic

**New:** JSON requests with retry logic

```javascript
async function exchange(code, verifier, redirectUri, expectedState) {
  const callback = parseCallbackInput(code);
  if (!callback) return { type: "failed" };
  if (expectedState && callback.state !== expectedState) {
    return { type: "failed" };
  }

  const maxRetries = 2;
  const baseDelayMs = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "User-Agent": "axios/1.13.6",
        },
        body: JSON.stringify({
          code: callback.code,
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          // Note: 'state' not included in body per auth-plugin
        }),
      });

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel();
          continue;
        }
        return { type: "failed" };
      }

      const json = await response.json();
      return {
        type: "success",
        refresh: json.refresh_token,
        access: json.access_token,
        expires: Date.now() + json.expires_in * 1000,
      };
    } catch (error) {
      const isNetworkError =
        error instanceof Error &&
        (error.message.includes("fetch failed") ||
          ("code" in error &&
            [
              "ECONNRESET",
              "ECONNREFUSED",
              "ETIMEDOUT",
              "UND_ERR_CONNECT_TIMEOUT",
            ].includes(error.code)));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw error;
    }
  }
}
```

#### 3. CSRF Protection (Update)

**Current:** PKCE verifier used as state

**New:** Separate UUID state + PKCE (from auth-plugin)

```javascript
function generateState() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function authorize(mode) {
  const pkce = await generatePKCE();
  const state = generateState(); // Separate from verifier

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  };
}
```

#### 4. Token Refresh (Update)

**Current:** Basic token refresh

**New:** Token refresh with retry logic and shared inflight promise (from auth-plugin)

```javascript
// Shared inflight refresh promise — prevents concurrent token refreshes
let refreshPromise = null;

async function ensureFreshToken(account, multiAuth) {
  if (account.access && account.expires > Date.now()) {
    return { ok: true };
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      const maxRetries = 2;
      const baseDelayMs = 500;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          const response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/plain, */*",
              "User-Agent": "axios/1.13.6",
            },
            body: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: account.refresh,
              client_id: CLIENT_ID,
            }),
          });

          if (!response.ok) {
            if (response.status >= 500 && attempt < maxRetries) {
              await response.body?.cancel();
              continue;
            }
            return { ok: false, status: response.status };
          }

          const json = await response.json();
          account.access = json.access_token;
          account.refresh = json.refresh_token;
          account.expires = Date.now() + json.expires_in * 1000;

          // Save updated tokens
          const idx = multiAuth.accounts.findIndex(
            (a) => a.name === account.name,
          );
          if (idx >= 0) {
            multiAuth.accounts[idx] = account;
            saveMultiAuth(multiAuth);
          }

          return { ok: true };
        } catch (error) {
          const isNetworkError =
            error instanceof Error &&
            (error.message.includes("fetch failed") ||
              ("code" in error &&
                [
                  "ECONNRESET",
                  "ECONNREFUSED",
                  "ETIMEDOUT",
                  "UND_ERR_CONNECT_TIMEOUT",
                ].includes(error.code)));

          if (attempt < maxRetries && isNetworkError) {
            continue;
          }
          throw error;
        }
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }

  await refreshPromise;
  return { ok: true };
}
```

#### 5. Request/Response Transformation (Enhance)

**Keep current logic, add improvements from auth-plugin:**

```javascript
function mergeBetaHeaders(headers) {
  const incomingBeta = headers.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(",");
}

function setOAuthHeaders(headers, accessToken) {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergeBetaHeaders(headers));
  headers.set("user-agent", "claude-cli/2.1.2 (external, cli)");
  headers.delete("x-api-key");
  return headers;
}

function prefixToolNames(body) {
  // Keep current implementation - adds 'mcp_' prefix to tool names
}

function stripToolPrefix(text) {
  // Keep current implementation - removes 'mcp_' prefix from responses
}

function rewriteUrl(input) {
  // Keep current implementation - adds ?beta=true to /v1/messages
}
```

#### 6. Multi-Account Logic (Preserve)

**Keep all existing multi-account features:**

- `selectThresholdAccount()` - Threshold-based account selection
- `getState()` / `saveState()` - State management
- `getMultiAuth()` / `saveMultiAuth()` - Account storage
- Usage metrics tracking from response headers
- Rate limit threshold checking
- Auth failure handling with cooldown
- Primary/fallback account logic

**No changes to these functions.**

#### 7. Auth Methods (Enhance)

**Add third method from auth-plugin:**

```javascript
auth: {
  provider: 'anthropic',
  async loader(getAuth, provider) {
    // Try multi-account first
    const multiAuth = getMultiAuth()
    if (multiAuth?.accounts?.length > 0) {
      // Zero out cost for Max plan
      for (const model of Object.values(provider.models)) {
        model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
      }

      return {
        apiKey: '',
        async fetch(input, init) {
          // Multi-account fetch logic (preserve existing)
        }
      }
    }

    // Fallback to single-account OAuth via getAuth
    const auth = await getAuth()
    if (!auth) return {}

    if (auth.type === 'oauth') {
      // Single-account OAuth logic (preserve existing)
      // But use auth-plugin's token refresh with retry
    }

    return {}
  },
  methods: [
    {
      label: 'Claude Pro/Max',
      type: 'oauth',
      authorize: async () => {
        const result = await authorize('max')
        return {
          url: result.url,
          instructions: 'Paste the callback URL or authorization code here: ',
          method: 'code',
          callback: async (code) => {
            return exchange(code, result.verifier, result.redirectUri, result.state)
          }
        }
      }
    },
    {
      label: 'Create an API Key',
      type: 'oauth',
      authorize: async () => {
        const result = await authorize('console')
        return {
          url: result.url,
          instructions: 'Paste the callback URL or authorization code here: ',
          method: 'code',
          callback: async (code) => {
            const credentials = await exchange(code, result.verifier, result.redirectUri, result.state)
            if (credentials.type === 'failed') return credentials
            const apiKey = await fetch('https://api.anthropic.com/api/oauth/claude_cli/create_api_key', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                authorization: `Bearer ${credentials.access}`
              }
            }).then(r => r.json())
            return { type: 'success', key: apiKey.raw_key }
          }
        }
      }
    },
    {
      provider: 'anthropic',
      label: 'Manually enter API Key',
      type: 'api'
    }
  ]
}
```

### CLI Enhancements

#### New Commands

1. **`set-primary <name>`** - Set primary account
2. **`list`** - List all accounts with status
3. **`remove <name>`** - Remove an account
4. **`test <name>`** - Test account functionality
5. **`diagnose`** - System diagnostics
6. **`migrate`** - Help with version upgrades

#### Command Improvements

1. **`usage`** - Rich formatted output with:
   - Account status indicators (✅ ⚠️ ❌)
   - Color-coded metrics (🟢 🟡 🔴)
   - Human-readable timestamps
   - Helpful tips

2. **`config`** - Interactive mode with:
   - Input validation
   - Preview before applying
   - Warning for extreme values

3. **`add`** - Enhanced UX with:
   - Step-by-step instructions
   - Scope explanations
   - Success confirmation

4. **`reauth`** - Better error messages and guidance

#### Example CLI Output

```
╔══════════════════════════════════════════════════════════════╗
║           anthropic-multi-account v1.1.0                      ║
╚══════════════════════════════════════════════════════════════╝

┌─ max-5x ◄── ACTIVE ── ✨ Best quota available
│  Account Status: ✅ Authenticated
│  Auth Type: Claude Max (OAuth)
│  Scopes: org:create_api_key, user:profile, user:inference,
│          user:sessions:claude_code, user:mcp_servers, user:file_upload
│
│  📊 Session (5h)  (threshold 95%)
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 18%
│  Resets: Feb 4 at 5:00 PM (2h 30m remaining)
│  Status: 🟢 Under threshold - optimal
│
│  💡 Tip: Use 'bun src/cli.ts config --thresholds 95,80,90' to adjust
└─
```

## Implementation Plan

### Phase 1: Core Auth Updates

1. Update constants to use auth-plugin endpoints
2. Implement JSON token exchange with retry logic
3. Add proper CSRF protection (UUID state)
4. Update token refresh with retry logic
5. Add comprehensive OAuth scopes

### Phase 2: Request/Response Enhancement

1. Add `mergeBetaHeaders()` function
2. Add `setOAuthHeaders()` function
3. Keep existing tool transformation logic
4. Keep existing URL rewriting logic

### Phase 3: Plugin Interface

1. Add third auth method ("Create an API Key")
2. Update `auth.loader()` to handle all cases
3. Ensure multi-account logic works with new auth
4. Update token storage for new scopes

### Phase 4: CLI Enhancements

1. Add `set-primary` command
2. Add `list` command
3. Add `remove` command
4. Add `test` command
5. Add `diagnose` command
6. Add `migrate` command
7. Enhance `usage` output formatting
8. Add interactive `config` mode

### Phase 5: Testing & Documentation

1. Test OAuth flow with both endpoints
2. Test token refresh with retry logic
3. Test account switching scenarios
4. Update CLI documentation
5. Update README with migration guide
6. Add troubleshooting section

## Migration Path

### For Existing Users

1. **Automatic:** Accounts will be migrated from legacy locations
2. **Manual:** Users need to re-authorize accounts due to new endpoints/scopes
3. **CLI Command:** `bun src/cli.ts migrate` will guide users
4. **Backward Compatible:** Old account files still work (with warning)

### Migration Steps

```bash
# 1. Pull latest changes
git pull origin main

# 2. Run migration assistant
bun src/cli.ts migrate

# 3. Re-authorize accounts (one-time)
bun src/cli.ts reauth primary
bun src/cli.ts reauth fallback1
bun src/cli.ts reauth fallback2

# 4. Verify accounts
bun src/cli.ts list

# 5. Test usage
bun src/cli.ts usage --watch
```

## Breaking Changes

1. **OAuth endpoints changed** - Users must re-authorize accounts
2. **Token format changed** - Old tokens won't work with new endpoints
3. **OAuth scopes expanded** - Need to re-authorize to get new scopes
4. **CLI command changes** - Some command flags may change

## Testing Strategy

### Unit Tests

1. Token exchange with retry logic
2. CSRF state validation
3. Beta header merging
4. Tool name transformation
5. Account selection logic
6. Threshold evaluation

### Integration Tests

1. Full OAuth flow (both endpoints)
2. Token refresh with network failures
3. Multi-account switching scenarios
4. Rate limit tracking
5. End-to-end request/response flow

### Manual Testing

1. Add account with new OAuth flow
2. Test re-authentication
3. Test account switching
4. Verify usage metrics
5. Test all CLI commands

## Risks & Mitigation

| Risk                         | Impact | Mitigation                                      |
| ---------------------------- | ------ | ----------------------------------------------- |
| Users lose existing accounts | High   | Migration assistant, backup files               |
| New OAuth endpoints fail     | High   | Fallback to old endpoints, clear error messages |
| Token format incompatible    | Medium | Comprehensive error handling, re-auth flow      |
| Performance regression       | Medium | Retain existing optimized code paths            |
| CLI UX confusion             | Medium | Interactive modes, clear documentation          |

## Success Metrics

1. **OAuth Success Rate** - >99% successful token exchanges
2. **Token Refresh Reliability** - >99.5% successful refreshes (with retry)
3. **Account Switching Accuracy** - 100% correct account selection
4. **Usage Tracking Accuracy** -100% accurate metric capture
5. **User Migration Success** - >95% users successfully migrate
6. **CLI Usability** - <5% support requests for CLI commands

## Open Questions

1. ~~Should primary account use OpenCode's built-in auth?~~ **Answer: No, file-based for all accounts**
2. ~~What OAuth scopes should we request?~~ **Answer: All scopes from auth-plugin**
3. ~~Should we use modular or monolithic structure?~~ **Answer: Monolithic with better organization**
4. ~~How should users migrate existing accounts?~~ **Answer: CLI migration assistant + re-auth**

## Timeline

- **Week 1:** Phase 1-2 (Core auth updates)
- **Week 2:** Phase 3-4 (Plugin interface + CLI)
- **Week 3:** Phase 5 (Testing + Documentation)
- **Week 4:** Beta release and user feedback

## References

- [opencode-anthropic-auth source](https://github.com/ex-machina-co/opencode-anthropic-auth)
- [oc-anthropic-multi-account source](https://github.com/gaboe/oc-anthropic-multi-account)
- [OpenCode Plugin API](https://github.com/anomalyco/opencode)
- [OAuth 2.0 PKCE](https://oauth.net/2/pkce/)
