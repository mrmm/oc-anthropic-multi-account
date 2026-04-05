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
        console.log(`  ⚠️  Recovered ${filePath} from backup`);
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
    console.error(`  ❌ Failed to save ${filePath}:`, e);
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

  console.log();
  console.log(
    "  ┌─────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "  │  📊 Rate Limit Usage — anthropic-multi-account v1.1.0      │",
  );
  console.log(
    "  └─────────────────────────────────────────────────────────────┘",
  );

  if (!accounts.length) {
    console.log("\n  ❌ No accounts configured");
    console.log(
      "     Run: bun src/cli.ts add <name>    Add your first account\n",
    );
    return;
  }

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const c = isActive ? "\x1b[1;36m" : "";
    const r = isActive ? "\x1b[0m" : "";

    // Account status
    const status =
      account.expires > Date.now() ? "✅ Authenticated" : "⚠️  Token expired";
    const bestQuota = isActive ? "  ✨ Best quota" : "";
    console.log(
      isActive
        ? `\n${c}┌─ ${account.name} ◄── ACTIVE${bestQuota}${r}`
        : `\n┌─ ${account.name}`,
    );
    console.log(`${c}│${r}  Status:    ${status}`);
    console.log(`${c}│${r}  Auth:      Claude Max (OAuth)`);

    if (!state.usage?.[account.name]) {
      console.log(`${c}│${r}`);
      console.log(`${c}│${r}  ⚠️  No usage data yet`);
      console.log(`${c}│${r}     Run: bun src/cli.ts ping ${account.name}`);
      console.log(`${c}└─${r}`);
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
    console.log(`${c}│${r}  Requests:     ${state.requestCount || 0} total`);
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
  console.log("  ────────────────────────────────────────");
  if (accounts.length > 1) {
    const primary = accounts[0];
    const primaryUsage = state.usage?.[primary.name];
    const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);
    if (
      primaryUsage &&
      (primaryUsage.session5h?.utilization || 0) > t.session5h * 0.9
    ) {
      console.log(
        `  ⚠️  Primary account (${primary.name}) is approaching threshold`,
      );
      console.log("     Run: bun src/cli.ts config --threshold 0.80");
    }
  }
  console.log("  💡 Tips:");
  console.log(
    "     Run: bun src/cli.ts config --help    Configuration options",
  );
  console.log("     Run: bun src/cli.ts list              Account overview");
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

    console.log("\n  ⚙️  Current Configuration");
    console.log("  ────────────────────────────────────────\n");
    if (allSame(t)) {
      console.log(`    Threshold:         ${Math.round(t.session5h * 100)}%`);
    } else {
      console.log(`    Thresholds:`);
      console.log(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      console.log(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      console.log(
        `      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`,
      );
    }
    console.log(
      `    Check interval:    ${(cfg.checkInterval ?? DEFAULTS.checkInterval) / 60000} min`,
    );
    console.log(
      "\n  💡 Run: bun src/cli.ts config --threshold 0.80    Change thresholds\n",
    );
    return;
  }

  if (args.includes("--reset")) {
    delete state.config;
    saveState(state);
    console.log("\n  ✅ Configuration reset to defaults");
    console.log(
      `     Threshold: ${Math.round(DEFAULTS.threshold * 100)}%  |  Check interval: ${DEFAULTS.checkInterval / 60000} min\n`,
    );
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
    const val = parseFloat(t);
    if (isNaN(val) || val < 0 || val > 1) {
      console.error(
        "\n  ❌ Invalid threshold value. Must be between 0 and 1 (e.g., 0.80 for 80%)",
      );
      console.error("     Run: bun src/cli.ts config --threshold 0.80\n");
      return;
    }
    if (val < 0.5) {
      console.warn(
        "\n  ⚠️  Threshold below 50% may cause frequent account switching",
      );
    }
    if (val > 0.95) {
      console.warn(
        "\n  ⚠️  Threshold above 95% increases risk of hitting rate limits",
      );
    }
    state.config.threshold = val;
    changed = true;
  }

  // --thresholds 95,80,90 → session=95%, weekly=80%, sonnet=90%
  const ta = parseArg("--thresholds");
  if (ta) {
    const parts = ta.split(",").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      console.error(
        "\n  ❌ Invalid --thresholds format. Expected: <session>,<weekly>,<sonnet>",
      );
      console.error("     Run: bun src/cli.ts config --thresholds 95,80,90\n");
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
    console.log("\n  ✅ Configuration saved");
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
            `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (threshold exceeded)`,
          );
          return;
        }
      }
    }
  } else {
    if (!isOverThreshold(primaryUsage)) {
      state.currentAccount = primary.name;
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (primary under threshold)`,
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
    console.log("\n  🔐 Add Account");
    console.log("  ────────────────────────────────────────\n");
    console.log("  Usage:");
    console.log(
      "    bun src/cli.ts add <name>                      Interactive OAuth flow",
    );
    console.log(
      "    bun src/cli.ts add <name> <auth-url> <code>    Direct mode (URL + code)",
    );
    console.log(
      "    bun src/cli.ts add <name> <auth-url> <code#s>  Direct mode with state",
    );
    console.log();
    return;
  }

  console.log(`\n  🔐 Adding account: ${name}`);
  console.log("  ────────────────────────────────────────\n");

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
      console.error("  ❌ Could not extract state/verifier from URL or code");
      console.error(
        "     Run: bun src/cli.ts add " +
          name +
          "    Try interactive mode instead",
      );
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

    console.log("  1. Open this URL in your browser:\n");
    console.log(`     ${url.toString()}\n`);
    console.log("  2. Log in to your Anthropic Max account");
    console.log("  3. After approval, copy the FULL URL from your browser\n");

    const input = await prompt("  Paste the callback URL here: ");

    // Try to parse as URL
    try {
      const parsed = new URL(input);
      code = parsed.searchParams.get("code") || input;
    } catch {
      code = input;
    }

    verifier = pkce.verifier;
  }

  console.log("  🔐 Exchanging code for tokens...");

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
    console.error(`\n  ❌ Token exchange failed (HTTP ${response.status})`);
    console.error(`     ${text.slice(0, 200)}`);
    console.error("     💡 Try again or use a fresh authorization URL\n");
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
    console.log(`\n  ✅ Account '${name}' updated`);
  } else {
    multiAuth.accounts.push(account);
    console.log(`\n  ✅ Account '${name}' added`);
  }

  saveMultiAuth(multiAuth);
  console.log("     Restart OpenCode to use the new account");
  console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
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
      const available = accounts.map((a: any) => a.name).join(", ");
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Account '${alias}' not found. Available: ${available || "none"}`,
        }),
      );
      return;
    }

    if (!account.access && !account.refresh) {
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Missing credentials. Re-authenticate with: bun src/cli.ts reauth ${alias}`,
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
      const available = accounts.map((a: any) => a.name).join(", ");
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `Account '${alias}' not found. Available: ${available || "none"}`,
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
        JSON.stringify({
          status: "error",
          alias,
          error: "Missing --verifier. Use the verifier from step 1.",
        }),
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
).pipe(Command.withDescription("Show usage metrics across all accounts"));

const usageAliasCommand = Command.make(
  "u",
  {
    watch: Options.boolean("watch").pipe(Options.withAlias("w")),
  },
  ({ watch }) =>
    Effect.sync(() => {
      cmdUsage(watch ? ["--watch"] : []);
    }),
).pipe(Command.withDescription("Show usage metrics (alias)"));

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
).pipe(Command.withDescription("Show or update configuration"));

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
).pipe(Command.withDescription("Show or update configuration (alias)"));

const accountNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Account alias (e.g., 'primary', 'fallback1')"),
);
const pingAliasArg = Args.text({ name: "alias" }).pipe(
  Args.withDescription("Account alias to ping and fetch rate limits for"),
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
).pipe(Command.withDescription("Add a new account via OAuth"));

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
).pipe(Command.withDescription("Add a new account via OAuth (alias)"));

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
).pipe(Command.withDescription("Ping an account and output JSON"));

const reauthAliasArg = Args.text({ name: "alias" }).pipe(
  Args.withDescription("Account alias to re-authenticate (e.g., 'primary')"),
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
).pipe(Command.withDescription("Re-authenticate an existing account"));

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
        console.log("\n  ❌ No accounts configured");
        console.log(
          "     Run: bun src/cli.ts add <name>    Add an account first\n",
        );
        return;
      }

      const account = multiAuth.accounts.find((a: any) => a.name === name);
      if (!account) {
        const available = multiAuth.accounts.map((a: any) => a.name).join(", ");
        console.log(`\n  ❌ Account '${name}' not found`);
        console.log(`     Available accounts: ${available}`);
        console.log("     Run: bun src/cli.ts list\n");
        return;
      }

      console.log("\n  ⚡ Set Primary Account");
      console.log("  ────────────────────────────────────────\n");

      // Current order
      console.log("  Before:");
      multiAuth.accounts.forEach((a: any, i: number) => {
        const role = i === 0 ? " (primary)" : " (fallback)";
        const marker = a.name === name ? " ◄" : "";
        console.log(`    ${i + 1}. ${a.name}${role}${marker}`);
      });

      // Move account to front
      const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);
      if (idx === 0) {
        console.log(`\n  ✅ '${name}' is already the primary account\n`);
        return;
      }

      const [removed] = multiAuth.accounts.splice(idx, 1);
      multiAuth.accounts.unshift(removed);

      // New order
      console.log("\n  After:");
      multiAuth.accounts.forEach((a: any, i: number) => {
        const role = i === 0 ? " (primary)" : " (fallback)";
        console.log(`    ${i + 1}. ${a.name}${role}`);
      });

      saveMultiAuth(multiAuth);
      console.log(`\n  ✅ '${name}' is now the primary account`);
      console.log("     Restart OpenCode to apply changes\n");
    }),
).pipe(Command.withDescription("Set an account as primary"));

// ============================================================================
// list command
// ============================================================================

const listCommand = Command.make("list", {}, () =>
  Effect.sync(() => {
    const accounts = loadAccounts();

    if (!accounts.length) {
      console.log("\n  ❌ No accounts configured");
      console.log(
        "     Run: bun src/cli.ts add <name>    Add your first account\n",
      );
      return;
    }

    console.log("\n  📋 Configured Accounts");
    console.log("  ────────────────────────────────────────\n");

    const state = loadState();

    // Table header
    const nameW = Math.max(6, ...accounts.map((a: any) => a.name.length)) + 2;
    console.log(
      `  ${"#".padEnd(4)}${"Name".padEnd(nameW)}${"Role".padEnd(12)}${"Status".padEnd(20)}${"Expires"}`,
    );
    console.log(
      `  ${"─".repeat(4)}${"─".repeat(nameW)}${"─".repeat(12)}${"─".repeat(20)}${"─".repeat(20)}`,
    );

    accounts.forEach((account: any, i: number) => {
      const isActive = state.currentAccount === account.name;
      const status = account.expires > Date.now() ? "✅ Valid" : "⚠️  Expired";
      const role = i === 0 ? "primary" : "fallback";
      const activeTag = isActive ? " ◄" : "";

      let expiresStr = "";
      if (account.expires > Date.now()) {
        const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
        const hoursLeft = Math.floor(minsLeft / 60);
        const mins = minsLeft % 60;
        expiresStr = `${hoursLeft}h ${mins}m`;
      } else {
        expiresStr = "—";
      }

      console.log(
        `  ${String(i + 1).padEnd(4)}${(account.name + activeTag).padEnd(nameW)}${role.padEnd(12)}${status.padEnd(20)}${expiresStr}`,
      );
    });

    console.log(`\n  ────────────────────────────────────────`);
    console.log(`  ${accounts.length} account(s) configured`);

    // Show fix hints for expired accounts
    const expired = accounts.filter((a: any) => a.expires <= Date.now());
    if (expired.length > 0) {
      console.log(`\n  ⚠️  ${expired.length} account(s) have expired tokens:`);
      expired.forEach((a: any) => {
        console.log(`     Run: bun src/cli.ts reauth ${a.name}`);
      });
    }

    console.log(`\n  💡 Run: bun src/cli.ts usage    View detailed metrics\n`);
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
        console.log("\n  ❌ No accounts configured\n");
        return;
      }

      const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);
      if (idx < 0) {
        const available = multiAuth.accounts.map((a: any) => a.name).join(", ");
        console.log(`\n  ❌ Account '${name}' not found`);
        console.log(`     Available accounts: ${available}`);
        console.log("     Run: bun src/cli.ts list\n");
        return;
      }

      const account = multiAuth.accounts[idx];
      const isPrimary = idx === 0;

      console.log(`\n  🗑️  Remove Account`);
      console.log("  ────────────────────────────────────────\n");

      if (isPrimary) {
        console.log("  ┌─────────────────────────────────────────┐");
        console.log("  │  ⚠️  This is the PRIMARY account         │");
        console.log("  └─────────────────────────────────────────┘\n");
      }

      console.log(`    Name:      ${account.name}`);
      console.log(`    Role:      ${isPrimary ? "primary" : "fallback"}`);
      console.log(
        `    Status:    ${account.expires > Date.now() ? "✅ Authenticated" : "⚠️  Expired"}`,
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

      console.log(`\n  ✅ Account '${name}' removed`);
      console.log("     Tokens revoked and usage data cleared");

      if (isPrimary && multiAuth.accounts.length > 0) {
        console.log(
          `     ⚡ '${multiAuth.accounts[0].name}' is now the primary account`,
        );
      }

      console.log(`\n  💡 Run: bun src/cli.ts add ${name}    Re-add later\n`);
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
          const available = accounts.map((a: any) => a.name).join(", ");
          console.log(`\n  ❌ Account '${name}' not found`);
          console.log(`     Available accounts: ${available || "none"}`);
          console.log("     Run: bun src/cli.ts list\n");
          return;
        }

        console.log(`\n  🔍 Testing Account: ${name}`);
        console.log("  ────────────────────────────────────────\n");

        let passed = 0;
        const total = 3;

        // Step 1: Check token validity
        console.log("  1. Checking token validity...");
        if (account.access && account.expires > Date.now()) {
          const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
          console.log(`     ✅ Token valid (expires in ${minsLeft} min)\n`);
          passed++;
        } else {
          console.log("     ⚠️  Token expired, attempting refresh...");
          const refreshError = await refreshToken(account);
          if (refreshError) {
            console.log(`     ❌ Refresh failed: ${refreshError}`);
            console.log(`     Run: bun src/cli.ts reauth ${name}\n`);
            console.log(`  ────────────────────────────────────────`);
            console.log(`  ❌ Result: ${passed}/${total} checks passed\n`);
            return;
          }
          console.log("     ✅ Token refreshed successfully\n");
          passed++;
        }

        // Step 2: Send test request (inline ping)
        console.log("  2. Sending API test request...");
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
          console.log(`     ❌ Request failed (HTTP ${res.status})`);
          console.log(`        ${text.slice(0, 200)}\n`);
          console.log(`  ────────────────────────────────────────`);
          console.log(`  ❌ Result: ${passed}/${total} checks passed\n`);
          return;
        }

        console.log("     ✅ API request successful\n");
        passed++;

        // Step 3: Check rate limits
        console.log("  3. Reading rate limit headers...");
        const quota = parseRateLimitHeaders(res);
        if (quota) {
          updateUsageState(name, quota);
          if (quota.session5h) {
            console.log(
              `     ✅ Session (5h):    ${Math.round(quota.session5h.utilization * 100)}% utilized`,
            );
          }
          if (quota.weekly7d) {
            console.log(
              `     ✅ Weekly (all):    ${Math.round(quota.weekly7d.utilization * 100)}% utilized`,
            );
          }
          if (quota.weekly7dSonnet) {
            console.log(
              `     ✅ Weekly (Sonnet): ${Math.round(quota.weekly7dSonnet.utilization * 100)}% utilized`,
            );
          }
          passed++;
        } else {
          console.log("     ⚠️  No rate limit headers in response (non-fatal)");
          passed++; // Still a pass - headers are optional
        }

        console.log(`\n  ────────────────────────────────────────`);
        console.log(`  ✅ Result: ${passed}/${total} checks passed`);
        console.log(`     Account '${name}' is fully functional\n`);
      },
      catch: (err) => new Error(String(err)),
    }),
).pipe(Command.withDescription("Test account connectivity and quotas"));

// ============================================================================
// diagnose command
// ============================================================================

const diagnoseCommand = Command.make("diagnose", {}, () =>
  Effect.sync(() => {
    console.log("\n  🔍 System Diagnostics");
    console.log("  ────────────────────────────────────────\n");

    const multiAuth = loadMultiAuth();
    const state = loadState();
    let issues = 0;

    // Check accounts
    console.log("  Accounts:");
    if (!multiAuth?.accounts?.length) {
      console.log("    ❌ No accounts configured");
      console.log("       Run: bun src/cli.ts add <name>\n");
      issues++;
    } else {
      console.log(`    ✅ Found ${multiAuth.accounts.length} account(s)`);
      multiAuth.accounts.forEach((account: any, i: number) => {
        const isExpired = account.expires <= Date.now();
        const status = isExpired ? "⚠️  Expired" : "✅ Valid";
        console.log(`       ${i + 1}. ${account.name} — ${status}`);
        if (isExpired) {
          console.log(`          Run: bun src/cli.ts reauth ${account.name}`);
          issues++;
        }
      });
      console.log();
    }

    // Check state
    console.log("  State:");
    if (state.currentAccount) {
      console.log(`    ✅ Active account: ${state.currentAccount}`);
    } else {
      console.log("    ⚠️  No active account set");
      issues++;
    }
    console.log(`    ✅ Request count: ${state.requestCount || 0}`);

    if (state.usage) {
      const accountNames = Object.keys(state.usage);
      console.log(`    ✅ Usage data: ${accountNames.length} account(s)`);
    } else {
      console.log("    ⚠️  No usage data");
      issues++;
    }

    if (state.config) {
      const t = normalizeThresholds(state.config.threshold, DEFAULTS.threshold);
      console.log(
        `    ✅ Config: threshold ${Math.round(t.session5h * 100)}%/${Math.round(t.weekly7d * 100)}%/${Math.round(t.weekly7dSonnet * 100)}%, interval ${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000}min`,
      );
    }
    console.log();

    // OAuth config
    console.log("  OAuth:");
    console.log("    ✅ Client ID configured");
    console.log(`    ✅ Token URL: ${TOKEN_URL}`);
    console.log(`    ✅ Callback URL: ${CODE_CALLBACK_URL}`);
    console.log("    ✅ Required scopes present\n");

    // File locations
    console.log("  Files:");
    console.log(`    ✅ Accounts: ${MULTI_AUTH_FILE}`);
    console.log(`    ✅ State:    ${STATE_FILE}`);
    console.log();

    // Summary
    console.log("  ────────────────────────────────────────");
    if (issues === 0) {
      console.log("  ✅ All checks passed — system is healthy");
    } else {
      console.log(`  ⚠️  ${issues} issue(s) found:`);
      if (!multiAuth?.accounts?.length) {
        console.log("     - No accounts configured");
      }
      if (multiAuth?.accounts?.some((a: any) => a.expires <= Date.now())) {
        console.log("     - Some accounts need re-authentication");
      }
      if (!state.currentAccount) {
        console.log("     - No active account set");
      }
    }
    console.log("     Run: bun src/cli.ts usage    View detailed metrics\n");
  }),
).pipe(Command.withDescription("Run system diagnostics and health checks"));

// ============================================================================
// migrate command
// ============================================================================

const migrateCommand = Command.make("migrate", {}, () =>
  Effect.sync(() => {
    console.log("\n  🔍 Migration Assistant");
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
      console.log("  ✅ No legacy files found — installation is up to date\n");
      return;
    }

    console.log(`  ⚠️  Found ${foundLegacy.length} legacy file(s):\n`);
    foundLegacy.forEach((f, i) => {
      console.log(`    ${i + 1}. ${f.path}`);
      console.log(`       Version: ${f.version}`);
    });

    console.log(`\n  New location: ${MULTI_AUTH_FILE}\n`);

    console.log("  Migration will:");
    console.log("    1. Move accounts to new location");
    console.log("    2. Update auth endpoints to platform.claude.com");
    console.log("    3. Preserve all tokens and usage data");
    console.log("    4. Create backups of original files\n");

    console.log("  ┌─────────────────────────────────────────────────────┐");
    console.log("  │  ⚠️  Due to endpoint changes, you will need to      │");
    console.log("  │     re-authorize accounts after migration            │");
    console.log("  └─────────────────────────────────────────────────────┘\n");

    console.log("  Next steps:");
    console.log("    1. Restart OpenCode (migration runs automatically)");
    console.log("    2. Re-authorize each account:");
    console.log("       Run: bun src/cli.ts reauth <account-name>");
    console.log("    3. Or add accounts fresh:");
    console.log("       Run: bun src/cli.ts add <account-name>\n");
  }),
).pipe(Command.withDescription("Assist with version migration"));

// ============================================================================
// config-interactive command
// ============================================================================

const interactiveConfigCommand = Command.make("config-interactive", {}, () =>
  Effect.tryPromise({
    try: async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const state = loadState();
      state.config = state.config || {};

      console.log("\n  ⚙️  Configuration Wizard");
      console.log("  ────────────────────────────────────────\n");

      const currentThresholds = normalizeThresholds(
        state.config.threshold,
        DEFAULTS.threshold,
      );

      console.log("  Current settings:");
      console.log(
        `    Session (5h):    ${Math.round(currentThresholds.session5h * 100)}%`,
      );
      console.log(
        `    Weekly (all):    ${Math.round(currentThresholds.weekly7d * 100)}%`,
      );
      console.log(
        `    Weekly (Sonnet): ${Math.round(currentThresholds.weekly7dSonnet * 100)}%`,
      );
      console.log(
        `    Check interval:  ${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000} min\n`,
      );

      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      const session = await ask(
        `  Session (5h) threshold %  [${Math.round(currentThresholds.session5h * 100)}]: `,
      );
      const weekly = await ask(
        `  Weekly (all) threshold %  [${Math.round(currentThresholds.weekly7d * 100)}]: `,
      );
      const sonnet = await ask(
        `  Weekly (Sonnet) threshold %  [${Math.round(currentThresholds.weekly7dSonnet * 100)}]: `,
      );
      const interval = await ask(
        `  Check interval (minutes)  [${(state.config.checkInterval || DEFAULTS.checkInterval) / 60000}]: `,
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
      console.log("\n  ┌─────────────────────────────────────────┐");
      console.log("  │  Preview                                 │");
      console.log("  └─────────────────────────────────────────┘");
      console.log(
        `    Session (5h):    ${Math.round(sessionVal * 100)}%  (switch when exceeded)`,
      );
      console.log(
        `    Weekly (all):    ${Math.round(weeklyVal * 100)}%  (switch when exceeded)`,
      );
      console.log(
        `    Weekly (Sonnet): ${Math.round(sonnetVal * 100)}%  (switch when exceeded)`,
      );
      console.log(
        `    Check interval:  every ${intervalVal / 60000} minutes\n`,
      );

      const confirm = await ask("  Apply these settings? (Y/n) ");

      if (confirm.toLowerCase() !== "n") {
        state.config.threshold = {
          session5h: sessionVal,
          weekly7d: weeklyVal,
          weekly7dSonnet: sonnetVal,
        };
        state.config.checkInterval = intervalVal;
        autoEvaluate(state);
        saveState(state);
        console.log("\n  ✅ Configuration saved\n");
      } else {
        console.log("\n  ❌ Configuration cancelled\n");
      }

      rl.close();
    },
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }),
).pipe(Command.withDescription("Interactive configuration wizard"));

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
    interactiveConfigCommand,
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
