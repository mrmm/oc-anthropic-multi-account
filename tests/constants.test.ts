import { describe, test, expect } from "bun:test";
import { DEFAULTS, EMPTY_DATA, DATA_FILE } from "../src/constants.js";

describe("DEFAULTS", () => {
  test("has threshold property (number)", () => {
    expect(typeof DEFAULTS.threshold).toBe("number");
    expect(DEFAULTS.threshold).toBe(0.7);
  });

  test("has checkInterval property (number)", () => {
    expect(typeof DEFAULTS.checkInterval).toBe("number");
    expect(DEFAULTS.checkInterval).toBeGreaterThan(0);
  });
});

describe("EMPTY_DATA", () => {
  test("has version 2.0", () => {
    expect(EMPTY_DATA.version).toBe("2.0");
  });

  test("has empty accounts array", () => {
    expect(Array.isArray(EMPTY_DATA.accounts)).toBe(true);
    expect(EMPTY_DATA.accounts).toHaveLength(0);
  });

  test("has null currentAccount", () => {
    expect(EMPTY_DATA.currentAccount).toBeNull();
  });

  test("has requestCount of 0", () => {
    expect(EMPTY_DATA.requestCount).toBe(0);
  });

  test("has null lastPrimaryCheck", () => {
    expect(EMPTY_DATA.lastPrimaryCheck).toBeNull();
  });

  test("has config with expected keys", () => {
    expect(EMPTY_DATA.config).toBeDefined();
    expect(typeof EMPTY_DATA.config.threshold).toBe("number");
    expect(typeof EMPTY_DATA.config.checkInterval).toBe("number");
    expect(typeof EMPTY_DATA.config.accounts).toBe("object");
  });

  test("has empty usage object", () => {
    expect(typeof EMPTY_DATA.usage).toBe("object");
    expect(Object.keys(EMPTY_DATA.usage)).toHaveLength(0);
  });
});

describe("DATA_FILE", () => {
  test("is a non-empty string", () => {
    expect(typeof DATA_FILE).toBe("string");
    expect(DATA_FILE.length).toBeGreaterThan(0);
  });

  test("ends with .json", () => {
    expect(DATA_FILE.endsWith(".json")).toBe(true);
  });

  test("is an absolute path", () => {
    expect(DATA_FILE.startsWith("/")).toBe(true);
  });
});
