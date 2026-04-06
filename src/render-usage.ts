import { DEFAULTS, EMPTY_USAGE } from "./constants.js";
import { loadData, saveData } from "./data.js";
import {
  normalizeThresholds,
  allSame,
  getAccountThresholds,
} from "./thresholds.js";
import { autoEvaluate } from "./auto-evaluate.js";

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

export function formatResetTime(ts: number | null): string {
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

export function cmdUsage(args: string[]) {
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
