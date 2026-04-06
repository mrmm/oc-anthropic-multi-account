import { describe, test, expect } from "bun:test";
import {
  normalizeThresholds,
  allSame,
  getAccountThresholds,
} from "../src/thresholds.js";

// ---------------------------------------------------------------------------
// normalizeThresholds
// ---------------------------------------------------------------------------

describe("normalizeThresholds", () => {
  test("single number produces identical PerMetric fields", () => {
    const result = normalizeThresholds(0.5, 0.7);
    expect(result).toEqual({
      session5h: 0.5,
      weekly7d: 0.5,
      weekly7dSonnet: 0.5,
    });
  });

  test("PerMetric object passes through unchanged", () => {
    const input = { session5h: 0.3, weekly7d: 0.6, weekly7dSonnet: 0.9 };
    const result = normalizeThresholds(input, 0.7);
    expect(result).toEqual(input);
  });

  test("partial PerMetric fills missing keys from fallback", () => {
    const result = normalizeThresholds({ session5h: 0.4 }, 0.7);
    expect(result).toEqual({
      session5h: 0.4,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });

  test("undefined value returns fallback for all fields", () => {
    const result = normalizeThresholds(undefined, 0.7);
    expect(result).toEqual({
      session5h: 0.7,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });

  test("null value returns fallback for all fields", () => {
    const result = normalizeThresholds(null, 0.7);
    expect(result).toEqual({
      session5h: 0.7,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });

  test("zero as number works correctly", () => {
    const result = normalizeThresholds(0, 0.7);
    expect(result).toEqual({
      session5h: 0,
      weekly7d: 0,
      weekly7dSonnet: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// allSame
// ---------------------------------------------------------------------------

describe("allSame", () => {
  test("returns true when all metrics are equal", () => {
    expect(
      allSame({ session5h: 0.7, weekly7d: 0.7, weekly7dSonnet: 0.7 }),
    ).toBe(true);
  });

  test("returns false when session5h differs", () => {
    expect(
      allSame({ session5h: 0.5, weekly7d: 0.7, weekly7dSonnet: 0.7 }),
    ).toBe(false);
  });

  test("returns false when weekly7dSonnet differs", () => {
    expect(
      allSame({ session5h: 0.7, weekly7d: 0.7, weekly7dSonnet: 0.9 }),
    ).toBe(false);
  });

  test("returns false when all three differ", () => {
    expect(
      allSame({ session5h: 0.1, weekly7d: 0.2, weekly7dSonnet: 0.3 }),
    ).toBe(false);
  });

  test("works with zero values", () => {
    expect(allSame({ session5h: 0, weekly7d: 0, weekly7dSonnet: 0 })).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// getAccountThresholds
// ---------------------------------------------------------------------------

describe("getAccountThresholds", () => {
  test("global threshold only (no per-account override)", () => {
    const config = { threshold: 0.5 };
    const result = getAccountThresholds("primary", config);
    expect(result).toEqual({
      session5h: 0.5,
      weekly7d: 0.5,
      weekly7dSonnet: 0.5,
    });
  });

  test("per-account override replaces global", () => {
    const config = {
      threshold: 0.7,
      accounts: {
        primary: { threshold: 0.3 },
      },
    };
    const result = getAccountThresholds("primary", config);
    expect(result).toEqual({
      session5h: 0.3,
      weekly7d: 0.3,
      weekly7dSonnet: 0.3,
    });
  });

  test("per-account partial override merges with global", () => {
    const config = {
      threshold: 0.7,
      accounts: {
        primary: { threshold: { session5h: 0.9 } },
      },
    };
    const result = getAccountThresholds("primary", config);
    expect(result).toEqual({
      session5h: 0.9,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });

  test("account not in config uses global defaults", () => {
    const config = {
      threshold: 0.6,
      accounts: {
        other: { threshold: 0.3 },
      },
    };
    const result = getAccountThresholds("primary", config);
    expect(result).toEqual({
      session5h: 0.6,
      weekly7d: 0.6,
      weekly7dSonnet: 0.6,
    });
  });

  test("undefined config falls back to DEFAULTS.threshold (0.7)", () => {
    const result = getAccountThresholds("primary", undefined);
    expect(result).toEqual({
      session5h: 0.7,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });

  test("empty config falls back to DEFAULTS.threshold", () => {
    const result = getAccountThresholds("primary", {});
    expect(result).toEqual({
      session5h: 0.7,
      weekly7d: 0.7,
      weekly7dSonnet: 0.7,
    });
  });
});
