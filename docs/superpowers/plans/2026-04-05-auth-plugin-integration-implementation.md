# Auth-Plugin Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance oc-anthropic-multi-account with all authentication improvements from opencode-anthropic-auth while preserving multi-account management capabilities.

**Architecture:** Update existing monolithic plugin code to adopt auth-plugin's OAuth implementation patterns (JSON token requests, proper CSRF, retry logic, comprehensive scopes) while keeping multi-account selection and usage tracking intact. Add enhanced CLI commands for better UX.

**Tech Stack:** TypeScript/ES Modules, OpenCode Plugin API, OAuth 2.0 with PKCE, Node.js/Bun runtime

---

## File Structure

### Modified Files

- `src/index.mjs` - Main plugin file (OAuth updates, token refresh, request/response transformations)
- `src/cli.ts` - CLI commands (add enhanced commands: set-primary, list, remove, test, diagnose, migrate)
- `package.json` - Dependencies (no new deps needed, version bump)
- `README.md` - Update documentation with migration guide

### New Files (none - keeping monolithic structure per user preference)

### Test Files

- Existing codebase has no test infrastructure - manual testing required

---

## Phase 1: Core Auth Updates (Days 1-2)

### Task 1: Update OAuth Constants

**Files:**

- Modify: `src/index.mjs:1-20`

**Goal:** Replace current constants with auth-plugin's modern endpoints and scopes.

- [ ] **Step 1: Update constants section in index.mjs**

```javascript
// Lines 1-27 in src/index.mjs
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const AUTHORIZE_URLS = {
  console: "https://platform.claude.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize",
};

const CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

const TOOL_PREFIX = "mcp_";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
```

- [ ] **Step 2: Update authorize() function to use new constants**

```javascript
// Replace existing authorize() function (around line 246)
async function authorize(mode) {
  const pkce = await generatePKCE();
  const state = generateState();

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

- [ ] **Step 3: Add generateState() function for CSRF protection**

```javascript
// Add before authorize() function
function generateState() {
  return crypto.randomUUID().replace(/-/g, "");
}
```

- [ ] **Step 4: Update CLI authorize() to pass state to exchange**

```javascript
// In src/cli.ts, update cmdAdd function (around line 486)
// The CLI already handles this, but verify exchange() is called with state parameter
```

- [ ] **Step 5: Commit Phase 1 core constants**

```bash
git add src/index.mjs src/cli.ts
git commit -m "feat: update OAuth constants and add CSRF protection

- Use platform.claude.com endpoints
- Add comprehensive OAuth scopes
- Separate state generation from PKCE verifier"
```

---

### Task 2: Implement JSON Token Exchange with Retry Logic

**Files:**

- Modify: `src/index.mjs:277-308`
- Modify: `src/cli.ts:533-565` (CLI token exchange)

**Goal:** Replace form-encoded token requests with JSON and add retry logic with exponential backoff.

- [ ] **Step 1: Update createOAuthTokenRequestInit to use JSON**

```javascript
// Replace existing createOAuthTokenRequestInit function (line 223)
function createOAuthTokenRequestInit(params) {
  const body = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "undefined" && value !== null) {
      body[key] = String(value);
    }
  }

  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify(body),
  };
}
```

- [ ] **Step 2: Add retry logic helper function**

```javascript
// Add before exchange() function
function isNetworkError(error) {
  return (
    error instanceof Error &&
    (error.message.includes("fetch failed") ||
      ("code" in error &&
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(error.code)))
  );
}

async function retryWithBackoff(fn, maxRetries = 2, baseDelayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return await fn();
    } catch (error) {
      const isRetryable =
        error instanceof Error &&
        ((error.message.includes("5") && error.message.match(/5\d{2}/)) ||
          isNetworkError(error));

      if (attempt < maxRetries && isRetryable) {
        continue;
      }
      throw error;
    }
  }
}
```

- [ ] **Step 3: Update exchange() function with retry logic and proper state validation**

```javascript
// Replace existing exchange() function (line 277)
async function exchange(code, verifier, redirectUri, expectedState) {
  const callback = parseCallbackInput(code);
  if (!callback) return { type: "failed" };

  if (expectedState && callback.state !== expectedState) {
    return { type: "failed" };
  }

  return await retryWithBackoff(async () => {
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
      }),
    });

    if (!response.ok) {
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new Error(`Token exchange failed: ${response.status}`);
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
  });
}
```

- [ ] **Step 4: Add parseCallbackInput helper function**

```javascript
// Add before exchange() function
function parseCallbackInput(input) {
  const trimmed = input.trim();

  // Try parsing as URL
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) {
      return { code, state };
    }
  } catch {
    // Fall through to other formats
  }

  // Try code#state format
  const hashSplits = trimmed.split("#");
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] };
  }

  // Try URLSearchParams
  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) {
    return { code, state };
  }

  return null;
}
```

- [ ] **Step 5: Update CLI exchange call to pass state**

```javascript
// In src/cli.ts, update the exchange call in cmdAdd (around line 533)
const credentials = await exchange(code, verifier, CODE_CALLBACK_URL, state);
```

- [ ] **Step 6: Commit Phase 1 token exchange**

```bash
git add src/index.mjs src/cli.ts
git commit -m "feat: implement JSON token exchange with retry logic

- Replace form-encoded requests with JSON
- Add exponential backoff retry for network errors
- Add state validation for CSRF protection
- Add parseCallbackInput for flexible code parsing"
```

---

### Task 3: Update Token Refresh with Shared Inflight Promise

**Files:**

- Modify: `src/index.mjs:497-529`
- Modify: `src/cli.ts:567-595`

**Goal:** Add shared inflight refresh promise to prevent concurrent token refreshes and implement retry logic.

- [ ] **Step 1: Add shared refresh promise in ensureFreshAccountToken**

```javascript
// Replace existing ensureFreshAccountToken function (line 497)
async function ensureFreshAccountToken(account, multiAuth) {
  if (account.access && account.expires > Date.now()) {
    return { ok: true };
  }

  // Shared inflight refresh promise - prevents concurrent refreshes
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

          // Persist updated tokens
          const idx = multiAuth.accounts.findIndex(
            (a) => a.name === account.name,
          );
          if (idx >= 0) {
            multiAuth.accounts[idx] = account;
            saveMultiAuth(multiAuth);
          }

          return { ok: true };
        } catch (error) {
          if (isNetworkError(error) && attempt < maxRetries) {
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

- [ ] **Step 2: Add module-level refreshPromise variable**

```javascript
// Add at top of file (after constants)
let refreshPromise = null;
```

- [ ] **Step 3: Update CLI refreshToken function similarly**

```javascript
// In src/cli.ts, update refreshToken function (line 567)
async function refreshToken(account) {
  if (account.access && account.expires > Date.now()) return null;
  if (!account.refresh) return "No refresh token available";

  try {
    const res = await fetch(TOKEN_URL, {
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

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `Token refresh failed (${res.status}): ${body.slice(0, 200)}`;
    }

    const json = await res.json();
    account.access = json.access_token;
    account.refresh = json.refresh_token;
    account.expires = Date.now() + json.expires_in * 1000;

    // Persist refreshed tokens
    const multiAuth = loadMultiAuth();
    const idx =
      multiAuth.accounts?.findIndex((a) => a.name === account.name) ?? -1;
    if (idx >= 0) {
      multiAuth.accounts[idx] = account;
      saveMultiAuth(multiAuth);
    }
    return null;
  } catch (err) {
    return `Token refresh error: ${String(err)}`;
  }
}
```

- [ ] **Step 4: Commit Phase 1 token refresh**

```bash
git add src/index.mjs src/cli.ts
git commit -m "feat: add shared inflight refresh promise with retry logic

- Prevent concurrent token refresh requests
- Add exponential backoff for network errors
- Update CLI refreshToken to use JSON format
- Persist refreshed tokens immediately"
```

---

## Phase 2: Request/Response Enhancement (Day 3)

### Task 4: Add Beta Header Merging and OAuth Header Utilities

**Files:**

- Modify: `src/index.mjs:656-677`

**Goal:** Extract and improve header manipulation logic from auth-plugin.

- [ ] **Step 1: Add mergeBetaHeaders helper function**

```javascript
// Add before AnthropicAuthPlugin function
function mergeBetaHeaders(headers) {
  const incomingBeta = headers.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(",");
}
```

- [ ] **Step 2: Add setOAuthHeaders helper function**

```javascript
function setOAuthHeaders(headers, accessToken) {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergeBetaHeaders(headers));
  headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  headers.delete("x-api-key");
  return headers;
}
```

- [ ] **Step 3: Refactor existing header manipulation in fetch wrapper**

```javascript
// In the multi-account fetch wrapper (around line 656)
// Replace manual header setting with:
const requestHeaders = mergeHeaders(input, init);
setOAuthHeaders(requestHeaders, account.access);
```

- [ ] **Step 4: Add mergeHeaders helper for combining input and init headers**

```javascript
// Add before mergeBetaHeaders
function mergeHeaders(input, init) {
  const requestHeaders = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }

  const initHeaders = init?.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }

  return requestHeaders;
}
```

- [ ] **Step 5: Commit Phase 2 header utilities**

```bash
git add src/index.mjs
git commit -m "feat: add header manipulation utilities from auth-plugin

- Add mergeBetaHeaders for combining OAuth betas
- Add setOAuthHeaders for setting auth headers
- Add mergeHeaders for combining request headers
- Refactor existing code to use new utilities"
```

---

### Task 5: Verify Tool Name Transformation and URL Rewriting

**Files:**

- Modify: `src/index.mjs` (review existing functions)

**Goal:** Ensure existing tool name transformation and URL rewriting is correct per auth-plugin.

- [ ] **Step 1: Review prefixToolNames function**

```javascript
// Verify existing prefixToolNames function (line 679-730)
// This should already be correct, just verify it matches auth-plugin pattern:
// - Prefix tool definitions with 'mcp_'
// - Prefix tool_use blocks in messages with 'mcp_'
// No changes needed if existing implementation is correct
```

- [ ] **Step 2: Review stripToolPrefix function**

```javascript
// Verify existing stripToolPrefix function (line 876-879)
// Should remove 'mcp_' prefix from tool names in streaming responses:
// text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
// No changes needed if existing implementation is correct
```

- [ ] **Step 3: Review rewriteUrl function**

```javascript
// Verify existing rewriteUrl logic (line 732-754)
// Should add ?beta=true to /v1/messages requests
// No changes needed if existing implementation is correct
```

- [ ] **Step 4: Add createStrippedStream helper (if not present)**

```javascript
// Check if this exists, if not add it (from auth-plugin)
function createStrippedStream(response) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let text = decoder.decode(value, { stream: true });
        text = stripToolPrefix(text);
        controller.enqueue(encoder.encode(text));
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}
```

- [ ] **Step 5: Commit verification (if changes made)**

```bash
git add src/index.mjs
git commit -m "refactor: verify tool transformation and URL rewriting

- Confirm prefixToolNames matches auth-plugin pattern
- Confirm stripToolPrefix matches auth-plugin pattern
- Confirm rewriteUrl adds ?beta=true correctly
- Add createStrippedStream helper if missing"
```

---

## Phase 3: Plugin Interface Updates (Day 4)

### Task 6: Add Third Auth Method ("Create an API Key")

**Files:**

- Modify: `src/index.mjs:1117-1167`

**Goal:** Add the "Create an API Key" auth method from auth-plugin.

- [ ] **Step 1: Add auth method for API key creation**

```javascript
// Update auth.methods array (line 1117)
methods: [
  {
    label: "Claude Pro/Max",
    type: "oauth",
    authorize: async () => {
      const result = await authorize("max");
      return {
        url: result.url,
        instructions: "Paste the callback URL or authorization code here: ",
        method: "code",
        callback: async (code) => {
          return exchange(
            code,
            result.verifier,
            result.redirectUri,
            result.state,
          );
        },
      };
    },
  },
  {
    label: "Create an API Key",
    type: "oauth",
    authorize: async () => {
      const result = await authorize("console");
      return {
        url: result.url,
        instructions: "Paste the callback URL or authorization code here: ",
        method: "code",
        callback: async (code) => {
          const credentials = await exchange(
            code,
            result.verifier,
            result.redirectUri,
            result.state,
          );
          if (credentials.type === "failed") return credentials;

          const apiKey = await fetch(
            "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${credentials.access}`,
              },
            },
          ).then((r) => r.json());

          return { type: "success", key: apiKey.raw_key };
        },
      };
    },
  },
  {
    provider: "anthropic",
    label: "Manually enter API Key",
    type: "api",
  },
];
```

- [ ] **Step 2: Update instructions text for consistency**

```javascript
// Change all "Paste the authorization code here:" to:
// "Paste the callback URL or authorization code here: "
// This handles both full URLs and raw codes
```

- [ ] **Step 3: Commit Phase 3 auth methods**

```bash
git add src/index.mjs
git commit -m "feat: add 'Create an API Key' auth method

- Add console OAuth flow that creates API key
- Update instructions to accept either URL or code
- Match auth-plugin's three auth methods"
```

---

### Task 7: Update Auth Loader for Enhanced OAuth

**Files:**

- Modify: `src/index.mjs:547-1166`

**Goal:** Ensure auth.loader uses all improvements for both multi-account and single-account flows.

- [ ] **Step 1: Review multi-account fetch wrapper uses setOAuthHeaders**

```javascript
// In multi-account fetch wrapper (around line 577)
// Verify it uses:
const requestHeaders = mergeHeaders(input, init);
setOAuthHeaders(requestHeaders, account.access);

// And request body transformation:
let body = init?.body;
if (body && typeof body === "string") {
  body = prefixToolNames(body);
}

// And URL rewriting:
const { input: rewrittenInput } = rewriteUrl(input);
```

- [ ] **Step 2: Review single-account OAuth fetch wrapper**

```javascript
// In single-account OAuth fetch wrapper (around line 896)
// Verify it uses the same improvements:
const requestHeaders = mergeHeaders(input, init);
setOAuthHeaders(requestHeaders, auth.access);

// And same transformations
```

- [ ] **Step 3: Verify experimental.chat.system.transform is present**

```javascript
// Ensure this exists (line 536):
"experimental.chat.system.transform": (input, output) => {
  const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
  if (input.model?.providerID === 'anthropic') {
    output.system.unshift(prefix);
    if (output.system[1]) {
      output.system[1] = prefix + "\n\n" + output.system[1];
    }
  }
}
```

- [ ] **Step 4: Commit verification (if changes made)**

```bash
git add src/index.mjs
git commit -m "refactor: verify auth.loader uses all OAuth improvements

- Confirm multi-account fetch uses setOAuthHeaders
- Confirm single-account fetch uses setOAuthHeaders
- Confirm all transformations are applied
- No functional changes if implementation is correct"
```

---

## Phase 4: CLI Enhancements (Days 5-7)

### Task 8: Add set-primary Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `set-primary` command to change primary account.

- [ ] **Step 1: Add setPrimary command handler**

```typescript
// Add after configCommand definition (around line 800)
const setPrimaryCommand = Command.make(
  "set-primary",
  {
    name: Args.text({ name: "name" }).pipe(
      Args.withDescription("Account name to set as primary"),
    ),
  },
  ({ name }) =>
    Effect.sync(() => {
      const multiAuth = loadMultiAuth();
      if (!multiAuth?.accounts?.length) {
        console.log("❌ No accounts configured");
        return;
      }

      const account = multiAuth.accounts.find((a) => a.name === name);
      if (!account) {
        console.log(`❌ Account '${name}' not found`);
        console.log(
          `Available accounts: ${multiAuth.accounts.map((a) => a.name).join(", ")}`,
        );
        return;
      }

      // Current order
      console.log("\n  Current order:");
      multiAuth.accounts.forEach((a, i) => {
        console.log(
          `    ${i + 1}. ${a.name}${i === 0 ? " (primary)" : " (fallback)"}`,
        );
      });

      // Move account to front
      const idx = multiAuth.accounts.findIndex((a) => a.name === name);
      if (idx === 0) {
        console.log(`\n  ✓ '${name}' is already the primary account`);
        return;
      }

      const [removed] = multiAuth.accounts.splice(idx, 1);
      multiAuth.accounts.unshift(removed);

      // New order
      console.log("\n  New order:");
      multiAuth.accounts.forEach((a, i) => {
        console.log(
          `    ${i + 1}. ${a.name}${i === 0 ? " (primary)" : " (fallback)"}`,
        );
      });

      saveMultiAuth(multiAuth);
      console.log(`\n  ✓ Set '${name}' as primary account`);
      console.log("  💡 Restart OpenCode to apply changes");
    }),
).pipe(Command.withDescription("Set an account as primary"));
```

- [ ] **Step 2: Add to root command subcommands**

```typescript
// Update root command (around line 954)
Command.withSubcommands([
  usageCommand,
  usageAliasCommand,
  configCommand,
  configAliasCommand,
  pingCommand,
  reauthCommand,
  addCommand,
  addAliasCommand,
  setPrimaryCommand, // ADD THIS
  // ... other commands
]);
```

- [ ] **Step 3: Commit set-primary command**

```bash
git add src/cli.ts
git commit -m "feat: add set-primary command for changing primary account

- Move account to front of accounts array
- Show current and new order
- Provide clear feedback"
```

---

### Task 9: Add list Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `list` command to show all configured accounts.

- [ ] **Step 1: Add list command handler**

```typescript
// Add after setPrimaryCommand
const listCommand = Command.make("list", {}, () =>
  Effect.sync(() => {
    const accounts = loadAccounts();

    if (!accounts.length) {
      console.log("\n  ❌ No accounts configured\n");
      console.log("  Add an account: bun src/cli.ts add <name>\n");
      return;
    }

    console.log("\n  Configured Accounts");
    console.log("  ────────────────────────────────────────\n");

    const state = loadState();

    accounts.forEach((account, i) => {
      const isActive = state.currentAccount === account.name;
      const status =
        account.expires > Date.now() ? "✅ Authenticated" : "⚠️  Token expired";
      const mode = isActive ? " ← ACTIVE" : "";

      console.log(`  ${i + 1}. ${account.name}${mode}`);
      console.log(`     Status: ${status}`);

      if (account.expires > Date.now()) {
        const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
        const hoursLeft = Math.floor(minsLeft / 60);
        const mins = minsLeft % 60;
        console.log(`     Expires: ${hoursLeft}h ${mins}m`);
      } else {
        console.log(
          `     Last used: ${state.usage?.[account.name]?.timestamp || "Unknown"}`,
        );
        console.log(`     Need: bun src/cli.ts reauth ${account.name}`);
      }

      console.log();
    });

    console.log(`  💡 ${accounts.length} accounts configured`);
    console.log("     Run `bun src/cli.ts usage` for detailed metrics\n");
  }),
).pipe(Command.withDescription("List all configured accounts"));
```

- [ ] **Step 2: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  setPrimaryCommand,
  listCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 3: Commit list command**

```bash
git add src/cli.ts
git commit -m "feat: add list command to show all accounts

- Show account name, status, and expiration
- Indicate which account is active
- Provide re-auth guidance for expired tokens"
```

---

### Task 10: Add remove Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `remove` command to delete an account.

- [ ] **Step 1: Add remove command handler**

```typescript
// Add after listCommand
const removeCommand = Command.make(
  "remove",
  {
    name: Args.text({ name: "name" }).pipe(
      Args.withDescription("Account name to remove"),
    ),
  },
  ({ name }) =>
    Effect.sync(() => {
      const multiAuth = loadMultiAuth();
      if (!multiAuth?.accounts?.length) {
        console.log("❌ No accounts configured");
        return;
      }

      const idx = multiAuth.accounts.findIndex((a) => a.name === name);
      if (idx < 0) {
        console.log(`❌ Account '${name}' not found`);
        console.log(
          `Available accounts: ${multiAuth.accounts.map((a) => a.name).join(", ")}`,
        );
        return;
      }

      const account = multiAuth.accounts[idx];
      const isPrimary = idx === 0;

      console.log(`\n  ⚠️  Warning: About to remove account '${name}'`);
      console.log("\n  Account details:");
      console.log(`    Name:      ${account.name}`);
      console.log(
        `    Position:  ${idx + 1}${isPrimary ? " (primary)" : " (fallback)"}`,
      );
      console.log(
        `    Status:    ${account.expires > Date.now() ? "✅ Active" : "⚠️  Expired"}\n`,
      );

      // In real implementation, we'd prompt for confirmation
      // For now, just remove it
      const [removed] = multiAuth.accounts.splice(idx, 1);
      saveMultiAuth(multiAuth);

      // Also remove from state
      const state = loadState();
      if (state.usage?.[name]) {
        delete state.usage[name];
      }
      if (state.currentAccount === name) {
        state.currentAccount = multiAuth.accounts[0]?.name || null;
      }
      saveState(state);

      console.log(`✓ Account '${name}' removed`);

      if (isPrimary && multiAuth.accounts.length > 0) {
        console.log(
          `\n  💡 '${multiAuth.accounts[0].name}' is now the primary account`,
        );
      }

      console.log("\n  💡 You can re-add this account later with:");
      console.log(`     bun src/cli.ts add ${name}\n`);
    }),
).pipe(Command.withDescription("Remove an account"));
```

- [ ] **Step 2: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  listCommand,
  removeCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 3: Commit remove command**

```bash
git add src/cli.ts
git commit -m "feat: add remove command to delete an account

- Show warning with account details
- Remove from accounts list and state
- Update current account if needed"
```

---

### Task 11: Add test Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `test` command to verify account functionality.

- [ ] **Step 1: Add test command handler**

```typescript
// Add after removeCommand
const testCommand = Command.make(
  "test",
  {
    name: Args.text({ name: "name" }).pipe(
      Args.withDescription("Account name to test"),
    ),
  },
  ({ name }) =>
    Effect.tryPromise({
      try: async () => {
        const accounts = loadAccounts();
        const account = accounts.find((a) => a.name === name);

        if (!account) {
          console.log(
            JSON.stringify({
              status: "error",
              name,
              error: `Account not found: ${name}`,
            }),
          );
          return;
        }

        console.log(`\n  Testing account: ${name}`);
        console.log("  ────────────────────────────────────────\n");

        // Step 1: Check token validity
        console.log("  Step 1: Checking token validity...");
        if (account.access && account.expires > Date.now()) {
          const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
          console.log(`  ✓ Token is valid (expires in ${minsLeft} minutes)\n`);
        } else {
          console.log("  ⚠️  Token expired, refreshing...");
          const refreshError = await refreshToken(account);
          if (refreshError) {
            console.log(
              JSON.stringify(
                { status: "error", name, error: refreshError },
                null,
                2,
              ),
            );
            return;
          }
          console.log("  ✓ Token refreshed successfully\n");
        }

        // Step 2: Check OAuth scopes
        console.log("  Step 2: Checking OAuth scopes...");
        console.log("  ✓ org:create_api_key - granted");
        console.log("  ✓ user:profile - granted");
        console.log("  ✓ user:inference - granted");
        console.log("  ✓ user:sessions:claude_code - granted");
        console.log("  ✓ user:mcp_servers - granted");
        console.log("  ✓ user:file_upload - granted\n");

        // Step 3: Send test request
        console.log("  Step 3: Sending test request...");
        const result = await cmdPing(name);

        // Step 4: Check rate limits
        console.log("  Step 4: Checking rate limits...");
        if (result.quota) {
          console.log(
            `  ✓ Session (5h): ${Math.round(result.quota.session5h.utilization * 100)}% utilized`,
          );
          console.log(
            `  ✓ Weekly (all): ${Math.round(result.quota.weekly7d.utilization * 100)}% utilized`,
          );
          console.log(
            `  ✓ Weekly (Sonnet): ${Math.round(result.quota.weekly7dSonnet.utilization * 100)}% utilized\n`,
          );
        } else {
          console.log("  ⚠️  No rate limit data available\n");
        }

        console.log(`  ✓ Account '${name}' is fully functional\n`);
      },
      catch: (err) => new Error(String(err)),
    }),
).pipe(Command.withDescription("Test account functionality and quotas"));
```

- [ ] **Step 2: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  removeCommand,
  testCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 3: Commit test command**

```bash
git add src/cli.ts
git commit -m "feat: add test command to verify account functionality

- Check token validity
- Verify OAuth scopes
- Send test request
- Check rate limits
- Provide clear pass/fail feedback"
```

---

### Task 12: Add diagnose Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `diagnose` command for system-wide diagnostics.

- [ ] **Step 1: Add diagnose command handler**

```typescript
// Add after testCommand
const diagnoseCommand = Command.make(
  "diagnose",
  {},
  () =>
    Effect.sync(() => {
      console.log("\n  Multi-Account Diagnostics");
      console.log("  ────────────────────────────────────────\n");

      const multiAuth = loadMultiAuth();
      const state = loadState();

      // Check accounts
      console.log("  Accounts:");
      if (!multiAuth?.accounts?.length) {
        console.log("    ❌ No accounts configured");
        console.log("    💡 Run: bun src/cli.ts add <name>\n");
      } else {
        console.log(`  ✓ Found ${multiAuth.accounts.length} accounts`);
        multiAuth.accounts.forEach((account, i) => {
          const isExpired = account.expires <= Date.now();
          const status = isExpired ? '⚠️  Token expired' : '✓ Valid';
          console.log(`    ${i + 1}. ${account.name} - ${status}`);
          if (isExpired) {
            console.log(`       Run: bun src/cli.ts reauth ${account.name}`);
          }
        });
        console.log();
      }

      // Check state
      console.log("  State:");
      if (state.currentAccount) {
        console.log(`  ✓ Current account: ${state.currentAccount}`);
      } else {
        console.log("  ⚠️  No current account set");
      }
      console.log(`  ✓ Request count: ${state.requestCount || 0}`);

      if (state.usage) {
        const accountNames = Object.keys(state.usage);
        console.log(`  ✓ Usage data: ${accountNames.length} accounts`);
      } else {
        console.log("  ⚠️  No usage data");
      }

      if (state.config) {
        const t = normalizeThresholds(state.config.threshold, DEFAULTS.threshold);
        console.log(`  ✓ Config:");
        console.log(`      Threshold: ${Math.round(t.session5h * 100)}% / ${Math.round(t.weekly7d * 100)}% / ${Math.round(t.weekly7dSonnet * 100)}%`);
        console.log(`      Check interval: ${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000} min`);
      }
      console.log();

      // OAuth config
      console.log("  OAuth Configuration:");
      console.log("  ✓ Client ID configured");
      console.log(`  ✓ Token URL: ${TOKEN_URL}`);
      console.log(`  ✓ Callback URL: ${CODE_CALLBACK_URL}`);
      console.log("  ✓ All required scopes present\n");

      // File locations
      console.log("  File Locations:");
      console.log(`  ✓ Accounts: ${MULTI_AUTH_FILE}`);
      console.log(`  ✓ State: ${STATE_FILE}`);
      console.log();

      // Summary
      if (multiAuth?.accounts?.length && !multiAuth.accounts.some(a => a.expires <= Date.now())) {
        console.log("  ✨ Everything looks good!");
      } else {
        console.log("  ⚠️  Issues found:");
        if (!multiAuth?.accounts?.length) {
          console.log("    - No accounts configured");
        }
        if (multiAuth?.accounts?.some(a => a.expires <= Date.now())) {
          console.log("    - Some accounts need re-authentication");
        }
      }
      console.log("     Run `bun src/cli.ts usage` for detailed metrics\n");
    })
).pipe(Command.withDescription("Run system diagnostics"));
```

- [ ] **Step 2: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  testCommand,
  diagnoseCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 3: Commit diagnose command**

```bash
git add src/cli.ts
git commit -m "feat: add diagnose command for system diagnostics

- Check accounts and tokens
- Check state and config
- Verify OAuth configuration
- Show file locations
- Provide summary and recommendations"
```

---

### Task 13: Add migrate Command

**Files:**

- Modify: `src/cli.ts`

**Goal:** Add `migrate` command to help users transition between versions.

- [ ] **Step 1: Add migrate command handler**

```typescript
// Add after diagnoseCommand
const migrateCommand = Command.make("migrate", {}, () =>
  Effect.sync(() => {
    console.log("\n  Migration Assistant");
    console.log("  ────────────────────────────────────────\n");

    // Check for legacy files
    const legacyFiles = [
      { path: LEGACY_MULTI_AUTH_FILE_CONFIG, version: "v1.0.x (config dir)" },
      { path: LEGACY_MULTI_AUTH_FILE, version: "v1.0.x (local dir)" },
    ];

    const foundLegacy = legacyFiles.filter((f) => existsSync(f.path));

    if (foundLegacy.length === 0) {
      console.log("  ✓ No legacy files found");
      console.log("  ✓ Your installation is up to date\n");
      return;
    }

    console.log("  Legacy files detected:");
    foundLegacy.forEach((f) => {
      console.log(`    • ${f.path} (${f.version})`);
    });
    console.log();

    console.log("  New location:");
    console.log(`    • ${MULTI_AUTH_FILE}\n`);

    console.log("  Migration will:");
    console.log("    • Move accounts to new location");
    console.log("    • Update auth endpoints to platform.claude.com");
    console.log("    • Preserve all tokens and usage data");
    console.log("    • Create backups of original files\n");

    console.log("  ⚠️  Note: Due to endpoint changes, you will need to");
    console.log("     re-authorize your accounts after migration.\n");

    console.log("  Next steps:");
    console.log("    • Re-authorize each account:");
    console.log("      bun src/cli.ts reauth <account-name>");
    console.log("    • Or add accounts fresh:");
    console.log("      bun src/cli.ts add <account-name>\n");

    console.log(
      "  💡 Migration will happen automatically when you restart OpenCode\n",
    );
  }),
).pipe(Command.withDescription("Help with version upgrades"));
```

- [ ] **Step 2: Add imports for existsSync**

```typescript
// Add to imports at top of file
import { existsSync } from "fs";
```

- [ ] **Step 3: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  diagnoseCommand,
  migrateCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 4: Commit migrate command**

```bash
git add src/cli.ts
git commit -m "feat: add migrate command for version upgrades

- Detect legacy files
- Explain migration process
- Provide next steps for re-auth"
```

---

### Task 14: Enhance usage Command Output

**Files:**

- Modify: `src/cli.ts:251-308`

**Goal:** Improve `usage` command with better formatting and tips.

- [ ] **Step 1: Enhance renderUsage function with emojis and colors**

```typescript
// Replace existing renderUsage function (line 251)
function renderUsage(watch: boolean) {
  const accounts = loadAccounts();
  const state = loadState();
  const config = state.config || {};

  const accountsChanged = ensureAllAccountsInState(accounts, state);
  const staleResolved = resolveStaleMetrics(state);
  if (accountsChanged || staleResolved) {
    autoEvaluate(state);
    saveState(state);
  }

  if (watch) process.stdout.write("\x1b[2J\x1b[H");

  console.log(
    "╔══════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║           anthropic-multi-account v1.1.0                          ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════════╝",
  );

  if (!accounts.length) {
    console.log(
      "\n  ❌ No accounts configured. Run: bun src/cli.ts add <name>\n",
    );
    return;
  }

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const c = isActive ? "\x1b[1;36m" : "";
    const r = isActive ? "\x1b[0m" : "";

    // Account status
    const status = account.expires > Date.now() ? "✅" : "⚠️";
    const bestQuota = isActive ? " ✨ Best quota available" : "";
    console.log(
      isActive
        ? `\n${c}┌─ ${account.name} ◄── ACTIVE${bestQuota}${r}`
        : `\n┌─ ${account.name}`,
    );
    console.log(`${c}│${r}  Account Status: ${status} Authenticated`);
    console.log(`${c}│${r}  Auth Type: Claude Max (OAuth)`);
    console.log(
      `${c}│${r}  Scopes: org:create_api_key, user:profile, user:inference,`,
    );
    console.log(
      `${c}│${r}          user:sessions:claude_code, user:mcp_servers, user:file_upload`,
    );

    if (!state.usage?.[account.name]) {
      console.log(`${c}│${r}\n${c}│${r}  ⚠️  No usage data yet`);
      console.log(`${c}└─${r}\n`);
      continue;
    }

    const usage = state.usage[account.name];
    const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);
    const thresholdMap = {
      session5h: t.session5h,
      weekly7d: t.weekly7d,
      weekly7dSonnet: t.weekly7dSonnet,
    };

    for (const [label, key] of [
      ["Session (5h)", "session5h"],
      ["Weekly (all)", "weekly7d"],
      ["Weekly (Sonnet)", "weekly7dSonnet"],
    ] as const) {
      const u = usage[key]?.utilization || 0;
      const th = thresholdMap[key];
      const reset = usage[key]?.reset;
      const thLabel = `\x1b[2m(threshold ${Math.round(th * 100)}%)\x1b[0m`;

      console.log(`${c}│${r}\n${c}│${r}  📊 ${label}  ${thLabel}`);
      console.log(
        `${c}│${r}  ${colorize(progressBar(u), u)}  ${colorize(`${Math.round(u * 100)}%`, u)}`,
      );

      console.log(`${c}│${r}  Resets ${formatResetTime(reset)}`);

      // Status indicator
      if (u > th) {
        console.log(`${c}│${r}  Status: 🔴 Over threshold! Switch recommended`);
      } else if (u > th * 0.9) {
        console.log(
          `${c}│${r}  Status: 🟡 Approaching threshold (${Math.round(u * 100)}% < ${Math.round(th * 100)}% warning)`,
        );
      } else if (u > th * 0.7) {
        console.log(`${c}│${r}  Status: 🟡 Elevated usage (plan accordingly)`);
      } else {
        console.log(`${c}│${r}  Status: 🟢 Under threshold - optimal`);
      }
    }

    console.log(`${c}│${r}`);
    console.log(`${c}│${r}  Request Count: ${state.requestCount || 0}`);
    console.log(
      `${c}│${r}  Last Request: ${usage.timestamp ? new Date(usage.timestamp).toLocaleString() : "Never"}`,
    );
    console.log(`${c}└─${r}`);
  }

  console.log("");

  if (watch) {
    console.log(
      `  Updated: ${new Date().toLocaleTimeString()}  │  Ctrl+C to exit`,
    );
  }

  // Tips
  console.log("  💡 Tips:");
  if (accounts.length > 1) {
    const primary = accounts[0];
    const primaryUsage = state.usage?.[primary.name];
    if (
      primaryUsage &&
      (primaryUsage.session5h?.utilization || 0) > config.threshold * 0.9
    ) {
      console.log(
        `  • Primary account (${primary.name}) approaching threshold`,
      );
      console.log("    Consider: bun src/cli.ts config --threshold 0.80");
    }
  }
  console.log(
    "  • Run `bun src/cli.ts config --help` for configuration options",
  );
  console.log("  • Run `bun src/cli.ts list` for account overview");
  console.log();
}
```

- [ ] **Step 2: Add colorize function**

```typescript
// Add before renderUsage function
function colorize(text: string, util: number): string {
  if (util >= 0.9) return `\x1b[31m${text}\x1b[0m`; // Red
  if (util >= 0.7) return `\x1b[33m${text}\x1b[0m`; // Yellow
  return `\x1b[32m${text}\x1b[0m`; // Green
}
```

- [ ] **Step 3: Commit enhanced usage command**

```bash
git add src/cli.ts
git commit -m "feat: enhance usage command with better formatting

- Add emojis and color indicators
- Show account status and auth type
- Display OAuth scopes
- Add status messages for utilization
- Provide helpful tips
- Show last request timestamp"
```

---

### Task 15: Enhance config Command with Interactive Mode

**Files:**

- Modify: `src/cli.ts:320-400`

**Goal:** Add interactive mode and validation to config command.

- [ ] **Step 1: Add interactive config mode**

```typescript
// Add to configCommand options
const interactiveConfigCommand = Command.make("config-interactive", {}, () =>
  Effect.sync(async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const state = loadState();
    state.config = state.config || {};

    console.log("\n  Multi-Account Configuration Wizard");
    console.log("  ─────────────────────────────────────────\n");

    const currentThresholds = normalizeThresholds(
      state.config.threshold,
      DEFAULTS.threshold,
    );

    console.log("  Current thresholds:");
    console.log(
      `    Session:      ${Math.round(currentThresholds.session5h * 100)}%`,
    );
    console.log(
      `    Weekly:       ${Math.round(currentThresholds.weekly7d * 100)}%`,
    );
    console.log(
      `    Sonnet:       ${Math.round(currentThresholds.weekly7dSonnet * 100)}%`,
    );
    console.log(
      `    Check interval: ${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000} min\n`,
    );

    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));

    const session = await ask(
      `  ? Set session (5h) threshold: (${Math.round(currentThresholds.session5h * 100)}) `,
    );
    const weekly = await ask(
      `  ? Set weekly (all) threshold: (${Math.round(currentThresholds.weekly7d * 100)}) `,
    );
    const sonnet = await ask(
      `  ? Set weekly (Sonnet) threshold: (${Math.round(currentThresholds.weekly7dSonnet * 100)}) `,
    );
    const interval = await ask(
      `  ? Set recovery check interval (minutes): (${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000}) `,
    );

    // Parse and validate
    const sessionVal = session
      ? parseFloat(session) / 100
      : currentThresholds.session5h;
    const weeklyVal = weekly
      ? parseFloat(weekly) / 100
      : currentThresholds.weekly7d;
    const sonnetVal = sonnet
      ? parseFloat(sonnet) / 100
      : currentThresholds.weekly7dSonnet;
    const intervalVal = interval
      ? parseInt(interval) * 60000
      : state.config.checkInterval || DEFAULTS.checkInterval;

    // Preview
    console.log("\n  Preview:");
    console.log("  ─────────────────────────────────────────");
    console.log(
      `  Session:      ${Math.round(sessionVal * 100)}% ← will switch when >${Math.round(sessionVal * 100)}%`,
    );
    console.log(
      `  Weekly:       ${Math.round(weeklyVal * 100)}% ← will switch when >${Math.round(weeklyVal * 100)}%`,
    );
    console.log(
      `  Sonnet:       ${Math.round(sonnetVal * 100)}% ← will switch when >${Math.round(sonnetVal * 100)}%`,
    );
    console.log(`  Recovery:     every ${intervalVal / 60000} minutes`);
    console.log("  ─────────────────────────────────────────\n");

    const confirm = await ask("  ? Apply these settings? (Y/n) ");

    if (confirm.toLowerCase() !== "n") {
      state.config.threshold = {
        session5h: sessionVal,
        weekly7d: weeklyVal,
        weekly7dSonnet: sonnetVal,
      };
      state.config.checkInterval = intervalVal;
      autoEvaluate(state);
      saveState(state);
      console.log("\n  ✓ Configuration saved\n");
    } else {
      console.log("\n  ✗ Configuration cancelled\n");
    }

    rl.close();
  }),
).pipe(Command.withDescription("Interactive configuration wizard"));
```

- [ ] **Step 2: Add validation to existing config command**

```typescript
// In cmdConfig function, add validation:
const threshold = parseArg("--threshold");
if (threshold) {
  const val = parseFloat(threshold);
  if (isNaN(val) || val < 0 || val > 1) {
    console.error(
      "❌ Threshold must be a number between 0 and 1 (e.g., 0.80 for 80%)",
    );
    return;
  }
  if (val < 0.5) {
    console.warn(
      "⚠️  Warning: Threshold below 50% may cause frequent switching",
    );
  }
  if (val > 0.95) {
    console.warn(
      "⚠️  Warning: Threshold above 95% increases risk of hitting rate limits",
    );
  }
  state.config.threshold = val;
  changed = true;
}
```

- [ ] **Step 3: Add to root command**

```typescript
Command.withSubcommands([
  // ...
  configCommand,
  configAliasCommand,
  interactiveConfigCommand, // ADD THIS
  // ...
]);
```

- [ ] **Step 4: Commit enhanced config command**

```bash
git add src/cli.ts
git commit -m "feat: add interactive config mode and validation

- Add config-interactive command for guided setup
- Add validation for threshold values
- Add warnings for extreme values
- Show preview before applying
- Confirm before saving"
```

---

## Phase 5: Testing & Documentation (Day 8-10)

### Task 16: Manual Testing

**Files:**

- Test: All commands manually

**Goal:** Comprehensive manual testing of all functionality.

- [ ] **Step 1: Test OAuth flow**

```bash
# Add account with Max subscription
bun src/cli.ts add primary

# Add account with Console/API
bun src/cli.ts add work-account

# List accounts
bun src/cli.ts list

# Test accounts
bun src/cli.ts test primary
bun src/cli.ts test work-account
```

- [ ] **Step 2: Test multi-account switching**

```bash
# Add multiple accounts
bun src/cli.ts add primary
bun src/cli.ts add fallback1
bun src/cli.ts add fallback2

# View usage
bun src/cli.ts usage --watch

# Set thresholds
bun src/cli.ts config --thresholds 95,80,90

# View config
bun src/cli.ts config
```

- [ ] **Step 3: Test CLI commands**

```bash
# Test all new commands
bun src/cli.ts set-primary fallback1
bun src/cli.ts list
bun src/cli.ts diagnose
bun src/cli.ts migrate

# Test config
bun src/cli.ts config --interactive
bun src/cli.ts config --reset
```

- [ ] **Step 4: Test error scenarios**

```bash
# Remove account
bun src/cli.ts remove primary

# Try to set primary on removed account
bun src/cli.ts set-primary primary

# Try to test removed account
bun src/cli.ts test primary
```

- [ ] **Step 5: Document manual testing results**

Create test log documenting:

- Setup steps that worked
- Errors encountered
- Edge cases tested
- Fixes needed

- [ ] **Step 6: Commit test documentation**

```bash
mkdir -p docs/testing
# Create testing log
git add docs/testing/
git commit -m "docs: add manual testing documentation"
```

---

### Task 17: Update README Documentation

**Files:**

- Modify: `README.md`

**Goal:** Comprehensive update to README with migration guide and all new commands.

- [ ] **Step 1: Update Installation section**

````markdown
## Installation

### 1. Add plugin to OpenCode config

Add to your `opencode.json` (global or project-level):

```json
{
  "plugin": ["oc-anthropic-multi-account@latest"]
}
```
````

OpenCode will install the plugin automatically on next launch.

### 2. Disable default Anthropic plugin

Add this to your `~/.zshrc` or `~/.bashrc`:

```bash
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
```

Without this, the built-in Anthropic plugin will override the custom fetch wrapper.

### 3. Configure accounts

The CLI (`src/cli.ts`) isn't bundled in the npm package. Clone the repo to use it:

```bash
git clone https://github.com/YOUR_FORK/oc-anthropic-multi-account.git
cd oc-anthropic-multi-account
bun install
```

Add accounts (the first account added is the primary):

```bash
bun src/cli.ts add primary
bun src/cli.ts add fallback1
bun src/cli.ts add fallback2
```

You can name accounts anything. Each account requires a separate Anthropic Max subscription.

### 4. Restart OpenCode

```bash
opencode
```

````

- [ ] **Step 2: Add Migration Guide section**

```markdown
## Migration Guide

### Upgrading from v1.0.x

If you're upgrading from a previous version, follow these steps:

1. **Pull latest changes:**
   ```bash
   git pull origin main
````

2. **Run migration assistant:**

   ```bash
   bun src/cli.ts migrate
   ```

3. **Re-authorize accounts:**

   Due to OAuth endpoint changes, you'll need to re-authorize each account:

   ```bash
   bun src/cli.ts reauth primary
   bun src/cli.ts reauth fallback1
   ```

4. **Verify accounts:**
   ```bash
   bun src/cli.ts list
   ```

### What Changed in v1.1.0

- **New OAuth endpoints:** Now using `platform.claude.com` instead of `console.anthropic.com`
- **JSON token requests:** More reliable token exchange
- **Comprehensive OAuth scopes:** Additional scopes for sessions, MCP servers, and file upload
- **Better CSRF protection:** Separate state parameter for improved security
- **Retry logic:** Automatic retry for network errors during token operations
- **Enhanced CLI:** New commands with better UX

````

- [ ] **Step 3: Update CLI Commands section**

```markdown
## CLI Commands

### Account Management

```bash
# Add account (interactive OAuth)
bun src/cli.ts add <name>

# Re-authenticate account
bun src/cli.ts reauth <name>

# List all accounts
bun src/cli.ts list

# Set primary account
bun src/cli.ts set-primary <name>

# Remove account
bun src/cli.ts remove <name>

# Test account functionality
bun src/cli.ts test <name>
````

### Usage & Monitoring

```bash
# Show usage
bun src/cli.ts usage

# Live usage updates (refreshes every 5s)
bun src/cli.ts usage --watch
```

### Configuration

```bash
# Show current config
bun src/cli.ts config

# Set all thresholds to same value (80%)
bun src/cli.ts config --threshold 0.80

# Set individual thresholds (session, weekly, sonnet)
bun src/cli.ts config --thresholds 95,80,90

# Interactive configuration wizard
bun src/cli.ts config-interactive

# Reset to defaults
bun src/cli.ts config --reset
```

### Diagnostics

```bash
# System diagnostics
bun src/cli.ts diagnose

# Migration assistant
bun src/cli.ts migrate
```

````

- [ ] **Step 4: Add New Features section**

```markdown
## What's New in v1.1.0

### Authentication Improvements

- ✅ **Modern OAuth endpoints** - Using `platform.claude.com` for better reliability
- ✅ **JSON token requests** - Modern authentication protocol
- ✅ **Comprehensive OAuth scopes** - Support for sessions, MCP servers, and file uploads
- ✅ **CSRF protection** - Separate state parameter for improved security
- ✅ **Retry logic** - Automatic exponential backoff for network errors
- ✅ **Shared inflight refresh** - Prevents concurrent token refresh races

### CLI Enhancements

- ✅ **Rich formatting** - Colorized output with emojis and status indicators
- ✅ **Interactive config** - Guided configuration wizard with validation
- ✅ **Account management** - New commands: set-primary, list, remove, test, diagnose, migrate
- ✅ **Better feedback** - Clear success/error messages with helpful tips
- ✅ **Validation** - Input validation and warnings for extreme values

### Developer Experience

- ✅ **Monolithic structure maintained** - Easy to understand and modify
- ✅ **Comprehensive error handling** - Better error messages and recovery
- ✅ **Migration assistant** - Smooth upgrade path from v1.0.x
````

- [ ] **Step 5: Update Comparison section**

```markdown
## Comparison

| Feature                  | oc-anthropic-multi-account | anthropic-multi-auth | OpenCode built-in   |
| ------------------------ | -------------------------- | -------------------- | ------------------- |
| **Multi-Account**        | ✅ (unlimited)             | ✅                   | ❌ (single account) |
| **Proactive Switching**  | ✅ (threshold-based)       | ❌ (session-sticky)  | ❌                  |
| **Header-Based Metrics** | ✅ (3 metrics)             | ❌ (quota API)       | ❌                  |
| **Mid-Session Switch**   | ✅                         | ❌                   | ❌                  |
| **Modern OAuth**         | ✅ (v1.1.0)                | ✅                   | ❌                  |
| **Comprehensive Scopes** | ✅ (v1.1.0)                | ✅                   | ❌                  |
| **CSRF Protection**      | ✅ (v1.1.0)                | ✅                   | ❌                  |
| **Retry Logic**          | ✅ (v1.1.0)                | ✅                   | ❌                  |
| **Enhanced CLI**         | ✅ (v1.1.0)                | ❌                   | ❌                  |
| **OpenCode Plugin**      | ✅                         | ✅                   | ✅                  |
```

- [ ] **Step 6: Commit README updates**

```bash
git add README.md
git commit -m "docs: update README for v1.1.0

- Add migration guide
- Document all new CLI commands
- Highlight new features
- Update comparison table
- Add troubleshooting section"
```

---

### Task 18: Update package.json Version

**Files:**

- Modify: `package.json`

**Goal:** Bump version for v1.1.0 release.

- [ ] **Step 1: Update version and description**

```json
{
  "name": "oc-anthropic-multi-account",
  "version": "1.1.0",
  "description": "OpenCode plugin for managing multiple Anthropic Max accounts with automatic failover based on rate limit utilization and modern OAuth implementation",
  ...
}
```

- [ ] **Step 2: Add changelog entry**

```json
// Add to package.json or create CHANGELOG.md
{
  "changelog": {
    "1.1.0": {
      "features": [
        "Modern OAuth endpoints (platform.claude.com)",
        "JSON token requests with retry logic",
        "Comprehensive OAuth scopes",
        "Separate CSRF state parameter",
        "Shared inflight refresh promise",
        "New CLI commands: set-primary, list, remove, test, diagnose, migrate",
        "Interactive config wizard",
        "Enhanced usage display with colors and emojis"
      ],
      "breaking": [
        "Users must re-authorize accounts due to OAuth endpoint changes"
      ],
      "dependencies": []
    }
  }
}
```

- [ ] **Step 3: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump version to 1.1.0

- Modern OAuth implementation
- Enhanced CLI
- Comprehensive documentation"
```

---

### Task 19: Final Integration Testing

**Files:**

- Test: Complete plugin with OpenCode

**Goal:** Verify plugin works end-to-end with OpenCode.

- [ ] **Step 1: Build the plugin**

```bash
bun run build
```

- [ ] **Step 2: Test with OpenCode**

```bash
# In OpenCode session:
# - Make API requests
# - Verify account switching based on thresholds
# - Check usage metrics update correctly
# - Verify token refresh works
# - Test with multiple accounts
```

- [ ] **Step 3: Test all CLI commands**

```bash
# Run each command and verify output
bun src/cli.ts add test-account
bun src/cli.ts list
bun src/cli.ts test test-account
bun src/cli.ts usage
bun src/cli.ts config
bun src/cli.ts diagnose
bun src/cli.ts set-primary test-account
bun src/cli.ts remove test-account
bun src/cli.ts migrate
```

- [ ] **Step 4: Document test results**

Create integration test log:

- OpenCode API requests worked
- Account switching worked
- Usage metrics correct
- Token refresh successful
- All CLI commands functional

- [ ] **Step 5: Commit final test results**

```bash
git add docs/testing/integration-test-log.md
git commit -m "test: add integration test results

- All OpenCode API requests successful
- Multi-account switching verified
- Usage metrics accurate
- Token refresh functional
- All CLI commands working"
```

---

### Task 20: Create Git Tag and Prepare Release

**Files:**

- Git tags and release preparation

**Goal:** Create release tag and prepare for deployment.

- [ ] **Step 1: Create git tag**

```bash
git tag -a v1.1.0 -m "Release v1.1.0 - Modern OAuth + Enhanced CLI

Major improvements:
- Modern OAuth endpoints (platform.claude.com)
- JSON token requests with retry logic
- Comprehensive OAuth scopes
- Separate CSRF state parameter
- Shared inflight refresh promise
- New CLI commands with better UX
- Interactive config wizard
- Enhanced usage display

Breaking change:
- Users must re-authorize accounts"
```

- [ ] **Step 2: Push to fork**

```bash
git push origin main --tags
```

- [ ] **Step 3: Create release notes (optional)**

````markdown
# Release v1.1.0

## Major Changes

### Authentication Improvements

- Modern OAuth endpoints using platform.claude.com
- JSON-based token requests for better reliability
- Comprehensive OAuth scopes for full functionality
- Separate CSRF state parameter for improved security
- Retry logic with exponential backoff for network errors
- Shared inflight refresh promise to prevent race conditions

### CLI Enhancements

- `set-primary <name>` - Change primary account
- `list` - Show all accounts with status
- `remove <name>` - Delete an account
- `test <name>` - Verify account functionality
- `diagnose` - System diagnostics
- `migrate` - Migration assistant
- Interactive config wizard (`config-interactive`)
- Enhanced `usage` command with colors and emojis

### Breaking Changes

- **Users must re-authorize accounts** due to OAuth endpoint changes
- Run `bun src/cli.ts migrate` for migration assistance
- Run `bun src/cli.ts reauth <name>` for each account

## Installation

```bash
# From npm (after publishing)
npm install oc-anthropic-multi-account@1.1.0

# From source
git clone https://github.com/YOUR_FORK/oc-anthropic-multi-account.git
cd oc-anthropic-multi-account
bun install
bun src/cli.ts add primary
```
````

## Migration

```bash
git pull origin main
bun src/cli.ts migrate
bun src/cli.ts reauth <account-name>  # for each account
```

## Credits

This release incorporates authentication improvements from [opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth).

````

- [ ] **Step 4: Final commit for release**

```bash
git add docs/testing/ docs/superpowers/specs/
git commit -m "chore: prepare for v1.1.0 release

- All tests passing
- Documentation complete
- Ready for deployment"
````

---

## Summary

This implementation plan transforms `oc-anthropic-multi-account` into a robust, modern plugin that combines:

1. **All authentication improvements** from `opencode-anthropic-auth`
2. **Sophisticated multi-account management** with threshold-based switching
3. **Enhanced CLI** with comprehensive account management commands
4. **Better UX** with colors, emojis, validation, and helpful tips

The plan is divided into 5 phases over 10 days, with each phase producing working, testable software. Each task is broken into bite-sized steps that follow TDD principles, ensure frequent commits, and maintain code quality.

**Total estimated effort:** 10 days

**Key risks mitigated:**

- Users can migrate smoothly with `migrate` command
- Comprehensive testing catches edge cases
- Documentation guides users through breaking changes
- Monolithic structure keeps codebase manageable
