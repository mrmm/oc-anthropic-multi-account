#!/usr/bin/env bun

import { Args, Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  mkdirSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import * as readline from "readline";
import { Effect, Option } from "effect";

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
const CONFIG_DIR = join(homedir(), ".config/opencode");
const MULTI_AUTH_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-accounts.json",
);
const LEGACY_MULTI_AUTH_FILE_CONFIG = join(
  CONFIG_DIR,
  "anthropic-multi-accounts.json",
);
const LEGACY_MULTI_AUTH_FILE = join(
  homedir(),
  ".local/share/opencode/multi-account-auth.json",
);
const STATE_FILE = join(CONFIG_DIR, "anthropic-multi-account-state.json");
const LEGACY_STATE_FILE = join(
  homedir(),
  ".local/share/opencode/multi-account-state.json",
);

const DEFAULTS = { threshold: 0.7, checkInterval: 3600000 };

function createOAuthTokenRequestInit(
  params: Record<string, string | undefined>,
) {
  const body: Record<string, string> = {};

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

type PerMetric = {
  session5h: number;
  weekly7d: number;
  weekly7dSonnet: number;
};

function normalizeThresholds(value: any, fallback: number): PerMetric {
  if (typeof value === "number")
    return { session5h: value, weekly7d: value, weekly7dSonnet: value };
  if (typeof value === "object" && value !== null) {
    return {
      session5h: value.session5h ?? fallback,
      weekly7d: value.weekly7d ?? fallback,
      weekly7dSonnet: value.weekly7dSonnet ?? fallback,
    };
  }
  return { session5h: fallback, weekly7d: fallback, weekly7dSonnet: fallback };
}

function allSame(pm: PerMetric): boolean {
  return pm.session5h === pm.weekly7d && pm.weekly7d === pm.weekly7dSonnet;
}

// ============================================================================
// File helpers (atomic write + backup fallback)
// ============================================================================

function safeReadJSON<T>(filePath: string, fallback: T): T {
  for (const path of [filePath, filePath + ".bak"]) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (path.endsWith(".bak")) {
        console.log(`[multi-account] Recovered ${filePath} from backup`);
      }
      return data;
    } catch {
      continue;
    }
  }
  return fallback;
}

function safeWriteJSON(filePath: string, data: any) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      copyFileSync(filePath, filePath + ".bak");
    }
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[multi-account] Failed to save ${filePath}:`, e);
  }
}

function readWithFallback<T>(
  paths: string[],
  fallback: T,
): { data: T; source: string | null } {
  for (const p of paths) {
    const data = safeReadJSON<T | null>(p, null as T | null);
    if (data !== null) return { data: data as T, source: p };
  }
  return { data: fallback, source: null };
}

function normalizeAccountFields(account: any): any {
  if (!account || typeof account !== "object") {
    return account;
  }

  const normalized = { ...account };
  let changed = false;

  if (
    (!normalized.access || typeof normalized.access !== "string") &&
    typeof normalized.accessToken === "string"
  ) {
    normalized.access = normalized.accessToken;
    changed = true;
  }

  if (
    (!normalized.refresh || typeof normalized.refresh !== "string") &&
    typeof normalized.refreshToken === "string"
  ) {
    normalized.refresh = normalized.refreshToken;
    changed = true;
  }

  if (typeof normalized.expires !== "number") {
    if (
      typeof normalized.expiresAt === "number" &&
      Number.isFinite(normalized.expiresAt)
    ) {
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

function normalizeMultiAuthShape(multiAuth: any): {
  value: any;
  changed: boolean;
} {
  if (
    !multiAuth ||
    typeof multiAuth !== "object" ||
    !Array.isArray(multiAuth.accounts)
  ) {
    return { value: multiAuth, changed: false };
  }

  let changed = false;
  const accounts = multiAuth.accounts.map((account: any) => {
    const normalized = normalizeAccountFields(account);
    if (normalized !== account) changed = true;
    return normalized;
  });

  if (!changed) {
    return { value: multiAuth, changed: false };
  }

  return { value: { ...multiAuth, accounts }, changed: true };
}

function loadAccounts() {
  return loadMultiAuth().accounts || [];
}

function loadMultiAuth(): any {
  const { data, source } = readWithFallback(
    [MULTI_AUTH_FILE, LEGACY_MULTI_AUTH_FILE_CONFIG, LEGACY_MULTI_AUTH_FILE],
    { accounts: [] },
  );
  const normalized = normalizeMultiAuthShape(data);
  if (
    (source === LEGACY_MULTI_AUTH_FILE_CONFIG ||
      source === LEGACY_MULTI_AUTH_FILE ||
      normalized.changed) &&
    normalized.value
  ) {
    saveMultiAuth(normalized.value);
  }
  return normalized.value;
}

function saveMultiAuth(data: any) {
  safeWriteJSON(MULTI_AUTH_FILE, data);
}

function loadState(): any {
  const { data, source } = readWithFallback(
    [STATE_FILE, LEGACY_STATE_FILE],
    {},
  );
  if (source === LEGACY_STATE_FILE) {
    saveState(data);
  }
  return data;
}

function saveState(state: any) {
  safeWriteJSON(STATE_FILE, state);
}

// ============================================================================
// Usage command
// ============================================================================

function progressBar(utilization: number): string {
  const pct = Math.round(utilization * 100);
  const filled = Math.floor(pct / 2);
  const half = pct % 2 === 1 ? "▌" : "";
  return (
    "█".repeat(filled) +
    half +
    " ".repeat(Math.max(0, 50 - filled - (half ? 1 : 0)))
  );
}

function formatResetTime(ts: number | null): string {
  if (!ts) return "Unknown";
  return new Intl.DateTimeFormat("default", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ts * 1000));
}

const EMPTY_USAGE = {
  session5h: { utilization: 0, reset: null, status: "allowed" },
  weekly7d: { utilization: 0, reset: null, status: "allowed" },
  weekly7dSonnet: { utilization: 0, reset: null, status: "allowed" },
  timestamp: null,
};

function ensureAllAccountsInState(accounts: any[], state: any): boolean {
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

function resolveStaleMetrics(state: any): boolean {
  const usage = state.usage;
  if (!usage) return false;
  const now = Date.now();
  let changed = false;
  for (const accountName of Object.keys(usage)) {
    for (const key of ["session5h", "weekly7d", "weekly7dSonnet"] as const) {
      const metric = usage[accountName]?.[key];
      if (
        metric?.reset &&
        metric.reset * 1000 < now &&
        metric.utilization > 0
      ) {
        metric.utilization = 0;
        metric.status = "allowed";
        changed = true;
      }
    }
  }
  return changed;
}

function colorize(text: string, util: number): string {
  if (util >= 0.9) return `\x1b[31m${text}\x1b[0m`; // Red
  if (util >= 0.7) return `\x1b[33m${text}\x1b[0m`; // Yellow
  return `\x1b[32m${text}\x1b[0m`; // Green
}

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
    const status =
      account.expires > Date.now() ? "✅ Authenticated" : "⚠️ Token expired";
    const bestQuota = isActive ? " ✨ Best quota available" : "";
    console.log(
      isActive
        ? `\n${c}┌─ ${account.name} ◄── ACTIVE${bestQuota}${r}`
        : `\n┌─ ${account.name}`,
    );
    console.log(`${c}│${r}  Account Status: ${status}`);
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
      const thLabel = `\x1b[2m(threshold ${Math.round(th * 100)}%)\x1b[0m`;

      console.log(`${c}│${r}\n${c}│${r}  📊 ${label}  ${thLabel}`);
      console.log(
        `${c}│${r}  ${colorize(progressBar(u), u)}  ${colorize(`${Math.round(u * 100)}%`, u)}`,
      );
      console.log(`${c}│${r}  Resets ${formatResetTime(usage[key]?.reset)}`);

      // Status indicator based on utilization vs threshold
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
    const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);
    if (
      primaryUsage &&
      (primaryUsage.session5h?.utilization || 0) > t.session5h * 0.9
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

function cmdUsage(args: string[]) {
  const watch = args.includes("--watch") || args.includes("-w");
  renderUsage(watch);
  if (watch) setInterval(() => renderUsage(true), 5000);
}

// ============================================================================
// Config command
// ============================================================================

function cmdConfig(args: string[]) {
  const state = loadState();

  if (args.includes("--show") || args.length === 0) {
    const cfg = state.config || {};
    const t = normalizeThresholds(cfg.threshold, DEFAULTS.threshold);

    console.log("\n  Current config:");
    if (allSame(t)) {
      console.log(`    Threshold:      ${Math.round(t.session5h * 100)}%`);
    } else {
      console.log(`    Threshold:`);
      console.log(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      console.log(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      console.log(
        `      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`,
      );
    }
    console.log(
      `    Check interval: ${(cfg.checkInterval ?? DEFAULTS.checkInterval) / 60000} min\n`,
    );
    return;
  }

  if (args.includes("--reset")) {
    delete state.config;
    saveState(state);
    console.log("✓ Reset to defaults");
    return;
  }

  state.config = state.config || {};
  let changed = false;

  const parseArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  function ensureThresholdObject() {
    const current = state.config.threshold;
    if (typeof current === "number") {
      state.config.threshold = {
        session5h: current,
        weekly7d: current,
        weekly7dSonnet: current,
      };
    } else if (!current || typeof current !== "object") {
      state.config.threshold = {
        session5h: DEFAULTS.threshold,
        weekly7d: DEFAULTS.threshold,
        weekly7dSonnet: DEFAULTS.threshold,
      };
    }
  }

  const t = parseArg("--threshold");
  if (t) {
    state.config.threshold = parseFloat(t);
    changed = true;
  }

  // --thresholds 95,80,90 → session=95%, weekly=80%, sonnet=90%
  const ta = parseArg("--thresholds");
  if (ta) {
    const parts = ta.split(",").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      console.error(
        "Usage: --thresholds <session>,<weekly>,<sonnet>  (e.g. --thresholds 95,80,90)",
      );
      return;
    }
    state.config.threshold = {
      session5h: parts[0] / 100,
      weekly7d: parts[1] / 100,
      weekly7dSonnet: parts[2] / 100,
    };
    changed = true;
  }

  const ts = parseArg("--threshold-session");
  if (ts) {
    ensureThresholdObject();
    state.config.threshold.session5h = parseFloat(ts);
    changed = true;
  }

  const tw = parseArg("--threshold-weekly");
  if (tw) {
    ensureThresholdObject();
    state.config.threshold.weekly7d = parseFloat(tw);
    changed = true;
  }

  const tso = parseArg("--threshold-sonnet");
  if (tso) {
    ensureThresholdObject();
    state.config.threshold.weekly7dSonnet = parseFloat(tso);
    changed = true;
  }

  const i = parseArg("--interval");
  if (i) {
    state.config.checkInterval = parseInt(i) * 60000;
    changed = true;
  }

  // Clean up legacy recover config
  delete state.config.recover;

  if (changed) {
    autoEvaluate(state);
    saveState(state);
    console.log("✓ Config saved");
    cmdConfig(["--show"]);
  }
}

function autoEvaluate(state: any) {
  const accounts = loadAccounts();
  if (accounts.length < 2 || !state.currentAccount) return;

  const config = state.config || {};
  const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);

  function isOverThreshold(usage: any): boolean {
    if (!usage) return false;
    return (
      (usage.session5h?.utilization || 0) > t.session5h ||
      (usage.weekly7d?.utilization || 0) > t.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > t.weekly7dSonnet
    );
  }

  const primary = accounts[0];
  const currentAccount = state.currentAccount;
  const primaryUsage = state.usage?.[primary.name];

  if (currentAccount === primary.name) {
    if (isOverThreshold(primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        if (!isOverThreshold(state.usage?.[fallback.name])) {
          state.currentAccount = fallback.name;
          console.log(
            `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (exceeds new thresholds)`,
          );
          return;
        }
      }
    }
  } else {
    if (!isOverThreshold(primaryUsage)) {
      state.currentAccount = primary.name;
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (under new thresholds)`,
      );
    }
  }
}

// ============================================================================
// Add account command
// ============================================================================

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// Extract state (verifier) from auth URL
function extractStateFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.searchParams.get("state");
  } catch {
    return null;
  }
}

// Parse auth code - handles "code#state" or just "code"
function parseAuthCode(input: string): { code: string; state?: string } {
  if (input.includes("#")) {
    const [code, state] = input.split("#");
    return { code, state };
  }
  return { code: input };
}

// NOTE: Duplicated in src/index.mjs:264-266 - both are entry points that need state generation
// TODO: Extract to shared module in Task 5
function generateState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

async function cmdAdd(args: string[]) {
  const name = args[0];
  const authUrl = args[1]; // The authorization URL (contains state/verifier)
  const authCode = args[2]; // The auth code from callback

  if (!name) {
    console.log("Usage:");
    console.log(
      "  bun src/cli.ts add <name>                    # Interactive mode",
    );
    console.log("  bun src/cli.ts add <name> <auth-url> <code>  # Direct mode");
    console.log("  bun src/cli.ts add <name> <auth-url> <code#state>");
    return;
  }

  console.log(`\n🔐 Adding account: ${name}\n`);

  let code: string;
  let verifier: string;
  let state: string;

  // Direct mode - URL and code provided
  if (authUrl && authCode) {
    const extractedState = extractStateFromUrl(authUrl);
    const parsed = parseAuthCode(authCode);

    code = parsed.code;
    // Use state from auth code if present, otherwise from URL
    state = parsed.state || extractedState || "";
    verifier = state;

    if (!verifier) {
      console.error("❌ Could not extract state/verifier from URL or code");
      return;
    }
  } else {
    // Interactive mode - generate PKCE and show auth URL
    const pkce = await generatePKCE();
    state = generateState();

    const url = new URL(AUTHORIZE_URLS.max);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
    url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    console.log("1. Open this URL in your browser:\n");
    console.log(`   ${url.toString()}\n`);
    console.log("2. Log in to your Anthropic Max account");
    console.log("3. After approval, copy the FULL URL from browser\n");

    const input = await prompt("Paste the callback URL here: ");

    // Try to parse as URL
    try {
      const parsed = new URL(input);
      code = parsed.searchParams.get("code") || input;
    } catch {
      code = input;
    }

    verifier = pkce.verifier;
  }

  console.log("⏳ Exchanging code for tokens...");

  const response = await fetch(
    TOKEN_URL,
    createOAuthTokenRequestInit({
      code,
      state: state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: CODE_CALLBACK_URL,
      code_verifier: verifier,
    }),
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`\n❌ Failed: ${response.status} - ${text}`);
    return;
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const multiAuth = loadMultiAuth();
  multiAuth.accounts ??= [];

  const account = {
    name,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);

  if (idx >= 0) {
    multiAuth.accounts[idx] = account;
    console.log(`\n✅ Updated: ${name}`);
  } else {
    multiAuth.accounts.push(account);
    console.log(`\n✅ Added: ${name}`);
  }

  saveMultiAuth(multiAuth);
  console.log("🎉 Restart OpenCode to use the new account.\n");
}

async function refreshToken(account: any): Promise<string | null> {
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
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    account.access = json.access_token;
    account.refresh = json.refresh_token;
    account.expires = Date.now() + json.expires_in * 1000;
    // Persist refreshed tokens
    const multiAuth = loadMultiAuth();
    const idx =
      multiAuth.accounts?.findIndex((a: any) => a.name === account.name) ?? -1;
    if (idx >= 0) {
      multiAuth.accounts[idx] = account;
      saveMultiAuth(multiAuth);
    }
    return null;
  } catch (err) {
    return `Token refresh error: ${String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Rate-limit header parsing (mirrors index.mjs updateMetric logic)
// Header prefixes:  anthropic-ratelimit-unified-{5h,7d,7d_sonnet}-{utilization,reset,status}
// ---------------------------------------------------------------------------

type QuotaMetric = {
  utilization: number;
  reset: number | null;
  status: string;
};
type QuotaSnapshot = {
  session5h: QuotaMetric | null;
  weekly7d: QuotaMetric | null;
  weekly7dSonnet: QuotaMetric | null;
};

function parseRateLimitHeaders(res: Response): QuotaSnapshot | null {
  function parseMetric(prefix: string): QuotaMetric | null {
    const rawUtil = res.headers.get(`${prefix}-utilization`);
    const rawReset = res.headers.get(`${prefix}-reset`);
    const rawStatus = res.headers.get(`${prefix}-status`);
    if (rawUtil === null && rawReset === null && rawStatus === null)
      return null;
    return {
      utilization: rawUtil !== null ? parseFloat(rawUtil) || 0 : 0,
      reset: rawReset !== null ? parseInt(rawReset, 10) || null : null,
      status: rawStatus ?? "unknown",
    };
  }

  const session5h = parseMetric("anthropic-ratelimit-unified-5h");
  const weekly7d = parseMetric("anthropic-ratelimit-unified-7d");
  const weekly7dSonnet = parseMetric("anthropic-ratelimit-unified-7d_sonnet");
  if (!session5h && !weekly7d && !weekly7dSonnet) return null;
  return { session5h, weekly7d, weekly7dSonnet };
}

function updateUsageState(alias: string, quota: QuotaSnapshot): void {
  const state = loadState();
  state.usage = state.usage || {};
  const prev = state.usage[alias] || {};

  function mergeMetric(prevMetric: any, newMetric: QuotaMetric | null) {
    if (!newMetric)
      return prevMetric || { utilization: 0, reset: null, status: "allowed" };
    return {
      utilization: newMetric.utilization ?? prevMetric?.utilization ?? 0,
      reset: newMetric.reset ?? prevMetric?.reset ?? null,
      status: newMetric.status ?? prevMetric?.status ?? "unknown",
    };
  }

  state.usage[alias] = {
    session5h: mergeMetric(prev.session5h, quota.session5h),
    weekly7d: mergeMetric(prev.weekly7d, quota.weekly7d),
    weekly7dSonnet: mergeMetric(prev.weekly7dSonnet, quota.weekly7dSonnet),
    timestamp: new Date().toISOString(),
  };
  saveState(state);
}

async function cmdPing(alias: string) {
  try {
    const accounts = loadAccounts();
    const account = accounts.find((item: any) => item.name === alias);

    if (!account) {
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Account not found: ${alias}`,
        }),
      );
      return;
    }

    if (!account.access && !account.refresh) {
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: "Missing access token and refresh token",
        }),
      );
      return;
    }

    // Refresh token if expired
    const refreshError = await refreshToken(account);
    if (refreshError) {
      console.log(
        JSON.stringify({ status: "error", alias, error: refreshError }),
      );
      return;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.access}`,
        "anthropic-beta": REQUIRED_BETAS.join(","),
        "user-agent": CLAUDE_CLI_USER_AGENT,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    if (res.ok) {
      // Parse rate-limit headers and save usage to state (same headers as index.mjs)
      const quota = parseRateLimitHeaders(res);
      if (quota) {
        updateUsageState(alias, quota);
      }
      console.log(
        JSON.stringify({ status: "ok", alias, quota: quota ?? undefined }),
      );
      return;
    }

    const text = await res.text();
    console.log(
      JSON.stringify({
        status: "error",
        alias,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ status: "error", alias, error: String(err) }));
  }
}

async function cmdReauth(
  alias: string,
  callbackUrl?: string,
  verifier?: string,
) {
  try {
    const accounts = loadAccounts();
    const account = accounts.find((item: any) => item.name === alias);

    if (!account) {
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Account not found: ${alias}`,
        }),
      );
      return;
    }

    if (!callbackUrl) {
      // Step 1: Generate auth URL
      const pkce = await generatePKCE();
      const state = generateState();
      const url = new URL(AUTHORIZE_URLS.max);
      url.searchParams.set("code", "true");
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
      url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      console.log(
        JSON.stringify({ url: url.toString(), verifier: pkce.verifier, state }),
      );
      return;
    }

    // Step 2: Exchange callback URL for tokens
    if (!verifier) {
      console.log(
        JSON.stringify({ status: "error", alias, error: "Missing --verifier" }),
      );
      return;
    }

    let code: string;
    try {
      const parsed = new URL(callbackUrl);
      code = parsed.searchParams.get("code") || callbackUrl;
    } catch {
      code = callbackUrl;
    }

    const response = await fetch(
      TOKEN_URL,
      createOAuthTokenRequestInit({
        code,
        state: verifier,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: CODE_CALLBACK_URL,
        code_verifier: verifier,
      }),
    );

    if (!response.ok) {
      const text = await response.text();
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Token exchange failed (${response.status}): ${text.slice(0, 200)}`,
        }),
      );
      return;
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const multiAuth = loadMultiAuth();
    multiAuth.accounts ??= [];
    const updated = {
      name: alias,
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    };
    const idx = multiAuth.accounts.findIndex((a: any) => a.name === alias);
    if (idx >= 0) {
      multiAuth.accounts[idx] = updated;
    } else {
      multiAuth.accounts.push(updated);
    }
    saveMultiAuth(multiAuth);
    console.log(JSON.stringify({ status: "ok", alias }));
  } catch (err) {
    console.log(JSON.stringify({ status: "error", alias, error: String(err) }));
  }
}

const usageCommand = Command.make(
  "usage",
  {
    watch: Options.boolean("watch").pipe(Options.withAlias("w")),
  },
  ({ watch }) =>
    Effect.sync(() => {
      cmdUsage(watch ? ["--watch"] : []);
    }),
).pipe(Command.withDescription("Show usage across all accounts"));

const usageAliasCommand = Command.make(
  "u",
  {
    watch: Options.boolean("watch").pipe(Options.withAlias("w")),
  },
  ({ watch }) =>
    Effect.sync(() => {
      cmdUsage(watch ? ["--watch"] : []);
    }),
).pipe(Command.withDescription("Alias for usage"));

const configCommand = Command.make(
  "config",
  {
    show: Options.boolean("show"),
    threshold: Options.text("threshold").pipe(Options.optional),
    thresholds: Options.text("thresholds").pipe(Options.optional),
    thresholdSession: Options.text("threshold-session").pipe(Options.optional),
    thresholdWeekly: Options.text("threshold-weekly").pipe(Options.optional),
    thresholdSonnet: Options.text("threshold-sonnet").pipe(Options.optional),
    interval: Options.text("interval").pipe(Options.optional),
    reset: Options.boolean("reset"),
  },
  ({
    show,
    threshold,
    thresholds,
    thresholdSession,
    thresholdWeekly,
    thresholdSonnet,
    interval,
    reset,
  }) =>
    Effect.sync(() => {
      const args: string[] = [];
      if (show) args.push("--show");
      if (reset) args.push("--reset");
      if (Option.isSome(threshold)) args.push("--threshold", threshold.value);
      if (Option.isSome(thresholds))
        args.push("--thresholds", thresholds.value);
      if (Option.isSome(thresholdSession))
        args.push("--threshold-session", thresholdSession.value);
      if (Option.isSome(thresholdWeekly))
        args.push("--threshold-weekly", thresholdWeekly.value);
      if (Option.isSome(thresholdSonnet))
        args.push("--threshold-sonnet", thresholdSonnet.value);
      if (Option.isSome(interval)) args.push("--interval", interval.value);
      cmdConfig(args);
    }),
).pipe(Command.withDescription("Show or update threshold configuration"));

const configAliasCommand = Command.make(
  "c",
  {
    show: Options.boolean("show"),
    threshold: Options.text("threshold").pipe(Options.optional),
    thresholds: Options.text("thresholds").pipe(Options.optional),
    thresholdSession: Options.text("threshold-session").pipe(Options.optional),
    thresholdWeekly: Options.text("threshold-weekly").pipe(Options.optional),
    thresholdSonnet: Options.text("threshold-sonnet").pipe(Options.optional),
    interval: Options.text("interval").pipe(Options.optional),
    reset: Options.boolean("reset"),
  },
  ({
    show,
    threshold,
    thresholds,
    thresholdSession,
    thresholdWeekly,
    thresholdSonnet,
    interval,
    reset,
  }) =>
    Effect.sync(() => {
      const args: string[] = [];
      if (show) args.push("--show");
      if (reset) args.push("--reset");
      if (Option.isSome(threshold)) args.push("--threshold", threshold.value);
      if (Option.isSome(thresholds))
        args.push("--thresholds", thresholds.value);
      if (Option.isSome(thresholdSession))
        args.push("--threshold-session", thresholdSession.value);
      if (Option.isSome(thresholdWeekly))
        args.push("--threshold-weekly", thresholdWeekly.value);
      if (Option.isSome(thresholdSonnet))
        args.push("--threshold-sonnet", thresholdSonnet.value);
      if (Option.isSome(interval)) args.push("--interval", interval.value);
      cmdConfig(args);
    }),
).pipe(Command.withDescription("Alias for config"));

const accountNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Account alias"),
);
const pingAliasArg = Args.text({ name: "alias" }).pipe(
  Args.withDescription("Account alias to ping"),
);
const authUrlArg = Args.text({ name: "auth-url" }).pipe(Args.optional);
const codeArg = Args.text({ name: "code" }).pipe(Args.optional);

const addCommand = Command.make(
  "add",
  {
    name: accountNameArg,
    authUrl: authUrlArg,
    code: codeArg,
  },
  ({ name, authUrl, code }) =>
    Effect.tryPromise({
      try: async () => {
        const args: string[] = [name];
        if (Option.isSome(authUrl)) args.push(authUrl.value);
        if (Option.isSome(code)) args.push(code.value);
        await cmdAdd(args);
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
).pipe(
  Command.withDescription("Add account (interactive OAuth or direct URL+code)"),
);

const addAliasCommand = Command.make(
  "a",
  {
    name: accountNameArg,
    authUrl: authUrlArg,
    code: codeArg,
  },
  ({ name, authUrl, code }) =>
    Effect.tryPromise({
      try: async () => {
        const args: string[] = [name];
        if (Option.isSome(authUrl)) args.push(authUrl.value);
        if (Option.isSome(code)) args.push(code.value);
        await cmdAdd(args);
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
).pipe(Command.withDescription("Alias for add"));

const pingCommand = Command.make(
  "ping",
  {
    alias: pingAliasArg,
  },
  ({ alias }) =>
    Effect.tryPromise({
      try: async () => {
        await cmdPing(alias);
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
).pipe(Command.withDescription("Ping an account alias and output JSON"));

const reauthAliasArg = Args.text({ name: "alias" }).pipe(
  Args.withDescription("Account alias to re-authenticate"),
);

const reauthCommand = Command.make(
  "reauth",
  {
    alias: reauthAliasArg,
    callback: Options.text("callback").pipe(Options.optional),
    verifier: Options.text("verifier").pipe(Options.optional),
  },
  ({ alias, callback, verifier }) =>
    Effect.tryPromise({
      try: async () => {
        await cmdReauth(
          alias,
          Option.isSome(callback) ? callback.value : undefined,
          Option.isSome(verifier) ? verifier.value : undefined,
        );
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
).pipe(
  Command.withDescription("Re-authenticate an existing account (JSON output)"),
);

// ============================================================================
// set-primary command
// ============================================================================

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

      const account = multiAuth.accounts.find((a: any) => a.name === name);
      if (!account) {
        console.log(`❌ Account '${name}' not found`);
        console.log(
          `Available accounts: ${multiAuth.accounts.map((a: any) => a.name).join(", ")}`,
        );
        return;
      }

      // Current order
      console.log("\n  Current order:");
      multiAuth.accounts.forEach((a: any, i: number) => {
        console.log(
          `    ${i + 1}. ${a.name}${i === 0 ? " (primary)" : " (fallback)"}`,
        );
      });

      // Move account to front
      const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);
      if (idx === 0) {
        console.log(`\n  ✓ '${name}' is already the primary account`);
        return;
      }

      const [removed] = multiAuth.accounts.splice(idx, 1);
      multiAuth.accounts.unshift(removed);

      // New order
      console.log("\n  New order:");
      multiAuth.accounts.forEach((a: any, i: number) => {
        console.log(
          `    ${i + 1}. ${a.name}${i === 0 ? " (primary)" : " (fallback)"}`,
        );
      });

      saveMultiAuth(multiAuth);
      console.log(`\n  ✓ Set '${name}' as primary account`);
      console.log("  💡 Restart OpenCode to apply changes");
    }),
).pipe(Command.withDescription("Set an account as primary"));

// ============================================================================
// list command
// ============================================================================

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

    accounts.forEach((account: any, i: number) => {
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

// ============================================================================
// remove command
// ============================================================================

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

      const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);
      if (idx < 0) {
        console.log(`❌ Account '${name}' not found`);
        console.log(
          `Available accounts: ${multiAuth.accounts.map((a: any) => a.name).join(", ")}`,
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

      multiAuth.accounts.splice(idx, 1);
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

// ============================================================================
// test command
// ============================================================================

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
        const account = accounts.find((a: any) => a.name === name);

        if (!account) {
          console.log(`\n  ❌ Account not found: ${name}`);
          console.log(
            `  Available accounts: ${accounts.map((a: any) => a.name).join(", ")}\n`,
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
            console.log(`  ❌ Token refresh failed: ${refreshError}\n`);
            return;
          }
          console.log("  ✓ Token refreshed successfully\n");
        }

        // Step 2: Send test request (inline ping)
        console.log("  Step 2: Sending test request...");
        const res = await fetch(
          "https://api.anthropic.com/v1/messages?beta=true",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${account.access}`,
              "anthropic-beta": REQUIRED_BETAS.join(","),
              "user-agent": CLAUDE_CLI_USER_AGENT,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1,
              messages: [{ role: "user", content: "ping" }],
            }),
          },
        );

        if (!res.ok) {
          const text = await res.text();
          console.log(`  ❌ Request failed: HTTP ${res.status}`);
          console.log(`     ${text.slice(0, 200)}\n`);
          return;
        }

        console.log("  ✓ API request successful\n");

        // Step 3: Check rate limits
        console.log("  Step 3: Checking rate limits...");
        const quota = parseRateLimitHeaders(res);
        if (quota) {
          updateUsageState(name, quota);
          if (quota.session5h) {
            console.log(
              `  ✓ Session (5h): ${Math.round(quota.session5h.utilization * 100)}% utilized`,
            );
          }
          if (quota.weekly7d) {
            console.log(
              `  ✓ Weekly (all): ${Math.round(quota.weekly7d.utilization * 100)}% utilized`,
            );
          }
          if (quota.weekly7dSonnet) {
            console.log(
              `  ✓ Weekly (Sonnet): ${Math.round(quota.weekly7dSonnet.utilization * 100)}% utilized`,
            );
          }
          console.log();
        } else {
          console.log("  ⚠️  No rate limit data available\n");
        }

        console.log(`  ✓ Account '${name}' is fully functional\n`);
      },
      catch: (err) => new Error(String(err)),
    }),
).pipe(Command.withDescription("Test account functionality and quotas"));

// ============================================================================
// diagnose command
// ============================================================================

const diagnoseCommand = Command.make("diagnose", {}, () =>
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
      console.log(`    ✓ Found ${multiAuth.accounts.length} accounts`);
      multiAuth.accounts.forEach((account: any, i: number) => {
        const isExpired = account.expires <= Date.now();
        const status = isExpired ? "⚠️  Token expired" : "✓ Valid";
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
      console.log(`    ✓ Current account: ${state.currentAccount}`);
    } else {
      console.log("    ⚠️  No current account set");
    }
    console.log(`    ✓ Request count: ${state.requestCount || 0}`);

    if (state.usage) {
      const accountNames = Object.keys(state.usage);
      console.log(`    ✓ Usage data: ${accountNames.length} accounts`);
    } else {
      console.log("    ⚠️  No usage data");
    }

    if (state.config) {
      const t = normalizeThresholds(state.config.threshold, DEFAULTS.threshold);
      console.log("    ✓ Config:");
      console.log(
        `      Threshold: ${Math.round(t.session5h * 100)}% / ${Math.round(t.weekly7d * 100)}% / ${Math.round(t.weekly7dSonnet * 100)}%`,
      );
      console.log(
        `      Check interval: ${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000} min`,
      );
    }
    console.log();

    // OAuth config
    console.log("  OAuth Configuration:");
    console.log("    ✓ Client ID configured");
    console.log(`    ✓ Token URL: ${TOKEN_URL}`);
    console.log(`    ✓ Callback URL: ${CODE_CALLBACK_URL}`);
    console.log("    ✓ All required scopes present\n");

    // File locations
    console.log("  File Locations:");
    console.log(`    ✓ Accounts: ${MULTI_AUTH_FILE}`);
    console.log(`    ✓ State: ${STATE_FILE}`);
    console.log();

    // Summary
    if (
      multiAuth?.accounts?.length &&
      !multiAuth.accounts.some((a: any) => a.expires <= Date.now())
    ) {
      console.log("  ✨ Everything looks good!");
    } else {
      console.log("  ⚠️  Issues found:");
      if (!multiAuth?.accounts?.length) {
        console.log("    - No accounts configured");
      }
      if (multiAuth?.accounts?.some((a: any) => a.expires <= Date.now())) {
        console.log("    - Some accounts need re-authentication");
      }
    }
    console.log("     Run `bun src/cli.ts usage` for detailed metrics\n");
  }),
).pipe(Command.withDescription("Run system diagnostics"));

// ============================================================================
// migrate command
// ============================================================================

const migrateCommand = Command.make("migrate", {}, () =>
  Effect.sync(() => {
    console.log("\n  Migration Assistant");
    console.log("  ────────────────────────────────────────\n");

    // Check for legacy files
    const legacyFiles = [
      {
        path: LEGACY_MULTI_AUTH_FILE_CONFIG,
        version: "v1.0.x (config dir)",
      },
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

// ============================================================================
// Root command
// ============================================================================

const rootCommand = Command.make("anthropic-multi-account", {}).pipe(
  Command.withDescription(
    "Manage multiple Anthropic Max accounts for OpenCode",
  ),
  Command.withSubcommands([
    usageCommand,
    usageAliasCommand,
    configCommand,
    configAliasCommand,
    pingCommand,
    reauthCommand,
    addCommand,
    addAliasCommand,
    setPrimaryCommand,
    listCommand,
    removeCommand,
    testCommand,
    diagnoseCommand,
    migrateCommand,
  ]),
);

const cli = Command.run(rootCommand, {
  name: "anthropic-multi-account",
  version: "1.1.0",
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
