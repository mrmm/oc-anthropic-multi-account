import { DEFAULTS, CLIENT_ID } from "./constants.js";
import type { PerMetric } from "./constants.js";

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

export function normalizeThresholds(value: any, fallback: number): PerMetric {
  if (typeof value === "number")
    return { session5h: value, weekly7d: value, weekly7dSonnet: value };
  if (typeof value === "object" && value !== null) {
    return {
      session5h: value.session5h ?? fallback,
      weekly7d: value.weekly7d ?? fallback,
      weekly7dSonnet: value.weekly7dSonnet ?? fallback,
    };
  }
  return { session5h: fallback, weekly7d: fallback, weekly7dSonnet: fallback };
}

export function allSame(pm: PerMetric): boolean {
  return pm.session5h === pm.weekly7d && pm.weekly7d === pm.weekly7dSonnet;
}

/**
 * Resolve thresholds for a specific account, merging per-account overrides with global defaults.
 */
export function getAccountThresholds(
  accountName: string,
  config: any,
): PerMetric {
  const globalThreshold = normalizeThresholds(
    config?.threshold,
    DEFAULTS.threshold,
  );
  const accountConfig = config?.accounts?.[accountName];
  if (!accountConfig?.threshold) return globalThreshold;

  const accountThreshold = normalizeThresholds(
    accountConfig.threshold,
    undefined as any,
  );
  return {
    session5h: accountThreshold.session5h ?? globalThreshold.session5h,
    weekly7d: accountThreshold.weekly7d ?? globalThreshold.weekly7d,
    weekly7dSonnet:
      accountThreshold.weekly7dSonnet ?? globalThreshold.weekly7dSonnet,
  };
}
