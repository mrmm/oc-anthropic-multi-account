import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { safeReadJSON, safeWriteJSON } from "../src/data.js";
import { EMPTY_DATA } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Temp directory for isolated file tests
// ---------------------------------------------------------------------------

const TEMP_DIR = join("/tmp", `oc-test-data-${process.pid}`);
const TEMP_FILE = join(TEMP_DIR, "test-state.json");

beforeEach(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
  // Clean up any leftover files
  for (const suffix of ["", ".bak", ".tmp"]) {
    const f = TEMP_FILE + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// safeWriteJSON / safeReadJSON roundtrip
// ---------------------------------------------------------------------------

describe("safeWriteJSON → safeReadJSON roundtrip", () => {
  test("writes and reads back identical data", () => {
    const payload = { version: "2.0", accounts: [{ name: "a" }], count: 42 };
    safeWriteJSON(TEMP_FILE, payload);
    const result = safeReadJSON(TEMP_FILE, null);
    expect(result).toEqual(payload);
  });

  test("creates a .bak file on subsequent writes", () => {
    safeWriteJSON(TEMP_FILE, { first: true });
    safeWriteJSON(TEMP_FILE, { second: true });
    expect(existsSync(TEMP_FILE + ".bak")).toBe(true);
    const backup = safeReadJSON(TEMP_FILE + ".bak", null);
    expect(backup).toEqual({ first: true });
  });

  test("handles nested objects and arrays", () => {
    const complex = {
      accounts: [{ name: "x", tokens: { a: 1, b: 2 } }],
      usage: { x: { session5h: { utilization: 0.5 } } },
    };
    safeWriteJSON(TEMP_FILE, complex);
    expect(safeReadJSON(TEMP_FILE, null)).toEqual(complex);
  });
});

// ---------------------------------------------------------------------------
// safeReadJSON fallback behavior
// ---------------------------------------------------------------------------

describe("safeReadJSON fallback", () => {
  test("returns fallback when file does not exist", () => {
    const result = safeReadJSON("/tmp/nonexistent-oc-test-file.json", {
      fallback: true,
    });
    expect(result).toEqual({ fallback: true });
  });

  test("recovers from .bak when primary is corrupt", () => {
    // Write valid backup directly
    safeWriteJSON(TEMP_FILE + ".bak", { recovered: true });
    // Write garbage to primary
    require("fs").writeFileSync(TEMP_FILE, "NOT VALID JSON{{{");
    const result = safeReadJSON(TEMP_FILE, null);
    expect(result).toEqual({ recovered: true });
  });
});

// ---------------------------------------------------------------------------
// EMPTY_DATA shape
// ---------------------------------------------------------------------------

describe("EMPTY_DATA shape", () => {
  test("has version 2.0", () => {
    expect(EMPTY_DATA.version).toBe("2.0");
  });

  test("has empty accounts array", () => {
    expect(EMPTY_DATA.accounts).toEqual([]);
  });

  test("has null currentAccount", () => {
    expect(EMPTY_DATA.currentAccount).toBeNull();
  });

  test("has zero requestCount", () => {
    expect(EMPTY_DATA.requestCount).toBe(0);
  });

  test("has config with threshold and checkInterval", () => {
    expect(EMPTY_DATA.config.threshold).toBe(0.7);
    expect(EMPTY_DATA.config.checkInterval).toBe(3600000);
  });

  test("has empty usage object", () => {
    expect(EMPTY_DATA.usage).toEqual({});
  });
});
