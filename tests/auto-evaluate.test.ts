import { describe, test, expect } from "bun:test";
import { autoEvaluate, logSwitch } from "../src/auto-evaluate.js";

// ---------------------------------------------------------------------------
// Helper: create mock data with sensible defaults
// ---------------------------------------------------------------------------

function mockData(overrides: Record<string, any> = {}): any {
  return {
    accounts: [{ name: "primary" }, { name: "fallback" }],
    currentAccount: "primary",
    config: { switchMode: "auto", threshold: 0.7 },
    usage: {
      primary: {
        session5h: { utilization: 0, status: "allowed", reset: 0 },
        weekly7d: { utilization: 0, status: "allowed", reset: 0 },
        weekly7dSonnet: { utilization: 0, status: "allowed", reset: 0 },
      },
      fallback: {
        session5h: { utilization: 0, status: "allowed", reset: 0 },
        weekly7d: { utilization: 0, status: "allowed", reset: 0 },
        weekly7dSonnet: { utilization: 0, status: "allowed", reset: 0 },
      },
    },
    ...overrides,
  };
}

function setUtil(
  data: any,
  account: string,
  s5h: number,
  w7d: number,
  opts: { s5hStatus?: string; w7dStatus?: string } = {},
) {
  data.usage[account].session5h.utilization = s5h;
  data.usage[account].weekly7d.utilization = w7d;
  if (opts.s5hStatus) data.usage[account].session5h.status = opts.s5hStatus;
  if (opts.w7dStatus) data.usage[account].weekly7d.status = opts.w7dStatus;
}

// ---------------------------------------------------------------------------
// Manual mode
// ---------------------------------------------------------------------------

describe("autoEvaluate — manual mode", () => {
  test("returns early, no switch when switchMode is manual", () => {
    const data = mockData({ config: { switchMode: "manual", threshold: 0.7 } });
    setUtil(data, "primary", 0.9, 0.9);
    setUtil(data, "fallback", 0.1, 0.1);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// On primary — switching to fallback
// ---------------------------------------------------------------------------

describe("autoEvaluate — on primary", () => {
  test("over threshold + fallback available → switch to fallback", () => {
    const data = mockData();
    setUtil(data, "primary", 0.8, 0.5);
    setUtil(data, "fallback", 0.1, 0.2);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("fallback");
  });

  test("over threshold + fallback rejected → stay on primary", () => {
    const data = mockData();
    setUtil(data, "primary", 0.8, 0.5);
    setUtil(data, "fallback", 0.1, 0.2, { s5hStatus: "rejected" });
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });

  test("over threshold + fallback has worse utilization → stay on primary", () => {
    const data = mockData();
    setUtil(data, "primary", 0.8, 0.5);
    // fallback has same or higher max-util than primary
    setUtil(data, "fallback", 0.85, 0.3);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });

  test("over threshold + fallback also over threshold → stay on primary", () => {
    const data = mockData();
    setUtil(data, "primary", 0.8, 0.5);
    setUtil(data, "fallback", 0.75, 0.5);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });

  test("under threshold → stay on primary (no switch needed)", () => {
    const data = mockData();
    setUtil(data, "primary", 0.3, 0.2);
    setUtil(data, "fallback", 0.1, 0.1);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// On fallback — switching back to primary
// ---------------------------------------------------------------------------

describe("autoEvaluate — on fallback", () => {
  test("primary under threshold → switch back to primary", () => {
    const data = mockData({ currentAccount: "fallback" });
    setUtil(data, "primary", 0.3, 0.2);
    setUtil(data, "fallback", 0.5, 0.4);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });

  test("primary rejected → stay on fallback", () => {
    const data = mockData({ currentAccount: "fallback" });
    setUtil(data, "primary", 0.3, 0.2, { s5hStatus: "rejected" });
    setUtil(data, "fallback", 0.5, 0.4);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("fallback");
  });

  test("primary still over threshold → stay on fallback", () => {
    const data = mockData({ currentAccount: "fallback" });
    setUtil(data, "primary", 0.8, 0.5);
    setUtil(data, "fallback", 0.3, 0.2);
    autoEvaluate(data);
    expect(data.currentAccount).toBe("fallback");
  });

  test("current rejected + primary better → switch to primary", () => {
    const data = mockData({ currentAccount: "fallback" });
    // primary over threshold but not rejected, and has lower util than current
    setUtil(data, "primary", 0.75, 0.5);
    setUtil(data, "fallback", 0.9, 0.8, { s5hStatus: "rejected" });
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });

  test("current rejected + primary also rejected → stay on fallback", () => {
    const data = mockData({ currentAccount: "fallback" });
    setUtil(data, "primary", 0.3, 0.2, { s5hStatus: "rejected" });
    setUtil(data, "fallback", 0.5, 0.4, { s5hStatus: "rejected" });
    autoEvaluate(data);
    expect(data.currentAccount).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("autoEvaluate — edge cases", () => {
  test("single account → no switch (returns early)", () => {
    const data = mockData({
      accounts: [{ name: "only" }],
      currentAccount: "only",
    });
    autoEvaluate(data);
    expect(data.currentAccount).toBe("only");
  });

  test("no currentAccount → returns early", () => {
    const data = mockData({ currentAccount: null });
    autoEvaluate(data);
    expect(data.currentAccount).toBeNull();
  });

  test("missing usage for accounts → no crash", () => {
    const data = mockData({ usage: {} });
    autoEvaluate(data);
    expect(data.currentAccount).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// logSwitch
// ---------------------------------------------------------------------------

describe("logSwitch", () => {
  test("appends entry to switchHistory", () => {
    const data: any = {};
    logSwitch(data, "a", "b", "test reason");
    expect(data.switchHistory).toHaveLength(1);
    expect(data.switchHistory[0]).toMatchObject({
      from: "a",
      to: "b",
      reason: "test reason",
    });
    expect(data.switchHistory[0].ts).toBeDefined();
  });

  test("keeps max 50 entries (trims oldest)", () => {
    const data: any = { switchHistory: [] };
    for (let i = 0; i < 55; i++) {
      logSwitch(data, "a", "b", `reason-${i}`);
    }
    expect(data.switchHistory).toHaveLength(50);
    // oldest should be reason-5 (indices 0-4 were trimmed)
    expect(data.switchHistory[0].reason).toBe("reason-5");
    expect(data.switchHistory[49].reason).toBe("reason-54");
  });

  test("creates switchHistory array if missing", () => {
    const data: any = {};
    logSwitch(data, "x", "y", "init");
    expect(Array.isArray(data.switchHistory)).toBe(true);
  });
});
