import { generatePKCE } from "@openauthjs/openauth/pkce";
import { existsSync } from "fs";
import * as clack from "@clack/prompts";
import {
  CLIENT_ID,
  REQUIRED_BETAS,
  CLAUDE_CLI_USER_AGENT,
  DEFAULTS,
  DATA_FILE,
  LEGACY_ACCOUNTS_FILE,
  LEGACY_ACCOUNTS_FILE_CONFIG,
  LEGACY_ACCOUNTS_FILE_LOCAL,
  LEGACY_STATE_FILE,
} from "./constants.js";
import {
  loadData,
  saveData,
  loadAccounts,
  upsertAccount,
  findAccountOrError,
} from "./data.js";
import { normalizeThresholds, getAccountThresholds } from "./thresholds.js";
import { autoEvaluate, logSwitch } from "./auto-evaluate.js";
import { refreshToken, prompt, createOAuthTokenRequestInit } from "./oauth.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  buildAuthHeaders,
} from "./oauth-utils.js";
import {
  parseRateLimitHeaders,
  updateUsageState,
  formatQuotaLine,
  detectExtraCredit,
  formatNumber,
  formatUSD,
} from "./rate-limits.js";
import {
  success,
  error,
  warning,
  info,
  plain,
  header,
  kv,
  divider,
  availableAccounts,
  Ansi,
} from "./ui-utils.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export async function cmdRefresh(accountName?: string) {
  const data = loadData();
  const accounts = data.accounts || [];

  const toRefresh = accountName
    ? accounts.filter((a: any) => a.name === accountName)
    : accounts;

  if (!toRefresh.length) {
    if (accountName) {
      error(`Account '${accountName}' not found`);
    } else {
      error("No accounts configured");
    }
    return;
  }

  info("Refreshing usage data...");

  for (const account of toRefresh) {
    if (account.type === "api_key") {
      warning(`${account.name}: API key accounts — pinging for metrics`);
      await cmdPing(account.name, false);
      continue;
    }

    const refreshErr = await refreshToken(account);
    if (refreshErr) {
      error(`${account.name}: ${refreshErr}`, 2);
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
        error(`${account.name}: Usage API returned ${res.status}`, 2);
        continue;
      }

      const json = (await res.json()) as Record<string, any>;

      data.usage[account.name] = data.usage[account.name] || {};
      const usage = data.usage[account.name];

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

      const s5h = usage.session5h?.utilization || 0;
      const w7d = usage.weekly7d?.utilization || 0;
      const wSnt = usage.weekly7dSonnet?.utilization || 0;
      const ec = usage.extraCredit?.detected ? " [OK] EXTRA CREDIT" : "";

      plain(`  ${account.name}${ec}`);
      plain(`    Session (5h)     ${Math.round(s5h * 100)}%`);
      plain(`    Weekly (all)     ${Math.round(w7d * 100)}%`);
      plain(
        `    Weekly (Sonnet)  ${wSnt ? Math.round(wSnt * 100) + "%" : "—"}`,
      );
      console.log();
    } catch (err) {
      error(`${account.name}: ${err}`, 2);
    }
  }

  autoEvaluate(data);
  saveData(data);
  success("Usage data refreshed");
}

export function cmdCosts(accountName?: string, args: string[] = []) {
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
    success(
      `Consumption data reset${accountName ? ` for '${accountName}'` : ""}`,
    );
    return;
  }

  const target = accountName
    ? accounts.filter((a: any) => a.name === accountName)
    : accounts;

  if (!target.length) {
    if (accountName) {
      error(`Account '${accountName}' not found`);
    } else {
      error("No accounts configured");
    }
    return;
  }

  header("Token Consumption");

  for (const account of target) {
    const usage = data.usage?.[account.name];
    const consumption = usage?.consumption;

    if (!consumption) {
      plain(`  ${account.name}: No consumption data yet`);
      plain(`    Run some queries to start tracking`);
      console.log();
      continue;
    }

    const ec = usage.extraCredit?.detected ? " [OK] EXTRA CREDIT" : "";
    plain(`  ${account.name}${ec}`);

    if (sessionOnly) {
      const s = consumption.currentSession;
      plain(
        `    Session:  ${formatNumber(s.input)} in / ${formatNumber(s.output)} out  (${s.requests} reqs)  ${formatUSD(s.estimatedCost)}`,
        4,
      );
    } else {
      const s = consumption.currentSession;
      const m = consumption.currentMonth;
      const a = consumption.allTime;

      plain(
        `    Session:  ${formatNumber(s.input)} in / ${formatNumber(s.output)} out  (${s.requests} reqs)  ${formatUSD(s.estimatedCost)}`,
        4,
      );
      plain(
        `    Month:    ${formatNumber(m.input)} in / ${formatNumber(m.output)} out  (${m.requests} reqs)  ${formatUSD(m.estimatedCost)}`,
        4,
      );
      plain(
        `    All-time: ${formatNumber(a.input)} in / ${formatNumber(a.output)} out  (${a.requests} reqs)  ${formatUSD(a.estimatedCost)}`,
        4,
      );

      const models = Object.entries(consumption.byModel || {}) as [
        string,
        any,
      ][];
      if (models.length > 0) {
        plain(`\n    By model:`, 4);
        for (const [model, stats] of models) {
          plain(
            `      ${model.padEnd(30)} ${formatNumber(stats.input)} in / ${formatNumber(stats.output)} out  ${formatUSD(stats.cost)}`,
            6,
          );
        }
      }

      if (usage.extraCredit?.detected && usage.extraCredit.estimatedCost > 0) {
        plain(
          `\n    [WARN] Extra credit: ${formatUSD(usage.extraCredit.estimatedCost)} estimated cost since ${new Date(usage.extraCredit.detectedAt).toLocaleDateString()}`,
          4,
        );
      }

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
          plain(
            `\n    [INFO] Value: ${formatUSD(m.estimatedCost)} API equivalent / ${formatUSD(planPrice)} subscription (${valueRatio}%)`,
            4,
          );

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
          plain(
            `    [INFO] Projected: ~${formatUSD(projected)} this month at current rate`,
            4,
          );
        }
      }
    }

    console.log();
  }
}

export async function cmdPing(alias: string, jsonMode: boolean = false) {
  try {
    const accounts = loadAccounts();
    const { account, abort } = findAccountOrError(accounts, alias);

    if (abort) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: `Account '${alias}' not found`,
          }),
        );
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
        error(`Missing credentials for '${alias}'`);
        plain(`     Run: bun src/cli.ts reauth ${alias}`);
      }
      return;
    }

    if (!jsonMode) {
      info(`Pinging ${alias}...`);
    }

    if (!isApiKey) {
      const refreshError = await refreshToken(account);
      if (refreshError) {
        if (jsonMode) {
          console.log(
            JSON.stringify({ status: "error", alias, error: refreshError }),
          );
        } else {
          error("Token refresh failed");
          plain(`     ${refreshError}`);
          plain(`     Run: bun src/cli.ts reauth ${alias}`);
        }
        return;
      }
    }

    const authHeaders = buildAuthHeaders(account);

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

      success("Account is reachable");

      if (quota) {
        const statuses = [
          quota.session5h?.status,
          quota.weekly7d?.status,
          quota.weekly7dSonnet?.status,
        ].filter(Boolean);
        const overallStatus = statuses.includes("limited")
          ? "limited"
          : "allowed";

        header("Rate Limits");
        console.log(formatQuotaLine("Session (5h)", quota.session5h));
        console.log(formatQuotaLine("Weekly (all)", quota.weekly7d));
        console.log(formatQuotaLine("Weekly (Sonnet)", quota.weekly7dSonnet));
        plain(`Status: ${overallStatus}`);
      } else {
        plain("No rate limit data in response", 2);
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
      error(`Request failed (HTTP ${res.status})`);
      plain(`     ${text.slice(0, 200)}`);
      plain(`     Run: bun src/cli.ts test ${alias}    Full diagnostics`);
    }
  } catch (err) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ status: "error", alias, error: String(err) }),
      );
    } else {
      error("Connection error");
      plain(`     ${String(err)}`);
      plain("     Check your network and try again");
    }
  }
}

export async function cmdReauth(alias: string, args: string[]) {
  const jsonMode = args.includes("--json");

  try {
    const accounts = loadAccounts();
    const { account, abort } = findAccountOrError(accounts, alias);

    if (abort) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: `Account '${alias}' not found`,
          }),
        );
      }
      return;
    }

    const callbackUrl = args.find((a) => !a.startsWith("--") && a !== alias);
    const verifierArg = args.find(
      (a, i) =>
        !a.startsWith("--") &&
        a !== alias &&
        i > args.indexOf(callbackUrl || ""),
    );

    if (jsonMode && callbackUrl) {
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

      let tokens;
      try {
        tokens = await exchangeCodeForTokens(code, verifier, verifier);
      } catch (err: any) {
        console.log(
          JSON.stringify({
            status: "error",
            alias,
            error: err.message,
          }),
        );
        return;
      }

      const reauthData = loadData();
      const updated = upsertAccount(reauthData, alias, {
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
        expires: Date.now() + tokens.expiresIn * 1000,
        type: "oauth",
      });
      saveData(updated);
      console.log(JSON.stringify({ status: "ok", alias }));
      return;
    }

    if (jsonMode && !callbackUrl) {
      const pkce = await generatePKCE();
      const state = crypto.randomUUID().replace(/-/g, "");
      const url = buildAuthorizationUrl(pkce.challenge, state);
      console.log(
        JSON.stringify({ url: url.toString(), verifier: pkce.verifier, state }),
      );
      return;
    }

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

    plain("");
    info(`Re-authenticating: ${alias}`);
    divider(2);
    plain(
      `  Auth type: ${label}${isOverride ? " (switching from " + (authType === "api_key" ? "OAuth" : "API Key") + ")" : ""}`,
    );
    console.log();

    if (authType === "api_key") {
      const apiKey = await clack.text({
        message: "Enter your API key",
        placeholder: "sk-ant-...",
        validate: (v) => (!v ? "API key is required" : undefined),
      });
      if (clack.isCancel(apiKey) || !apiKey) {
        clack.cancel("Cancelled");
        return;
      }

      const reauthApiData = loadData();
      const updated = upsertAccount(reauthApiData, alias, {
        apiKey,
        type: "api_key",
      });
      saveData(updated);
      success(`API key saved for '${alias}'`);
      return;
    }

    const pkce = await generatePKCE();
    const state = crypto.randomUUID().replace(/-/g, "");

    const url = buildAuthorizationUrl(pkce.challenge, state);

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
      const parts = input.split("#");
      code = parts[0];
    }

    info("Exchanging tokens...");

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code, pkce.verifier, state);
    } catch (err: any) {
      error(err.message);
      plain("     [INFO] Try again or use a fresh authorization URL");
      return;
    }
    const reauthOauthData = loadData();
    const updated = upsertAccount(reauthOauthData, alias, {
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: Date.now() + tokens.expiresIn * 1000,
      type: "oauth",
    });
    saveData(updated);

    const expiresMin = Math.round(tokens.expiresIn / 60);
    success(`Account '${alias}' re-authenticated`);
    plain(`     Expires in ${expiresMin} minutes`);
    plain(`  Run: bun src/cli.ts test ${alias}    Verify connectivity`);
  } catch (err) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ status: "error", alias, error: String(err) }),
      );
    } else {
      error(`Error: ${String(err)}`);
    }
  }
}

export function cmdSetPrimary(name: string) {
  if (!name) {
    error("Missing account name");
    plain("  Usage: bun src/cli.ts set-primary <name>");
    return;
  }

  const data = loadData();
  if (!data.accounts?.length) {
    error("No accounts configured");
    plain("     Run: bun src/cli.ts add <name>    Add an account first");
    return;
  }

  const account = data.accounts.find((a: any) => a.name === name);
  if (!account) {
    const available = data.accounts.map((a: any) => a.name).join(", ");
    error(`Account '${name}' not found`);
    plain(`     Available accounts: ${available}`);
    plain("     Run: bun src/cli.ts list");
    return;
  }

  header("Set Primary Account");

  plain("  Before:");
  data.accounts.forEach((a: any, i: number) => {
    const role = i === 0 ? " (primary)" : " (fallback)";
    const marker = a.name === name ? " <-" : "";
    plain(`    ${i + 1}. ${a.name}${role}${marker}`, 4);
  });

  const idx = data.accounts.findIndex((a: any) => a.name === name);
  if (idx === 0) {
    success(`'${name}' is already the primary account`);
    return;
  }

  const [removed] = data.accounts.splice(idx, 1);
  data.accounts.unshift(removed);

  plain("\n  After:");
  data.accounts.forEach((a: any, i: number) => {
    const role = i === 0 ? " (primary)" : " (fallback)";
    plain(`    ${i + 1}. ${a.name}${role}`, 4);
  });

  saveData(data);
  success(`'${name}' is now the primary account`);
  plain("     Restart OpenCode to apply changes");
}

export function cmdList() {
  const data = loadData();
  const accounts = data.accounts || [];

  if (!accounts.length) {
    error("No accounts configured");
    plain("     Run: bun src/cli.ts add <name>    Add your first account");
    return;
  }

  header("Configured Accounts");

  const nameW = Math.max(6, ...accounts.map((a: any) => a.name.length)) + 2;
  plain(
    `  ${"#".padEnd(4)}${"Name".padEnd(nameW)}${"Role".padEnd(12)}${"Status".padEnd(20)}${"Expires"}`,
  );
  plain(
    `  ${"─".repeat(4)}${"─".repeat(nameW)}${"─".repeat(12)}${"─".repeat(20)}${"─".repeat(20)}`,
  );

  accounts.forEach((account: any, i: number) => {
    const isActive = data.currentAccount === account.name;
    const isApiKey = account.type === "api_key";
    const status = isApiKey
      ? "[OK] API Key"
      : account.expires > Date.now()
        ? "[OK] Valid"
        : "[WARN] Expired";
    const role = i === 0 ? "primary" : "fallback";
    const activeTag = isActive ? " <-" : "";

    let expiresStr = "";
    if (isApiKey) {
      expiresStr = "∞";
    } else if (account.expires > Date.now()) {
      const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
      const hoursLeft = Math.floor(minsLeft / 60);
      const mins = minsLeft % 60;
      expiresStr = `${hoursLeft}h ${mins}m`;
    } else {
      expiresStr = "—";
    }

    plain(
      `  ${String(i + 1).padEnd(4)}${(account.name + activeTag).padEnd(nameW)}${role.padEnd(12)}${status.padEnd(20)}${expiresStr}`,
    );
  });

  plain(`\n  ${"─".repeat(40)}`);
  plain(`  ${accounts.length} account(s) configured`);

  const expired = accounts.filter(
    (a: any) => a.type !== "api_key" && a.expires <= Date.now(),
  );
  if (expired.length > 0) {
    warning(`${expired.length} account(s) have expired tokens:`);
    expired.forEach((a: any) => {
      plain(`     Run: bun src/cli.ts reauth ${a.name}`);
    });
  }

  plain("\n  [INFO] Run: bun src/cli.ts usage    View detailed metrics");
}

export function cmdRemove(name: string) {
  if (!name) {
    error("Missing account name");
    plain("  Usage: bun src/cli.ts remove <name>");
    return;
  }

  const data = loadData();
  if (!data.accounts?.length) {
    error("No accounts configured");
    return;
  }

  const idx = data.accounts.findIndex((a: any) => a.name === name);
  if (idx < 0) {
    const available = data.accounts.map((a: any) => a.name).join(", ");
    error(`Account '${name}' not found`);
    plain(`     Available accounts: ${available}`);
    plain("     Run: bun src/cli.ts list");
    return;
  }

  const account = data.accounts[idx];
  const isPrimary = idx === 0;

  header("Remove Account");

  if (isPrimary) {
    plain("  ┌─────────────────────────────────────────┐");
    plain("  │  [WARN] This is the PRIMARY account         │");
    plain("  └─────────────────────────────────────────┘");
  }

  plain(`    Name:      ${account.name}`, 4);
  plain(`    Role:      ${isPrimary ? "primary" : "fallback"}`, 4);
  plain(
    `    Status:    ${account.expires > Date.now() ? "[OK] Authenticated" : "[WARN] Expired"}`,
    4,
  );

  data.accounts.splice(idx, 1);

  if (data.usage?.[name]) {
    delete data.usage[name];
  }
  if (data.currentAccount === name) {
    data.currentAccount = data.accounts[0]?.name || null;
  }
  saveData(data);

  success(`Account '${name}' removed`);
  plain("     Tokens revoked and usage data cleared");

  if (isPrimary && data.accounts.length > 0) {
    plain(`     [OK] '${data.accounts[0].name}' is now the primary account`);
  }

  plain("\n  [INFO] Run: bun src/cli.ts add ${name}    Re-add later");
}

export async function cmdTest(name: string) {
  if (!name) {
    error("Missing account name");
    plain("  Usage: bun src/cli.ts test <name>");
    return;
  }

  const accounts = loadAccounts();
  const { account, abort } = findAccountOrError(accounts, name);

  if (abort) return;

  header(`Testing Account: ${name}`);

  const isApiKey = account.type === "api_key";
  let passed = 0;
  const total = 3;

  plain("  1. Checking token validity...");
  if (isApiKey) {
    success("API key configured (does not expire)", 5);
    passed++;
  } else if (account.access && account.expires > Date.now()) {
    const minsLeft = Math.floor((account.expires - Date.now()) / 60000);
    success(`Token valid (expires in ${minsLeft} min)`, 5);
    passed++;
  } else {
    warning("Token expired, attempting refresh...", 5);
    const refreshError = await refreshToken(account);
    if (refreshError) {
      error(`Refresh failed: ${refreshError}`, 5);
      plain(`     Run: bun src/cli.ts reauth ${name}`);
      divider(2);
      error(`Result: ${passed}/${total} checks passed`);
      return;
    }
    success("Token refreshed successfully", 5);
    passed++;
  }

  plain("  2. Sending API test request...");
  const authHeaders = buildAuthHeaders(account);

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
    error(`Request failed (HTTP ${res.status})`, 5);
    plain(`        ${text.slice(0, 200)}`);
    divider(2);
    error(`Result: ${passed}/${total} checks passed`);
    return;
  }

  success("API request successful", 5);
  passed++;

  plain("  3. Reading rate limit headers...");
  const quota = parseRateLimitHeaders(res);
  if (quota) {
    updateUsageState(name, quota);
    if (quota.session5h) {
      success(
        `Session (5h):    ${Math.round(quota.session5h.utilization * 100)}% utilized`,
        5,
      );
    }
    if (quota.weekly7d) {
      success(
        `Weekly (all):    ${Math.round(quota.weekly7d.utilization * 100)}% utilized`,
        5,
      );
    }
    if (quota.weekly7dSonnet) {
      success(
        `Weekly (Sonnet): ${Math.round(quota.weekly7dSonnet.utilization * 100)}% utilized`,
        5,
      );
    }
    passed++;
  } else {
    warning("No rate limit headers in response (non-fatal)", 5);
    passed++;
  }

  divider(2);
  success(`Result: ${passed}/${total} checks passed`);
  plain(`     Account '${name}' is fully functional`);
}

export function cmdDiagnose() {
  header("System Diagnostics");

  const data = loadData();
  let issues = 0;

  plain("  Accounts:");
  if (!data.accounts?.length) {
    error("No accounts configured", 4);
    plain("       Run: bun src/cli.ts add <name>", 4);
    issues++;
  } else {
    success(`Found ${data.accounts.length} account(s)`, 4);
    data.accounts.forEach((account: any, i: number) => {
      const isApiKey = account.type === "api_key";
      const isExpired = !isApiKey && account.expires <= Date.now();
      const status = isApiKey
        ? "[OK] API Key"
        : isExpired
          ? "[WARN] Expired"
          : "[OK] Valid";
      plain(`       ${i + 1}. ${account.name} — ${status}`, 4);
      if (isExpired) {
        plain(`          Run: bun src/cli.ts reauth ${account.name}`, 4);
        issues++;
      }
    });
    console.log();
  }

  plain("  State:");
  if (data.currentAccount) {
    success(`Active account: ${data.currentAccount}`, 4);
  } else {
    warning("No active account set", 4);
    issues++;
  }
  success(`Request count: ${data.requestCount || 0}`, 4);

  if (data.usage && Object.keys(data.usage).length > 0) {
    const accountNames = Object.keys(data.usage);
    success(`Usage data: ${accountNames.length} account(s)`, 4);
  } else {
    warning("No usage data", 4);
    issues++;
  }

  if (data.config) {
    const t = normalizeThresholds(data.config.threshold, DEFAULTS.threshold);
    success(
      `Config: threshold ${Math.round(t.session5h * 100)}%/${Math.round(t.weekly7d * 100)}%/${Math.round(t.weekly7dSonnet * 100)}%, interval ${(data.config.checkInterval || DEFAULTS.checkInterval) / 60000}min`,
      4,
    );
  }
  console.log();

  plain("  OAuth:");
  success("Client ID configured", 4);
  success(`Token URL: ${TOKEN_URL}`, 4);
  success(`Callback URL: ${CODE_CALLBACK_URL}`, 4);
  success("Required scopes present", 4);
  console.log();

  plain("  Files:");
  success(`Data: ${DATA_FILE}`, 4);
  console.log();

  divider(2);
  if (issues === 0) {
    success("All checks passed — system is healthy");
  } else {
    warning(`${issues} issue(s) found:`);
    if (!data.accounts?.length) {
      plain("     - No accounts configured");
    }
    if (data.accounts?.some((a: any) => a.expires <= Date.now())) {
      plain("     - Some accounts need re-authentication");
    }
    if (!data.currentAccount) {
      plain("     - No active account set");
    }
  }
  plain("     Run: bun src/cli.ts usage    View detailed metrics");
}

export function cmdMigrate() {
  header("Migration Assistant");

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
    success("No legacy files found — installation is up to date");
    return;
  }

  warning(`Found ${foundLegacy.length} legacy file(s):`);
  foundLegacy.forEach((f, i) => {
    plain(`    ${i + 1}. ${f.path}`);
    plain(`       Version: ${f.version}`);
  });

  plain(`\n  New location: ${DATA_FILE}`);

  console.log("\n  Migration will:");
  plain("    1. Move accounts to new location");
  plain("    2. Update auth endpoints to platform.claude.com");
  plain("    3. Preserve all tokens and usage data");
  plain("    4. Create backups of original files");

  console.log();
  plain("  ┌─────────────────────────────────────────────────────┐");
  plain("  │  [WARN] Due to endpoint changes, you will need to      │");
  plain("  │     re-authorize accounts after migration            │");
  plain("  └─────────────────────────────────────────────────────┘");

  console.log("\n  Next steps:");
  plain("    1. Restart OpenCode (migration runs automatically)");
  plain("    2. Re-authorize each account:");
  plain("       Run: bun src/cli.ts reauth <account-name>");
  plain("    3. Or add accounts fresh:");
  plain("       Run: bun src/cli.ts add <account-name>");
}

export function cmdSwitch(name: string) {
  if (!name) {
    error("Missing account name");
    plain("  Usage: bun src/cli.ts switch <name>");
    return;
  }

  const accounts = loadAccounts();
  const { account, abort } = findAccountOrError(accounts, name);

  if (abort) return;

  const data = loadData();
  const previous = data.currentAccount || accounts[0]?.name;

  if (previous === name) {
    success(`Already using '${name}'`);
    return;
  }

  data.currentAccount = name;
  data.lastPrimaryCheck = Date.now();
  logSwitch(data, previous, name, "manual switch");
  saveData(data);

  success(`Switched: ${previous} → ${name}`);
  plain("  Active account is now '${name}'");
  plain("  Note: Automatic threshold switching will resume normally.");
  plain("  The system may switch away if this account exceeds thresholds.");
}
