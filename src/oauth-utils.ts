import {
  CLIENT_ID,
  AUTHORIZE_URLS,
  CODE_CALLBACK_URL,
  TOKEN_URL,
  OAUTH_SCOPES,
} from "./constants.js";
import { createOAuthTokenRequestInit } from "./oauth.js";

/**
 * Build an OAuth authorization URL with PKCE parameters.
 * @param pkceChallenge - The PKCE code challenge
 * @param state - The OAuth state parameter
 * @returns URL object ready to be opened in browser
 */
export function buildAuthorizationUrl(
  pkceChallenge: string,
  state: string,
): URL {
  const url = new URL(AUTHORIZE_URLS.max);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url;
}

/**
 * Exchange an authorization code for OAuth tokens.
 * @param code - The authorization code
 * @param verifier - The PKCE code verifier
 * @param state - The OAuth state parameter
 * @returns Object containing accessToken, refreshToken, and expiresIn
 * @throws Error if the exchange fails
 */
export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  state: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(
    TOKEN_URL,
    createOAuthTokenRequestInit({
      code,
      state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: CODE_CALLBACK_URL,
      code_verifier: verifier,
    }),
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
  };
}
