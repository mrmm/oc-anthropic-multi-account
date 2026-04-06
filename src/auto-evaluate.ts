import { homedir } from "os";
import { join } from "path";
import { getAccountThresholds } from "./thresholds.js";

export const SWITCH_LOG = join(
  homedir(),
  ".config/opencode/anthropic-multi-account-switches.log",
);

export function logSwitch(data: any, from: string, to: string, reason: string) {
  const ts = new Date().toISOString();
  if (!data.switchHistory) data.switchHistory = [];
  data.switchHistory.push({ ts, from, to, reason });
  if (data.switchHistory.length > 50) {
    data.switchHistory = data.switchHistory.slice(-50);
  }
  // Append to dedicated log file
  try {
    const line = `${ts}  ${from} → ${to}  [${reason}]\n`;
    require("fs").appendFileSync(SWITCH_LOG, line);
  } catch {}
}

export function autoEvaluate(data: any) {
  const accounts = data.accounts || [];
  if (accounts.length < 2 || !data.currentAccount) return;

  const config = data.config || {};

  // Manual mode: skip auto-evaluation entirely
  if (config.switchMode === "manual") return;
  const LOG_FILE = "/tmp/sketchybar_logs.txt";

  function aeLog(msg: string) {
    try {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      require("fs").appendFileSync(LOG_FILE, `${ts} [autoEvaluate] ${msg}\n`);
    } catch {}
  }

  function isOverThreshold(accountName: string, usage: any): boolean {
    if (!usage) return false;
    const t = getAccountThresholds(accountName, config);
    return (
      (usage.session5h?.utilization || 0) > t.session5h ||
      (usage.weekly7d?.utilization || 0) > t.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > t.weekly7dSonnet
    );
  }

  function isRejected(usage: any): boolean {
    if (!usage) return false;
    return (
      usage.session5h?.status === "rejected" ||
      usage.weekly7d?.status === "rejected"
    );
  }

  function maxUtil(usage: any): number {
    if (!usage) return 0;
    return Math.max(
      usage.session5h?.utilization || 0,
      usage.weekly7d?.utilization || 0,
    );
  }

  const primary = accounts[0];
  const currentAccount = data.currentAccount;
  const primaryUsage = data.usage?.[primary.name];
  const currentUsage = data.usage?.[currentAccount];

  aeLog(`Evaluating: current=${currentAccount}, primary=${primary.name}`);
  for (const acct of accounts) {
    const u = data.usage?.[acct.name];
    const t = getAccountThresholds(acct.name, config);
    aeLog(
      `  ${acct.name}: s5h=${((u?.session5h?.utilization || 0) * 100).toFixed(0)}% (${u?.session5h?.status || "?"}), ` +
        `w7d=${((u?.weekly7d?.utilization || 0) * 100).toFixed(0)}% (${u?.weekly7d?.status || "?"}), ` +
        `overThreshold=${isOverThreshold(acct.name, u)}, rejected=${isRejected(u)}, ` +
        `thresholds=[s5h:${t.session5h}, w7d:${t.weekly7d}]`,
    );
  }

  if (currentAccount === primary.name) {
    // On primary: switch to fallback only if fallback is actually better
    if (isOverThreshold(primary.name, primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        const fallbackUsage = data.usage?.[fallback.name];
        // Skip fallbacks that are rejected or have higher utilization
        if (isRejected(fallbackUsage)) {
          aeLog(`  Skip ${fallback.name}: rejected`);
          continue;
        }
        if (isOverThreshold(fallback.name, fallbackUsage)) {
          aeLog(`  Skip ${fallback.name}: also over threshold`);
          continue;
        }
        if (maxUtil(fallbackUsage) >= maxUtil(primaryUsage)) {
          aeLog(
            `  Skip ${fallback.name}: util ${(maxUtil(fallbackUsage) * 100).toFixed(0)}% >= primary ${(maxUtil(primaryUsage) * 100).toFixed(0)}%`,
          );
          continue;
        }
        data.currentAccount = fallback.name;
        logSwitch(
          data,
          primary.name,
          fallback.name,
          "threshold exceeded, fallback available",
        );
        aeLog(
          `  SWITCH: ${primary.name} → ${fallback.name} (fallback is better)`,
        );
        console.log(
          `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (threshold exceeded, fallback available)`,
        );
        return;
      }
      aeLog(`  STAY on ${primary.name}: no better fallback available`);
    } else {
      aeLog(`  STAY on ${primary.name}: under threshold`);
    }
  } else {
    // On fallback: switch back to primary only if primary is actually better
    const currentRejected = isRejected(currentUsage);
    const primaryRejected = isRejected(primaryUsage);
    const primaryUnderThreshold = !isOverThreshold(primary.name, primaryUsage);
    const primaryBetterUtil = maxUtil(primaryUsage) < maxUtil(currentUsage);

    if (primaryUnderThreshold && !primaryRejected) {
      data.currentAccount = primary.name;
      logSwitch(data, currentAccount, primary.name, "primary under threshold");
      aeLog(
        `  SWITCH: ${currentAccount} → ${primary.name} (primary under threshold)`,
      );
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (primary under threshold)`,
      );
    } else if (currentRejected && !primaryRejected && primaryBetterUtil) {
      data.currentAccount = primary.name;
      logSwitch(
        data,
        currentAccount,
        primary.name,
        "current rejected, primary better",
      );
      aeLog(
        `  SWITCH: ${currentAccount} → ${primary.name} (current rejected, primary better)`,
      );
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (current rejected, primary available)`,
      );
    } else {
      aeLog(
        `  STAY on ${currentAccount}: primary not better (overThresh=${!primaryUnderThreshold}, rejected=${primaryRejected})`,
      );
    }
  }
}
