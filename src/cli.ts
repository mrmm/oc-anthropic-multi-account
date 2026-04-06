#!/usr/bin/env bun

import { Command } from "commander";
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

const program = new Command();

program
  .name("oc-anth-ma")
  .description(
    "Manage multiple Anthropic accounts with automatic threshold-based failover.\n\n" +
      "Monitors session (5h) and weekly (7d) rate limits across accounts,\n" +
      "automatically switching when thresholds are exceeded.",
  )
  .version("1.1.0", "-v, --version")
  .enablePositionalOptions()
  .addHelpText(
    "after",
    `
Examples:
  $ oc-anth-ma add                           Interactive account setup
  $ oc-anth-ma add work                      Add account named "work"
  $ oc-anth-ma usage -w                      Live usage dashboard
  $ oc-anth-ma config --switch-mode manual   Disable auto-switching
  $ oc-anth-ma switch fallback               Force switch to "fallback"
  $ oc-anth-ma config --account work \\
      --email me@co.com --org Acme --plan team
`,
  );

// Ensure closeRL is called after every action
program.hook("postAction", () => {
  closeRL();
});

// ── Accounts ────────────────────────────────────────────────────────────────

program
  .command("add")
  .alias("a")
  .description("Add a new account (interactive or with arguments)")
  .argument("[name]", "account alias (interactive if omitted)")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .addHelpText(
    "after",
    `
Examples:
  $ oc-anth-ma add                           Full interactive wizard
  $ oc-anth-ma add primary                   Interactive auth method
  $ oc-anth-ma add primary <url> <code>      Direct OAuth (non-interactive)
`,
  )
  .action((_name, _opts, _cmd) => {
    return cmdAdd(process.argv.slice(3));
  });

program
  .command("reauth")
  .description("Re-authenticate an existing account")
  .argument("<name>", "account alias")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .passThroughOptions()
  .addHelpText(
    "after",
    `
Examples:
  $ oc-anth-ma reauth primary                Interactive re-auth
  $ oc-anth-ma reauth primary --api-key      Switch to API key auth
`,
  )
  .action((name) => {
    return cmdReauth(name, process.argv.slice(4));
  });

program
  .command("list")
  .alias("ls")
  .description("List all configured accounts with status")
  .action(() => {
    cmdList();
  });

program
  .command("remove")
  .alias("rm")
  .description("Remove an account permanently")
  .argument("<name>", "account alias")
  .action((name) => {
    cmdRemove(name);
  });

program
  .command("set-primary")
  .description("Promote an account to primary (first in failover order)")
  .argument("<name>", "account alias")
  .action((name) => {
    cmdSetPrimary(name);
  });

program
  .command("switch")
  .description("Force switch the active account")
  .argument("<name>", "account alias to activate")
  .action((name) => {
    cmdSwitch(name);
  });

// ── Monitoring ──────────────────────────────────────────────────────────────

program
  .command("usage")
  .alias("u")
  .description("Show rate-limit usage dashboard for all accounts")
  .option("-w, --watch", "live-refresh every 5 seconds")
  .option("-j, --json", "output as JSON")
  .action((opts) => {
    const args: string[] = [];
    if (opts.watch) args.push("--watch");
    if (opts.json) args.push("--json");
    cmdUsage(args);
  });

program
  .command("refresh")
  .description("Fetch latest usage data from Anthropic API")
  .argument("[name]", "specific account (all if omitted)")
  .action((name) => {
    return cmdRefresh(name);
  });

program
  .command("ping")
  .description("Test connectivity and show current rate-limit headers")
  .argument("<name>", "account alias")
  .option("-j, --json", "output as JSON")
  .action((name, opts) => {
    return cmdPing(name, opts.json ?? false);
  });

program
  .command("test")
  .description("Send a test message and verify account works end-to-end")
  .argument("<name>", "account alias")
  .action((name) => {
    return cmdTest(name);
  });

program
  .command("costs")
  .description("Show token consumption and estimated costs")
  .argument("[name]", "specific account (all if omitted)")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .passThroughOptions()
  .action((name) => {
    cmdCosts(name, process.argv.slice(3));
  });

program
  .command("requests")
  .aliases(["reqs", "log"])
  .description("Browse request history with filtering and summaries")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .passThroughOptions()
  .addHelpText(
    "after",
    `
Options (pass-through):
  --limit <n>            Max entries to show (default: 50)
  --account <name>       Filter by account
  --model <model>        Filter by model
  --errors               Show only errors
  --switches             Show only account switches
  --summary              Aggregate summary view
  --json                 Output as JSON
`,
  )
  .action(() => {
    cmdRequests(process.argv.slice(3));
  });

program
  .command("diagnose")
  .description("Run diagnostic checks on configuration and auth state")
  .action(() => {
    cmdDiagnose();
  });

// ── Configuration ───────────────────────────────────────────────────────────

program
  .command("config")
  .alias("c")
  .description(
    "View or update configuration (thresholds, intervals, switch mode)",
  )
  .allowUnknownOption()
  .allowExcessArguments(true)
  .passThroughOptions()
  .addHelpText(
    "after",
    `
Options (pass-through):
  --show                 Display current config (default)
  --threshold <0-1>      Set global threshold (e.g. 0.8)
  --thresholds <s,w,sn>  Set per-metric thresholds (e.g. 95,80,90)
  --interval <min>       Check interval in minutes
  --switch-mode <mode>   "auto" or "manual"
  --account <name>       Target a specific account, then:
    --plan <plan>        pro | team | max5x | max20x
    --email <email>      Set account email
    --org <org>          Set account organization
    --extra-credit <m>   on | off | auto
    --reset              Reset account overrides

Examples:
  $ oc-anth-ma config                        Show current config
  $ oc-anth-ma config --threshold 0.8        Set global threshold to 80%
  $ oc-anth-ma config --switch-mode manual   Disable auto-switching
  $ oc-anth-ma config --account work \\
      --plan team --email me@co.com --org Acme
`,
  )
  .action(() => {
    cmdConfig(process.argv.slice(3));
  });

program
  .command("config-interactive")
  .description("Step-by-step configuration wizard using prompts")
  .action(() => {
    return cmdConfigInteractive();
  });

// ── Integration ─────────────────────────────────────────────────────────────

program
  .command("bar")
  .description("Output key=value status for sketchybar widget")
  .action(() => {
    cmdBar();
  });

program
  .command("bar-detail")
  .description("Output detailed key=value for sketchybar popup")
  .action(() => {
    cmdBarDetail();
  });

program
  .command("migrate")
  .description("Migrate data from older config format versions")
  .action(() => {
    cmdMigrate();
  });

// ── Parse & Run ─────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
