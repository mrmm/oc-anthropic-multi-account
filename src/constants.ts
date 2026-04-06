import { homedir } from "os";
import { join } from "path";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const AUTHORIZE_URLS = {
  console: "https://platform.claude.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize",
};

export const CODE_CALLBACK_URL =
  "https://platform.claude.com/oauth/code/callback";

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export const REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
];

export const TOOL_PREFIX = "mcp_";
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
export const CONFIG_DIR = join(homedir(), ".config/opencode");
export const DATA_FILE = join(CONFIG_DIR, "anthropic-multi-account.json");

// Legacy file paths (for migration)
export const LEGACY_ACCOUNTS_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-accounts.json",
);
export const LEGACY_ACCOUNTS_FILE_CONFIG = join(
  CONFIG_DIR,
  "anthropic-multi-accounts.json",
);
export const LEGACY_ACCOUNTS_FILE_LOCAL = join(
  homedir(),
  ".local/share/opencode/multi-account-auth.json",
);
export const LEGACY_STATE_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-state.json",
);
export const LEGACY_STATE_FILE_LOCAL = join(
  homedir(),
  ".local/share/opencode/multi-account-state.json",
);

export const DEFAULTS = { threshold: 0.7, checkInterval: 3600000 };

export const EMPTY_DATA = {
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

export type PerMetric = {
  session5h: number;
  weekly7d: number;
  weekly7dSonnet: number;
};

export const EMPTY_USAGE = {
  session5h: { utilization: 0, reset: null, status: "allowed" },
  weekly7d: { utilization: 0, reset: null, status: "allowed" },
  weekly7dSonnet: { utilization: 0, reset: null, status: "allowed" },
  timestamp: null,
};
