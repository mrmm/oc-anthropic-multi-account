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
const DATA_FILE = join(CONFIG_DIR, "anthropic-multi-account.json");

// Legacy file paths (for migration)
const LEGACY_ACCOUNTS_FILE = join(CONFIG_DIR, "anthropic-multi-account-accounts.json");
const LEGACY_ACCOUNTS_FILE_CONFIG = join(CONFIG_DIR, "anthropic-multi-accounts.json");
const LEGACY_ACCOUNTS_FILE_LOCAL = join(homedir(), ".local/share/opencode/multi-account-auth.json");
const LEGACY_STATE_FILE = join(CONFIG_DIR, "anthropic-multi-account-state.json");
const LEGACY_STATE_FILE_LOCAL = join(homedir(), ".local/share/opencode/multi-account-state.json");

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

const EMPTY_DATA = {
  version: "2.0",
  accounts: [],
  currentAccount: null,
  requestCount: 0,
  lastPrimaryCheck: null,
  config: { threshold: 0.70, checkInterval: 3600000, accounts: {} },
  usage: {}
};

/**
 * Load consolidated data file, migrating from legacy two-file system if needed.
 */
function loadData() {
  // 1. Try loading new consolidated file first
  const newData = safeReadJSON(DATA_FILE, null);
  if (newData && newData.version === "2.0") {
    const normalized = normalizeMultiAuthShape(newData);
    if (normalized.changed) {
      const result = { ...newData, accounts: normalized.value.accounts };
      saveData(result);
      return result;
    }
    return newData;
  }

  // 2. Try migrating from legacy files
  const legacyAccountSources = [
    LEGACY_ACCOUNTS_FILE,
    LEGACY_ACCOUNTS_FILE_CONFIG,
    LEGACY_ACCOUNTS_FILE_LOCAL,
  ];

  const sources = [];
  for (const sourcePath of legacyAccountSources) {
    const data = safeReadJSON(sourcePath, null);
    if (!data || typeof data !== "object") continue;
    const normalized = normalizeMultiAuthShape(data);
    if (!normalized.value || !Array.isArray(normalized.value.accounts)) continue;
    sources.push(normalized.value);
  }

  const merged = sources.length > 0 ? mergeMultiAuthSources(sources) : null;
  const accounts = merged?.accounts || [];

  const { data: legacyState, sourcePath: stateSource } = readJsonWithFallback(
    [LEGACY_STATE_FILE, LEGACY_STATE_FILE_LOCAL],
    {}
  );

  // Merge into consolidated structure
  const data = {
    ...structuredClone(EMPTY_DATA),
    accounts,
    currentAccount: legacyState.currentAccount || null,
    requestCount: Math.max(merged?.requestCount || 0, legacyState.requestCount || 0),
    lastPrimaryCheck: legacyState.lastPrimaryCheck || null,
    config: legacyState.config || EMPTY_DATA.config,
    usage: legacyState.usage || {},
  };

  // Preserve authFailures if present
  if (legacyState.authFailures) {
    data.authFailures = legacyState.authFailures;
  }

  if (sources.length > 0 || stateSource) {
    saveData(data);
    console.log(`[multi-account] Migrated to consolidated file: ${DATA_FILE}`);
  }

  return data;
}

function saveData(data) {
  safeWriteJSON(DATA_FILE, data);
}

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

// NOTE: Duplicated in src/cli.ts:624-626 - both are entry points that need state generation
// TODO: Extract to shared module in Task 5
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
 * Exchange authorization code for tokens
 * @param {string} code - Authorization code (full URL, raw code, or code#state format)
 * @param {string} verifier - PKCE code verifier
 * @param {string} redirectUri - OAuth redirect URI
 * @param {string} expectedState - State returned from authorize() to verify against callback
 */
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
      if (isNetworkError(error) && attempt < maxRetries) {
        continue;
      }
      throw error;
    }
  }
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

/**
 * Resolve thresholds for a specific account, merging per-account overrides with global defaults.
 * @param {string} accountName
 * @param {object} config - state.config
 */
function getAccountThresholds(accountName, config) {
  const globalThreshold = normalizeThresholds(config?.threshold, 0.70);
  const accountConfig = config?.accounts?.[accountName];
  if (!accountConfig?.threshold) return globalThreshold;

  const accountThreshold = normalizeThresholds(accountConfig.threshold, undefined);
  return {
    session5h: accountThreshold.session5h ?? globalThreshold.session5h,
    weekly7d: accountThreshold.weekly7d ?? globalThreshold.weekly7d,
    weekly7dSonnet: accountThreshold.weekly7dSonnet ?? globalThreshold.weekly7dSonnet,
  };
}

const EMPTY_USAGE = {
  session5h: { utilization: 0, reset: null, status: 'allowed' },
  weekly7d: { utilization: 0, reset: null, status: 'allowed' },
  weekly7dSonnet: { utilization: 0, reset: null, status: 'allowed' },
  timestamp: null
};

const AUTH_FAILURE_COOLDOWN = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token consumption tracking & extra credit detection
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
  // Per million tokens [input, output]
  "haiku": [1.00, 5.00],
  "sonnet": [3.00, 15.00],
  "opus": [15.00, 75.00],
};

function getModelPricing(model) {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return MODEL_PRICING.haiku;
  if (m.includes("opus")) return MODEL_PRICING.opus;
  return MODEL_PRICING.sonnet; // default
}

function calculateCost(model, input, output) {
  const [inputPrice, outputPrice] = getModelPricing(model);
  return (input * inputPrice + output * outputPrice) / 1_000_000;
}

function trackConsumption(accountName, model, inputTokens, outputTokens, data) {
  const usage = data.usage[accountName];
  if (!usage) return;

  usage.consumption = usage.consumption || {
    allTime: { input: 0, output: 0, requests: 0, estimatedCost: 0, since: new Date().toISOString() },
    currentMonth: { input: 0, output: 0, requests: 0, estimatedCost: 0, since: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    currentSession: { input: 0, output: 0, requests: 0, estimatedCost: 0, since: new Date().toISOString() },
    byModel: {}
  };

  // Check month rollover
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  if (usage.consumption.currentMonth.since !== monthStart.slice(0, 7) &&
      !usage.consumption.currentMonth.since?.startsWith(monthStart.slice(0, 7))) {
    usage.consumption.currentMonth = { input: 0, output: 0, requests: 0, estimatedCost: 0, since: monthStart };
  }

  const cost = calculateCost(model, inputTokens, outputTokens);

  // Update all levels
  for (const level of [usage.consumption.allTime, usage.consumption.currentMonth, usage.consumption.currentSession]) {
    level.input += inputTokens;
    level.output += outputTokens;
    level.requests += 1;
    level.estimatedCost = Math.round((level.estimatedCost + cost) * 100) / 100;
  }

  // By model
  const modelKey = model;
  usage.consumption.byModel[modelKey] = usage.consumption.byModel[modelKey] || { input: 0, output: 0, cost: 0 };
  usage.consumption.byModel[modelKey].input += inputTokens;
  usage.consumption.byModel[modelKey].output += outputTokens;
  usage.consumption.byModel[modelKey].cost = Math.round(
    (usage.consumption.byModel[modelKey].cost + cost) * 100
  ) / 100;

  // Extra credit tracking
  if (usage.extraCredit?.detected) {
    usage.extraCredit.tokens = usage.extraCredit.tokens || { input: 0, output: 0 };
    usage.extraCredit.tokens.input += inputTokens;
    usage.extraCredit.tokens.output += outputTokens;
    usage.extraCredit.estimatedCost = Math.round(
      (usage.extraCredit.estimatedCost + cost) * 100
    ) / 100;
  }
}

function detectExtraCredit(usage) {
  for (const key of ['session5h', 'weekly7d', 'weekly7dSonnet']) {
    const m = usage?.[key];
    if (m && m.utilization >= 1.0 && m.status === 'allowed') {
      if (!usage.extraCredit?.detected) {
        usage.extraCredit = {
          detected: true,
          detectedAt: new Date().toISOString(),
          metric: key,
          tokens: { input: 0, output: 0 },
          estimatedCost: 0,
        };
      }
      return;
    }
  }
  // Reset if no longer in extra credit
  if (usage.extraCredit?.detected) {
    usage.extraCredit.detected = false;
  }
}

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

  function isOverThreshold(accountName, usage) {
    if (!usage) return false;
    const t = getAccountThresholds(accountName, config);
    return (
      (usage.session5h?.utilization || 0) > t.session5h ||
      (usage.weekly7d?.utilization || 0) > t.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > t.weekly7dSonnet
    );
  }

  function getExceededMetric(accountName, usage) {
    if (!usage) return { name: 'unknown', value: 0, threshold: 1 };
    const t = getAccountThresholds(accountName, config);
    const metrics = [
      { name: 'session (5h)', value: usage.session5h?.utilization || 0, threshold: t.session5h },
      { name: 'weekly (all)', value: usage.weekly7d?.utilization || 0, threshold: t.weekly7d },
      { name: 'weekly (Sonnet)', value: usage.weekly7dSonnet?.utilization || 0, threshold: t.weekly7dSonnet }
    ];
    return metrics.reduce((max, m) => (m.value / m.threshold) > (max.value / max.threshold) ? m : max);
  }

  function getUtilizationScore(accountName, usage) {
    if (!usage) return 0;
    const t = getAccountThresholds(accountName, config);
    return Math.max(
      (usage.session5h?.utilization || 0) / t.session5h,
      (usage.weekly7d?.utilization || 0) / t.weekly7d,
      (usage.weekly7dSonnet?.utilization || 0) / t.weekly7dSonnet
    );
  }

  const primaryUsage = state.usage?.[primary.name];
  const currentIsPrimary = state.currentAccount === primary.name;

  if (currentIsPrimary) {
    if (isOverThreshold(primary.name, primaryUsage)) {
      for (const fallback of fallbacks) {
        const fallbackUsage = state.usage?.[fallback.name];
        if (!isOverThreshold(fallback.name, fallbackUsage) && !isTemporarilyUnavailable(fallback.name)) {
          const exceeded = getExceededMetric(primary.name, primaryUsage);
          console.log(`[multi-account] ${primary.name} → ${fallback.name}: ${exceeded.name} at ${Math.round(exceeded.value * 100)}% (threshold ${Math.round(exceeded.threshold * 100)}%)`);
          return fallback;
        }
      }
      const availableFallbacks = fallbacks.filter((fallback) => !isTemporarilyUnavailable(fallback.name));
      const pool = availableFallbacks.length > 0 ? availableFallbacks : fallbacks;
      const best = pool.reduce((lowest, f) => {
        return getUtilizationScore(f.name, state.usage?.[f.name]) < getUtilizationScore(lowest.name, state.usage?.[lowest.name]) ? f : lowest;
      }, pool[0]);
      const exceeded = getExceededMetric(primary.name, primaryUsage);
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
      
      if (!isOverThreshold(primary.name, primaryUsage)) {
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

let refreshPromise = null;

async function ensureFreshAccountToken(account, data) {
  // API key accounts don't need token refresh
  if (account.type === "api_key" && account.apiKey) {
    return { ok: true };
  }

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
          const idx = data.accounts.findIndex(
            (a) => a.name === account.name,
          );
          if (idx >= 0) {
            data.accounts[idx] = account;
            saveData(data);
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

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

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
  headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  headers.delete("x-api-key");
  return headers;
}

// ---------------------------------------------------------------------------
// Tool name transformation
// ---------------------------------------------------------------------------

function prefixToolNames(bodyString) {
  try {
    const parsed = JSON.parse(bodyString);

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
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
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

    return JSON.stringify(parsed);
  } catch (e) {
    // ignore parse errors, return original
    return bodyString;
  }
}

function stripToolPrefix(text) {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

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

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

function rewriteUrl(input) {
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
    const rewrittenInput =
      input instanceof Request
        ? new Request(requestUrl.toString(), input)
        : requestUrl;
    return { input: rewrittenInput };
  }

  return { input };
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

        // Check for multi-account mode by reading consolidated data file
        const pluginData = loadData();
        const hasMultiAccounts = pluginData?.accounts?.length > 0;

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
              // Read consolidated data file
              const data = loadData();
              if (!data?.accounts?.length) {
                return fetch(input, init);
              }

              const accounts = data.accounts;

               ensureAllAccountsInState(accounts, data);
               resolveStaleMetrics(data);

               let account = selectThresholdAccount(accounts, data);
               if (!account) {
                 throw new Error("No accounts configured for multi-account");
               }

               // Track state for threshold logic
               const previousAccount = data.currentAccount;
               const primaryName = accounts[0]?.name;
               data.currentAccount = account.name;
               if (account.name !== previousAccount && account.name !== primaryName) {
                 data.lastPrimaryCheck = Date.now();
               }

               // Refresh account token, fallback to other account on token failure.
               const attemptedAccounts = new Set();
               while (true) {
                 const refreshResult = await ensureFreshAccountToken(account, data);
                 if (refreshResult.ok) break;

                 attemptedAccounts.add(account.name);
                 const fallback = accounts.find((candidate) => !attemptedAccounts.has(candidate.name));
                 if (!fallback) {
                   throw new Error(`Token refresh failed for ${account.name}: ${refreshResult.status}`);
                 }

                 console.warn(`[multi-account] refresh failed for ${account.name} (${refreshResult.status}), trying ${fallback.name}`);
                 account = fallback;
                 data.currentAccount = account.name;
                 if (account.name !== previousAccount && account.name !== primaryName) {
                   data.lastPrimaryCheck = Date.now();
                 }
               }

              // Increment request counter
              data.requestCount = (data.requestCount || 0) + 1;

              const requestInit = init ?? {};
              const requestHeaders = mergeHeaders(input, init);

              // Set auth headers based on account type
              if (account.type === "api_key" && account.apiKey) {
                requestHeaders.set("x-api-key", account.apiKey);
                requestHeaders.set("anthropic-beta", mergeBetaHeaders(requestHeaders));
                requestHeaders.set("user-agent", CLAUDE_CLI_USER_AGENT);
                requestHeaders.delete("authorization");
              } else {
                setOAuthHeaders(requestHeaders, account.access);
              }

              let body = requestInit.body;
              if (body && typeof body === "string") {
                body = prefixToolNames(body);
              }

              const { input: requestInput } = rewriteUrl(input);

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
                // Update auth headers for current account
                if (account.type === "api_key" && account.apiKey) {
                  requestHeaders.set("x-api-key", account.apiKey);
                  requestHeaders.delete("authorization");
                } else {
                  requestHeaders.set("authorization", `Bearer ${account.access}`);
                  requestHeaders.delete("x-api-key");
                }

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

                data.authFailures = data.authFailures || {};
                data.authFailures[account.name] = Date.now() + AUTH_FAILURE_COOLDOWN;

                const retryAccount = accounts.find(
                  (candidate) =>
                    !attemptedRequestAccounts.has(candidate.name) &&
                    (!data.authFailures?.[candidate.name] || data.authFailures[candidate.name] <= Date.now()),
                );

                if (!retryAccount) {
                  break;
                }

                console.warn(`[multi-account] auth scope failed for ${account.name}, trying ${retryAccount.name}`);
                account = retryAccount;
                data.currentAccount = account.name;
                if (account.name !== previousAccount && account.name !== primaryName) {
                  data.lastPrimaryCheck = Date.now();
                }

                const retryRefresh = await ensureFreshAccountToken(account, data);
                if (!retryRefresh.ok) {
                  data.authFailures[account.name] = Date.now() + AUTH_FAILURE_COOLDOWN;
                  continue;
                }
              }

              if (data.authFailures?.[account.name]) {
                delete data.authFailures[account.name];
              }

              // Capture usage from response headers and save to data
              // Only update metrics when headers are actually present to avoid
              // overwriting valid data with zeros (e.g. Sonnet headers only appear on Sonnet requests)
              data.usage = data.usage || {};
              const prev = data.usage[account.name] || {};

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

              data.usage[account.name] = {
                ...data.usage[account.name],
                session5h: updateMetric(prev.session5h, 'anthropic-ratelimit-unified-5h'),
                weekly7d: updateMetric(prev.weekly7d, 'anthropic-ratelimit-unified-7d'),
                weekly7dSonnet: updateMetric(prev.weekly7dSonnet, 'anthropic-ratelimit-unified-7d_sonnet'),
                timestamp: new Date().toISOString()
              };

              // Detect extra credit state
              detectExtraCredit(data.usage[account.name]);

              // Save consolidated data
              saveData(data);

              // Track token consumption from response body
              try {
                const cloned = response.clone();
                const respBody = await cloned.json().catch(() => null);
                if (respBody?.usage) {
                  const model = respBody.model || "unknown";
                  const inputTokens = respBody.usage.input_tokens || 0;
                  const outputTokens = respBody.usage.output_tokens || 0;
                  trackConsumption(account.name, model, inputTokens, outputTokens, data);
                  saveData(data);
                }
              } catch {}

              // Transform streaming response to strip tool prefixes
              return createStrippedStream(response);
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
              const requestHeaders = mergeHeaders(input, init);
              setOAuthHeaders(requestHeaders, auth.access);

              let body = requestInit.body;
              if (body && typeof body === "string") {
                body = prefixToolNames(body);
              }

              const { input: requestInput } = rewriteUrl(input);

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Track token consumption for single-account mode
              try {
                const cloned = response.clone();
                const respBody = await cloned.json().catch(() => null);
                if (respBody?.usage) {
                  const singleData = loadData();
                  const accountName = singleData.accounts?.[0]?.name || "_single";
                  singleData.usage = singleData.usage || {};
                  singleData.usage[accountName] = singleData.usage[accountName] || {};
                  const model = respBody.model || "unknown";
                  const inputTokens = respBody.usage.input_tokens || 0;
                  const outputTokens = respBody.usage.output_tokens || 0;
                  trackConsumption(accountName, model, inputTokens, outputTokens, singleData);
                  saveData(singleData);
                }
              } catch {}

              // Transform streaming response to strip tool prefixes
              return createStrippedStream(response);
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
            const result = await authorize("max");
            return {
              url: result.url,
              instructions: "Paste the callback URL or authorization code here: ",
              method: "code",
              callback: async (code) => {
                return exchange(code, result.verifier, result.redirectUri, result.state);
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
                const credentials = await exchange(code, result.verifier, result.redirectUri, result.state);
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
      ],
    },
  };
}

export default AnthropicAuthPlugin;
