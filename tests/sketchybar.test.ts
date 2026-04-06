import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { safeWriteJSON } from "../src/data.js";
import { DATA_FILE } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers — capture stdout from the CLI
// ---------------------------------------------------------------------------

const BUN =
  "/Users/mourad.maatoug/.local/share/mise/installs/bun/1.3.4/bin/bun";
const PROJECT_ROOT =
  "/Users/mourad.maatoug/.config/opencode/plugins-clones/oc-anthropic-multi-account.auth-plugin-integration";

// We use a temp data file and set env so the CLI reads from it.
// Since the CLI reads DATA_FILE from constants.ts (which is a fixed path), we
// write our mock data to that file, run the command, then restore the original.

let originalData: string | null = null;

beforeEach(() => {
  // Back up real data file if it exists
  if (existsSync(DATA_FILE)) {
    originalData = require("fs").readFileSync(DATA_FILE, "utf-8");
  } else {
    originalData = null;
  }
});

afterEach(() => {
  // Restore original data
  if (originalData !== null) {
    mkdirSync(require("path").dirname(DATA_FILE), { recursive: true });
    require("fs").writeFileSync(DATA_FILE, originalData);
  } else if (existsSync(DATA_FILE)) {
    require("fs").unlinkSync(DATA_FILE);
  }
});

function writeMockData(data: any) {
  safeWriteJSON(DATA_FILE, data);
}

async function runBarCommand(cmd: string): Promise<string> {
  const proc = Bun.spawn([BUN, join(PROJECT_ROOT, "dist/cli.js"), cmd], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

function parseKV(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// cmdBar output
// ---------------------------------------------------------------------------

describe("cmdBar (bar command)", () => {
  test("produces key=value pairs for a single account", async () => {
    writeMockData({
      version: "2.0",
      accounts: [{ name: "main" }],
      currentAccount: "main",
      config: {},
      usage: {
        main: {
          session5h: { utilization: 0.25, status: "allowed", reset: 0 },
          weekly7d: { utilization: 0.1, status: "allowed", reset: 0 },
        },
      },
    });
    const out = await runBarCommand("bar");
    const kv = parseKV(out);
    expect(kv.name).toBe("main");
    expect(kv.s5h).toBe("25");
    expect(kv.w7d).toBe("10");
    expect(kv.color).toBeDefined();
  });

  test("returns none when no accounts exist", async () => {
    writeMockData({
      version: "2.0",
      accounts: [],
      currentAccount: null,
      config: {},
      usage: {},
    });
    const out = await runBarCommand("bar");
    const kv = parseKV(out);
    expect(kv.name).toBe("none");
    expect(kv.color).toBe("grey");
  });
});

// ---------------------------------------------------------------------------
// cmdBarDetail output
// ---------------------------------------------------------------------------

describe("cmdBarDetail (bar-detail command)", () => {
  test("includes count, current, and per-account fields", async () => {
    writeMockData({
      version: "2.0",
      accounts: [
        { name: "alpha", email: "a@test.com", org: "org1" },
        { name: "beta", email: "b@test.com" },
      ],
      currentAccount: "alpha",
      config: { switchMode: "auto" },
      usage: {
        alpha: {
          session5h: { utilization: 0.4, status: "allowed", reset: 0 },
          weekly7d: { utilization: 0.2, status: "allowed", reset: 0 },
          weekly7dSonnet: { utilization: 0.1, status: "allowed", reset: 0 },
        },
        beta: {
          session5h: { utilization: 0.1, status: "allowed", reset: 0 },
          weekly7d: { utilization: 0.05, status: "allowed", reset: 0 },
          weekly7dSonnet: { utilization: 0, status: "allowed", reset: 0 },
        },
      },
    });
    const out = await runBarCommand("bar-detail");
    const kv = parseKV(out);
    expect(kv.count).toBe("2");
    expect(kv.current).toBe("alpha");
    expect(kv.switchMode).toBe("auto");
    expect(kv["0.name"]).toBe("alpha");
    expect(kv["0.role"]).toBe("primary");
    expect(kv["0.active"]).toBe("true");
    expect(kv["0.s5h"]).toBe("40");
    expect(kv["0.email"]).toBe("a@test.com");
    expect(kv["1.name"]).toBe("beta");
    expect(kv["1.role"]).toBe("fallback");
    expect(kv["1.active"]).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Color logic (tested via bar output)
// ---------------------------------------------------------------------------

describe("color logic", () => {
  async function getColor(
    s5hUtil: number,
    status: string = "allowed",
  ): Promise<string> {
    writeMockData({
      version: "2.0",
      accounts: [{ name: "test" }],
      currentAccount: "test",
      config: {},
      usage: {
        test: {
          session5h: { utilization: s5hUtil, status, reset: 0 },
          weekly7d: { utilization: 0, status: "allowed", reset: 0 },
        },
      },
    });
    const out = await runBarCommand("bar");
    return parseKV(out).color;
  }

  test("green at 0% utilization", async () => {
    expect(await getColor(0)).toBe("green");
  });

  test("yellow at 30% utilization", async () => {
    expect(await getColor(0.3)).toBe("yellow");
  });

  test("orange at 60% utilization", async () => {
    expect(await getColor(0.6)).toBe("orange");
  });

  test("red at 85% utilization", async () => {
    expect(await getColor(0.85)).toBe("red");
  });

  test("red when session is rejected", async () => {
    expect(await getColor(0.1, "rejected")).toBe("red");
  });
});
