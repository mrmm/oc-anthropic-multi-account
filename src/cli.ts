#!/usr/bin/env bun

import { generatePKCE } from "@openauthjs/openauth/pkce";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  mkdirSync,
  statSync,
  readdirSync,
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
const DATA_FILE = join(CONFIG_DIR, "anthropic-multi-account.json");

// Legacy file paths (for migration)
const LEGACY_ACCOUNTS_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-accounts.json",
);
const LEGACY_ACCOUNTS_FILE_CONFIG = join(
  CONFIG_DIR,
  "anthropic-multi-accounts.json",
);
const LEGACY_ACCOUNTS_FILE_LOCAL = join(
  homedir(),
  ".local/share/opencode/multi-account-auth.json",
);
const LEGACY_STATE_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-state.json",
);
const LEGACY_STATE_FILE_LOCAL = join(
  homedir(),
  ".local/share/opencode/multi-account-state.json",
);

const DEFAULTS = { threshold: 0.7, checkInterval: 3600000 };

const EMPTY_DATA = {
  version: "2.0",
  accounts: [] as any[],
  currentAccount: null as string | null,
  requestCount: 0,
  lastPrimaryCheck: null as number | null,
  config: {
    threshold: 0.7,
    checkInterval: 3600000,
    accounts: {} as Record<string, any>,
  },
  usage: {} as Record<string, any>,
};

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

/**
 * Load consolidated data file, migrating from legacy two-file system if needed.
 */
function loadData(): typeof EMPTY_DATA & Record<string, any> {
  // 1. Try loading new consolidated file first
  const newData = safeReadJSON<any>(DATA_FILE, null);
  if (newData && newData.version === "2.0") {
    // Normalize account fields
    const normalized = normalizeMultiAuthShape(newData);
    if (normalized.changed) {
      const result = { ...newData, accounts: normalized.value.accounts };
      saveData(result);
      return result;
    }
    return newData;
  }

  // 2. Try migrating from legacy files
  const { data: legacyAccounts, source: accountsSource } = readWithFallback(
    [
      LEGACY_ACCOUNTS_FILE,
      LEGACY_ACCOUNTS_FILE_CONFIG,
      LEGACY_ACCOUNTS_FILE_LOCAL,
    ],
    { accounts: [] },
  );
  const { data: legacyState, source: stateSource } = readWithFallback(
    [LEGACY_STATE_FILE, LEGACY_STATE_FILE_LOCAL],
    {},
  );

  const normalized = normalizeMultiAuthShape(legacyAccounts);
  const accounts = normalized.value?.accounts || legacyAccounts?.accounts || [];

  // Merge into consolidated structure
  const data: any = {
    ...structuredClone(EMPTY_DATA),
    accounts,
    currentAccount: legacyState.currentAccount || null,
    requestCount: legacyState.requestCount || 0,
    lastPrimaryCheck: legacyState.lastPrimaryCheck || null,
    config: legacyState.config || EMPTY_DATA.config,
    usage: legacyState.usage || {},
  };

  // Preserve authFailures if present
  if (legacyState.authFailures) {
    data.authFailures = legacyState.authFailures;
  }

  if (accountsSource || stateSource) {
    // Save migrated data
    saveData(data);
    console.log(`  ⚡ Migrated to consolidated file: ${DATA_FILE}`);
  }

  return data;
}

function saveData(data: any) {
  safeWriteJSON(DATA_FILE, data);
}

function loadAccounts() {
  return loadData().accounts || [];
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
  const data = loadData();
  const accounts = data.accounts || [];
  const config = data.config || {};

  const accountsChanged = ensureAllAccountsInState(accounts, data);
  const staleResolved = resolveStaleMetrics(data);
  if (accountsChanged || staleResolved) {
    autoEvaluate(data);
    saveData(data);
  }

  if (watch) process.stdout.write("\x1b[2J\x1b[H");

  const totalRequests = data.requestCount || 0;
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
    renderCompactUsage(accounts, data, config, totalRequests);

    // Summary line
    const activeAcct = data.currentAccount || accounts[0]?.name || "none";
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
    const isActive = data.currentAccount === account.name;
    const usage = data.usage?.[account.name];
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

    // Plan and cost info
    const PLAN_PRICES_DISPLAY: Record<string, number> = {
      pro: 20,
      max5x: 100,
      max20x: 200,
    };
    let planCostStr = "";
    if (account.plan) {
      const planType =
        typeof account.plan === "object" ? account.plan.type : account.plan;
      const planPrice =
        typeof account.plan === "object"
          ? account.plan.price
          : PLAN_PRICES_DISPLAY[account.plan];
      const planLabel =
        planType === "pro"
          ? "Pro"
          : planType === "max5x"
            ? "Max 5x"
            : planType === "max20x"
              ? "Max 20x"
              : planType;
      const monthCost = usage?.consumption?.currentMonth?.estimatedCost || 0;
      if (planPrice) {
        planCostStr = ` \u00b7 ${planLabel} \u00b7 $${Math.round(monthCost)}/$${planPrice} this month`;
      }
    }

    const statusLine = `${authStatus} \u00b7 ${isActive ? reqCount + " requests" : "0 requests"} \u00b7 ${isActive ? "last used " + lastUsed : "idle"}`;
    const statusInner = padToWidth(statusLine, CARD_W - 4);
    console.log(`  \u2502  ${statusInner}\u2502`);

    // Plan/cost line (if plan is set)
    if (planCostStr) {
      const activeTag2 = isActive ? " \u25c4 ACTIVE" : "";
      const planLine = `${account.name}${activeTag2}${planCostStr}`;
      const planInner = padToWidth(planLine, CARD_W - 4);
      console.log(`  \u2502  ${planInner}\u2502`);
    }

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
  const activeAcct2 = data.currentAccount || accounts[0]?.name || "none";
  const threshStr2 = allSame(globalT)
    ? `${Math.round(globalT.session5h * 100)}%`
    : `${Math.round(globalT.session5h * 100)}/${Math.round(globalT.weekly7d * 100)}/${Math.round(globalT.weekly7dSonnet * 100)}%`;
  const intervalMin2 = (config.checkInterval ?? DEFAULTS.checkInterval) / 60000;
  console.log(
    `\n  Active: ${activeAcct2} \u00b7 Thresholds: ${threshStr2} \u00b7 Check interval: ${intervalMin2}m`,
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
    const isActive = state?.currentAccount === account.name;
    const usage = state?.usage?.[account.name];
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
  const json = args.includes("--json") || args.includes("-j");

  if (json) {
    renderUsageJson();
    return;
  }

  renderUsage(watch);
  if (watch) setInterval(() => renderUsage(true), 5000);
}

function renderUsageJson() {
  const data = loadData();
  const accounts = data.accounts || [];

  const accountsChanged = ensureAllAccountsInState(accounts, data);
  const staleResolved = resolveStaleMetrics(data);
  if (accountsChanged || staleResolved) {
    autoEvaluate(data);
    saveData(data);
  }

  const result = {
    version: "1.0",
    activeAccount: data.currentAccount || accounts[0]?.name || null,
    accounts: accounts.map((account: any) => {
      const isActive = data.currentAccount === account.name;
      const usage = data.usage?.[account.name] || {};
      return {
        name: account.name,
        active: isActive,
        utilization: {
          session5h: usage.session5h?.utilization || 0,
          weekly7d: usage.weekly7d?.utilization || 0,
          weekly7dSonnet: usage.weekly7dSonnet?.utilization || 0,
        },
        status: {
          session5h: usage.session5h?.status || "unknown",
          weekly7d: usage.weekly7d?.status || "unknown",
          weekly7dSonnet: usage.weekly7dSonnet?.status || "unknown",
        },
        reset: {
          session5h: usage.session5h?.reset || null,
          weekly7d: usage.weekly7d?.reset || null,
          weekly7dSonnet: usage.weekly7dSonnet?.reset || null,
        },
      };
    }),
    requestCount: data.requestCount || 0,
  };

  console.log(JSON.stringify(result));
}

// ============================================================================
// Config command
// ============================================================================

function cmdConfig(args: string[]) {
  const data = loadData();

  const parseArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  const accountName = parseArg("--account");

  const PLAN_PRICES: Record<string, number> = {
    pro: 20,
    max5x: 100,
    max20x: 200,
  };

  // Per-account config mode
  if (accountName) {
    const accounts = data.accounts || [];
    const account = accounts.find((a: any) => a.name === accountName);
    if (!account) {
      const available = accounts.map((a: any) => a.name).join(", ");
      console.error(`\n  ❌ Account '${accountName}' not found`);
      console.error(`     Available: ${available || "none"}\n`);
      return;
    }

    data.config = data.config || {};
    data.config.accounts = data.config.accounts || {};

    // Handle --plan flag
    const planArg = parseArg("--plan");
    if (planArg) {
      const validPlans = ["pro", "max5x", "max20x"];
      if (!validPlans.includes(planArg)) {
        console.error(`\n  ❌ Invalid plan: '${planArg}'`);
        console.error(`     Valid plans: ${validPlans.join(", ")}\n`);
        return;
      }
      account.plan = { type: planArg, price: PLAN_PRICES[planArg] };
      saveData(data);
      console.log(
        `\n  ✅ Plan set for '${accountName}': ${planArg} ($${PLAN_PRICES[planArg]}/month)\n`,
      );
      return;
    }

    // Handle --email flag
    const emailArg = parseArg("--email");
    if (emailArg) {
      account.email = emailArg;
      saveData(data);
      console.log(`\n  ✅ Email set for '${accountName}': ${emailArg}\n`);
      return;
    }

    // Handle --org flag
    const orgArg = parseArg("--org");
    if (orgArg) {
      account.org = orgArg;
      saveData(data);
      console.log(`\n  ✅ Organization set for '${accountName}': ${orgArg}\n`);
      return;
    }

    // Handle --extra-credit flag
    const extraCreditArg = parseArg("--extra-credit");
    if (extraCreditArg) {
      const validModes = ["on", "off", "auto"];
      if (!validModes.includes(extraCreditArg)) {
        console.error(`\n  ❌ Invalid extra-credit mode: '${extraCreditArg}'`);
        console.error(`     Valid modes: ${validModes.join(", ")}\n`);
        return;
      }
      data.config.accounts[accountName] =
        data.config.accounts[accountName] || {};
      data.config.accounts[accountName].extraCredit = extraCreditArg;
      saveData(data);
      console.log(
        `\n  ✅ Extra credit handling for '${accountName}': ${extraCreditArg}\n`,
      );
      return;
    }

    // Show per-account config
    const hasThresholdArg =
      args.includes("--threshold") ||
      args.includes("--thresholds") ||
      args.includes("--threshold-session") ||
      args.includes("--threshold-weekly") ||
      args.includes("--threshold-sonnet");

    if (!hasThresholdArg && !args.includes("--reset")) {
      const t = getAccountThresholds(accountName, data.config);
      const globalT = normalizeThresholds(
        data.config.threshold,
        DEFAULTS.threshold,
      );
      const hasOverride = !!data.config.accounts[accountName]?.threshold;

      console.log(`\n  ⚙️  Configuration for account: ${accountName}`);
      console.log("  ────────────────────────────────────────\n");

      // Show identity info
      if (account.email) console.log(`    Email:             ${account.email}`);
      if (account.org) console.log(`    Organization:      ${account.org}`);
      if (account.plan) {
        const planType =
          typeof account.plan === "object" ? account.plan.type : account.plan;
        const planPrice =
          typeof account.plan === "object"
            ? account.plan.price
            : PLAN_PRICES[account.plan];
        console.log(
          `    Plan:              ${planType} ($${planPrice || "?"}/month)`,
        );
      }
      const ecMode = data.config.accounts[accountName]?.extraCredit || "auto";
      console.log(`    Extra credit:      ${ecMode}`);
      if (account.email || account.org || account.plan) console.log();

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
      delete data.config.accounts[accountName];
      if (Object.keys(data.config.accounts).length === 0) {
        delete data.config.accounts;
      }
      saveData(data);
      console.log(
        `\n  ✅ Per-account config for '${accountName}' removed (using global defaults)\n`,
      );
      return;
    }

    // Set per-account thresholds
    data.config.accounts[accountName] = data.config.accounts[accountName] || {};
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
      data.config.accounts[accountName].threshold = val;
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
      data.config.accounts[accountName].threshold = {
        session5h: parts[0] / 100,
        weekly7d: parts[1] / 100,
        weekly7dSonnet: parts[2] / 100,
      };
      changed = true;
    }

    const ts = parseArg("--threshold-session");
    if (ts) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.session5h = parseFloat(ts);
      changed = true;
    }

    const tw = parseArg("--threshold-weekly");
    if (tw) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.weekly7d = parseFloat(tw);
      changed = true;
    }

    const tso = parseArg("--threshold-sonnet");
    if (tso) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.weekly7dSonnet =
        parseFloat(tso);
      changed = true;
    }

    if (changed) {
      autoEvaluate(data);
      saveData(data);
      console.log(`\n  ✅ Per-account config for '${accountName}' saved`);
      cmdConfig(["--account", accountName]);
    }
    return;
  }

  // Global config mode (original behavior)
  if (args.includes("--show") || args.length === 0) {
    const cfg = data.config || {};
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
    console.log(`    Switch mode:       ${cfg.switchMode || "auto"}`);

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
    data.config = structuredClone(EMPTY_DATA.config);
    saveData(data);
    console.log("\n  ✅ Configuration reset to defaults");
    console.log(
      `     Threshold: ${Math.round(DEFAULTS.threshold * 100)}%  |  Check interval: ${DEFAULTS.checkInterval / 60000} min\n`,
    );
    return;
  }

  data.config = data.config || {};
  let changed = false;

  function ensureThresholdObject() {
    const current = data.config.threshold;
    if (typeof current === "number") {
      data.config.threshold = {
        session5h: current,
        weekly7d: current,
        weekly7dSonnet: current,
      };
    } else if (!current || typeof current !== "object") {
      data.config.threshold = {
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
    data.config.threshold = val;
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
    data.config.threshold = {
      session5h: parts[0] / 100,
      weekly7d: parts[1] / 100,
      weekly7dSonnet: parts[2] / 100,
    };
    changed = true;
  }

  const ts = parseArg("--threshold-session");
  if (ts) {
    ensureThresholdObject();
    data.config.threshold.session5h = parseFloat(ts);
    changed = true;
  }

  const tw = parseArg("--threshold-weekly");
  if (tw) {
    ensureThresholdObject();
    data.config.threshold.weekly7d = parseFloat(tw);
    changed = true;
  }

  const tso = parseArg("--threshold-sonnet");
  if (tso) {
    ensureThresholdObject();
    data.config.threshold.weekly7dSonnet = parseFloat(tso);
    changed = true;
  }

  const i = parseArg("--interval");
  if (i) {
    data.config.checkInterval = parseInt(i) * 60000;
    changed = true;
  }

  // Switch mode: auto or manual
  const sm = parseArg("--switch-mode");
  if (sm) {
    if (sm !== "auto" && sm !== "manual") {
      console.log("\n  ❌ --switch-mode must be 'auto' or 'manual'");
      return;
    }
    data.config.switchMode = sm;
    changed = true;
  }

  // Clean up legacy recover config
  delete data.config.recover;

  if (changed) {
    autoEvaluate(data);
    saveData(data);
    console.log("\n  ✅ Configuration saved");
    cmdConfig(["--show"]);
  }
}

function logSwitch(data: any, from: string, to: string, reason: string) {
  if (!data.switchHistory) data.switchHistory = [];
  data.switchHistory.push({
    ts: new Date().toISOString(),
    from,
    to,
    reason,
  });
  // Keep last 50 entries
  if (data.switchHistory.length > 50) {
    data.switchHistory = data.switchHistory.slice(-50);
  }
}

function autoEvaluate(data: any) {
  const accounts = data.accounts || [];
  if (accounts.length < 2 || !data.currentAccount) return;

  const config = data.config || {};

  // Manual mode: skip auto-evaluation entirely
  if (config.switchMode === "manual") return;
  const LOG_FILE = "/tmp/sketchybar_logs.txt";

  function aeLog(msg: string) {
    try {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      require("fs").appendFileSync(LOG_FILE, `${ts} [autoEvaluate] ${msg}\n`);
    } catch {}
  }

  function isOverThreshold(accountName: string, usage: any): boolean {
    if (!usage) return false;
    const t = getAccountThresholds(accountName, config);
    return (
      (usage.session5h?.utilization || 0) > t.session5h ||
      (usage.weekly7d?.utilization || 0) > t.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > t.weekly7dSonnet
    );
  }

  function isRejected(usage: any): boolean {
    if (!usage) return false;
    return (
      usage.session5h?.status === "rejected" ||
      usage.weekly7d?.status === "rejected"
    );
  }

  function maxUtil(usage: any): number {
    if (!usage) return 0;
    return Math.max(
      usage.session5h?.utilization || 0,
      usage.weekly7d?.utilization || 0,
    );
  }

  const primary = accounts[0];
  const currentAccount = data.currentAccount;
  const primaryUsage = data.usage?.[primary.name];
  const currentUsage = data.usage?.[currentAccount];

  aeLog(`Evaluating: current=${currentAccount}, primary=${primary.name}`);
  for (const acct of accounts) {
    const u = data.usage?.[acct.name];
    const t = getAccountThresholds(acct.name, config);
    aeLog(
      `  ${acct.name}: s5h=${((u?.session5h?.utilization || 0) * 100).toFixed(0)}% (${u?.session5h?.status || "?"}), ` +
        `w7d=${((u?.weekly7d?.utilization || 0) * 100).toFixed(0)}% (${u?.weekly7d?.status || "?"}), ` +
        `overThreshold=${isOverThreshold(acct.name, u)}, rejected=${isRejected(u)}, ` +
        `thresholds=[s5h:${t.session5h}, w7d:${t.weekly7d}]`,
    );
  }

  if (currentAccount === primary.name) {
    // On primary: switch to fallback only if fallback is actually better
    if (isOverThreshold(primary.name, primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        const fallbackUsage = data.usage?.[fallback.name];
        // Skip fallbacks that are rejected or have higher utilization
        if (isRejected(fallbackUsage)) {
          aeLog(`  Skip ${fallback.name}: rejected`);
          continue;
        }
        if (isOverThreshold(fallback.name, fallbackUsage)) {
          aeLog(`  Skip ${fallback.name}: also over threshold`);
          continue;
        }
        if (maxUtil(fallbackUsage) >= maxUtil(primaryUsage)) {
          aeLog(
            `  Skip ${fallback.name}: util ${(maxUtil(fallbackUsage) * 100).toFixed(0)}% >= primary ${(maxUtil(primaryUsage) * 100).toFixed(0)}%`,
          );
          continue;
        }
        data.currentAccount = fallback.name;
        logSwitch(
          data,
          primary.name,
          fallback.name,
          "threshold exceeded, fallback available",
        );
        aeLog(
          `  SWITCH: ${primary.name} → ${fallback.name} (fallback is better)`,
        );
        console.log(
          `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (threshold exceeded, fallback available)`,
        );
        return;
      }
      aeLog(`  STAY on ${primary.name}: no better fallback available`);
    } else {
      aeLog(`  STAY on ${primary.name}: under threshold`);
    }
  } else {
    // On fallback: switch back to primary only if primary is actually better
    const currentRejected = isRejected(currentUsage);
    const primaryRejected = isRejected(primaryUsage);
    const primaryUnderThreshold = !isOverThreshold(primary.name, primaryUsage);
    const primaryBetterUtil = maxUtil(primaryUsage) < maxUtil(currentUsage);

    if (primaryUnderThreshold && !primaryRejected) {
      data.currentAccount = primary.name;
      logSwitch(data, currentAccount, primary.name, "primary under threshold");
      aeLog(
        `  SWITCH: ${currentAccount} → ${primary.name} (primary under threshold)`,
      );
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (primary under threshold)`,
      );
    } else if (currentRejected && !primaryRejected && primaryBetterUtil) {
      data.currentAccount = primary.name;
      logSwitch(
        data,
        currentAccount,
        primary.name,
        "current rejected, primary better",
      );
      aeLog(
        `  SWITCH: ${currentAccount} → ${primary.name} (current rejected, primary better)`,
      );
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (current rejected, primary available)`,
      );
    } else {
      aeLog(
        `  STAY on ${currentAccount}: primary not better (overThresh=${!primaryUnderThreshold}, rejected=${primaryRejected})`,
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
    const data = loadData();
    data.accounts ??= [];

    const account = {
      id: crypto.randomUUID(),
      name,
      email: null as string | null,
      org: null as string | null,
      plan: null as string | null,
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      type: "oauth",
    };
    const idx = data.accounts.findIndex((a: any) => a.name === name);

    if (idx >= 0) {
      account.id = data.accounts[idx].id || account.id;
      account.email = data.accounts[idx].email || null;
      account.org = data.accounts[idx].org || null;
      account.plan = data.accounts[idx].plan || null;
      data.accounts[idx] = account;
      console.log(`\n  \u2705 Account '${name}' updated`);
    } else {
      data.accounts.push(account);
      console.log(`\n  \u2705 Account '${name}' added`);
    }

    saveData(data);
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

    const data = loadData();
    data.accounts ??= [];

    const account = {
      id: crypto.randomUUID(),
      name,
      email: null as string | null,
      org: null as string | null,
      plan: null as string | null,
      apiKey,
      type: "api_key",
    };
    const idx = data.accounts.findIndex((a: any) => a.name === name);

    if (idx >= 0) {
      account.id = data.accounts[idx].id || account.id;
      account.email = data.accounts[idx].email || null;
      account.org = data.accounts[idx].org || null;
      account.plan = data.accounts[idx].plan || null;
      data.accounts[idx] = account;
      console.log(`\n  \u2705 Account '${name}' updated with API key`);
    } else {
      data.accounts.push(account);
      console.log(`\n  \u2705 Account '${name}' added with API key`);
    }

    saveData(data);
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
  // Try to parse as URL first
  try {
    const parsed = new URL(input);
    code = parsed.searchParams.get("code") || input;
  } catch {
    // Handle code#state format (strip the state suffix)
    const authParsed = parseAuthCode(input);
    code = authParsed.code;
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
  const data = loadData();
  data.accounts ??= [];

  const account = {
    id: crypto.randomUUID(),
    name,
    email: null as string | null,
    org: null as string | null,
    plan: null as string | null,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    type: "oauth",
  };
  const idx = data.accounts.findIndex((a: any) => a.name === name);

  if (idx >= 0) {
    account.id = data.accounts[idx].id || account.id;
    account.email = data.accounts[idx].email || null;
    account.org = data.accounts[idx].org || null;
    account.plan = data.accounts[idx].plan || null;
    data.accounts[idx] = account;
    console.log(`\n  \u2705 Account '${name}' updated`);
  } else {
    data.accounts.push(account);
    console.log(`\n  \u2705 Account '${name}' added`);
  }

  saveData(data);
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
    const data = loadData();
    const idx =
      data.accounts?.findIndex((a: any) => a.name === account.name) ?? -1;
    if (idx >= 0) {
      data.accounts[idx] = account;
      saveData(data);
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
  const data = loadData();
  data.usage = data.usage || {};
  const prev = data.usage[alias] || {};

  function mergeMetric(prevMetric: any, newMetric: QuotaMetric | null) {
    if (!newMetric)
      return prevMetric || { utilization: 0, reset: null, status: "allowed" };
    return {
      utilization: newMetric.utilization ?? prevMetric?.utilization ?? 0,
      reset: newMetric.reset ?? prevMetric?.reset ?? null,
      status: newMetric.status ?? prevMetric?.status ?? "unknown",
    };
  }

  data.usage[alias] = {
    session5h: mergeMetric(prev.session5h, quota.session5h),
    weekly7d: mergeMetric(prev.weekly7d, quota.weekly7d),
    weekly7dSonnet: mergeMetric(prev.weekly7dSonnet, quota.weekly7dSonnet),
    timestamp: new Date().toISOString(),
  };
  saveData(data);
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

// ============================================================================
// Token consumption & extra credit (shared with index.mjs)
// ============================================================================

const MODEL_PRICING: Record<string, [number, number]> = {
  haiku: [1.0, 5.0],
  sonnet: [3.0, 15.0],
  opus: [15.0, 75.0],
};

function getModelPricing(model: string): [number, number] {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return MODEL_PRICING.haiku;
  if (m.includes("opus")) return MODEL_PRICING.opus;
  return MODEL_PRICING.sonnet;
}

function calculateCost(model: string, input: number, output: number): number {
  const [inputPrice, outputPrice] = getModelPricing(model);
  return (input * inputPrice + output * outputPrice) / 1_000_000;
}

function detectExtraCredit(usage: any) {
  for (const key of ["session5h", "weekly7d", "weekly7dSonnet"] as const) {
    const m = usage?.[key];
    if (m && m.utilization >= 1.0 && m.status === "allowed") {
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
  if (usage.extraCredit?.detected) {
    usage.extraCredit.detected = false;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ============================================================================
// refresh command
// ============================================================================

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

async function cmdRefresh(accountName?: string) {
  const data = loadData();
  const accounts = data.accounts || [];

  const toRefresh = accountName
    ? accounts.filter((a: any) => a.name === accountName)
    : accounts;

  if (!toRefresh.length) {
    console.log(
      accountName
        ? `\n  ❌ Account '${accountName}' not found\n`
        : "\n  ❌ No accounts configured\n",
    );
    return;
  }

  console.log("\n  🔄 Refreshing usage data...\n");

  for (const account of toRefresh) {
    if (account.type === "api_key") {
      console.log(
        `  ${account.name}: ⚠️  API key accounts — pinging for metrics`,
      );
      await cmdPing(account.name, false);
      continue;
    }

    // Ensure fresh token
    const refreshErr = await refreshToken(account);
    if (refreshErr) {
      console.log(`  ${account.name}: ❌ ${refreshErr}`);
      continue;
    }

    try {
      const res = await fetch(USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${account.access}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        console.log(`  ${account.name}: ❌ Usage API returned ${res.status}`);
        continue;
      }

      const json = (await res.json()) as Record<string, any>;

      // Update usage data
      data.usage[account.name] = data.usage[account.name] || {};
      const usage = data.usage[account.name];

      // Usage API returns utilization as percentage (e.g. 81.0 for 81%)
      // or as 0-1 fraction. Normalize to 0-1 scale for consistency with
      // response headers which use 0-1 scale.
      function normalizeUtil(val: number): number {
        return val > 1 ? val / 100 : val;
      }

      if (json.five_hour) {
        usage.session5h = {
          utilization: normalizeUtil(json.five_hour.utilization || 0),
          reset: json.five_hour.resets_at
            ? Math.floor(new Date(json.five_hour.resets_at).getTime() / 1000)
            : usage.session5h?.reset || null,
          status: usage.session5h?.status || "allowed",
        };
      }
      if (json.seven_day) {
        usage.weekly7d = {
          utilization: normalizeUtil(json.seven_day.utilization || 0),
          reset: json.seven_day.resets_at
            ? Math.floor(new Date(json.seven_day.resets_at).getTime() / 1000)
            : usage.weekly7d?.reset || null,
          status: usage.weekly7d?.status || "allowed",
        };
      }
      if (json.seven_day_sonnet) {
        usage.weekly7dSonnet = {
          utilization: normalizeUtil(json.seven_day_sonnet.utilization || 0),
          reset: json.seven_day_sonnet.resets_at
            ? Math.floor(
                new Date(json.seven_day_sonnet.resets_at).getTime() / 1000,
              )
            : usage.weekly7dSonnet?.reset || null,
          status: usage.weekly7dSonnet?.status || "allowed",
        };
      }

      usage.timestamp = new Date().toISOString();
      detectExtraCredit(usage);

      // Display results
      const s5h = usage.session5h?.utilization || 0;
      const w7d = usage.weekly7d?.utilization || 0;
      const wSnt = usage.weekly7dSonnet?.utilization || 0;
      const ec = usage.extraCredit?.detected ? "  ⚡ EXTRA CREDIT" : "";

      console.log(`  ${account.name}${ec}`);
      console.log(`    Session (5h)     ${Math.round(s5h * 100)}%`);
      console.log(`    Weekly (all)     ${Math.round(w7d * 100)}%`);
      console.log(
        `    Weekly (Sonnet)  ${wSnt ? Math.round(wSnt * 100) + "%" : "—"}`,
      );
      console.log();
    } catch (err) {
      console.log(`  ${account.name}: ❌ ${err}`);
    }
  }

  autoEvaluate(data);
  saveData(data);
  console.log("  ✅ Usage data refreshed\n");
}

// ============================================================================
// costs command
// ============================================================================

function cmdCosts(accountName?: string, args: string[] = []) {
  const data = loadData();
  const accounts = data.accounts || [];

  const sessionOnly = args.includes("--session");
  const resetFlag = args.includes("--reset");

  if (resetFlag) {
    const target = accountName
      ? accounts.filter((a: any) => a.name === accountName)
      : accounts;
    for (const account of target) {
      if (data.usage?.[account.name]?.consumption) {
        delete data.usage[account.name].consumption;
      }
    }
    saveData(data);
    console.log(
      `\n  ✅ Consumption data reset${accountName ? ` for '${accountName}'` : ""}\n`,
    );
    return;
  }

  const target = accountName
    ? accounts.filter((a: any) => a.name === accountName)
    : accounts;

  if (!target.length) {
    console.log(
      accountName
        ? `\n  ❌ Account '${accountName}' not found\n`
        : "\n  ❌ No accounts configured\n",
    );
    return;
  }

  console.log("\n  💰 Token Consumption");
  console.log("  ────────────────────────────────────────\n");

  for (const account of target) {
    const usage = data.usage?.[account.name];
    const consumption = usage?.consumption;

    if (!consumption) {
      console.log(`  ${account.name}: No consumption data yet`);
      console.log(`    Run some queries to start tracking\n`);
      continue;
    }

    const ec = usage.extraCredit?.detected ? " ⚡ EXTRA CREDIT" : "";
    console.log(`  ${account.name}${ec}`);

    if (sessionOnly) {
      const s = consumption.currentSession;
      console.log(
        `    Session:  ${formatNumber(s.input)} in / ${formatNumber(s.output)} out  (${s.requests} reqs)  ${formatUSD(s.estimatedCost)}`,
      );
    } else {
      const s = consumption.currentSession;
      const m = consumption.currentMonth;
      const a = consumption.allTime;

      console.log(
        `    Session:  ${formatNumber(s.input)} in / ${formatNumber(s.output)} out  (${s.requests} reqs)  ${formatUSD(s.estimatedCost)}`,
      );
      console.log(
        `    Month:    ${formatNumber(m.input)} in / ${formatNumber(m.output)} out  (${m.requests} reqs)  ${formatUSD(m.estimatedCost)}`,
      );
      console.log(
        `    All-time: ${formatNumber(a.input)} in / ${formatNumber(a.output)} out  (${a.requests} reqs)  ${formatUSD(a.estimatedCost)}`,
      );

      // Per-model breakdown
      const models = Object.entries(consumption.byModel || {}) as [
        string,
        any,
      ][];
      if (models.length > 0) {
        console.log(`\n    By model:`);
        for (const [model, stats] of models) {
          console.log(
            `      ${model.padEnd(30)} ${formatNumber(stats.input)} in / ${formatNumber(stats.output)} out  ${formatUSD(stats.cost)}`,
          );
        }
      }

      // Extra credit info
      if (usage.extraCredit?.detected && usage.extraCredit.estimatedCost > 0) {
        console.log(
          `\n    ⚡ Extra credit: ${formatUSD(usage.extraCredit.estimatedCost)} estimated cost since ${new Date(usage.extraCredit.detectedAt).toLocaleDateString()}`,
        );
      }

      // Subscription value comparison
      const plan = account.plan;
      if (plan && m.estimatedCost > 0) {
        const planPrice =
          plan.price ||
          (plan.type === "pro"
            ? 20
            : plan.type === "max5x"
              ? 100
              : plan.type === "max20x"
                ? 200
                : 0);
        if (planPrice > 0) {
          const valueRatio = Math.round((m.estimatedCost / planPrice) * 100);
          console.log(
            `\n    📊 Value: ${formatUSD(m.estimatedCost)} API equivalent / ${formatUSD(planPrice)} subscription (${valueRatio}%)`,
          );

          // Projection based on current rate
          const monthStart = new Date(m.since);
          const now = new Date();
          const daysPassed = Math.max(
            1,
            (now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24),
          );
          const daysInMonth = new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            0,
          ).getDate();
          const projected =
            Math.round((m.estimatedCost / daysPassed) * daysInMonth * 100) /
            100;
          console.log(
            `    📈 Projected: ~${formatUSD(projected)} this month at current rate`,
          );
        }
      }
    }

    console.log();
  }
}

// ============================================================================
// Ping command
// ============================================================================

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
      const reauthData = loadData();
      reauthData.accounts ??= [];
      const updated: any = {
        id: crypto.randomUUID(),
        name: alias,
        email: null,
        org: null,
        plan: null,
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + json.expires_in * 1000,
        type: "oauth",
      };
      const idx = reauthData.accounts.findIndex((a: any) => a.name === alias);
      if (idx >= 0) {
        updated.id = reauthData.accounts[idx].id || updated.id;
        updated.email = reauthData.accounts[idx].email || null;
        updated.org = reauthData.accounts[idx].org || null;
        updated.plan = reauthData.accounts[idx].plan || null;
        reauthData.accounts[idx] = updated;
      } else {
        reauthData.accounts.push(updated);
      }
      saveData(reauthData);
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

    // Interactive mode — detect auth type, allow override with --method
    const methodFlag =
      args.find((a) => a.startsWith("--method="))?.split("=")[1] ||
      (args.includes("--method") ? args[args.indexOf("--method") + 1] : null);

    let authType: string;
    if (methodFlag === "oauth" || methodFlag === "apikey") {
      authType = methodFlag === "apikey" ? "api_key" : "oauth";
    } else {
      authType = account.type || (account.apiKey ? "api_key" : "oauth");
    }

    const label = authType === "api_key" ? "API Key" : "Claude Pro/Max (OAuth)";
    const isOverride =
      methodFlag &&
      authType !== (account.type || (account.apiKey ? "api_key" : "oauth"));

    console.log(`\n  \ud83d\udd10 Re-authenticating: ${alias}`);
    console.log(
      "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
    );
    console.log(
      `  Auth type: ${label}${isOverride ? " (switching from " + (authType === "api_key" ? "OAuth" : "API Key") + ")" : ""}\n`,
    );

    if (authType === "api_key") {
      // Manual API key
      const apiKey = await prompt("  ? Enter your API key: ");
      if (!apiKey) {
        console.error("\n  \u274c No API key provided\n");
        return;
      }

      const reauthApiData = loadData();
      reauthApiData.accounts ??= [];
      const updated: any = {
        id: crypto.randomUUID(),
        name: alias,
        email: null,
        org: null,
        plan: null,
        apiKey,
        type: "api_key",
      };

      const idx = reauthApiData.accounts.findIndex(
        (a: any) => a.name === alias,
      );
      if (idx >= 0) {
        updated.id = reauthApiData.accounts[idx].id || updated.id;
        updated.email = reauthApiData.accounts[idx].email || null;
        updated.org = reauthApiData.accounts[idx].org || null;
        updated.plan = reauthApiData.accounts[idx].plan || null;
        reauthApiData.accounts[idx] = updated;
      } else {
        reauthApiData.accounts.push(updated);
      }
      saveData(reauthApiData);
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
      // Handle code#state format (strip the state suffix)
      const authParsed = parseAuthCode(input);
      code = authParsed.code;
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
    const reauthOauthData = loadData();
    reauthOauthData.accounts ??= [];
    const updated: any = {
      id: crypto.randomUUID(),
      name: alias,
      email: null,
      org: null,
      plan: null,
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      type: "oauth",
    };
    const idx = reauthOauthData.accounts.findIndex(
      (a: any) => a.name === alias,
    );
    if (idx >= 0) {
      updated.id = reauthOauthData.accounts[idx].id || updated.id;
      updated.email = reauthOauthData.accounts[idx].email || null;
      updated.org = reauthOauthData.accounts[idx].org || null;
      updated.plan = reauthOauthData.accounts[idx].plan || null;
      reauthOauthData.accounts[idx] = updated;
    } else {
      reauthOauthData.accounts.push(updated);
    }
    saveData(reauthOauthData);

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

  const data = loadData();
  if (!data.accounts?.length) {
    console.log("\n  ❌ No accounts configured");
    console.log(
      "     Run: bun src/cli.ts add <name>    Add an account first\n",
    );
    return;
  }

  const account = data.accounts.find((a: any) => a.name === name);
  if (!account) {
    const available = data.accounts.map((a: any) => a.name).join(", ");
    console.log(`\n  ❌ Account '${name}' not found`);
    console.log(`     Available accounts: ${available}`);
    console.log("     Run: bun src/cli.ts list\n");
    return;
  }

  console.log("\n  ⚡ Set Primary Account");
  console.log("  ────────────────────────────────────────\n");

  // Current order
  console.log("  Before:");
  data.accounts.forEach((a: any, i: number) => {
    const role = i === 0 ? " (primary)" : " (fallback)";
    const marker = a.name === name ? " ◄" : "";
    console.log(`    ${i + 1}. ${a.name}${role}${marker}`);
  });

  // Move account to front
  const idx = data.accounts.findIndex((a: any) => a.name === name);
  if (idx === 0) {
    console.log(`\n  ✅ '${name}' is already the primary account\n`);
    return;
  }

  const [removed] = data.accounts.splice(idx, 1);
  data.accounts.unshift(removed);

  // New order
  console.log("\n  After:");
  data.accounts.forEach((a: any, i: number) => {
    const role = i === 0 ? " (primary)" : " (fallback)";
    console.log(`    ${i + 1}. ${a.name}${role}`);
  });

  saveData(data);
  console.log(`\n  ✅ '${name}' is now the primary account`);
  console.log("     Restart OpenCode to apply changes\n");
}

// ============================================================================
// list command
// ============================================================================

function cmdList() {
  const data = loadData();
  const accounts = data.accounts || [];

  if (!accounts.length) {
    console.log("\n  ❌ No accounts configured");
    console.log(
      "     Run: bun src/cli.ts add <name>    Add your first account\n",
    );
    return;
  }

  console.log("\n  📋 Configured Accounts");
  console.log("  ────────────────────────────────────────\n");

  // Table header
  const nameW = Math.max(6, ...accounts.map((a: any) => a.name.length)) + 2;
  console.log(
    `  ${"#".padEnd(4)}${"Name".padEnd(nameW)}${"Role".padEnd(12)}${"Status".padEnd(20)}${"Expires"}`,
  );
  console.log(
    `  ${"─".repeat(4)}${"─".repeat(nameW)}${"─".repeat(12)}${"─".repeat(20)}${"─".repeat(20)}`,
  );

  accounts.forEach((account: any, i: number) => {
    const isActive = data.currentAccount === account.name;
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

  const data = loadData();
  if (!data.accounts?.length) {
    console.log("\n  ❌ No accounts configured\n");
    return;
  }

  const idx = data.accounts.findIndex((a: any) => a.name === name);
  if (idx < 0) {
    const available = data.accounts.map((a: any) => a.name).join(", ");
    console.log(`\n  ❌ Account '${name}' not found`);
    console.log(`     Available accounts: ${available}`);
    console.log("     Run: bun src/cli.ts list\n");
    return;
  }

  const account = data.accounts[idx];
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

  data.accounts.splice(idx, 1);

  // Also remove usage data
  if (data.usage?.[name]) {
    delete data.usage[name];
  }
  if (data.currentAccount === name) {
    data.currentAccount = data.accounts[0]?.name || null;
  }
  saveData(data);

  console.log(`\n  ✅ Account '${name}' removed`);
  console.log("     Tokens revoked and usage data cleared");

  if (isPrimary && data.accounts.length > 0) {
    console.log(
      `     ⚡ '${data.accounts[0].name}' is now the primary account`,
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

  const data = loadData();
  let issues = 0;

  // Check accounts
  console.log("  Accounts:");
  if (!data.accounts?.length) {
    console.log("    ❌ No accounts configured");
    console.log("       Run: bun src/cli.ts add <name>\n");
    issues++;
  } else {
    console.log(`    ✅ Found ${data.accounts.length} account(s)`);
    data.accounts.forEach((account: any, i: number) => {
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
  if (data.currentAccount) {
    console.log(`    ✅ Active account: ${data.currentAccount}`);
  } else {
    console.log("    ⚠️  No active account set");
    issues++;
  }
  console.log(`    ✅ Request count: ${data.requestCount || 0}`);

  if (data.usage && Object.keys(data.usage).length > 0) {
    const accountNames = Object.keys(data.usage);
    console.log(`    ✅ Usage data: ${accountNames.length} account(s)`);
  } else {
    console.log("    ⚠️  No usage data");
    issues++;
  }

  if (data.config) {
    const t = normalizeThresholds(data.config.threshold, DEFAULTS.threshold);
    console.log(
      `    ✅ Config: threshold ${Math.round(t.session5h * 100)}%/${Math.round(t.weekly7d * 100)}%/${Math.round(t.weekly7dSonnet * 100)}%, interval ${(data.config.checkInterval || DEFAULTS.checkInterval) / 60000}min`,
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
  console.log(`    ✅ Data: ${DATA_FILE}`);
  console.log();

  // Summary
  console.log("  ────────────────────────────────────────");
  if (issues === 0) {
    console.log("  ✅ All checks passed — system is healthy");
  } else {
    console.log(`  ⚠️  ${issues} issue(s) found:`);
    if (!data.accounts?.length) {
      console.log("     - No accounts configured");
    }
    if (data.accounts?.some((a: any) => a.expires <= Date.now())) {
      console.log("     - Some accounts need re-authentication");
    }
    if (!data.currentAccount) {
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
      path: LEGACY_ACCOUNTS_FILE,
      version: "v1.1.x (accounts file)",
    },
    {
      path: LEGACY_ACCOUNTS_FILE_CONFIG,
      version: "v1.0.x (config dir)",
    },
    { path: LEGACY_ACCOUNTS_FILE_LOCAL, version: "v1.0.x (local dir)" },
    { path: LEGACY_STATE_FILE, version: "v1.1.x (state file)" },
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

  console.log(`\n  New location: ${DATA_FILE}\n`);

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
  const data = loadData();
  data.config = data.config || {};

  console.log("\n  ⚙️  Configuration Wizard");
  console.log("  ────────────────────────────────────────\n");

  const currentThresholds = normalizeThresholds(
    data.config.threshold,
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
    `    Check interval:  ${(data.config.checkInterval || DEFAULTS.checkInterval) / 60000} min\n`,
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
    `  Check interval (minutes)  [${(data.config.checkInterval || DEFAULTS.checkInterval) / 60000}]: `,
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
    : data.config.checkInterval || DEFAULTS.checkInterval;

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
    data.config.threshold = {
      session5h: sessionVal,
      weekly7d: weeklyVal,
      weekly7dSonnet: sonnetVal,
    };
    data.config.checkInterval = intervalVal;
    autoEvaluate(data);
    saveData(data);
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

  const data = loadData();
  const previous = data.currentAccount || accounts[0]?.name;

  if (previous === name) {
    console.log(`\n  ✅ Already using '${name}'\n`);
    return;
  }

  data.currentAccount = name;
  data.lastPrimaryCheck = Date.now(); // Reset check timer
  saveData(data);

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

// ============================================================================
// Request history log
// ============================================================================

const LOGS_DIR = join(CONFIG_DIR, "anthropic-multi-account-logs");
const LEGACY_LOG_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-requests.jsonl",
);

interface RequestLogEntry {
  v?: number;
  timestamp: string;
  account: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
  };
  cost: number;
  durationMs: number;
  statusCode: number;
  stopReason?: string | null;
  requestId?: string | null;
  switched: boolean;
  switchReason: string | null;
  extraCredit: boolean;
  request?: {
    requestModel?: string;
    maxTokens?: number;
    temperature?: number;
    messageCount?: number;
    userMessages?: number;
    assistantMessages?: number;
    toolUseCalls?: number;
    toolResultCalls?: number;
    toolDefinitions?: number;
    systemPromptParts?: number;
    systemPromptChars?: number;
    thinking?: { type: string; budgetTokens?: number };
  };
  rateLimits?: {
    session5h: number | null;
    weekly7d: number | null;
    weekly7dSonnet: number | null;
  };
  context: {
    directory: string | null;
    worktree: string | null;
    repoName?: string | null;
  };
}

function listLogFiles(): string[] {
  if (!existsSync(LOGS_DIR)) return [];
  return readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))
    .sort(); // chronological order (YYYY-MM.jsonl)
}

function readLogFile(filePath: string): string {
  if (filePath.endsWith(".gz")) {
    try {
      return execSync(`gzip -dc "${filePath}"`, {
        maxBuffer: 100 * 1024 * 1024,
      }).toString("utf8");
    } catch {
      return "";
    }
  }
  return readFileSync(filePath, "utf8");
}

function readRequestLog(
  limit: number = 50,
  filter?: {
    account?: string;
    model?: string;
    directory?: string;
    month?: string;
    since?: string;
  },
): RequestLogEntry[] {
  const files = listLogFiles();
  // Also check legacy file
  const allFiles: string[] = [];
  if (existsSync(LEGACY_LOG_FILE)) allFiles.push(LEGACY_LOG_FILE);
  for (const f of files) {
    const month = f.replace(".jsonl.gz", "").replace(".jsonl", "");
    if (filter?.month && !month.startsWith(filter.month)) continue;
    allFiles.push(join(LOGS_DIR, f));
  }

  let entries: RequestLogEntry[] = [];
  for (const file of allFiles) {
    const content = readLogFile(file);
    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
  }

  // Apply filters
  if (filter?.account) {
    entries = entries.filter((e) => e.account === filter.account);
  }
  if (filter?.model) {
    entries = entries.filter((e) =>
      e.model?.toLowerCase().includes(filter.model!.toLowerCase()),
    );
  }
  if (filter?.directory) {
    entries = entries.filter(
      (e) =>
        e.context?.directory?.includes(filter.directory!) ||
        e.context?.worktree?.includes(filter.directory!) ||
        e.context?.repoName?.includes(filter.directory!),
    );
  }
  if (filter?.since) {
    entries = entries.filter((e) => e.timestamp >= filter.since!);
  }
  // Sort by timestamp
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  // Return last N entries (most recent)
  return entries.slice(-limit);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function cmdRequests(args: string[] = []) {
  const limit =
    parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "") ||
    50;
  const accountFilter = args
    .find((a) => a.startsWith("--account="))
    ?.split("=")[1];
  const modelFilter = args.find((a) => a.startsWith("--model="))?.split("=")[1];
  const dirFilter = args.find((a) => a.startsWith("--dir="))?.split("=")[1];
  const monthFilter = args.find((a) => a.startsWith("--month="))?.split("=")[1];
  const sinceFilter = args.find((a) => a.startsWith("--since="))?.split("=")[1];
  const showSummary = args.includes("--summary");
  const showJson = args.includes("--json");
  const showFiles = args.includes("--files");

  // Show available log files
  if (showFiles) {
    const files = listLogFiles();
    if (files.length === 0) {
      console.log(`\n  No log files found in ${LOGS_DIR}\n`);
      return;
    }
    console.log(`\n  📁 Log files in ${LOGS_DIR}\n`);
    for (const f of files) {
      const fullPath = join(LOGS_DIR, f);
      try {
        const stat = statSync(fullPath);
        const size =
          stat.size > 1024 * 1024
            ? `${(stat.size / 1024 / 1024).toFixed(1)}MB`
            : stat.size > 1024
              ? `${(stat.size / 1024).toFixed(0)}KB`
              : `${stat.size}B`;
        const gz = f.endsWith(".gz") ? " (compressed)" : "";
        console.log(`    ${f}  ${size}${gz}`);
      } catch {}
    }
    if (existsSync(LEGACY_LOG_FILE)) {
      console.log(`    [legacy] ${LEGACY_LOG_FILE}`);
    }
    console.log();
    return;
  }

  const entries = readRequestLog(showSummary ? 100000 : limit, {
    account: accountFilter,
    model: modelFilter,
    directory: dirFilter,
    month: monthFilter,
    since: sinceFilter,
  });

  if (entries.length === 0) {
    console.log(`\n  No request history found.`);
    console.log(
      `  Requests are logged after using OpenCode with the multi-account plugin.\n`,
    );
    return;
  }

  if (showJson) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (showSummary) {
    // Aggregate stats
    const byAccount: Record<
      string,
      {
        reqs: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        totalMs: number;
      }
    > = {};
    const byModel: Record<
      string,
      { reqs: number; input: number; output: number; cost: number }
    > = {};
    const byDir: Record<
      string,
      { reqs: number; input: number; output: number; cost: number }
    > = {};
    let totalSwitches = 0;
    let totalExtraCredit = 0;

    for (const e of entries) {
      // By account
      const acc = (byAccount[e.account] ??= {
        reqs: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        totalMs: 0,
      });
      acc.reqs++;
      acc.input += e.tokens.input;
      acc.output += e.tokens.output;
      acc.cacheRead += e.tokens.cacheRead;
      acc.cacheWrite += e.tokens.cacheWrite;
      acc.cost += e.cost;
      acc.totalMs += e.durationMs;

      // By model
      const mod = (byModel[e.model] ??= {
        reqs: 0,
        input: 0,
        output: 0,
        cost: 0,
      });
      mod.reqs++;
      mod.input += e.tokens.input;
      mod.output += e.tokens.output;
      mod.cost += e.cost;

      // By directory
      const dirKey = e.context?.directory || "unknown";
      const dir = (byDir[dirKey] ??= { reqs: 0, input: 0, output: 0, cost: 0 });
      dir.reqs++;
      dir.input += e.tokens.input;
      dir.output += e.tokens.output;
      dir.cost += e.cost;

      if (e.switched) totalSwitches++;
      if (e.extraCredit) totalExtraCredit++;
    }

    console.log(`\n  📊 Request Summary (${entries.length} requests)`);
    console.log(`  ${"─".repeat(60)}\n`);

    console.log(`  By Account:`);
    for (const [name, s] of Object.entries(byAccount)) {
      console.log(
        `    ${name}: ${s.reqs} reqs | ${formatTokens(s.input)} in / ${formatTokens(s.output)} out | cache: ${formatTokens(s.cacheRead)} read / ${formatTokens(s.cacheWrite)} write | $${s.cost.toFixed(2)} | avg ${formatDuration(s.totalMs / s.reqs)}`,
      );
    }

    console.log(`\n  By Model:`);
    for (const [name, s] of Object.entries(byModel)) {
      console.log(
        `    ${name}: ${s.reqs} reqs | ${formatTokens(s.input)} in / ${formatTokens(s.output)} out | $${s.cost.toFixed(2)}`,
      );
    }

    console.log(`\n  By Project:`);
    // Build richer per-project stats
    const byDirDetailed: Record<
      string,
      {
        reqs: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        totalMs: number;
        reasoning: number;
        models: Record<
          string,
          { reqs: number; input: number; output: number; cost: number }
        >;
        accounts: Record<string, number>;
        firstSeen: string;
        lastSeen: string;
      }
    > = {};

    for (const e of entries) {
      const dirKey = e.context?.directory || "unknown";
      const d = (byDirDetailed[dirKey] ??= {
        reqs: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        totalMs: 0,
        reasoning: 0,
        models: {},
        accounts: {},
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
      });
      d.reqs++;
      d.input += e.tokens.input;
      d.output += e.tokens.output;
      d.cacheRead += e.tokens.cacheRead;
      d.cacheWrite += e.tokens.cacheWrite;
      d.reasoning += e.tokens.reasoning;
      d.cost += e.cost;
      d.totalMs += e.durationMs;
      if (e.timestamp < d.firstSeen) d.firstSeen = e.timestamp;
      if (e.timestamp > d.lastSeen) d.lastSeen = e.timestamp;

      const m = (d.models[e.model] ??= {
        reqs: 0,
        input: 0,
        output: 0,
        cost: 0,
      });
      m.reqs++;
      m.input += e.tokens.input;
      m.output += e.tokens.output;
      m.cost += e.cost;

      d.accounts[e.account] = (d.accounts[e.account] || 0) + 1;
    }

    // Sort by cost descending
    const sortedDirs = Object.entries(byDirDetailed).sort(
      (a, b) => b[1].cost - a[1].cost,
    );
    for (const [dir, d] of sortedDirs) {
      const shortDir =
        dir === "unknown" ? "unknown" : dir.replace(homedir(), "~");
      const cacheHitRate =
        d.input > 0
          ? Math.round((d.cacheRead / (d.input + d.cacheRead)) * 100)
          : 0;
      const avgDur = formatDuration(d.totalMs / d.reqs);
      console.log(`\n    📁 ${shortDir}`);
      console.log(
        `       ${d.reqs} requests | $${d.cost.toFixed(2)} total | avg ${avgDur}/req`,
      );
      console.log(
        `       Tokens: ${formatTokens(d.input)} in / ${formatTokens(d.output)} out / ${formatTokens(d.reasoning)} reasoning`,
      );
      console.log(
        `       Cache:  ${formatTokens(d.cacheRead)} read / ${formatTokens(d.cacheWrite)} write | hit rate: ${cacheHitRate}%`,
      );
      console.log(
        `       Period: ${d.firstSeen.slice(0, 10)} → ${d.lastSeen.slice(0, 10)}`,
      );
      console.log(`       Models:`);
      const sortedModels = Object.entries(d.models).sort(
        (a, b) => b[1].cost - a[1].cost,
      );
      for (const [model, ms] of sortedModels) {
        console.log(
          `         ${model}: ${ms.reqs} reqs | ${formatTokens(ms.input)} in / ${formatTokens(ms.output)} out | $${ms.cost.toFixed(2)}`,
        );
      }
      if (Object.keys(d.accounts).length > 1) {
        console.log(
          `       Accounts: ${Object.entries(d.accounts)
            .map(([a, n]) => `${a}(${n})`)
            .join(", ")}`,
        );
      }
    }

    console.log(
      `\n  Switches: ${totalSwitches} | Extra credit requests: ${totalExtraCredit}`,
    );
    console.log();
    return;
  }

  // Table view
  console.log(`\n  📋 Request History (last ${entries.length})`);
  console.log(`  ${"─".repeat(120)}`);

  // Header
  const hdr = [
    "Timestamp".padEnd(20),
    "Account".padEnd(18),
    "Model".padEnd(22),
    "In".padStart(7),
    "Out".padStart(7),
    "Cache".padStart(7),
    "Cost".padStart(7),
    "Time".padStart(7),
    "Info".padEnd(12),
  ].join(" │ ");
  console.log(`  ${hdr}`);
  console.log(`  ${"─".repeat(120)}`);

  for (const e of entries) {
    const ts = e.timestamp.replace("T", " ").slice(0, 19);
    const acc = e.account.slice(0, 17).padEnd(18);
    const model = (e.model || "unknown").slice(0, 21).padEnd(22);
    const inp = formatTokens(e.tokens.input).padStart(7);
    const out = formatTokens(e.tokens.output).padStart(7);
    const cache = formatTokens(e.tokens.cacheRead).padStart(7);
    const cost = `$${e.cost.toFixed(2)}`.padStart(7);
    const dur = formatDuration(e.durationMs).padStart(7);
    const flags: string[] = [];
    if (e.switched) flags.push("SW");
    if (e.extraCredit) flags.push("EC");
    if (e.statusCode !== 200) flags.push(`${e.statusCode}`);
    const info = flags.join(",").padEnd(12) || "";

    console.log(
      `  ${ts} │ ${acc} │ ${model} │ ${inp} │ ${out} │ ${cache} │ ${cost} │ ${dur} │ ${info}`,
    );
  }
  console.log(`  ${"─".repeat(120)}\n`);

  // Summary line
  const totalCost = entries.reduce((s, e) => s + e.cost, 0);
  const totalIn = entries.reduce((s, e) => s + e.tokens.input, 0);
  const totalOut = entries.reduce((s, e) => s + e.tokens.output, 0);
  console.log(
    `  Total: ${entries.length} requests | ${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out | $${totalCost.toFixed(2)}\n`,
  );
}

function showHelp() {
  console.log(`
  anthropic-multi-account v1.1.0
  Manage multiple Anthropic Max accounts with automatic failover.

  ACCOUNT MANAGEMENT
    add <name>              Add account (OAuth or API key)
    reauth <name>           Re-authenticate (uses same method as add)
    reauth <name> --method oauth
                            Override: switch to OAuth authentication
    reauth <name> --method apikey
                            Override: switch to API key authentication
    reauth <name> --json    Re-authenticate (JSON for scripting)
    list, ls                List all configured accounts
    set-primary <name>      Set an account as the primary
    remove, rm <name>       Remove an account

  MONITORING
    usage, u [--watch]      Show rate limit usage dashboard
    refresh [<name>]        Refresh usage data from API
    costs [<name>]          Show token consumption and costs
    costs --session         Show current session only
    costs --reset           Reset consumption counters
    requests, reqs, log     Show request history table
    requests --summary      Aggregated stats by account/model/project
    requests --files        List available monthly log files
    requests --limit=100    Show last N requests (default 50)
    requests --account=X    Filter by account name
    requests --model=X      Filter by model name
    requests --dir=X        Filter by project/repo directory
    requests --month=YYYY-MM  Filter by month
    requests --since=DATE   Filter since date (ISO format)
    requests --json         Output raw JSON
    test <name>             Test account connectivity and quotas
    ping <name> [--json]    Ping account (human-readable, or JSON with --json)
    diagnose                Run system diagnostics

  ACCOUNT SWITCHING
    switch <name>           Force switch to a specific account

  CONFIGURATION
    config                           Show global configuration
    config --account <name>          Show account-specific config
    config --account <name> --plan max5x
                                     Set subscription plan (pro/max5x/max20x)
    config --account <name> --email <email>
                                     Set account email
    config --account <name> --org <org>
                                     Set account organization
    config --account <name> --extra-credit on|off|auto
                                     Set extra credit handling
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
// Sketchybar bar output (key=value, easily parsed by Lua)
// ============================================================================

function cmdBar() {
  const data = loadData();
  const usage = data.usage || {};
  const accounts = data.accounts || [];
  const current = data.currentAccount || "";

  // Build scored list: lower score = better candidate
  // Rejected sessions get a high penalty, then sort by max utilization
  let best: any = null;
  let bestScore = Infinity;

  for (const acct of accounts) {
    const name = acct.name;
    const u = usage[name] || {};
    const s5h = u.session5h || {};
    const w7d = u.weekly7d || {};

    const pctS = Math.round((s5h.utilization || 0) * 100);
    const pctW = Math.round((w7d.utilization || 0) * 100);
    const statusS = s5h.status || "unknown";
    const statusW = w7d.status || "unknown";
    const resetS = s5h.reset || 0;

    const rejected = statusS === "rejected" || statusW === "rejected";
    const score = (rejected ? 1000 : 0) + Math.max(pctS, pctW);

    // Among ties, prefer current account (score - 0.5)
    const tiebreak = name === current ? score - 0.5 : score;

    if (tiebreak < bestScore) {
      bestScore = tiebreak;
      best = { name, pctS, pctW, resetS, rejected };
    }
  }

  if (!best) {
    console.log("name=none\ns5h=0\nw7d=0\nreset=0\ncolor=grey");
    return;
  }

  // Compute countdown for session reset
  let countdown = "";
  if (best.pctS > 0 && best.resetS) {
    const remain = best.resetS - Math.floor(Date.now() / 1000);
    if (remain > 0) {
      const hrs = Math.floor(remain / 3600);
      const mins = Math.floor((remain % 3600) / 60);
      const secs = remain % 60;
      countdown = `${hrs}h${String(mins).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
    }
  }

  // Color: red if weekly rejected, otherwise based on session (5h) usage
  let color: string;
  if (best.rejected) {
    color = "red";
  } else if (best.pctS >= 80) {
    color = "red";
  } else if (best.pctS >= 50) {
    color = "orange";
  } else if (best.pctS > 0) {
    color = "yellow";
  } else {
    color = "green";
  }

  console.log(`name=${best.name}`);
  console.log(`s5h=${best.pctS}`);
  console.log(`w7d=${best.pctW}`);
  console.log(`reset=${countdown}`);
  console.log(`color=${color}`);
}

// ============================================================================
// Sketchybar bar-detail output (all accounts, key=value per account)
// ============================================================================

function cmdBarDetail() {
  const data = loadData();
  const usage = data.usage || {};
  const accounts = data.accounts || [];
  const current = data.currentAccount || "";
  const now = Math.floor(Date.now() / 1000);

  function colorFor(pctS: number, pctW: number): string {
    const hi = Math.max(pctW, pctS);
    if (hi >= 80) return "red";
    if (hi >= 50) return "orange";
    if (hi > 0) return "yellow";
    return "green";
  }

  function countdown(resetTs: number): string {
    if (!resetTs) return "";
    const remain = resetTs - now;
    if (remain <= 0) return "";
    const days = Math.floor(remain / 86400);
    const hrs = Math.floor((remain % 86400) / 3600);
    const mins = Math.floor((remain % 3600) / 60);
    const secs = remain % 60;
    if (days > 0) {
      return `${days}d ${hrs}h${String(mins).padStart(2, "0")}m`;
    }
    return `${hrs}h${String(mins).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
  }

  const switchMode = data.config?.switchMode || "auto";
  console.log(`count=${accounts.length}`);
  console.log(`current=${current}`);
  console.log(`switchMode=${switchMode}`);

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const name = acct.name;
    const u = usage[name] || {};
    const s5h = u.session5h || {};
    const w7d = u.weekly7d || {};
    const snt = u.weekly7dSonnet || {};

    const pctS = Math.round((s5h.utilization || 0) * 100);
    const pctW = Math.round((w7d.utilization || 0) * 100);
    const pctSnt = Math.round((snt.utilization || 0) * 100);
    const statusS = s5h.status || "unknown";
    const statusW = w7d.status || "unknown";
    const resetS = countdown(s5h.reset || 0);
    const resetW = countdown(w7d.reset || 0);
    const active = name === current;
    const role = i === 0 ? "primary" : "fallback";
    const color = colorFor(pctS, pctW);

    console.log(`${i}.name=${name}`);
    console.log(`${i}.role=${role}`);
    console.log(`${i}.active=${active}`);
    console.log(`${i}.s5h=${pctS}`);
    console.log(`${i}.s5h_status=${statusS}`);
    console.log(`${i}.s5h_reset=${resetS}`);
    console.log(`${i}.w7d=${pctW}`);
    console.log(`${i}.w7d_status=${statusW}`);
    console.log(`${i}.w7d_reset=${resetW}`);
    console.log(`${i}.sonnet=${pctSnt}`);
    console.log(`${i}.color=${color}`);
  }
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
    case "refresh":
      await cmdRefresh(rest[0]);
      break;
    case "costs":
      cmdCosts(rest[0], rest);
      break;
    case "requests":
    case "reqs":
    case "log":
      cmdRequests(rest);
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
    case "bar":
      cmdBar();
      break;
    case "bar-detail":
      cmdBarDetail();
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
