import { generatePKCE } from "@openauthjs/openauth/pkce";
import * as readline from "readline";
import * as clack from "@clack/prompts";
import { CLIENT_ID, TOKEN_URL, CODE_CALLBACK_URL } from "./constants.js";
import { loadData, saveData, upsertAccount } from "./data.js";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "./oauth-utils.js";

export function createOAuthTokenRequestInit(
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

export function closeRL() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

export async function prompt(q: string): Promise<string> {
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

export async function cmdAdd(args: string[]) {
  let name = args[0];
  const authUrl = args[1]; // The authorization URL (contains state/verifier)
  const authCode = args[2]; // The auth code from callback

  if (!name) {
    // Fully interactive mode — prompt for everything
    clack.intro("Add Account");

    const inputName = await clack.text({
      message: "Account name (alias)",
      placeholder: "e.g. primary, work, personal",
      validate: (v) => {
        if (!v) return "Name is required";
        const data = loadData();
        if (data.accounts?.find((a: any) => a.name === v))
          return `Account '${v}' already exists`;
        return undefined;
      },
    });
    if (clack.isCancel(inputName)) {
      clack.cancel("Cancelled");
      return;
    }

    const inputEmail = await clack.text({
      message: "Email (optional)",
      placeholder: "user@example.com",
    });
    if (clack.isCancel(inputEmail)) {
      clack.cancel("Cancelled");
      return;
    }

    const inputOrg = await clack.text({
      message: "Organization (optional)",
      placeholder: "e.g. Pelico, Personal",
    });
    if (clack.isCancel(inputOrg)) {
      clack.cancel("Cancelled");
      return;
    }

    const inputPlan = await clack.select({
      message: "Subscription plan",
      options: [
        { value: "team", label: "Team / Premium", hint: "$30/month" },
        { value: "pro", label: "Pro", hint: "$20/month" },
        { value: "max5x", label: "Max 5x", hint: "$100/month" },
        { value: "max20x", label: "Max 20x", hint: "$200/month" },
      ],
    });
    if (clack.isCancel(inputPlan)) {
      clack.cancel("Cancelled");
      return;
    }

    const inputAuth = await clack.select({
      message: "Authentication method",
      options: [
        {
          value: "oauth",
          label: "Claude Pro/Max (OAuth)",
          hint: "recommended",
        },
        { value: "api_key", label: "API Key", hint: "manual entry" },
      ],
    });
    if (clack.isCancel(inputAuth)) {
      clack.cancel("Cancelled");
      return;
    }

    // Set name for rest of the function
    args[0] = inputName as string;

    if (inputAuth === "api_key") {
      const apiKey = await clack.text({
        message: "Enter your API key",
        placeholder: "sk-ant-...",
        validate: (v) => (!v ? "API key is required" : undefined),
      });
      if (clack.isCancel(apiKey)) {
        clack.cancel("Cancelled");
        return;
      }

      const data = loadData();
      data.accounts ??= [];
      const account = {
        id: crypto.randomUUID(),
        name: inputName as string,
        email: (inputEmail as string) || null,
        org: (inputOrg as string) || null,
        plan: inputPlan
          ? {
              type: inputPlan as string,
              price:
                ({ pro: 20, team: 30, max5x: 100, max20x: 200 } as any)[
                  inputPlan as string
                ] || 0,
            }
          : null,
        apiKey,
        type: "api_key",
      };
      data.accounts.push(account);
      saveData(data);

      clack.outro(`Account '${inputName}' added with API key ✅`);
      return;
    }

    // OAuth flow — fall through to the OAuth section below with name set
    // First save the account stub with metadata
    const data = loadData();
    data.accounts ??= [];
    const stub = {
      id: crypto.randomUUID(),
      name: inputName as string,
      email: (inputEmail as string) || null,
      org: (inputOrg as string) || null,
      plan: inputPlan
        ? {
            type: inputPlan as string,
            price:
              ({ pro: 20, team: 30, max5x: 100, max20x: 200 } as any)[
                inputPlan as string
              ] || 0,
          }
        : null,
      access: "",
      refresh: "",
      expires: 0,
      type: "oauth",
    };
    data.accounts.push(stub);
    saveData(data);

    // Continue to the OAuth flow below (name is now set)
    name = inputName as string;
  }

  console.log(`\n  🔐 Adding account: ${name}`);
  console.log("  ────────────────────────────────────────\n");

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

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code, verifier, state);
    } catch (err: any) {
      console.error(`\n  \u274c ${err.message}`);
      console.error(
        "     \ud83d\udca1 Try again or use a fresh authorization URL\n",
      );
      return;
    }

    const data = loadData();
    const updated = upsertAccount(data, name, {
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: Date.now() + tokens.expiresIn * 1000,
      type: "oauth",
    });
    saveData(updated);

    console.log(`\n  ✅ Account '${name}' added`);
    console.log("     Restart OpenCode to use the new account");
    console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
    return;
  }

  // Interactive mode - choose auth method
  clack.intro("Add Account");

  const choice = await clack.select({
    message: "Authentication method",
    options: [
      { value: "1", label: "Claude Pro/Max (OAuth)", hint: "recommended" },
      { value: "2", label: "API Key", hint: "manual entry" },
    ],
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Cancelled");
    return;
  }

  if (choice === "2") {
    // Manual API key
    const apiKey = await clack.text({
      message: "Enter your API key",
      placeholder: "sk-ant-...",
      validate: (v) => (!v ? "API key is required" : undefined),
    });
    if (clack.isCancel(apiKey)) {
      clack.cancel("Cancelled");
      return;
    }
    if (!apiKey) {
      console.error("\n  \u274c No API key provided\n");
      return;
    }

    const data = loadData();
    const updated = upsertAccount(data, name, {
      apiKey,
      type: "api_key",
    });
    saveData(updated);

    console.log(`\n  ✅ Account '${name}' added with API key`);
    console.log("     Restart OpenCode to use the new account");
    console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
    return;
  }

  // OAuth flow
  const pkce = await generatePKCE();
  const state = generateState();

  const url = buildAuthorizationUrl(pkce.challenge, state);

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

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, pkce.verifier, state);
  } catch (err: any) {
    console.error(`\n  \u274c ${err.message}`);
    console.error(
      "     \ud83d\udca1 Try again or use a fresh authorization URL\n",
    );
    return;
  }

  const data = loadData();
  const updated = upsertAccount(data, name, {
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: Date.now() + tokens.expiresIn * 1000,
    type: "oauth",
  });
  saveData(updated);

  console.log(`\n  ✅ Account '${name}' added`);
  console.log("     Restart OpenCode to use the new account");
  console.log(`     Run: bun src/cli.ts usage    View usage metrics\n`);
}

export async function refreshToken(account: any): Promise<string | null> {
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
