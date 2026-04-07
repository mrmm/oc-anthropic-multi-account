import { describe, test, expect } from "bun:test";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from "../src/oauth-utils.js";
import {
  CLIENT_ID,
  AUTHORIZE_URLS,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
} from "../src/constants.js";

describe("buildAuthorizationUrl", () => {
  test("builds correct URL with all required parameters", () => {
    const pkceChallenge = "test-challenge-123";
    const state = "test-state-456";

    const url = buildAuthorizationUrl(pkceChallenge, state);

    expect(url.origin).toBe(AUTHORIZE_URLS.max.replace("/oauth/authorize", ""));
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(CODE_CALLBACK_URL);
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state);
  });

  test("uses max authorization URL by default", () => {
    const url = buildAuthorizationUrl("challenge", "state");

    expect(url.toString()).toContain("claude.ai");
  });

  test("returns URL object that can be converted to string", () => {
    const url = buildAuthorizationUrl("challenge", "state");

    expect(typeof url.toString()).toBe("string");
    expect(url.toString()).toContain("code=true");
    expect(url.toString()).toContain("response_type=code");
  });
});

describe("exchangeCodeForTokens", () => {
  test("returns access_token, refresh_token, and expires_in on success", async () => {
    // This test will need mocking of fetch - we'll use a simple mock
    const originalFetch = global.fetch;
    global.fetch = async () => {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const result = await exchangeCodeForTokens(
        "test-code",
        "test-verifier",
        "test-state",
      );

      expect(result).toEqual({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresIn: 3600,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("throws on HTTP error with response text", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      return new Response("Invalid grant", {
        status: 400,
        statusText: "Bad Request",
      });
    };

    try {
      await exchangeCodeForTokens("code", "verifier", "state");
      throw new Error("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("400");
      expect(err.message).toContain("Invalid grant");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("throws on network error", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("Network error");
    };

    try {
      await exchangeCodeForTokens("code", "verifier", "state");
      throw new Error("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("Network error");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("includes correct parameters in request body", async () => {
    const originalFetch = global.fetch;
    let capturedBody: string | null = null;
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = async (url: any, init: any) => {
      capturedBody = init.body;
      capturedHeaders = init.headers;
      return new Response(
        JSON.stringify({
          access_token: "token",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };

    try {
      await exchangeCodeForTokens("my-code", "my-verifier", "my-state");

      const body = JSON.parse(capturedBody!);
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("my-code");
      expect(body.code_verifier).toBe("my-verifier");
      expect(body.state).toBe("my-state");
      expect(body.client_id).toBe(CLIENT_ID);
      expect(body.redirect_uri).toBe(CODE_CALLBACK_URL);

      expect(capturedHeaders!["Content-Type"]).toBe("application/json");
      expect(capturedHeaders!["Accept"]).toBe(
        "application/json, text/plain, */*",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
