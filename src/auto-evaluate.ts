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
  try {
    const line = `${ts}  ${from} → ${to}  [${reason}]\n`;
    require("fs").appendFileSync(SWITCH_LOG, line);
  } catch {}
}

export function autoEvaluate(data: any) {
  const accounts = data.accounts || [];
  if (accounts.length < 2 || !data.currentAccount) return;

  const config = data.config || {};

  if (config.switchMode === "manual") return;

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

  if (currentAccount === primary.name) {
    if (isOverThreshold(primary.name, primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        const fallbackUsage = data.usage?.[fallback.name];
        if (isRejected(fallbackUsage)) continue;
        if (isOverThreshold(fallback.name, fallbackUsage)) continue;
        if (maxUtil(fallbackUsage) >= maxUtil(primaryUsage)) continue;
        data.currentAccount = fallback.name;
        logSwitch(
          data,
          primary.name,
          fallback.name,
          "threshold exceeded, fallback available",
        );
        console.log(
          `  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (threshold exceeded, fallback available)`,
        );
        return;
      }
    }
  } else {
    const currentRejected = isRejected(currentUsage);
    const primaryRejected = isRejected(primaryUsage);
    const primaryUnderThreshold = !isOverThreshold(primary.name, primaryUsage);
    const primaryBetterUtil = maxUtil(primaryUsage) < maxUtil(currentUsage);

    if (primaryUnderThreshold && !primaryRejected) {
      data.currentAccount = primary.name;
      logSwitch(data, currentAccount, primary.name, "primary under threshold");
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
      console.log(
        `  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (current rejected, primary available)`,
      );
    }
  }
}
