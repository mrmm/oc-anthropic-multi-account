import { loadData, saveData } from "./data.js";
import { formatResetTime } from "./render-usage.js";

// ---------------------------------------------------------------------------
// Rate-limit header parsing (mirrors index.mjs updateMetric logic)
// Header prefixes:  anthropic-ratelimit-unified-{5h,7d,7d_sonnet}-{utilization,reset,status}
// ---------------------------------------------------------------------------

export type QuotaMetric = {
  utilization: number;
  reset: number | null;
  status: string;
};
export type QuotaSnapshot = {
  session5h: QuotaMetric | null;
  weekly7d: QuotaMetric | null;
  weekly7dSonnet: QuotaMetric | null;
};

export function parseRateLimitHeaders(res: Response): QuotaSnapshot | null {
  function parseMetric(prefix: string): QuotaMetric | null {
    const rawUtil = res.headers.get(`${prefix}-utilization`);
    const rawReset = res.headers.get(`${prefix}-reset`);
    const rawStatus = res.headers.get(`${prefix}-status`);
    if (rawUtil === null && rawReset === null && rawStatus === null)
      return null;
    return {
      utilization: rawUtil !== null ? parseFloat(rawUtil) || 0 : 0,
      reset: rawReset !== null ? parseInt(rawReset, 10) || null : null,
      status: rawStatus ?? "unknown",
    };
  }

  const session5h = parseMetric("anthropic-ratelimit-unified-5h");
  const weekly7d = parseMetric("anthropic-ratelimit-unified-7d");
  const weekly7dSonnet = parseMetric("anthropic-ratelimit-unified-7d_sonnet");
  if (!session5h && !weekly7d && !weekly7dSonnet) return null;
  return { session5h, weekly7d, weekly7dSonnet };
}

export function updateUsageState(alias: string, quota: QuotaSnapshot): void {
  const data = loadData();
  data.usage = data.usage || {};
  const prev = data.usage[alias] || {};

  function mergeMetric(prevMetric: any, newMetric: QuotaMetric | null) {
    if (!newMetric)
      return prevMetric || { utilization: 0, reset: null, status: "allowed" };
    return {
      utilization: newMetric.utilization ?? prevMetric?.utilization ?? 0,
      reset: newMetric.reset ?? prevMetric?.reset ?? null,
      status: newMetric.status ?? prevMetric?.status ?? "unknown",
    };
  }

  data.usage[alias] = {
    session5h: mergeMetric(prev.session5h, quota.session5h),
    weekly7d: mergeMetric(prev.weekly7d, quota.weekly7d),
    weekly7dSonnet: mergeMetric(prev.weekly7dSonnet, quota.weekly7dSonnet),
    timestamp: new Date().toISOString(),
  };
  saveData(data);
}

export function miniProgressBar(
  utilization: number,
  width: number = 15,
): string {
  const filled = Math.round(utilization * width);
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      bar += "\u2501"; // ━
    } else {
      bar += "\x1b[2m\u2591\x1b[0m"; // dim ░
    }
  }
  return bar;
}

export function formatQuotaLine(
  label: string,
  metric: QuotaMetric | null,
): string {
  if (!metric) {
    return `  ${label.padEnd(17)}\x1b[2m\u2014   no data\x1b[0m`;
  }
  const pct = Math.round(metric.utilization * 100);
  const pctStr = `${pct}%`.padStart(4);
  const bar = miniProgressBar(metric.utilization);
  const reset = metric.reset ? `resets ${formatResetTime(metric.reset)}` : "";
  return `  ${label.padEnd(17)}${pctStr}  ${bar}  \x1b[2m${reset}\x1b[0m`;
}

// ============================================================================
// Token consumption & extra credit (shared with index.mjs)
// ============================================================================

export const MODEL_PRICING: Record<string, [number, number]> = {
  haiku: [1.0, 5.0],
  sonnet: [3.0, 15.0],
  opus: [15.0, 75.0],
};

export function getModelPricing(model: string): [number, number] {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return MODEL_PRICING.haiku;
  if (m.includes("opus")) return MODEL_PRICING.opus;
  return MODEL_PRICING.sonnet;
}

export function calculateCost(
  model: string,
  input: number,
  output: number,
): number {
  const [inputPrice, outputPrice] = getModelPricing(model);
  return (input * inputPrice + output * outputPrice) / 1_000_000;
}

export function detectExtraCredit(usage: any) {
  for (const key of ["session5h", "weekly7d", "weekly7dSonnet"] as const) {
    const m = usage?.[key];
    if (m && m.utilization >= 1.0 && m.status === "allowed") {
      if (!usage.extraCredit?.detected) {
        usage.extraCredit = {
          detected: true,
          detectedAt: new Date().toISOString(),
          metric: key,
          tokens: { input: 0, output: 0 },
          estimatedCost: 0,
        };
      }
      return;
    }
  }
  if (usage.extraCredit?.detected) {
    usage.extraCredit.detected = false;
  }
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}
