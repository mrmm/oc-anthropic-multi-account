import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR } from "./constants.js";

// ============================================================================
// Request history log
// ============================================================================

export const LOGS_DIR = join(CONFIG_DIR, "anthropic-multi-account-logs");
export const LEGACY_LOG_FILE = join(
  CONFIG_DIR,
  "anthropic-multi-account-requests.jsonl",
);

export interface RequestLogEntry {
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

export function cmdRequests(args: string[] = []) {
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
