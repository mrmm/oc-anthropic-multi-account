import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { safeReadJSON, safeWriteJSON, upsertAccount } from "../src/data.js";
import { EMPTY_DATA } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Account Preservation During Upsert
// ---------------------------------------------------------------------------
// Tests that account data (id, email, org, plan, USAGE) is preserved
// when re-authenticating or updating an existing account.
// ---------------------------------------------------------------------------

const TEMP_DIR = join("/tmp", `oc-test-account-${process.pid}`);
const TEMP_FILE = join(TEMP_DIR, "test-state.json");

beforeEach(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
  for (const suffix of ["", ".bak", ".tmp"]) {
    const f = TEMP_FILE + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("Account Preservation During Upsert", () => {
  describe("preserves usage data on reauth", () => {
    test("preserves session5h utilization when re-authenticating OAuth account", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "existing-id-123",
            name: "primary",
            email: "user@example.com",
            org: "Acme Corp",
            plan: { type: "max5x", price: 100 },
            access: "old-access-token",
            refresh: "old-refresh-token",
            expires: Date.now() - 1000,
            type: "oauth",
            usage: {
              session5h: {
                utilization: 0.75,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7d: {
                utilization: 0.45,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7dSonnet: {
                utilization: 0.3,
                reset: 1234567890,
                status: "allowed",
              },
              timestamp: "2025-01-15T10:00:00.000Z",
              consumption: {
                allTime: {
                  input: 1000000,
                  output: 500000,
                  requests: 150,
                  estimatedCost: 12.5,
                },
                currentMonth: {
                  input: 200000,
                  output: 100000,
                  requests: 30,
                  estimatedCost: 2.5,
                },
                currentSession: {
                  input: 50000,
                  output: 25000,
                  requests: 5,
                  estimatedCost: 0.75,
                },
                byModel: {
                  haiku: { input: 50000, output: 25000, cost: 0.175 },
                },
              },
            },
          },
        ],
      };

      // Use the ACTUAL upsertAccount function
      const newFields = {
        access: "new-access-token",
        refresh: "new-refresh-token",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "primary", newFields);

      // Verify tokens were updated
      expect(result.accounts[0].access).toBe("new-access-token");
      expect(result.accounts[0].refresh).toBe("new-refresh-token");

      // CRITICAL: Verify usage was PRESERVED
      expect(result.accounts[0].usage).toEqual(existingData.accounts[0].usage);
      expect(result.accounts[0].usage.session5h.utilization).toBe(0.75);
      expect(result.accounts[0].usage.consumption.allTime.requests).toBe(150);
    });

    test("preserves consumption tracking when re-authenticating API key account", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "api-key-id-456",
            name: "backup",
            email: null,
            org: null,
            plan: null,
            apiKey: "old-api-key",
            type: "api_key",
            usage: {
              session5h: {
                utilization: 0.2,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7d: {
                utilization: 0.1,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7dSonnet: {
                utilization: 0.05,
                reset: 1234567890,
                status: "allowed",
              },
              timestamp: "2025-01-15T10:00:00.000Z",
              consumption: {
                allTime: {
                  input: 5000000,
                  output: 2000000,
                  requests: 500,
                  estimatedCost: 55.0,
                },
                currentMonth: {
                  input: 1000000,
                  output: 400000,
                  requests: 100,
                  estimatedCost: 11.0,
                },
                currentSession: {
                  input: 100000,
                  output: 40000,
                  requests: 10,
                  estimatedCost: 1.1,
                },
                byModel: {},
              },
            },
          },
        ],
      };

      const newFields = {
        apiKey: "new-api-key",
        type: "api_key",
      };

      const result = upsertAccount(existingData, "backup", newFields);

      // Verify API key was updated
      expect(result.accounts[0].apiKey).toBe("new-api-key");

      // CRITICAL: Verify consumption was PRESERVED
      expect(result.accounts[0].usage.consumption.allTime.requests).toBe(500);
      expect(result.accounts[0].usage.consumption.currentMonth.requests).toBe(
        100,
      );
      expect(result.accounts[0].usage.consumption.currentSession.requests).toBe(
        10,
      );
    });

    test("preserves extraCredit detection state on reauth", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "ec-id-789",
            name: "primary",
            email: "user@example.com",
            org: null,
            plan: { type: "max5x", price: 100 },
            access: "old-token",
            refresh: "old-refresh",
            expires: Date.now() - 1000,
            type: "oauth",
            usage: {
              session5h: {
                utilization: 1.05,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7d: {
                utilization: 0.8,
                reset: 1234567890,
                status: "allowed",
              },
              weekly7dSonnet: {
                utilization: 0.6,
                reset: 1234567890,
                status: "allowed",
              },
              timestamp: "2025-01-15T10:00:00.000Z",
              consumption: {
                allTime: { input: 0, output: 0, requests: 0, estimatedCost: 0 },
                currentMonth: {
                  input: 0,
                  output: 0,
                  requests: 0,
                  estimatedCost: 0,
                },
                currentSession: {
                  input: 0,
                  output: 0,
                  requests: 0,
                  estimatedCost: 0,
                },
                byModel: {},
              },
              extraCredit: {
                detected: true,
                detectedAt: "2025-01-15T09:30:00.000Z",
                metric: "session5h",
              },
            },
          },
        ],
      };

      const newFields = {
        access: "new-access-token",
        refresh: "new-refresh-token",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "primary", newFields);

      // CRITICAL: Verify extraCredit state was PRESERVED
      expect(result.accounts[0].usage.extraCredit.detected).toBe(true);
      expect(result.accounts[0].usage.extraCredit.detectedAt).toBe(
        "2025-01-15T09:30:00.000Z",
      );
    });
  });

  describe("preserves account identity on reauth", () => {
    test("preserves id, email, org, plan from existing account", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "original-uuid-123",
            name: "work",
            email: "user@company.com",
            org: "Company Inc",
            plan: { type: "team", price: 30 },
            access: "old-token",
            refresh: "old-refresh",
            expires: Date.now() - 1000,
            type: "oauth",
          },
        ],
      };

      const newFields = {
        access: "new-token",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "work", newFields);

      // Verify identity fields were preserved
      expect(result.accounts[0].id).toBe("original-uuid-123");
      expect(result.accounts[0].email).toBe("user@company.com");
      expect(result.accounts[0].org).toBe("Company Inc");
      expect(result.accounts[0].plan).toEqual({ type: "team", price: 30 });

      // Verify tokens were updated
      expect(result.accounts[0].access).toBe("new-token");
      expect(result.accounts[0].refresh).toBe("new-refresh");
    });

    test("generates new id for new accounts", () => {
      const existingData = { ...EMPTY_DATA, accounts: [] };

      const newFields = {
        access: "new-token",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "first-account", newFields);

      // New account should have a valid UUID
      expect(result.accounts[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.accounts[0].name).toBe("first-account");
    });

    test("sets email/org/plan to null for new accounts", () => {
      const existingData = { ...EMPTY_DATA, accounts: [] };

      const newFields = {
        access: "new-token",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "new", newFields);

      expect(result.accounts[0].email).toBeNull();
      expect(result.accounts[0].org).toBeNull();
      expect(result.accounts[0].plan).toBeNull();
    });
  });

  describe("handles edge cases", () => {
    test("handles account with null usage (should initialize)", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "test-id",
            name: "test",
            email: null,
            org: null,
            plan: null,
            access: "old",
            refresh: "old-refresh",
            expires: Date.now(),
            type: "oauth",
            usage: null, // Null usage
          },
        ],
      };

      const newFields = {
        access: "new",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "test", newFields);

      // Should preserve null or handle gracefully
      expect(result.accounts[0].usage).toBeNull();
    });

    test("handles account with undefined usage (should preserve undefined)", () => {
      const existingData = {
        ...EMPTY_DATA,
        accounts: [
          {
            id: "test-id",
            name: "test",
            email: null,
            org: null,
            plan: null,
            access: "old",
            refresh: "old-refresh",
            expires: Date.now(),
            type: "oauth",
            // usage property not set
          },
        ],
      };

      const newFields = {
        access: "new",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
        type: "oauth",
      };

      const result = upsertAccount(existingData, "test", newFields);

      // Should preserve undefined or handle gracefully
      expect(result.accounts[0].usage).toBeUndefined();
    });
  });
});
