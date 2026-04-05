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
// Toast + console status tracking
// ---------------------------------------------------------------------------

let _pluginClient = null;
const _lastLoggedUtilization = {};
const UTILIZATION_LOG_DELTA = 0.05; // Only log when utilization changes by >5%
const AUTO_TOAST_INTERVAL = 5; // Show auto-toast every N requests

function _showToast(title, message, variant = "info", duration = 5000) {
  if (!_pluginClient?.tui?.showToast) return;
  try {
    _pluginClient.tui.showToast({ body: { title, message, variant, duration } });
  } catch {
    // Silently ignore toast failures
  }
}

function _formatUtilization(usage) {
  if (!usage) return "no data";
  const s5h = Math.round((usage.session5h?.utilization || 0) * 100);
  const w7d = Math.round((usage.weekly7d?.utilization || 0) * 100);
  const son = Math.round((usage.weekly7dSonnet?.utilization || 0) * 100);
  return `5h: ${s5h}% | 7d: ${w7d}% | sonnet: ${son}%`;
}

function _shouldLogUtilization(accountName, usage) {
  const prev = _lastLoggedUtilization[accountName];
  if (!prev) return true;
  if (!usage) return false;
  const delta = Math.abs((usage.session5h?.utilization || 0) - (prev.session5h || 0));
  const delta7d = Math.abs((usage.weekly7d?.utilization || 0) - (prev.weekly7d || 0));
  const deltaSon = Math.abs((usage.weekly7dSonnet?.utilization || 0) - (prev.weekly7dSonnet || 0));
  return delta > UTILIZATION_LOG_DELTA || delta7d > UTILIZATION_LOG_DELTA || deltaSon > UTILIZATION_LOG_DELTA;
}

function _recordLoggedUtilization(accountName, usage) {
  _lastLoggedUtilization[accountName] = {
    session5h: usage?.session5h?.utilization || 0,
    weekly7d: usage?.weekly7d?.utilization || 0,
    weekly7dSonnet: usage?.weekly7dSonnet?.utilization || 0,
  };
}

// ---------------------------------------------------------------------------
// Request log for optimization analytics
// Monthly JSONL files in dedicated folder: ~/.config/opencode/anthropic-multi-account-logs/
// Format: YYYY-MM.jsonl (one line per request)
// Old months auto-compressed to .jsonl.gz
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import { appendFileSync, readdirSync, statSync, unlinkSync } from "fs";

const LOGS_DIR = join(CONFIG_DIR, "anthropic-multi-account-logs");
const LEGACY_LOG_FILE = join(CONFIG_DIR, "anthropic-multi-account-requests.jsonl");
let _pluginDirectory = null;
let _pluginWorktree = null;
let _requestBodyMeta = null; // extracted from request body before fetch

function _getMonthlyLogPath(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}.jsonl`);
}

function _ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function _migrateLegacyLog() {
  if (!existsSync(LEGACY_LOG_FILE)) return;
  try {
    _ensureLogsDir();
    const content = readFileSync(LEGACY_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Group by month
    const byMonth = {};
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const d = new Date(entry.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        (byMonth[key] ??= []).push(line);
      } catch {}
    }
    for (const [month, monthLines] of Object.entries(byMonth)) {
      const path = join(LOGS_DIR, `${month}.jsonl`);
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
      writeFileSync(path, existing + monthLines.join('\n') + '\n', 'utf8');
    }
    // Remove legacy file after migration
    unlinkSync(LEGACY_LOG_FILE);
    console.log(`[multi-account] Migrated request log to monthly files in ${LOGS_DIR}`);
  } catch {}
}

function _compressOldMonths() {
  try {
    const currentMonth = _getMonthlyLogPath().split('/').pop().replace('.jsonl', '');
    const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const month = file.replace('.jsonl', '');
      if (month < currentMonth) {
        const fullPath = join(LOGS_DIR, file);
        const gzPath = fullPath + '.gz';
        if (!existsSync(gzPath)) {
          try {
            execSync(`gzip -k "${fullPath}"`, { timeout: 10000 });
            unlinkSync(fullPath);
          } catch {}
        }
      }
    }
  } catch {}
}

function _appendRequestLog(entry) {
  try {
    _ensureLogsDir();
    _migrateLegacyLog();
    const logPath = _getMonthlyLogPath();
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    // Compress old months in background (non-blocking)
    setTimeout(() => _compressOldMonths(), 100);
  } catch {
    // Silently ignore log failures
  }
}

function _extractRequestBodyMeta(body) {
  if (!body || typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body);
    const meta = {};
    meta.requestModel = parsed.model || null;
    meta.maxTokens = parsed.max_tokens || null;
    meta.temperature = parsed.temperature ?? null;
    meta.topP = parsed.top_p ?? null;
    meta.stream = parsed.stream ?? null;
    // System prompt stats
    if (parsed.system && Array.isArray(parsed.system)) {
      meta.systemPromptParts = parsed.system.length;
      meta.systemPromptChars = parsed.system.reduce((sum, p) => sum + (p.text?.length || 0), 0);
    }
    // Message stats
    if (parsed.messages && Array.isArray(parsed.messages)) {
      meta.messageCount = parsed.messages.length;
      meta.userMessages = parsed.messages.filter(m => m.role === 'user').length;
      meta.assistantMessages = parsed.messages.filter(m => m.role === 'assistant').length;
      // Count tool_use and tool_result blocks
      let toolUseCalls = 0;
      let toolResultCalls = 0;
      for (const msg of parsed.messages) {
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') toolUseCalls++;
            if (block.type === 'tool_result') toolResultCalls++;
          }
        }
      }
      meta.toolUseCalls = toolUseCalls;
      meta.toolResultCalls = toolResultCalls;
    }
    // Tool definitions count
    if (parsed.tools && Array.isArray(parsed.tools)) {
      meta.toolDefinitions = parsed.tools.length;
    }
    // Thinking/extended thinking config
    if (parsed.thinking) {
      meta.thinking = { type: parsed.thinking.type, budgetTokens: parsed.thinking.budget_tokens || null };
    }
    return meta;
  } catch {
    return {};
  }
}

function _logRequest({
  account, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  reasoningTokens, cost, durationMs, statusCode, switched, switchReason, extraCredit,
  stopReason, requestId, bodyMeta, rateLimits,
}) {
  _appendRequestLog({
    v: 2, // schema version for future compatibility
    timestamp: new Date().toISOString(),
    account,
    model,
    tokens: {
      input: inputTokens || 0,
      output: outputTokens || 0,
      cacheRead: cacheReadTokens || 0,
      cacheWrite: cacheWriteTokens || 0,
      reasoning: reasoningTokens || 0,
      total: (inputTokens || 0) + (outputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0) + (reasoningTokens || 0),
    },
    cost: cost || 0,
    durationMs: durationMs || 0,
    statusCode: statusCode || 200,
    stopReason: stopReason || null,
    requestId: requestId || null,
    switched: switched || false,
    switchReason: switchReason || null,
    extraCredit: extraCredit || false,
    request: bodyMeta || {},
    rateLimits: rateLimits || null,
    context: {
      directory: _pluginDirectory || null,
      worktree: _pluginWorktree || null,
      repoName: _pluginDirectory ? _pluginDirectory.split('/').pop() : null,
    },
  });
}

function _formatUsageDashboard(data) {
  const accounts = data?.accounts || [];
  const lines = ["[multi-account] Account Usage Dashboard"];
  for (const acc of accounts) {
    const usage = data?.usage?.[acc.name];
    const active = data?.currentAccount === acc.name ? " (active)" : "";
    const extra = usage?.extraCredit?.detected ? " [EXTRA CREDIT]" : "";
    lines.push(`  ${acc.name}${active}${extra}: ${_formatUtilization(usage)}`);
    if (usage?.consumption?.currentSession) {
      const cs = usage.consumption.currentSession;
      lines.push(`    session: ${cs.requests} reqs, ${cs.input + cs.output} tokens, ~$${cs.estimatedCost}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Token consumption tracking & extra credit detection
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
  // Per million tokens [input, output, cache_read, cache_write]
  "haiku": [1.00, 5.00, 0.10, 1.25],
  "sonnet": [3.00, 15.00, 0.30, 3.75],
  "opus": [15.00, 75.00, 1.50, 18.75],
};

// Anthropic cost rates per million tokens for OpenCode's native cost display
const ANTHROPIC_MODEL_COSTS = {
  "claude-haiku":       { input: 1.00, output: 5.00, cache: { read: 0.10, write: 1.25 } },
  "claude-sonnet":      { input: 3.00, output: 15.00, cache: { read: 0.30, write: 3.75 } },
  "claude-opus":        { input: 15.00, output: 75.00, cache: { read: 1.50, write: 18.75 } },
};

function setRealModelCosts(providerModels) {
  for (const [modelId, model] of Object.entries(providerModels)) {
    const id = modelId.toLowerCase();
    let rates;
    if (id.includes("haiku")) rates = ANTHROPIC_MODEL_COSTS["claude-haiku"];
    else if (id.includes("opus")) rates = ANTHROPIC_MODEL_COSTS["claude-opus"];
    else rates = ANTHROPIC_MODEL_COSTS["claude-sonnet"]; // default for sonnet and unknown
    model.cost = {
      input: rates.input,
      output: rates.output,
      cache: { read: rates.cache.read, write: rates.cache.write },
    };
  }
}

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

const SWITCH_LOG_FILE = require("path").join(require("os").homedir(), ".config/opencode/anthropic-multi-account-switches.log");

function logSwitch(data, from, to, reason) {
  const ts = new Date().toISOString();
  if (!data.switchHistory) data.switchHistory = [];
  data.switchHistory.push({ ts, from, to, reason });
  if (data.switchHistory.length > 50) data.switchHistory = data.switchHistory.slice(-50);
  // Append to dedicated log file
  try {
    const line = `${ts}  ${from} → ${to}  [${reason}]\n`;
    require("fs").appendFileSync(SWITCH_LOG_FILE, line);
  } catch {}
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

  // Manual mode: always return the currently set account, no auto-switching
  if (config.switchMode === "manual") {
    const current = accounts.find((a) => a.name === state.currentAccount);
    return current || primary;
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
        const fallbackRejected = fallbackUsage?.session5h?.status === "rejected" || fallbackUsage?.weekly7d?.status === "rejected";
        if (!fallbackRejected && !isOverThreshold(fallback.name, fallbackUsage) && !isTemporarilyUnavailable(fallback.name)) {
          const exceeded = getExceededMetric(primary.name, primaryUsage);
          const msg = `${primary.name} → ${fallback.name}: ${exceeded.name} at ${Math.round(exceeded.value * 100)}% (threshold ${Math.round(exceeded.threshold * 100)}%)`;
          console.log(`[multi-account] ${msg}`);
          _showToast("Account Switch", msg, "warning");
          return fallback;
        }
      }
      // All fallbacks are also over threshold — only switch if one is actually better
      const availableFallbacks = fallbacks.filter((fallback) => !isTemporarilyUnavailable(fallback.name));
      const pool = availableFallbacks.length > 0 ? availableFallbacks : fallbacks;
      const best = pool.reduce((lowest, f) => {
        return getUtilizationScore(f.name, state.usage?.[f.name]) < getUtilizationScore(lowest.name, state.usage?.[lowest.name]) ? f : lowest;
      }, pool[0]);
      const bestUsage = state.usage?.[best.name];
      const bestRejected = bestUsage?.session5h?.status === "rejected" || bestUsage?.weekly7d?.status === "rejected";
      const bestScore = getUtilizationScore(best.name, bestUsage);
      const primaryScore = getUtilizationScore(primary.name, primaryUsage);
      // Stay on primary if best fallback is rejected or has worse utilization
      if (bestRejected || bestScore >= primaryScore) {
        return primary;
      }
      const exceeded = getExceededMetric(primary.name, primaryUsage);
      const msg = `${primary.name} → ${best.name}: ${exceeded.name} at ${Math.round(exceeded.value * 100)}% (all accounts busy)`;
      console.log(`[multi-account] ${msg}`);
      _showToast("Account Switch", msg, "warning");
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
        const msg = `→ ${primary.name}: under threshold, switching back`;
        console.log(`[multi-account] ${msg}`);
        _showToast("Account Switch", msg, "success");
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
export async function AnthropicAuthPlugin({ client, directory, worktree }) {
  // Store client reference for toast notifications
  _pluginClient = client;
  _pluginDirectory = directory;
  _pluginWorktree = worktree;

  return {
    // Custom tool: oc_ma_usage - returns account usage dashboard without LLM cost
    tool: {
      oc_ma_usage: {
        description: "Show multi-account usage dashboard with current account, utilization percentages, token consumption, and switch status. Call this when the user asks about account usage, rate limits, or costs.",
        args: {},
        async execute() {
          const data = loadData();
          if (!data?.accounts?.length) {
            return "Multi-account not configured. Only single account active.";
          }
          return _formatUsageDashboard(data);
        },
      },
    },
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
          // Set real Anthropic pricing so OpenCode's TUI shows actual equivalent costs
          setRealModelCosts(provider.models);

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
                if (account.name !== previousAccount) {
                  logSwitch(data, previousAccount, account.name, "threshold evaluation");
                  if (account.name !== primaryName) {
                    data.lastPrimaryCheck = Date.now();
                  }
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

                 logSwitch(data, account.name, fallback.name, "token refresh failed");
                 console.warn(`[multi-account] refresh failed for ${account.name} (${refreshResult.status}), trying ${fallback.name}`);
                 account = fallback;
                 data.currentAccount = account.name;
                 if (account.name !== previousAccount && account.name !== primaryName) {
                   data.lastPrimaryCheck = Date.now();
                 }
               }

              // Increment request counter and start timing
              data.requestCount = (data.requestCount || 0) + 1;
              const _requestStartTime = Date.now();
              const _didSwitch = previousAccount && previousAccount !== account.name;

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
              // Extract request body metadata for analytics before tool name transformation
              const _bodyMeta = _extractRequestBodyMeta(body);
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

                // Handle 429 rate limit: switch to another account transparently
                if (response.status === 429) {
                  const rateLimitAccount = accounts.find(
                    (candidate) =>
                      !attemptedRequestAccounts.has(candidate.name) &&
                      (!data.authFailures?.[candidate.name] || data.authFailures[candidate.name] <= Date.now()),
                  );

                  if (rateLimitAccount) {
                    logSwitch(data, account.name, rateLimitAccount.name, "429 rate limit");
                    const msg = `429 on ${account.name}, switched to ${rateLimitAccount.name}`;
                    console.warn(`[multi-account] ${msg}`);
                    _showToast("Rate Limit Switch", msg, "error", 8000);

                    account = rateLimitAccount;
                    data.currentAccount = account.name;
                    if (account.name !== previousAccount && account.name !== primaryName) {
                      data.lastPrimaryCheck = Date.now();
                    }

                    const rlRefresh = await ensureFreshAccountToken(account, data);
                    if (!rlRefresh.ok) {
                      data.authFailures = data.authFailures || {};
                      data.authFailures[account.name] = Date.now() + AUTH_FAILURE_COOLDOWN;
                      continue;
                    }
                    // Update auth headers for the new account
                    if (account.type === "api_key" && account.apiKey) {
                      requestHeaders.set("x-api-key", account.apiKey);
                      requestHeaders.delete("authorization");
                    } else {
                      requestHeaders.set("authorization", `Bearer ${account.access}`);
                      requestHeaders.delete("x-api-key");
                    }
                    continue;
                  }
                  // All accounts exhausted -- let the 429 pass through to OpenCode
                  _showToast("All Accounts Exhausted", "All accounts rate limited. Passing 429 to OpenCode.", "error", 10000);
                  break;
                }

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

                logSwitch(data, account.name, retryAccount.name, "401/403 auth scope failure");
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

              // Console log status when utilization changes significantly
              const currentUsage = data.usage[account.name];
              if (_shouldLogUtilization(account.name, currentUsage)) {
                const extra = currentUsage?.extraCredit?.detected ? " [EXTRA CREDIT]" : "";
                console.log(`[multi-account] active: ${account.name}${extra} | ${_formatUtilization(currentUsage)}`);
                _recordLoggedUtilization(account.name, currentUsage);
              }

              // Auto-toast every N requests
              if (data.requestCount % AUTO_TOAST_INTERVAL === 0) {
                const lines = accounts.map((a) => {
                  const u = data.usage?.[a.name];
                  const tag = a.name === account.name ? "*" : " ";
                  const extra = u?.extraCredit?.detected ? " [EC]" : "";
                  return `${tag}${a.name}${extra}: ${_formatUtilization(u)}`;
                }).join(" | ");
                _showToast("Multi-Account Status", lines, "info", 4000);
              }

              // Track token consumption from streaming response
              // Clone before the stream is consumed by createStrippedStream
              const consumptionClone = response.clone();
              const strippedResponse = createStrippedStream(response);

              // Parse consumption in background (don't block the response)
              const _accountName = account.name;
              const _extraCredit = !!(data.usage[_accountName]?.extraCredit?.detected);
              // Capture rate limit headers for logging
              const _rateLimits = {
                session5h: parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization') || '') || null,
                weekly7d: parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization') || '') || null,
                weekly7dSonnet: parseFloat(response.headers.get('anthropic-ratelimit-unified-7d_sonnet-utilization') || '') || null,
              };
              const _responseRequestId = response.headers.get('request-id') || response.headers.get('x-request-id') || null;

              consumptionClone.text().then((text) => {
                try {
                  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalReasoning = 0;
                  let model = data._lastModel || "unknown";
                  let stopReason = null;
                  let messageId = null;
                  // Parse SSE stream events
                  const lines = text.split('\n');
                  for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6);
                    if (jsonStr === '[DONE]') continue;
                    try {
                      const event = JSON.parse(jsonStr);
                      if (event.type === 'message_start' && event.message) {
                        const msg = event.message;
                        if (msg.usage) {
                          totalInput += msg.usage.input_tokens || 0;
                          totalCacheRead += msg.usage.cache_read_input_tokens || 0;
                          totalCacheWrite += msg.usage.cache_creation_input_tokens || 0;
                        }
                        model = msg.model || model;
                        messageId = msg.id || null;
                        stopReason = msg.stop_reason || null;
                        data._lastModel = model;
                        if (totalInput > 0) {
                          trackConsumption(_accountName, model, totalInput, 0, data);
                        }
                      }
                      if (event.type === 'message_delta') {
                        if (event.usage) {
                          totalOutput += event.usage.output_tokens || 0;
                          totalReasoning += event.usage.reasoning_tokens || 0;
                        }
                        if (event.delta?.stop_reason) {
                          stopReason = event.delta.stop_reason;
                        }
                        if (totalOutput > 0) {
                          trackConsumption(_accountName, event.model || model, 0, totalOutput, data);
                        }
                      }
                    } catch {}
                  }
                  saveData(data);

                  // Log request for analytics
                  const [inputRate, outputRate, cacheReadRate, cacheWriteRate] = getModelPricing(model);
                  const cost = (totalInput * (inputRate || 0) + totalOutput * (outputRate || 0)
                    + totalCacheRead * (cacheReadRate || 0) + totalCacheWrite * (cacheWriteRate || 0)) / 1_000_000;
                  _logRequest({
                    account: _accountName,
                    model,
                    inputTokens: totalInput,
                    outputTokens: totalOutput,
                    cacheReadTokens: totalCacheRead,
                    cacheWriteTokens: totalCacheWrite,
                    reasoningTokens: totalReasoning,
                    cost,
                    durationMs: Date.now() - _requestStartTime,
                    statusCode: response.status,
                    stopReason,
                    requestId: _responseRequestId || messageId,
                    switched: _didSwitch,
                    switchReason: _didSwitch ? `${previousAccount} → ${_accountName}` : null,
                    extraCredit: _extraCredit,
                    bodyMeta: _bodyMeta,
                    rateLimits: _rateLimits,
                  });
                } catch {}
              }).catch(() => {});

              return strippedResponse;
            },
          };
        }

        // Handle single OAuth auth (original behavior)
        if (auth.type === "oauth") {
          // Set real Anthropic pricing so OpenCode's TUI shows actual equivalent costs
          setRealModelCosts(provider.models);
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
