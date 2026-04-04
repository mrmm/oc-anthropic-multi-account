# oc-anthropic-multi-account

[![npm version](https://img.shields.io/npm/v/oc-anthropic-multi-account)](https://www.npmjs.com/package/oc-anthropic-multi-account)

Never hit a Claude rate limit again with proactive multi-account switching for OpenCode.

## Installation

### 1. Add plugin to OpenCode config

Add to your `opencode.json` (global or project-level):

```json
{
  "plugin": ["oc-anthropic-multi-account@latest"]
}
```

OpenCode will install the plugin automatically on next launch.

### 2. Disable default Anthropic plugin

Add this to your `~/.zshrc` or `~/.bashrc`:

```bash
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
```

Without this, the built-in Anthropic plugin will override the custom fetch wrapper.

### 3. Configure accounts

The CLI (`src/cli.ts`) isn't bundled in the npm package. Clone the repo to use it:

```bash
git clone https://github.com/gaboe/oc-anthropic-multi-account.git
cd oc-anthropic-multi-account
bun install
```

Add accounts (the first account added is the primary):

```bash
bun src/cli.ts add primary
bun src/cli.ts add fallback1
bun src/cli.ts add fallback2
```

You can name accounts anything, such as `work`, `personal`, or `backup`. The CLI will guide you through OAuth authentication for each account.

Each account requires a separate Anthropic Max subscription.

<details>
<summary>Manual configuration (advanced)</summary>

Tokens are stored in `~/.config/opencode/anthropic-multi-account-accounts.json`:

```json
{
  "accounts": [
    {
      "name": "primary",
      "access": "your-access-token",
      "refresh": "your-refresh-token",
      "expires": 1234567890000
    }
  ]
}
```

Tokens are automatically refreshed when expired.

</details>

### 4. Restart OpenCode

```bash
opencode
```

## Migration Guide

### Upgrading from v1.0.x

If you're upgrading from a previous version, follow these steps:

1. **Pull latest changes:**

   ```bash
   git pull origin main
   ```

2. **Run migration assistant:**

   ```bash
   bun src/cli.ts migrate
   ```

3. **Re-authorize accounts:**

   Due to OAuth endpoint changes, you'll need to re-authorize each account:

   ```bash
   bun src/cli.ts reauth primary
   bun src/cli.ts reauth fallback1
   ```

4. **Verify accounts:**
   ```bash
   bun src/cli.ts list
   ```

### What Changed in v1.1.0

- **New OAuth endpoints:** Now using `platform.claude.com` instead of `console.anthropic.com`
- **JSON token requests:** More reliable token exchange with `application/json` content type
- **Comprehensive OAuth scopes:** 6 scopes including sessions, MCP servers, and file upload
- **Better CSRF protection:** Separate state parameter for improved security
- **Retry logic:** Automatic exponential backoff for network errors during token operations
- **Shared inflight refresh:** Prevents concurrent token refresh races across parallel requests
- **Enhanced CLI:** New commands with better UX, colors, and diagnostics

## Why This Plugin?

Claude Max subscriptions have strict rate limits. Hitting them kills your flow and forces you to wait minutes or hours before you can work again. This plugin manages multiple accounts and automatically switches between them based on real-time usage metrics.

### What This Plugin Does Differently

- Proactive switching reads rate limit headers from every response and switches before you hit a 429 error.
- Tracks 3 independent metrics: session (5h), weekly (all models), and weekly (Sonnet).
- Per-metric configurable thresholds allow fine-grained control over when to switch.
- Mid-session switching ensures you aren't stuck with a depleted account.
- Primary-first logic with automatic recovery switches back when your main account recovers.
- Atomic file writes with backups ensure crash-safe state persistence.
- Works with any number of accounts and subscription tiers (5x, 20x, or a mix).
- Live usage dashboard via CLI provides full visibility into your account status.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      Request Flow                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Request  ──►  Check primary metrics  ──►  Route request  │
│                        │                        │           │
│                        ▼                        ▼           │
│               Any metric > 70%?         Use selected        │
│                   │       │              account            │
│                  YES      NO                 │              │
│                   │       │                  ▼              │
│                   ▼       ▼           Capture response      │
│            Use fallback  Use primary    headers             │
│                                              │              │
│                                              ▼              │
│                                        Update usage         │
│                                        metrics              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Account Priority

- **accounts[0]** = Primary (always preferred)
- **accounts[1..n]** = Fallbacks (in order of preference)

### Threshold Logic

Each metric (session, weekly, sonnet) can have its own threshold.

| Condition                                  | Action                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| Any primary metric > its **threshold**     | Switch to first fallback under thresholds                     |
| All primary metrics < their **thresholds** | Switch back to primary                                        |
| On fallback                                | Check recovery every **1 hour** or on rate limit window reset |

### Metrics Tracked

Anthropic sends these headers with every response (no extra API calls needed):

- `anthropic-ratelimit-unified-5h-utilization` - 5-hour rolling window
- `anthropic-ratelimit-unified-7d-utilization` - 7-day rolling window
- `anthropic-ratelimit-unified-7d_sonnet-utilization` - 7-day Sonnet-specific

## CLI Commands

### Account Management

```bash
# Add account (interactive OAuth)
bun src/cli.ts add <name>

# Re-authenticate account
bun src/cli.ts reauth <name>

# List all accounts with status
bun src/cli.ts list

# Set primary account
bun src/cli.ts set-primary <name>

# Remove account
bun src/cli.ts remove <name>

# Test account functionality
bun src/cli.ts test <name>
```

### Usage & Monitoring

```bash
# Show usage for all accounts
bun src/cli.ts usage

# Live usage updates (refreshes every 5s)
bun src/cli.ts usage --watch
```

### Configuration

```bash
# Show current config
bun src/cli.ts config

# Set all thresholds to same value (80%)
bun src/cli.ts config --threshold 0.80

# Set individual thresholds (session, weekly, sonnet)
bun src/cli.ts config --thresholds 95,80,90

# Interactive configuration wizard
bun src/cli.ts config-interactive

# Reset to defaults
bun src/cli.ts config --reset
```

### Diagnostics

```bash
# System diagnostics (file paths, accounts, config)
bun src/cli.ts diagnose

# Migration assistant (detect legacy files, guide upgrade)
bun src/cli.ts migrate

# Ping Anthropic API to verify connectivity
bun src/cli.ts ping
```

Example output:

```
╔══════════════════════════════════════════════════════════════════╗
║           anthropic-multi-account v1.1.0                          ║
╚══════════════════════════════════════════════════════════════════╝

┌─ max-5x ◄── ACTIVE ✨ Best quota available
│  Account Status: ✅ Authenticated
│  Auth Type: Claude Max (OAuth)
│  Scopes: org:create_api_key, user:profile, user:inference,
│          user:sessions:claude_code, user:mcp_servers, user:file_upload
│
│  📊 Session (5h)  (threshold 95%)
│  █████████                                           18%
│  Resets Feb 4 at 5:00 PM
│  Status: 🟢 Under threshold - optimal
│
│  📊 Weekly (all)  (threshold 80%)
│  ██                                                  4%
│  Resets Feb 11 at 9:00 AM
│  Status: 🟢 Under threshold - optimal
│
│  📊 Weekly (Sonnet)  (threshold 90%)
│  █                                                   2%
│  Resets Feb 16 at 8:00 AM
│  Status: 🟢 Under threshold - optimal
│
│  Request Count: 473
│  Last Request: 2/4/2025, 12:00:00 PM
└─

  💡 Tips:
  • Run `bun src/cli.ts config --help` for configuration options
  • Run `bun src/cli.ts list` for account overview
```

Colors: 🟢 < 50% │ 🟡 50-70% │ 🔴 > 70% │ 🔵 active

## Configuration

Configure via CLI (saved to state file):

```bash
bun src/cli.ts config --thresholds 95,80,90   # set session, weekly, sonnet thresholds
bun src/cli.ts config --threshold 0.80         # same threshold for all metrics
bun src/cli.ts config --threshold-session 0.95  # set individual metric
bun src/cli.ts config --threshold-weekly 0.80
bun src/cli.ts config --threshold-sonnet 0.90
bun src/cli.ts config --interval 30             # check recovery every 30 min
bun src/cli.ts config --reset                   # reset to defaults
```

Defaults: threshold=70%, interval=60min

Changing config auto-evaluates whether the active account should switch.

## What's New in v1.1.0

### Authentication Improvements

- **Modern OAuth endpoints** - Using `platform.claude.com` for better reliability
- **JSON token requests** - Modern `application/json` content type for token exchange
- **Comprehensive OAuth scopes** - 6 scopes: `org:create_api_key`, `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`
- **CSRF protection** - Separate state parameter for improved security
- **Retry logic** - Automatic exponential backoff for network errors during token operations
- **Shared inflight refresh** - Prevents concurrent token refresh races across parallel requests

### CLI Enhancements

- **Rich formatting** - Colorized output with emojis and status indicators
- **Interactive config** - Guided configuration wizard with validation (`config-interactive`)
- **Account management** - New commands: `set-primary`, `list`, `remove`, `test`, `diagnose`, `migrate`
- **Better feedback** - Clear success/error messages with helpful tips
- **Validation** - Input validation and warnings for extreme threshold values

### Developer Experience

- **Monolithic structure maintained** - Easy to understand and modify
- **Comprehensive error handling** - Better error messages and recovery paths
- **Migration assistant** - Smooth upgrade path from v1.0.x via `migrate` command

## Data Storage

Data is split into two files to prevent corruption from frequent writes:

**`~/.config/opencode/anthropic-multi-account-accounts.json`** - Tokens (changes rarely)

- `accounts` - Array of accounts with access/refresh tokens

**`~/.config/opencode/anthropic-multi-account-state.json`** - Runtime state (changes frequently)

- `currentAccount` - Currently active account name
- `usage` - Per-account usage metrics with timestamps
- `requestCount` - Total requests made through the plugin
- `lastPrimaryCheck` - Timestamp of last recovery check

## Comparison

| Feature                  | oc-anthropic-multi-account | anthropic-multi-auth | OpenCode built-in   |
| ------------------------ | -------------------------- | -------------------- | ------------------- |
| **Multi-Account**        | Yes (unlimited)            | Yes                  | No (single account) |
| **Proactive Switching**  | Yes (threshold-based)      | No (session-sticky)  | No                  |
| **Header-Based Metrics** | Yes (3 metrics)            | No (quota API)       | No                  |
| **Mid-Session Switch**   | Yes                        | No                   | No                  |
| **Modern OAuth**         | Yes (v1.1.0)               | Yes                  | No                  |
| **Comprehensive Scopes** | Yes (6 scopes, v1.1.0)     | Yes                  | No                  |
| **CSRF Protection**      | Yes (v1.1.0)               | Yes                  | No                  |
| **Retry Logic**          | Yes (v1.1.0)               | Yes                  | No                  |
| **Enhanced CLI**         | Yes (v1.1.0)               | No                   | No                  |
| **OpenCode Plugin**      | Yes                        | Yes                  | Yes                 |

## License

MIT
