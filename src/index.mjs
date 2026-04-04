import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

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
const AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");
const CONFIG_DIR = join(homedir(), ".config/opencode");
const MULTI_AUTH_FILE = join(CONFIG_DIR, "anthropic-multi-account-accounts.json");
const LEGACY_MULTI_AUTH_FILE_CONFIG = join(CONFIG_DIR, "anthropic-multi-accounts.json");
const LEGACY_MULTI_AUTH_FILE = join(homedir(), ".local/share/opencode/multi-account-auth.json");
const STATE_FILE = join(CONFIG_DIR, "anthropic-multi-account-state.json");
const LEGACY_STATE_FILE = join(homedir(), ".local/share/opencode/multi-account-state.json");

function readJsonWithFallback(filePaths, fallback) {
  for (const filePath of filePaths) {
    const data = safeReadJSON(filePath, null);
    if (data !== null) return { data, sourcePath: filePath };
  }
  return { data: fallback, sourcePath: null };
}

function normalizeAccountFields(account) {
  if (!account || typeof account !== "object") {
    return account;
  }

  const normalized = { ...account };
  let changed = false;

  if ((!normalized.access || typeof normalized.access !== "string") && typeof normalized.accessToken === "string") {
    normalized.access = normalized.accessToken;
    changed = true;
  }

  if ((!normalized.refresh || typeof normalized.refresh !== "string") && typeof normalized.refreshToken === "string") {
    normalized.refresh = normalized.refreshToken;
    changed = true;
  }

  if (typeof normalized.expires !== "number") {
    if (typeof normalized.expiresAt === "number" && Number.isFinite(normalized.expiresAt)) {
      normalized.expires = normalized.expiresAt;
      changed = true;
    } else if (typeof normalized.expiresAt === "string") {
      const parsed = Date.parse(normalized.expiresAt);
      if (Number.isFinite(parsed)) {
        normalized.expires = parsed;
        changed = true;
      }
    }
  }

  return changed ? normalized : account;
}

function normalizeMultiAuthShape(multiAuth) {
  if (!multiAuth || typeof multiAuth !== "object" || !Array.isArray(multiAuth.accounts)) {
    return { value: multiAuth, changed: false };
  }

  let changed = false;
  const accounts = multiAuth.accounts.map((account) => {
    const normalized = normalizeAccountFields(account);
    if (normalized !== account) changed = true;
    return normalized;
  });

  if (!changed) {
    return { value: multiAuth, changed: false };
  }

  return { value: { ...multiAuth, accounts }, changed: true };
}

function getAccountExpiry(account) {
  const normalized = normalizeAccountFields(account);
  if (typeof normalized?.expires === "number" && Number.isFinite(normalized.expires)) {
    return normalized.expires;
  }
  return 0;
}

function hasRefreshToken(account) {
  return typeof account?.refresh === "string" && account.refresh.length > 0;
}

function pickPreferredAccount(current, candidate) {
  if (!current) return candidate;

  const currentHasRefresh = hasRefreshToken(current);
  const candidateHasRefresh = hasRefreshToken(candidate);

  if (candidateHasRefresh && !currentHasRefresh) {
    return candidate;
  }

  if (getAccountExpiry(candidate) > getAccountExpiry(current)) {
    return candidate;
  }

  return current;
}

function mergeMultiAuthSources(sourceDataList) {
  const mergedByName = new Map();
  let requestCount = 0;

  for (const source of sourceDataList) {
    if (!source || !Array.isArray(source.accounts)) continue;

    if (typeof source.requestCount === "number" && source.requestCount > requestCount) {
      requestCount = source.requestCount;
    }

    for (const rawAccount of source.accounts) {
      const account = normalizeAccountFields(rawAccount);
      if (!account?.name) continue;
      const current = mergedByName.get(account.name);
      mergedByName.set(account.name, pickPreferredAccount(current, account));
    }
  }

  if (mergedByName.size === 0) return null;

  return {
    accounts: Array.from(mergedByName.values()),
    requestCount,
  };
}

// Safe JSON read with .bak fallback
function safeReadJSON(filePath, fallback) {
  for (const path of [filePath, filePath + '.bak']) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (path.endsWith('.bak')) {
        console.log(`[multi-account] Recovered ${filePath} from backup`);
      }
      return data;
    } catch {
      continue;
    }
  }
  return fallback;
}

// Atomic write: backup current → write to .tmp → rename to target
function safeWriteJSON(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      copyFileSync(filePath, filePath + '.bak');
    }
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[multi-account] Failed to save ${filePath}:`, e);
  }
}

// Read multi-account-auth.json (separate file for multi-account tokens)
function getMultiAuth() {
  const sourcePaths = [
    MULTI_AUTH_FILE,
    LEGACY_MULTI_AUTH_FILE_CONFIG,
    LEGACY_MULTI_AUTH_FILE,
  ];

  const sources = [];

  for (const sourcePath of sourcePaths) {
    const data = safeReadJSON(sourcePath, null);
    if (!data || typeof data !== "object") continue;

    const normalized = normalizeMultiAuthShape(data);
    if (!normalized.value || !Array.isArray(normalized.value.accounts)) continue;
    sources.push({ sourcePath, data: normalized.value });
  }

  if (sources.length === 0) return null;

  const merged = mergeMultiAuthSources(sources.map((source) => source.data));
  if (!merged) return null;

  const canonical = sources.find((source) => source.sourcePath === MULTI_AUTH_FILE)?.data ?? null;

  if (!canonical || JSON.stringify(canonical) !== JSON.stringify(merged)) {
    saveMultiAuth(merged);
  }

  return merged;
}

// Save multi-account-auth.json
function saveMultiAuth(multiAuth) {
  safeWriteJSON(MULTI_AUTH_FILE, multiAuth);
}

// Read state.json (usage, currentAccount, requestCount)
function getState() {
  const { data, sourcePath } = readJsonWithFallback(
    [STATE_FILE, LEGACY_STATE_FILE],
    {}
  );

  if (sourcePath === LEGACY_STATE_FILE && data && typeof data === "object") {
    saveState(data);
  }

  return data;
}

// Save state.json
function saveState(state) {
  safeWriteJSON(STATE_FILE, state);
}

function createOAuthTokenRequestInit(params) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "undefined" && value !== null) {
      body.set(key, String(value));
    }
  }

  return {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": CLAUDE_CLI_USER_AGENT,
    },
    body: body.toString(),
  };
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * @param {"max" | "console"} mode
 */
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

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} [state]
 */
async function exchange(code, verifier, state) {
  // Accept both full callback URL and raw code
  try {
    const url = new URL(code);
    const codeParam = url.searchParams.get("code");
    if (codeParam) {
      code = codeParam;
    }
  } catch {
    // Not a URL — use as-is
  }
  const splits = code.split("#");
  const result = await fetch(TOKEN_URL, createOAuthTokenRequestInit({
      code: splits[0],
      state: state || splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: CODE_CALLBACK_URL,
      code_verifier: verifier,
    }));
  if (!result.ok)
    return {
      type: "failed",
    };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Select account using weighted rotation
 * @param {Array} accounts
 * @param {number} requestCount
 */
// DEPRECATED: Replaced by selectThresholdAccount() in Task 3
// function selectWeightedAccount(accounts, requestCount) {
//   if (!accounts || accounts.length === 0) return null;
//
//   const totalWeight = accounts.reduce((sum, acc) => sum + (acc.weight || 1), 0);
//   const position = requestCount % totalWeight;
//
//   let cumulative = 0;
//   for (const account of accounts) {
//     cumulative += (acc.weight || 1);
//     if (position < cumulative) return account;
//   }
//   return accounts[0];
// }

/**
 * Normalize threshold/recover config - supports both a single number and per-metric object.
 * @param {number|{session5h?: number, weekly7d?: number, weekly7dSonnet?: number}} value
 * @param {number} fallback
 */
function normalizeThresholds(value, fallback) {
  if (typeof value === 'number') return { session5h: value, weekly7d: value, weekly7dSonnet: value };
  if (typeof value === 'object' && value !== null) {
    return {
      session5h: value.session5h ?? fallback,
      weekly7d: value.weekly7d ?? fallback,
      weekly7dSonnet: value.weekly7dSonnet ?? fallback
    };
  }
  return { session5h: fallback, weekly7d: fallback, weekly7dSonnet: fallback };
}

const EMPTY_USAGE = {
  session5h: { utilization: 0, reset: null, status: 'allowed' },
  weekly7d: { utilization: 0, reset: null, status: 'allowed' },
  weekly7dSonnet: { utilization: 0, reset: null, status: 'allowed' },
  timestamp: null
};

const AUTH_FAILURE_COOLDOWN = 60 * 60 * 1000;

function ensureAllAccountsInState(accounts, state) {
  if (!accounts?.length) return false;
  state.usage = state.usage || {};
  let changed = false;
  for (const account of accounts) {
    if (!state.usage[account.name]) {
      state.usage[account.name] = structuredClone(EMPTY_USAGE);
      changed = true;
    }
  }
  return changed;
}

function resolveStaleMetrics(state) {
  const usage = state.usage;
  if (!usage) return false;
  const now = Date.now();
  let changed = false;
  for (const accountName of Object.keys(usage)) {
    for (const key of ['session5h', 'weekly7d', 'weekly7dSonnet']) {
      const metric = usage[accountName]?.[key];
      if (metric?.reset && metric.reset * 1000 < now && metric.utilization > 0) {
        metric.utilization = 0;
        metric.status = 'allowed';
        changed = true;
      }
    }
  }
  return changed;
}

function selectThresholdAccount(accounts, state) {
  const config = state?.config || {};
  const thresholds = normalizeThresholds(config.threshold, 0.70);
  const CHECK_INTERVAL = config.checkInterval ?? 3600000;
  const now = Date.now();
  const authFailures = state?.authFailures || {};

  function isTemporarilyUnavailable(accountName) {
    const until = authFailures?.[accountName];
    return typeof until === 'number' && until > now;
  }

  if (!accounts || accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];

  const primary = accounts[0];
  const fallbacks = accounts.slice(1);

  if (!state || !state.currentAccount) {
    return primary;
  }

  function isOverThreshold(usage) {
    if (!usage) return false;
    return (
      (usage.session5h?.utilization || 0) > thresholds.session5h ||
      (usage.weekly7d?.utilization || 0) > thresholds.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > thresholds.weekly7dSonnet
    );
  }

  function getExceededMetric(usage) {
    if (!usage) return { name: 'unknown', value: 0, threshold: 1 };
    const metrics = [
      { name: 'session (5h)', value: usage.session5h?.utilization || 0, threshold: thresholds.session5h },
      { name: 'weekly (all)', value: usage.weekly7d?.utilization || 0, threshold: thresholds.weekly7d },
      { name: 'weekly (Sonnet)', value: usage.weekly7dSonnet?.utilization || 0, threshold: thresholds.weekly7dSonnet }
    ];
    return metrics.reduce((max, m) => (m.value / m.threshold) > (max.value / max.threshold) ? m : max);
  }

  function getUtilizationScore(usage) {
    if (!usage) return 0;
    return Math.max(
      (usage.session5h?.utilization || 0) / thresholds.session5h,
      (usage.weekly7d?.utilization || 0) / thresholds.weekly7d,
      (usage.weekly7dSonnet?.utilization || 0) / thresholds.weekly7dSonnet
    );
  }

  const primaryUsage = state.usage?.[primary.name];
  const currentIsPrimary = state.currentAccount === primary.name;

  if (currentIsPrimary) {
    if (isOverThreshold(primaryUsage)) {
      for (const fallback of fallbacks) {
        const fallbackUsage = state.usage?.[fallback.name];
        if (!isOverThreshold(fallbackUsage) && !isTemporarilyUnavailable(fallback.name)) {
          const exceeded = getExceededMetric(primaryUsage);
          console.log(`[multi-account] ${primary.name} → ${fallback.name}: ${exceeded.name} at ${Math.round(exceeded.value * 100)}% (threshold ${Math.round(exceeded.threshold * 100)}%)`);
          return fallback;
        }
      }
      const availableFallbacks = fallbacks.filter((fallback) => !isTemporarilyUnavailable(fallback.name));
      const pool = availableFallbacks.length > 0 ? availableFallbacks : fallbacks;
      const best = pool.reduce((lowest, f) => {
        return getUtilizationScore(state.usage?.[f.name]) < getUtilizationScore(state.usage?.[lowest.name]) ? f : lowest;
      }, pool[0]);
      const exceeded = getExceededMetric(primaryUsage);
      console.log(`[multi-account] ${primary.name} → ${best.name}: ${exceeded.name} at ${Math.round(exceeded.value * 100)}% (all accounts busy)`);
      return best;
    }
    return primary;
  } else {
    const lastCheck = state.lastPrimaryCheck || 0;
    
    function getEarliestResetTime(usage) {
      if (!usage) return null;
      const resets = [
        usage.session5h?.reset,
        usage.weekly7d?.reset,
        usage.weekly7dSonnet?.reset
      ].filter(r => r != null);
      if (resets.length === 0) return null;
      return Math.min(...resets) * 1000;
    }
    
    const earliestReset = getEarliestResetTime(primaryUsage);
    const resetPassed = earliestReset && earliestReset <= now && earliestReset > lastCheck;
    const intervalPassed = (now - lastCheck) > CHECK_INTERVAL;
    
    if (resetPassed || intervalPassed) {
      state.lastPrimaryCheck = now;
      
      if (!isOverThreshold(primaryUsage)) {
        console.log(`[multi-account] → ${primary.name}: under threshold, switching back`);
        return primary;
      }
    }
    
    const current = accounts.find((candidate) => candidate.name === state.currentAccount);
    if (current && !isTemporarilyUnavailable(current.name)) {
      return current;
    }

    const nextFallback = fallbacks.find((fallback) => !isTemporarilyUnavailable(fallback.name));
    return nextFallback || primary;
  }
}

async function ensureFreshAccountToken(account, multiAuth) {
  if (account.access && account.expires > Date.now()) {
    return { ok: true };
  }

  const response = await fetch(
    TOKEN_URL,
    createOAuthTokenRequestInit({
      grant_type: "refresh_token",
      refresh_token: account.refresh,
      client_id: CLIENT_ID,
    }),
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
    };
  }

  const json = await response.json();
  account.access = json.access_token;
  account.refresh = json.refresh_token;
  account.expires = Date.now() + json.expires_in * 1000;
  account.accessToken = account.access;
  account.refreshToken = account.refresh;
  account.expiresAt = account.expires;

  saveMultiAuth(multiAuth);

  return { ok: true };
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  return {
    "experimental.chat.system.transform": (input, output) => {
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1])
          output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();

        // Bug fix: handle undefined auth
        if (!auth) return {};

        // Check for multi-account mode by reading separate multi-account-auth.json
        const multiAuth = getMultiAuth();
        const hasMultiAccounts = multiAuth?.accounts?.length > 0;

        // Handle multi-account auth
        if (auth.type === "oauth" && hasMultiAccounts) {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }

          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              // Read accounts from multi-account-auth.json, state from state.json
              const multiAuth = getMultiAuth();
              if (!multiAuth?.accounts?.length) {
                return fetch(input, init);
              }

              const accounts = multiAuth.accounts;
              const state = getState();

               ensureAllAccountsInState(accounts, state);
               resolveStaleMetrics(state);

               let account = selectThresholdAccount(accounts, state);
               if (!account) {
                 throw new Error("No accounts configured for multi-account");
               }

               // Track state for threshold logic
               const previousAccount = state.currentAccount;
               const primaryName = accounts[0]?.name;
               state.currentAccount = account.name;
               if (account.name !== previousAccount && account.name !== primaryName) {
                 state.lastPrimaryCheck = Date.now();
               }

               // Refresh account token, fallback to other account on token failure.
               const attemptedAccounts = new Set();
               while (true) {
                 const refreshResult = await ensureFreshAccountToken(account, multiAuth);
                 if (refreshResult.ok) break;

                 attemptedAccounts.add(account.name);
                 const fallback = accounts.find((candidate) => !attemptedAccounts.has(candidate.name));
                 if (!fallback) {
                   throw new Error(`Token refresh failed for ${account.name}: ${refreshResult.status}`);
                 }

                 console.warn(`[multi-account] refresh failed for ${account.name} (${refreshResult.status}), trying ${fallback.name}`);
                 account = fallback;
                 state.currentAccount = account.name;
                 if (account.name !== previousAccount && account.name !== primaryName) {
                   state.lastPrimaryCheck = Date.now();
                 }
               }

              // Increment request counter
              state.requestCount = (state.requestCount || 0) + 1;

              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Preserve all incoming beta headers while ensuring OAuth requirements
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = REQUIRED_BETAS;
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].join(",");

              requestHeaders.set("authorization", `Bearer ${account.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              requestHeaders.set(
                "user-agent",
                CLAUDE_CLI_USER_AGENT,
              );
              requestHeaders.delete("x-api-key");

              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item) => {
                      if (item.type === "text" && item.text) {
                        return {
                          ...item,
                          text: item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude"),
                        };
                      }
                      return item;
                    });
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool) => ({
                      ...tool,
                      name: tool.name
                        ? `${TOOL_PREFIX}${tool.name}`
                        : tool.name,
                    }));
                  }
                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map((msg) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content.map((block) => {
                          if (block.type === "tool_use" && block.name) {
                            return {
                              ...block,
                              name: `${TOOL_PREFIX}${block.name}`,
                            };
                          }
                          return block;
                        });
                      }
                      return msg;
                    });
                  }
                  body = JSON.stringify(parsed);
                } catch (e) {
                  // ignore parse errors
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              function isScopeFailureResponse(responseBody, status) {
                if (status !== 401 && status !== 403) return false;
                if (!responseBody) return status === 401;
                const text = responseBody.toLowerCase();
                return (
                  text.includes("scope requirement") ||
                  text.includes("oauth token does not meet scope requirement") ||
                  text.includes("invalid oauth token") ||
                  text.includes("unauthorized")
                );
              }

              const attemptedRequestAccounts = new Set();
              let response;

              while (true) {
                attemptedRequestAccounts.add(account.name);
                requestHeaders.set("authorization", `Bearer ${account.access}`);

                response = await fetch(requestInput, {
                  ...requestInit,
                  body,
                  headers: requestHeaders,
                });

                if (response.status !== 401 && response.status !== 403) {
                  break;
                }

                let responseBody = "";
                try {
                  responseBody = await response.clone().text();
                } catch {
                  responseBody = "";
                }

                if (!isScopeFailureResponse(responseBody, response.status)) {
                  break;
                }

                state.authFailures = state.authFailures || {};
                state.authFailures[account.name] = Date.now() + AUTH_FAILURE_COOLDOWN;

                const retryAccount = accounts.find(
                  (candidate) =>
                    !attemptedRequestAccounts.has(candidate.name) &&
                    (!state.authFailures?.[candidate.name] || state.authFailures[candidate.name] <= Date.now()),
                );

                if (!retryAccount) {
                  break;
                }

                console.warn(`[multi-account] auth scope failed for ${account.name}, trying ${retryAccount.name}`);
                account = retryAccount;
                state.currentAccount = account.name;
                if (account.name !== previousAccount && account.name !== primaryName) {
                  state.lastPrimaryCheck = Date.now();
                }

                const retryRefresh = await ensureFreshAccountToken(account, multiAuth);
                if (!retryRefresh.ok) {
                  state.authFailures[account.name] = Date.now() + AUTH_FAILURE_COOLDOWN;
                  continue;
                }
              }

              if (state.authFailures?.[account.name]) {
                delete state.authFailures[account.name];
              }

              // Capture usage from response headers and save to state
              // Only update metrics when headers are actually present to avoid
              // overwriting valid data with zeros (e.g. Sonnet headers only appear on Sonnet requests)
              state.usage = state.usage || {};
              const prev = state.usage[account.name] || {};

              function updateMetric(prev, prefix) {
                const rawUtil = response.headers.get(`${prefix}-utilization`);
                const rawReset = response.headers.get(`${prefix}-reset`);
                const rawStatus = response.headers.get(`${prefix}-status`);
                if (rawUtil === null && rawReset === null && rawStatus === null) {
                  return prev;
                }
                const newReset = rawReset !== null ? (parseInt(rawReset) || null) : null;
                if (!newReset && prev) {
                  return prev;
                }
                return {
                  utilization: rawUtil !== null ? (parseFloat(rawUtil) || 0) : (prev?.utilization ?? 0),
                  reset: newReset || (prev?.reset ?? null),
                  status: rawStatus !== null ? rawStatus : (prev?.status ?? 'unknown')
                };
              }

              state.usage[account.name] = {
                session5h: updateMetric(prev.session5h, 'anthropic-ratelimit-unified-5h'),
                weekly7d: updateMetric(prev.weekly7d, 'anthropic-ratelimit-unified-7d'),
                weekly7dSonnet: updateMetric(prev.weekly7dSonnet, 'anthropic-ratelimit-unified-7d_sonnet'),
                timestamp: new Date().toISOString()
              };

              // Save state (usage, currentAccount, requestCount)
              saveState(state);

              // Transform streaming response to rename tools back
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        // Handle single OAuth auth (original behavior)
        if (auth.type === "oauth") {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);
              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch(
                  TOKEN_URL,
                  createOAuthTokenRequestInit({
                    grant_type: "refresh_token",
                    refresh_token: auth.refresh,
                    client_id: CLIENT_ID,
                  }),
                );
                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status}`);
                }
                const json = await response.json();
                await client.auth.set({
                  path: {
                    id: "anthropic",
                  },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                });
                auth.access = json.access_token;
              }
              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Preserve all incoming beta headers while ensuring OAuth requirements
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = REQUIRED_BETAS;
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].join(",");

              requestHeaders.set("authorization", `Bearer ${auth.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              requestHeaders.set(
                "user-agent",
                CLAUDE_CLI_USER_AGENT,
              );
              requestHeaders.delete("x-api-key");

              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item) => {
                      if (item.type === "text" && item.text) {
                        return {
                          ...item,
                          text: item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude"),
                        };
                      }
                      return item;
                    });
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool) => ({
                      ...tool,
                      name: tool.name
                        ? `${TOOL_PREFIX}${tool.name}`
                        : tool.name,
                    }));
                  }
                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map((msg) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content.map((block) => {
                          if (block.type === "tool_use" && block.name) {
                            return {
                              ...block,
                              name: `${TOOL_PREFIX}${block.name}`,
                            };
                          }
                          return block;
                        });
                      }
                      return msg;
                    });
                  }
                  body = JSON.stringify(parsed);
                } catch (e) {
                  // ignore parse errors
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Transform streaming response to rename tools back
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier, state } = await authorize("max");
            return {
              url: url,
              instructions: "Paste the callback URL or authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier, state);
                return credentials;
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier, state } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the callback URL or authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier, state);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}

export default AnthropicAuthPlugin;
