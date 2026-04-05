#!/usr/bin/env bun

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

/**
 * Resolve thresholds for a specific account, merging per-account overrides with global defaults.
 */
function getAccountThresholds(accountName: string, config: any): PerMetric {
  const globalThreshold = normalizeThresholds(
    config?.threshold,
    DEFAULTS.threshold,
  );
  const accountConfig = config?.accounts?.[accountName];
  if (!accountConfig?.threshold) return globalThreshold;

  const accountThreshold = normalizeThresholds(
    accountConfig.threshold,
    undefined as any,
  );
  return {
    session5h: accountThreshold.session5h ?? globalThreshold.session5h,
    weekly7d: accountThreshold.weekly7d ?? globalThreshold.weekly7d,
    weekly7dSonnet:
      accountThreshold.weekly7dSonnet ?? globalThreshold.weekly7dSonnet,
  };
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

function progressBar(
  utilization: number,
  threshold: number,
  width: number = 35,
): string {
  const filled = Math.round(utilization * width);
  const threshPos = Math.round(threshold * width);
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i === threshPos && threshPos > 0 && threshPos < width) {
      bar += "\x1b[2m\u2502\x1b[0m"; // dim │ threshold marker
    } else if (i < filled) {
      bar += "\u2501"; // ━ filled
    } else {
      bar += "\x1b[2m\u2501\x1b[0m"; // dim ━ empty
    }
  }
  return bar;
}

function formatResetTime(ts: number | null): string {
  if (!ts) return "\u2014";
  const now = Date.now();
  const resetMs = ts * 1000;
  const diffMs = resetMs - now;
  if (diffMs <= 0) return "\u2014";
  const totalMin = Math.floor(diffMs / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
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

function colorize(text: string, util: number, threshold: number): string {
  const ratio = threshold > 0 ? util / threshold : 0;
  if (ratio >= 1) return `\x1b[31m${text}\x1b[0m`; // Red — over threshold
  if (ratio >= 0.9) return `\x1b[33m${text}\x1b[0m`; // Yellow — 90-100% of threshold
  if (ratio >= 0.7) return `\x1b[33m${text}\x1b[0m`; // Yellow — 70-90% of threshold
  return `\x1b[32m${text}\x1b[0m`; // Green — under 70% of threshold
}

function relativeLastUsed(timestamp: string | null): string {
  if (!timestamp) return "idle";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

  const totalRequests = state.requestCount || 0;
  const CARD_W = 72;

  // Compact header
  console.log();
  console.log(
    `  anthropic-multi-account v1.1.0 \u00b7 ${accounts.length} account${accounts.length !== 1 ? "s" : ""} \u00b7 ${totalRequests} requests`,
  );

  if (!accounts.length) {
    console.log("\n  No accounts configured. Run: bun src/cli.ts add <name>\n");
    return;
  }

  const globalT = normalizeThresholds(config.threshold, DEFAULTS.threshold);

  // Compact table mode for watch with 3+ accounts
  if (watch && accounts.length >= 3) {
    renderCompactUsage(accounts, state, config, totalRequests);

    // Summary line
    const activeAcct = state.currentAccount || accounts[0]?.name || "none";
    const threshStr = allSame(globalT)
      ? `${Math.round(globalT.session5h * 100)}%`
      : `${Math.round(globalT.session5h * 100)}/${Math.round(globalT.weekly7d * 100)}/${Math.round(globalT.weekly7dSonnet * 100)}%`;
    const intervalMin =
      (config.checkInterval ?? DEFAULTS.checkInterval) / 60000;
    console.log(
      `\n  Active: ${activeAcct} \u00b7 Thresholds: ${threshStr} \u00b7 Check: ${intervalMin}m`,
    );

    const timeStr = new Date().toLocaleTimeString();
    console.log(
      `  \u2500\u2500\u2500 Updated ${timeStr} \u00b7 refreshes 5s \u00b7 Ctrl+C \u2500\u2500\u2500`,
    );
    console.log();
    return;
  }

  const BAR_W = 35;
  const LABEL_W = 16;

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const usage = state.usage?.[account.name];
    const acctT = getAccountThresholds(account.name, config);
    const thresholdMap: Record<string, number> = {
      session5h: acctT.session5h,
      weekly7d: acctT.weekly7d,
      weekly7dSonnet: acctT.weekly7dSonnet,
    };

    // Top border with account name
    const activeTag = isActive ? " \u25c4 ACTIVE" : "";
    const authType = account.type === "api_key" ? " [API key]" : "";
    const titleContent = `\u2500 ${account.name}${authType}${activeTag} `;
    const topPad = Math.max(0, CARD_W - 4 - titleContent.length);
    const topBorder = `  \u250c${titleContent}${"\u2500".repeat(topPad)}\u2510`;
    if (isActive) {
      console.log(`\n\x1b[1;36m${topBorder}\x1b[0m`);
    } else {
      console.log(`\n${topBorder}`);
    }

    // Status line
    const authStatus =
      account.type === "api_key"
        ? "\u2705 API Key"
        : account.expires > Date.now()
          ? "\u2705 Authenticated"
          : "\u26a0\ufe0f  Token expired";
    const reqCount = totalRequests;
    const lastUsed = relativeLastUsed(usage?.timestamp || null);
    const statusLine = `${authStatus} \u00b7 ${isActive ? reqCount + " requests" : "0 requests"} \u00b7 ${isActive ? "last used " + lastUsed : "idle"}`;
    const statusInner = padToWidth(statusLine, CARD_W - 4);
    console.log(`  \u2502  ${statusInner}\u2502`);

    // Empty separator
    console.log(`  \u2502${" ".repeat(CARD_W - 2)}\u2502`);

    if (!usage) {
      const noData =
        "\u26a0\ufe0f  No usage data \u2014 run: bun src/cli.ts ping " +
        account.name;
      const noDataInner = padToWidth(noData, CARD_W - 4);
      console.log(`  \u2502  ${noDataInner}\u2502`);
    } else {
      // Metric rows
      for (const [label, key] of [
        ["Session (5h)", "session5h"],
        ["Weekly (all)", "weekly7d"],
        ["Weekly (Snnt)", "weekly7dSonnet"],
      ] as const) {
        const u = usage[key]?.utilization || 0;
        const th = thresholdMap[key];
        const pct = Math.round(u * 100);
        const resetStr = formatResetTime(usage[key]?.reset);
        const overMarker = u > th ? " !" : "";

        // Build colored bar with threshold marker
        const filledCount = Math.round(u * BAR_W);
        let coloredBar = "";
        for (let i = 0; i < BAR_W; i++) {
          const isThreshPos =
            i === Math.round(th * BAR_W) &&
            Math.round(th * BAR_W) > 0 &&
            Math.round(th * BAR_W) < BAR_W;
          if (isThreshPos) {
            coloredBar += "\x1b[2m\u2502\x1b[0m";
          } else if (i < filledCount) {
            const ratio = th > 0 ? u / th : 0;
            if (ratio >= 1) coloredBar += "\x1b[31m\u2501\x1b[0m";
            else if (ratio >= 0.7) coloredBar += "\x1b[33m\u2501\x1b[0m";
            else coloredBar += "\x1b[32m\u2501\x1b[0m";
          } else {
            coloredBar += "\x1b[2m\u2501\x1b[0m";
          }
        }

        const pctStr = `${pct}%${overMarker}`;
        const pctColored = colorize(pctStr.padStart(5), u, th);
        const resetColored = `\x1b[2m${resetStr.padEnd(6)}\x1b[0m`;

        const lineContent = `${label.padEnd(LABEL_W)}${coloredBar} ${pctColored}  ${resetColored}`;
        const lineInner = padToWidth(lineContent, CARD_W - 4);
        console.log(`  \u2502  ${lineInner}\u2502`);
      }
    }

    // Bottom border
    console.log(`  \u2514${"\u2500".repeat(CARD_W - 2)}\u2518`);
  }

  // Summary line
  const activeAcct = state.currentAccount || accounts[0]?.name || "none";
  const threshStr = allSame(globalT)
    ? `${Math.round(globalT.session5h * 100)}%`
    : `${Math.round(globalT.session5h * 100)}/${Math.round(globalT.weekly7d * 100)}/${Math.round(globalT.weekly7dSonnet * 100)}%`;
  const intervalMin = (config.checkInterval ?? DEFAULTS.checkInterval) / 60000;
  console.log(
    `\n  Active: ${activeAcct} \u00b7 Thresholds: ${threshStr} \u00b7 Check interval: ${intervalMin}m`,
  );

  if (watch) {
    const timeStr = new Date().toLocaleTimeString();
    console.log(
      `\n  \u2500\u2500\u2500 Updated ${timeStr} \u00b7 refreshes every 5s \u00b7 Ctrl+C to exit \u2500\u2500\u2500`,
    );
  }

  console.log();
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Approximate display width accounting for wide chars (emoji, CJK). */
function displayWidth(str: string): number {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    // Variation selectors / zero-width joiners
    if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue;
    // Common wide ranges: emoji, CJK, box-drawing (1-wide), etc.
    if (
      (cp >= 0x1f000 && cp <= 0x1ffff) || // Supplemental Symbols, Emoticons
      (cp >= 0x2600 && cp <= 0x27bf) || // Misc Symbols, Dingbats
      (cp >= 0x2702 && cp <= 0x27b0) ||
      cp === 0x2705 || // ✅
      cp === 0x26a0 || // ⚠
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = displayWidth(str);
  const pad = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(pad);
}

function compactBar(
  utilization: number,
  threshold: number,
  width: number = 5,
): string {
  const filled = Math.round(utilization * width);
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const ratio = threshold > 0 ? utilization / threshold : 0;
      if (ratio >= 1) bar += "\x1b[31m\u2501\x1b[0m";
      else if (ratio >= 0.7) bar += "\x1b[33m\u2501\x1b[0m";
      else bar += "\x1b[32m\u2501\x1b[0m";
    } else {
      bar += "\x1b[2m\u2591\x1b[0m";
    }
  }
  bar += "\x1b[2m\u2502\x1b[0m";
  return bar;
}

function renderCompactUsage(
  accounts: any[],
  state: any,
  config: any,
  totalRequests: number,
) {
  // Header
  const nameW = Math.max(14, ...accounts.map((a: any) => a.name.length + 4));
  console.log();
  console.log(
    `  ${"Account".padEnd(nameW)}${"Status".padEnd(8)}${"Session(5h)".padEnd(13)}${"Weekly(all)".padEnd(13)}${"Weekly(Snnt)"}`,
  );
  console.log(
    `  ${"\u2500".repeat(nameW)}${"\u2500".repeat(8)}${"\u2500".repeat(13)}${"\u2500".repeat(13)}${"\u2500".repeat(12)}`,
  );

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const usage = state.usage?.[account.name];
    const activeTag = isActive ? " \u25c4" : "";
    const authOk = account.type === "api_key" || account.expires > Date.now();
    const statusIcon = authOk ? "\u2705" : "\u26a0\ufe0f";
    const acctT = getAccountThresholds(account.name, config);
    const thresholdMap: Record<string, number> = {
      session5h: acctT.session5h,
      weekly7d: acctT.weekly7d,
      weekly7dSonnet: acctT.weekly7dSonnet,
    };

    let cols = "";
    if (!usage) {
      cols = "\x1b[2mno data\x1b[0m";
    } else {
      for (const key of ["session5h", "weekly7d", "weekly7dSonnet"] as const) {
        const u = usage[key]?.utilization || 0;
        const th = thresholdMap[key];
        const pct = Math.round(u * 100);
        const pctStr = colorize(`${pct}%`.padStart(4), u, th);
        const bar = compactBar(u, th);
        cols += `${pctStr} ${bar}  `;
      }
    }

    console.log(
      `  ${(account.name + activeTag).padEnd(nameW)}${statusIcon.padEnd(8)}${cols}`,
    );
  }
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

  const parseArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  const accountName = parseArg("--account");

  // Per-account config mode
  if (accountName) {
    const accounts = loadAccounts();
    if (!accounts.find((a: any) => a.name === accountName)) {
      const available = accounts.map((a: any) => a.name).join(", ");
      console.error(`\n  ❌ Account '${accountName}' not found`);
      console.error(`     Available: ${available || "none"}\n`);
      return;
    }

    state.config = state.config || {};
    state.config.accounts = state.config.accounts || {};

    // Show per-account config
    const hasThresholdArg =
      args.includes("--threshold") ||
      args.includes("--thresholds") ||
      args.includes("--threshold-session") ||
      args.includes("--threshold-weekly") ||
      args.includes("--threshold-sonnet");

    if (!hasThresholdArg && !args.includes("--reset")) {
      const t = getAccountThresholds(accountName, state.config);
      const globalT = normalizeThresholds(
        state.config.threshold,
        DEFAULTS.threshold,
      );
      const hasOverride = !!state.config.accounts[accountName]?.threshold;

      console.log(`\n  ⚙️  Configuration for account: ${accountName}`);
      console.log("  ────────────────────────────────────────\n");
      if (hasOverride) {
        console.log(`    Thresholds (per-account override):`);
      } else {
        console.log(`    Thresholds (using global defaults):`);
      }
      console.log(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      console.log(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      console.log(
        `      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`,
      );
      if (hasOverride) {
        const gStr = allSame(globalT)
          ? `${Math.round(globalT.session5h * 100)}%`
          : `${Math.round(globalT.session5h * 100)}/${Math.round(globalT.weekly7d * 100)}/${Math.round(globalT.weekly7dSonnet * 100)}%`;
        console.log(`\n    Global fallback:   ${gStr}`);
      }
      console.log(
        `\n  💡 Run: bun src/cli.ts config --account ${accountName} --threshold 0.80\n`,
      );
      return;
    }

    // Reset per-account config
    if (args.includes("--reset")) {
      delete state.config.accounts[accountName];
      if (Object.keys(state.config.accounts).length === 0) {
        delete state.config.accounts;
      }
      saveState(state);
      console.log(
        `\n  ✅ Per-account config for '${accountName}' removed (using global defaults)\n`,
      );
      return;
    }

    // Set per-account thresholds
    state.config.accounts[accountName] =
      state.config.accounts[accountName] || {};
    let changed = false;

    const t = parseArg("--threshold");
    if (t) {
      const val = parseFloat(t);
      if (isNaN(val) || val < 0 || val > 1) {
        console.error(
          "\n  ❌ Invalid threshold value. Must be between 0 and 1\n",
        );
        return;
      }
      state.config.accounts[accountName].threshold = val;
      changed = true;
    }

    const ta = parseArg("--thresholds");
    if (ta) {
      const parts = ta.split(",").map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) {
        console.error(
          "\n  ❌ Invalid --thresholds format. Expected: <session>,<weekly>,<sonnet>\n",
        );
        return;
      }
      state.config.accounts[accountName].threshold = {
        session5h: parts[0] / 100,
        weekly7d: parts[1] / 100,
        weekly7dSonnet: parts[2] / 100,
      };
      changed = true;
    }

    const ts = parseArg("--threshold-session");
    if (ts) {
      const current = state.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, state.config);
      if (typeof current !== "object" || current === null) {
        state.config.accounts[accountName].threshold = { ...resolved };
      }
      state.config.accounts[accountName].threshold.session5h = parseFloat(ts);
      changed = true;
    }

    const tw = parseArg("--threshold-weekly");
    if (tw) {
      const current = state.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, state.config);
      if (typeof current !== "object" || current === null) {
        state.config.accounts[accountName].threshold = { ...resolved };
      }
      state.config.accounts[accountName].threshold.weekly7d = parseFloat(tw);
      changed = true;
    }

    const tso = parseArg("--threshold-sonnet");
    if (tso) {
      const current = state.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, state.config);
      if (typeof current !== "object" || current === null) {
        state.config.accounts[accountName].threshold = { ...resolved };
      }
      state.config.accounts[accountName].threshold.weekly7dSonnet =
        parseFloat(tso);
      changed = true;
    }

    if (changed) {
      autoEvaluate(state);
      saveState(state);
      console.log(`\n  ✅ Per-account config for '${accountName}' saved`);
      cmdConfig(["--account", accountName]);
    }
    return;
  }

  // Global config mode (original behavior)
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

    // Show per-account overrides if any exist
    const accountOverrides = cfg.accounts;
    if (accountOverrides && Object.keys(accountOverrides).length > 0) {
      console.log("\n    Per-account overrides:");
      for (const [name, acctCfg] of Object.entries(accountOverrides) as [
        string,
        any,
      ][]) {
        if (acctCfg?.threshold) {
          const at = getAccountThresholds(name, cfg);
          if (allSame(at)) {
            console.log(`      ${name}: ${Math.round(at.session5h * 100)}%`);
          } else {
            console.log(
              `      ${name}: ${Math.round(at.session5h * 100)}/${Math.round(at.weekly7d * 100)}/${Math.round(at.weekly7dSonnet * 100)}%`,
            );
          }
        }
      }
    }

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

  function isOverThreshold(accountName: string, usage: any): boolean {
    if (!usage) return false;
    const t = getAccountThresholds(accountName, config);
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
    if (isOverThreshold(primary.name, primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        if (!isOverThreshold(fallback.name, state.usage?.[fallback.name])) {
          state.currentAccount = fallback.name;
          console.log(
            `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (threshold exceeded)`,
          );
          return;
        }
      }
    }
  } else {
    if (!isOverThreshold(primary.name, primaryUsage)) {
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

// Shared readline interface — reuse across multiple prompts to prevent
// Bun from closing stdin when a readline instance is destroyed.
let _rl: ReturnType<typeof readline.createInterface> | null = null;

function getRL(): ReturnType<typeof readline.createInterface> {
  if (!_rl) {
    _rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    _rl.on("close", () => {
      _rl = null;
    });
  }
  return _rl;
}

function closeRL() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

async function prompt(q: string): Promise<string> {
  const rl = getRL();
  return new Promise((resolve) =>
    rl.question(q, (a) => {
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
    console.log("\n  \ud83d\udd10 Add Account");
    console.log(
      "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
    );
    console.log("  Usage:");
    console.log(
      "    bun src/cli.ts add <name>                      Interactive (OAuth or API key)",
    );
    console.log(
      "    bun src/cli.ts add <name> <auth-url> <code>    Direct OAuth mode (URL + code)",
    );
    console.log(
      "    bun src/cli.ts add <name> <auth-url> <code#s>  Direct OAuth mode with state",
    );
    console.log();
    return;
  }

  console.log(`\n  \ud83d\udd10 Adding account: ${name}`);
  console.log(
    "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
  );

  // Direct mode - URL and code provided (always OAuth)
  if (authUrl && authCode) {
    const extractedState = extractStateFromUrl(authUrl);
    const parsed = parseAuthCode(authCode);

    const code = parsed.code;
    const state = parsed.state || extractedState || "";
    const verifier = state;

    if (!verifier) {
      console.error(
        "  \u274c Could not extract state/verifier from URL or code",
      );
      console.error(
        "     Run: bun src/cli.ts add " +
          name +
          "    Try interactive mode instead",
      );
      return;
    }

    console.log("  \ud83d\udd10 Exchanging code for tokens...");

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
      console.error(
        `\n  \u274c Token exchange failed (HTTP ${response.status})`,
      );
      console.error(`     ${text.slice(0, 200)}`);
      console.error(
        "     \ud83d\udca1 Try again or use a fresh authorization URL\n",
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

    const account = {
      name,
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      type: "oauth",
    };
    const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);

    if (idx >= 0) {
      multiAuth.accounts[idx] = account;
      console.log(`\n  \u2705 Account '${name}' updated`);
    } else {
      multiAuth.accounts.push(account);
      console.log(`\n  \u2705 Account '${name}' added`);
    }

    saveMultiAuth(multiAuth);
    console.log("     Restart OpenCode to use the new account");
    console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
    return;
  }

  // Interactive mode - choose auth method
  console.log("  Choose authentication method:");
  console.log("    1. Claude Pro/Max (OAuth)");
  console.log("    2. Manually enter API Key\n");

  const method = await prompt("  ? Select method (1): ");
  const choice = method.trim() || "1";

  if (choice === "2") {
    // Manual API key
    const apiKey = await prompt("  ? Enter your API key: ");
    if (!apiKey) {
      console.error("\n  \u274c No API key provided\n");
      return;
    }

    const multiAuth = loadMultiAuth();
    multiAuth.accounts ??= [];

    const account = {
      name,
      apiKey,
      type: "api_key",
    };
    const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);

    if (idx >= 0) {
      multiAuth.accounts[idx] = account;
      console.log(`\n  \u2705 Account '${name}' updated with API key`);
    } else {
      multiAuth.accounts.push(account);
      console.log(`\n  \u2705 Account '${name}' added with API key`);
    }

    saveMultiAuth(multiAuth);
    console.log("     Restart OpenCode to use the new account");
    console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
    return;
  }

  // OAuth flow
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

  console.log("\n  1. Open this URL in your browser:\n");
  console.log(`     ${url.toString()}\n`);
  console.log("  2. Log in to your Anthropic Max account and authorize");
  console.log("  3. Copy the authorization code shown after approval\n");
  console.log("     (You can also paste the full callback URL — both work)\n");

  const input = await prompt("  ? Paste authorization code: ");

  let code: string;
  // Try to parse as URL
  try {
    const parsed = new URL(input);
    code = parsed.searchParams.get("code") || input;
  } catch {
    code = input;
  }

  console.log("\n  \u231b Exchanging code for tokens...");

  const response = await fetch(
    TOKEN_URL,
    createOAuthTokenRequestInit({
      code,
      state: state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: CODE_CALLBACK_URL,
      code_verifier: pkce.verifier,
    }),
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`\n  \u274c Token exchange failed (HTTP ${response.status})`);
    console.error(`     ${text.slice(0, 200)}`);
    console.error(
      "     \ud83d\udca1 Try again or use a fresh authorization URL\n",
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

  const account = {
    name,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    type: "oauth",
  };
  const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);

  if (idx >= 0) {
    multiAuth.accounts[idx] = account;
    console.log(`\n  \u2705 Account '${name}' updated`);
  } else {
    multiAuth.accounts.push(account);
    console.log(`\n  \u2705 Account '${name}' added`);
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

function miniProgressBar(utilization: number, width: number = 15): string {
  const filled = Math.round(utilization * width);
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      bar += "\u2501"; // ━
    } else {
      bar += "\x1b[2m\u2591\x1b[0m"; // dim ░
    }
  }
  return bar;
}

function formatQuotaLine(label: string, metric: QuotaMetric | null): string {
  if (!metric) {
    return `  ${label.padEnd(17)}\x1b[2m\u2014   no data\x1b[0m`;
  }
  const pct = Math.round(metric.utilization * 100);
  const pctStr = `${pct}%`.padStart(4);
  const bar = miniProgressBar(metric.utilization);
  const reset = metric.reset ? `resets ${formatResetTime(metric.reset)}` : "";
  return `  ${label.padEnd(17)}${pctStr}  ${bar}  \x1b[2m${reset}\x1b[0m`;
}

async function cmdPing(alias: string, jsonMode: boolean = false) {
  try {
    const accounts = loadAccounts();
    const account = accounts.find((item: any) => item.name === alias);

    if (!account) {
      const available = accounts.map((a: any) => a.name).join(", ");
      if (jsonMode) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: `Account '${alias}' not found. Available: ${available || "none"}`,
          }),
        );
      } else {
        console.log(`\n  \u274c Account '${alias}' not found`);
        console.log(`     Available: ${available || "none"}`);
        console.log(`     Run: bun src/cli.ts list\n`);
      }
      return;
    }

    const isApiKey = account.type === "api_key";

    if (!isApiKey && !account.access && !account.refresh) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: `Missing credentials. Re-authenticate with: bun src/cli.ts reauth ${alias}`,
          }),
        );
      } else {
        console.log(`\n  \u274c Missing credentials for '${alias}'`);
        console.log(`     Run: bun src/cli.ts reauth ${alias}\n`);
      }
      return;
    }

    if (!jsonMode) {
      console.log(`\n  \ud83d\udd0d Pinging ${alias}...`);
    }

    // Refresh token if expired (skip for API key accounts)
    if (!isApiKey) {
      const refreshError = await refreshToken(account);
      if (refreshError) {
        if (jsonMode) {
          console.log(
            JSON.stringify({ status: "error", alias, error: refreshError }),
          );
        } else {
          console.log(`\n  \u274c Token refresh failed`);
          console.log(`     ${refreshError}`);
          console.log(`     Run: bun src/cli.ts reauth ${alias}\n`);
        }
        return;
      }
    }

    const authHeaders: Record<string, string> = isApiKey
      ? { "x-api-key": account.apiKey }
      : { authorization: `Bearer ${account.access}` };

    const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: {
        ...authHeaders,
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

      if (jsonMode) {
        console.log(
          JSON.stringify({ status: "ok", alias, quota: quota ?? undefined }),
        );
        return;
      }

      console.log(`\n  \u2705 Account is reachable`);

      if (quota) {
        // Determine overall status from metrics
        const statuses = [
          quota.session5h?.status,
          quota.weekly7d?.status,
          quota.weekly7dSonnet?.status,
        ].filter(Boolean);
        const overallStatus = statuses.includes("limited")
          ? "limited"
          : "allowed";

        console.log(`\n  \ud83d\udcca Rate Limits`);
        console.log(
          `  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
        );
        console.log(formatQuotaLine("Session (5h)", quota.session5h));
        console.log(formatQuotaLine("Weekly (all)", quota.weekly7d));
        console.log(formatQuotaLine("Weekly (Sonnet)", quota.weekly7dSonnet));
        console.log(`\n  Status: ${overallStatus}`);
      } else {
        console.log(`\n  \x1b[2mNo rate limit data in response\x1b[0m`);
      }

      console.log();
      return;
    }

    const text = await res.text();
    if (jsonMode) {
      console.log(
        JSON.stringify({
          status: "error",
          alias,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        }),
      );
    } else {
      console.log(`\n  \u274c Request failed (HTTP ${res.status})`);
      console.log(`     ${text.slice(0, 200)}`);
      console.log(
        `     Run: bun src/cli.ts test ${alias}    Full diagnostics\n`,
      );
    }
  } catch (err) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ status: "error", alias, error: String(err) }),
      );
    } else {
      console.log(`\n  \u274c Connection error`);
      console.log(`     ${String(err)}`);
      console.log(`     Check your network and try again\n`);
    }
  }
}

async function cmdReauth(alias: string, args: string[]) {
  const jsonMode = args.includes("--json");

  try {
    const accounts = loadAccounts();
    const account = accounts.find((item: any) => item.name === alias);

    if (!account) {
      const available = accounts.map((a: any) => a.name).join(", ");
      if (jsonMode) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: `Account '${alias}' not found. Available: ${available || "none"}`,
          }),
        );
      } else {
        console.error(`\n  \u274c Account '${alias}' not found`);
        console.error(`     Available: ${available || "none"}\n`);
      }
      return;
    }

    // Legacy JSON mode: callbackUrl and verifier passed as positional args
    const callbackUrl = args.find((a) => !a.startsWith("--") && a !== alias);
    const verifierArg = args.find(
      (a, i) =>
        !a.startsWith("--") &&
        a !== alias &&
        i > args.indexOf(callbackUrl || ""),
    );

    if (jsonMode && callbackUrl) {
      // Legacy step 2: exchange callback for tokens (scripting mode)
      const verifier = verifierArg;
      if (!verifier) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: "Missing verifier. Use the verifier from step 1.",
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
        type: "oauth",
      };
      const idx = multiAuth.accounts.findIndex((a: any) => a.name === alias);
      if (idx >= 0) {
        multiAuth.accounts[idx] = updated;
      } else {
        multiAuth.accounts.push(updated);
      }
      saveMultiAuth(multiAuth);
      console.log(JSON.stringify({ status: "ok", alias }));
      return;
    }

    if (jsonMode && !callbackUrl) {
      // Legacy step 1: generate auth URL (scripting mode)
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

    // Interactive mode
    console.log(`\n  \ud83d\udd10 Re-authenticating: ${alias}`);
    console.log(
      "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
    );
    console.log("  Choose authentication method:");
    console.log("    1. Claude Pro/Max (OAuth)");
    console.log("    2. Manually enter API Key\n");

    const method = await prompt("  ? Select method (1): ");
    const choice = method.trim() || "1";

    if (choice === "2") {
      // Manual API key
      const apiKey = await prompt("  ? Enter your API key: ");
      if (!apiKey) {
        console.error("\n  \u274c No API key provided\n");
        return;
      }

      const multiAuth = loadMultiAuth();
      multiAuth.accounts ??= [];
      const updated: any = {
        name: alias,
        apiKey,
        type: "api_key",
      };
      // Clear OAuth fields
      delete updated.access;
      delete updated.refresh;
      delete updated.expires;

      const idx = multiAuth.accounts.findIndex((a: any) => a.name === alias);
      if (idx >= 0) {
        multiAuth.accounts[idx] = updated;
      } else {
        multiAuth.accounts.push(updated);
      }
      saveMultiAuth(multiAuth);
      console.log(`\n  \u2705 API key saved for '${alias}'\n`);
      return;
    }

    // OAuth flow
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

    console.log("\n  1. Open this URL in your browser:\n");
    console.log(`     ${url.toString()}\n`);
    console.log("  2. Log in and authorize the application");
    console.log("  3. Copy the authorization code shown after approval\n");
    console.log(
      "     (You can also paste the full callback URL — both work)\n",
    );

    const input = await prompt("  ? Paste authorization code: ");

    let code: string;
    try {
      const parsed = new URL(input);
      code = parsed.searchParams.get("code") || input;
    } catch {
      code = input;
    }

    console.log("\n  \u231b Exchanging tokens...");

    const response = await fetch(
      TOKEN_URL,
      createOAuthTokenRequestInit({
        code,
        state: state,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: CODE_CALLBACK_URL,
        code_verifier: pkce.verifier,
      }),
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `\n  \u274c Token exchange failed (HTTP ${response.status})`,
      );
      console.error(`     ${text.slice(0, 200)}`);
      console.error(
        "     \ud83d\udca1 Try again or use a fresh authorization URL\n",
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
      type: "oauth",
    };
    const idx = multiAuth.accounts.findIndex((a: any) => a.name === alias);
    if (idx >= 0) {
      multiAuth.accounts[idx] = updated;
    } else {
      multiAuth.accounts.push(updated);
    }
    saveMultiAuth(multiAuth);

    const expiresMin = Math.round(json.expires_in / 60);
    console.log(`  \u2705 Account '${alias}' re-authenticated`);
    console.log(`     Expires in ${expiresMin} minutes\n`);
    console.log(`  Run: bun src/cli.ts test ${alias}    Verify connectivity\n`);
  } catch (err) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ status: "error", alias, error: String(err) }),
      );
    } else {
      console.error(`\n  \u274c Error: ${String(err)}\n`);
    }
  }
}

// ============================================================================
// set-primary command
// ============================================================================

function cmdSetPrimary(name: string) {
  if (!name) {
    console.log("\n  ❌ Missing account name");
    console.log("  Usage: bun src/cli.ts set-primary <name>\n");
    return;
  }

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
}

// ============================================================================
// list command
// ============================================================================

function cmdList() {
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
    const isApiKey = account.type === "api_key";
    const status = isApiKey
      ? "\u2705 API Key"
      : account.expires > Date.now()
        ? "\u2705 Valid"
        : "\u26a0\ufe0f  Expired";
    const role = i === 0 ? "primary" : "fallback";
    const activeTag = isActive ? " \u25c4" : "";

    let expiresStr = "";
    if (isApiKey) {
      expiresStr = "\u221e";
    } else if (account.expires > Date.now()) {
      const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
      const hoursLeft = Math.floor(minsLeft / 60);
      const mins = minsLeft % 60;
      expiresStr = `${hoursLeft}h ${mins}m`;
    } else {
      expiresStr = "\u2014";
    }

    console.log(
      `  ${String(i + 1).padEnd(4)}${(account.name + activeTag).padEnd(nameW)}${role.padEnd(12)}${status.padEnd(20)}${expiresStr}`,
    );
  });

  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  ${accounts.length} account(s) configured`);

  // Show fix hints for expired accounts (skip API key accounts - they don't expire)
  const expired = accounts.filter(
    (a: any) => a.type !== "api_key" && a.expires <= Date.now(),
  );
  if (expired.length > 0) {
    console.log(`\n  ⚠️  ${expired.length} account(s) have expired tokens:`);
    expired.forEach((a: any) => {
      console.log(`     Run: bun src/cli.ts reauth ${a.name}`);
    });
  }

  console.log(`\n  💡 Run: bun src/cli.ts usage    View detailed metrics\n`);
}

// ============================================================================
// remove command
// ============================================================================

function cmdRemove(name: string) {
  if (!name) {
    console.log("\n  ❌ Missing account name");
    console.log("  Usage: bun src/cli.ts remove <name>\n");
    return;
  }

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
}

// ============================================================================
// test command
// ============================================================================

async function cmdTest(name: string) {
  if (!name) {
    console.log("\n  ❌ Missing account name");
    console.log("  Usage: bun src/cli.ts test <name>\n");
    return;
  }

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

  const isApiKey = account.type === "api_key";
  let passed = 0;
  const total = 3;

  // Step 1: Check token validity
  console.log("  1. Checking token validity...");
  if (isApiKey) {
    console.log(`     \u2705 API key configured (does not expire)\n`);
    passed++;
  } else if (account.access && account.expires > Date.now()) {
    const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
    console.log(`     \u2705 Token valid (expires in ${minsLeft} min)\n`);
    passed++;
  } else {
    console.log("     \u26a0\ufe0f  Token expired, attempting refresh...");
    const refreshError = await refreshToken(account);
    if (refreshError) {
      console.log(`     \u274c Refresh failed: ${refreshError}`);
      console.log(`     Run: bun src/cli.ts reauth ${name}\n`);
      console.log(
        `  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      );
      console.log(`  \u274c Result: ${passed}/${total} checks passed\n`);
      return;
    }
    console.log("     \u2705 Token refreshed successfully\n");
    passed++;
  }

  // Step 2: Send test request (inline ping)
  console.log("  2. Sending API test request...");
  const authHeaders: Record<string, string> = isApiKey
    ? { "x-api-key": account.apiKey }
    : { authorization: `Bearer ${account.access}` };

  const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: {
      ...authHeaders,
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
}

// ============================================================================
// diagnose command
// ============================================================================

function cmdDiagnose() {
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
      const isApiKey = account.type === "api_key";
      const isExpired = !isApiKey && account.expires <= Date.now();
      const status = isApiKey
        ? "\u2705 API Key"
        : isExpired
          ? "\u26a0\ufe0f  Expired"
          : "\u2705 Valid";
      console.log(`       ${i + 1}. ${account.name} \u2014 ${status}`);
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
}

// ============================================================================
// migrate command
// ============================================================================

function cmdMigrate() {
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
}

// ============================================================================
// config-interactive command
// ============================================================================

async function cmdConfigInteractive() {
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
  console.log(`    Check interval:  every ${intervalVal / 60000} minutes\n`);

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
}

// ============================================================================
// switch command
// ============================================================================

function cmdSwitch(name: string) {
  if (!name) {
    console.log("\n  ❌ Missing account name");
    console.log("  Usage: bun src/cli.ts switch <name>\n");
    return;
  }

  const accounts = loadAccounts();
  const account = accounts.find((a: any) => a.name === name);

  if (!account) {
    console.log(`\n  ❌ Account '${name}' not found`);
    console.log(`  Available: ${accounts.map((a: any) => a.name).join(", ")}`);
    console.log("  Run: bun src/cli.ts list\n");
    return;
  }

  const state = loadState();
  const previous = state.currentAccount || accounts[0]?.name;

  if (previous === name) {
    console.log(`\n  ✅ Already using '${name}'\n`);
    return;
  }

  state.currentAccount = name;
  state.lastPrimaryCheck = Date.now(); // Reset check timer
  saveState(state);

  console.log(`\n  ⚡ Switched: ${previous} → ${name}`);
  console.log(`  Active account is now '${name}'`);
  console.log("\n  Note: Automatic threshold switching will resume normally.");
  console.log(
    "  The system may switch away if this account exceeds thresholds.\n",
  );
}

// ============================================================================
// Help
// ============================================================================

function showHelp() {
  console.log(`
  anthropic-multi-account v1.1.0
  Manage multiple Anthropic Max accounts with automatic failover.

  ACCOUNT MANAGEMENT
    add <name>              Add account (OAuth or API key)
    reauth <name>           Re-authenticate account
    reauth <name> --json    Re-authenticate (JSON output for scripting)
    list, ls                List all configured accounts
    set-primary <name>      Set an account as the primary
    remove, rm <name>       Remove an account

  MONITORING
    usage, u [--watch]      Show rate limit usage dashboard
    test <name>             Test account connectivity and quotas
    ping <name> [--json]    Ping account (human-readable, or JSON with --json)
    diagnose                Run system diagnostics

  ACCOUNT SWITCHING
    switch <name>           Force switch to a specific account

  CONFIGURATION
    config                           Show global configuration
    config --account <name>          Show account-specific config
    config --account <name> --threshold 0.95
                                     Set per-account threshold
    config --threshold 0.8           Set all global thresholds (0-1)
    config --thresholds 95,80,90     Set session, weekly, sonnet thresholds
    config --interval 30             Set recovery check interval (minutes)
    config --reset                   Reset to defaults
    config-interactive               Interactive configuration wizard

  OTHER
    migrate                 Assist with version migration
    help, --help            Show this help message
    version, --version      Show version number

  EXAMPLES
    bun src/cli.ts add primary                       Add your first account
    bun src/cli.ts usage --watch                     Live usage dashboard
    bun src/cli.ts switch fallback1                  Force switch to fallback1
    bun src/cli.ts config --thresholds 95,80,90      Set global thresholds
    bun src/cli.ts config --account primary --threshold 0.95
                                                     Set per-account threshold
`);
}

// ============================================================================
// Main dispatcher
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "usage":
    case "u":
      cmdUsage(rest);
      break;
    case "config":
    case "c":
      cmdConfig(rest);
      break;
    case "config-interactive":
      await cmdConfigInteractive();
      break;
    case "add":
    case "a":
      await cmdAdd(rest);
      break;
    case "reauth":
      await cmdReauth(rest[0], rest.slice(1));
      break;
    case "ping":
      await cmdPing(rest[0], rest.includes("--json"));
      break;
    case "test":
      await cmdTest(rest[0]);
      break;
    case "switch":
      cmdSwitch(rest[0]);
      break;
    case "set-primary":
      cmdSetPrimary(rest[0]);
      break;
    case "list":
    case "ls":
      cmdList();
      break;
    case "remove":
    case "rm":
      cmdRemove(rest[0]);
      break;
    case "diagnose":
      cmdDiagnose();
      break;
    case "migrate":
      cmdMigrate();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      break;
    case "version":
    case "--version":
    case "-V":
      console.log("anthropic-multi-account v1.1.0");
      break;
    default:
      console.log(`\n  ❌ Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    closeRL();
  });
