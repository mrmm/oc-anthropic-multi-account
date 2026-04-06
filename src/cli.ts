#!/usr/bin/env bun

import { cmdUsage } from "./render-usage.js";
import { cmdConfig, cmdConfigInteractive } from "./config.js";
import { cmdAdd, closeRL } from "./oauth.js";
import {
  cmdRefresh,
  cmdCosts,
  cmdPing,
  cmdReauth,
  cmdSwitch,
  cmdSetPrimary,
  cmdList,
  cmdRemove,
  cmdTest,
  cmdDiagnose,
  cmdMigrate,
} from "./commands.js";
import { cmdRequests } from "./request-log.js";
import { cmdBar, cmdBarDetail } from "./sketchybar.js";

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
