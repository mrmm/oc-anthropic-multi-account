import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import {
  DATA_FILE,
  EMPTY_DATA,
  LEGACY_ACCOUNTS_FILE,
  LEGACY_ACCOUNTS_FILE_CONFIG,
  LEGACY_ACCOUNTS_FILE_LOCAL,
  LEGACY_STATE_FILE,
  LEGACY_STATE_FILE_LOCAL,
} from "./constants.js";
import { warning, info, error } from "./ui-utils.js";

// ============================================================================
// File helpers (atomic write + backup fallback)
// ============================================================================

export function safeReadJSON<T>(filePath: string, fallback: T): T {
  for (const path of [filePath, filePath + ".bak"]) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (path.endsWith(".bak")) {
        warning(`Recovered ${filePath} from backup`, 2);
      }
      return data;
    } catch {
      continue;
    }
  }
  return fallback;
}

export function safeWriteJSON(filePath: string, data: any) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      copyFileSync(filePath, filePath + ".bak");
    }
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  } catch (e) {
    error(`Failed to save ${filePath}: ${e}`, 2);
  }
}

export function readWithFallback<T>(
  paths: string[],
  fallback: T,
): { data: T; source: string | null } {
  for (const p of paths) {
    const data = safeReadJSON<T | null>(p, null as T | null);
    if (data !== null) return { data: data as T, source: p };
  }
  return { data: fallback, source: null };
}

export function normalizeAccountFields(account: any): any {
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

export function normalizeMultiAuthShape(multiAuth: any): {
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
export function loadData(): typeof EMPTY_DATA & Record<string, any> {
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
    info(`Migrated to consolidated file: ${DATA_FILE}`, 2);
  }

  return data;
}

export function saveData(data: any) {
  safeWriteJSON(DATA_FILE, data);
}

export function loadAccounts() {
  return loadData().accounts || [];
}

/**
 * Find an account by name, returning the account or null.
 */
export function findAccount(accounts: any[], name: string): any | null {
  return accounts.find((a: any) => a.name === name) || null;
}

/**
 * Find an account or print error and return null.
 * Returns { account, abort } where abort=true means error was already printed.
 */
export function findAccountOrError(
  accounts: any[],
  name: string,
): { account: any; abort: boolean } {
  const account = findAccount(accounts, name);
  if (!account) {
    const available = accounts.map((a: any) => a.name).join(", ");
    error(`Account '${name}' not found`, 2);
    console.log(`       Available: ${available || "none"}`);
    console.log(`       Run: bun src/cli.ts list\n`);
    return { account: null, abort: true };
  }
  return { account, abort: false };
}

// ============================================================================
// Account Upsert Helper
// ============================================================================

/**
 * Upsert an account into the data, preserving existing fields on reauth.
 *
 * CRITICAL: This function preserves:
 * - id (account identity)
 * - email, org, plan (user metadata)
 * - usage (rate limits and consumption tracking)
 *
 * @param data - The current data object
 * @param accountName - The account name to find or create
 * @param newFields - Fields to set/update (access, refresh, expires, apiKey, type)
 * @returns A new data object with the account upserted (does NOT mutate input)
 */
export function upsertAccount(
  data: any,
  accountName: string,
  newFields: any,
): any {
  // Deep clone to avoid mutation
  const result = JSON.parse(JSON.stringify(data));
  result.accounts = result.accounts || [];

  const idx = result.accounts.findIndex((a: any) => a.name === accountName);

  // Create base account object
  const updated: any = {
    id: crypto.randomUUID(),
    name: accountName,
    email: null,
    org: null,
    plan: null,
    ...newFields,
  };

  if (idx >= 0) {
    // EXISTING ACCOUNT: Preserve identity and usage data
    const existing = result.accounts[idx];
    updated.id = existing.id || updated.id;
    updated.email = existing.email || null;
    updated.org = existing.org || null;
    updated.plan = existing.plan || null;
    // CRITICAL: Preserve usage data (rate limits + consumption)
    if (existing.usage !== undefined) {
      updated.usage = existing.usage;
    }
    result.accounts[idx] = updated;
  } else {
    // NEW ACCOUNT: Just add it
    result.accounts.push(updated);
  }

  return result;
}
