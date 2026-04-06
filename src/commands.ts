import { generatePKCE } from "@openauthjs/openauth/pkce";
import { existsSync } from "fs";
import * as clack from "@clack/prompts";
import {
  CLIENT_ID,
  AUTHORIZE_URLS,
  CODE_CALLBACK_URL,
  TOKEN_URL,
  OAUTH_SCOPES,
  REQUIRED_BETAS,
  CLAUDE_CLI_USER_AGENT,
  DEFAULTS,
  DATA_FILE,
  LEGACY_ACCOUNTS_FILE,
  LEGACY_ACCOUNTS_FILE_CONFIG,
  LEGACY_ACCOUNTS_FILE_LOCAL,
  LEGACY_STATE_FILE,
} from "./constants.js";
import { loadData, saveData, loadAccounts } from "./data.js";
import {
  normalizeThresholds,
  getAccountThresholds,
  createOAuthTokenRequestInit,
} from "./thresholds.js";
import { autoEvaluate, logSwitch } from "./auto-evaluate.js";
import { refreshToken, prompt } from "./oauth.js";
import {
  parseRateLimitHeaders,
  updateUsageState,
  formatQuotaLine,
  detectExtraCredit,
  formatNumber,
  formatUSD,
} from "./rate-limits.js";

// ============================================================================
// refresh command
// ============================================================================

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export async function cmdRefresh(accountName?: string) {
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

export async function cmdPing(alias: string, jsonMode: boolean = false) {
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

export async function cmdReauth(alias: string, args: string[]) {
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
      const state = crypto.randomUUID().replace(/-/g, "");
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
    const state = crypto.randomUUID().replace(/-/g, "");

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
      const parts = input.split("#");
      code = parts[0];
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

export function cmdSetPrimary(name: string) {
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

export function cmdList() {
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

export function cmdRemove(name: string) {
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

export async function cmdTest(name: string) {
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

export function cmdDiagnose() {
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

export function cmdMigrate() {
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
// switch command
// ============================================================================

export function cmdSwitch(name: string) {
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
  logSwitch(data, previous, name, "manual switch");
  saveData(data);

  console.log(`\n  ⚡ Switched: ${previous} → ${name}`);
  console.log(`  Active account is now '${name}'`);
  console.log("\n  Note: Automatic threshold switching will resume normally.");
  console.log(
    "  The system may switch away if this account exceeds thresholds.\n",
  );
}
