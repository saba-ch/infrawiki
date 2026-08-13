// Vendored from @earendil-works/pi (packages/ai/src/auth/oauth/openai-codex.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Modified: direct node imports (CLI-only), refresh() owns its request timeout.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page";
import { generatePKCE } from "./pkce";
import type { AuthInteraction, OAuthCredential } from "./types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const CALLBACK_HOST = "127.0.0.1";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OAuthToken = { access: string; refresh: string; expires: number };

type DeviceAuthInfo = {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
};

function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1] ?? ""));
  } catch {
    return null;
  }
}

async function fetchWithLoginCancellation(
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw new Error("Login cancelled");
    }
    throw error;
  }
}

async function readTokenResponse(
  response: Response,
  operation: "exchange" | "refresh",
): Promise<OAuthToken> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (
    !json?.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error(
      `OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`,
    );
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthToken> {
  const response = await fetchWithLoginCancellation(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal,
  });

  return readTokenResponse(response, "exchange");
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : null;
}

function credentialsFromToken(token: OAuthToken): OAuthCredential {
  const accountId = getAccountId(token.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }

  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId,
  };
}

async function startDeviceAuth(signal: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  } | null;
  const intervalSeconds =
    typeof json?.interval === "string"
      ? Number(json.interval.trim())
      : json?.interval;
  if (
    !json?.device_auth_id ||
    !json.user_code ||
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 0
  ) {
    throw new Error(
      `Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`,
    );
  }

  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  };
}

async function pollDeviceAuth(
  device: DeviceAuthInfo,
  signal: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  return pollOAuthDeviceCodeFlow<{
    authorizationCode: string;
    codeVerifier: string;
  }>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
    signal,
    poll: async () => {
      const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode,
        }),
        signal,
      });

      if (response.ok) {
        const json = (await response.json()) as {
          authorization_code?: string;
          code_verifier?: string;
        } | null;
        if (!json?.authorization_code || !json.code_verifier) {
          return {
            status: "failed",
            message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
          };
        }
        return {
          status: "complete",
          value: {
            authorizationCode: json.authorization_code,
            codeVerifier: json.code_verifier,
          },
        };
      }

      if (response.status === 403 || response.status === 404) {
        return { status: "pending" };
      }

      const responseBody = await response.text().catch(() => "");
      let errorCode: unknown;
      try {
        const json = JSON.parse(responseBody) as {
          error?: string | { code?: string };
        } | null;
        const error = json?.error;
        errorCode = typeof error === "object" ? error?.code : error;
      } catch {}

      if (errorCode === "deviceauth_authorization_pending") {
        return { status: "pending" };
      }
      if (errorCode === "slow_down") {
        return { status: "slow_down" };
      }

      return {
        status: "failed",
        message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
      };
    },
  });
}

type OAuthServerInfo = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("Callback route not found."));
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("State mismatch."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("Missing authorization code."));
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      oauthSuccessHtml(
        "OpenAI authentication completed. You can close this window.",
      ),
    );
    settleWait?.({ code });
  });

  return new Promise((resolve) => {
    server
      .listen(1455, CALLBACK_HOST, () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => settleWait?.(null),
          waitForCode: () => waitForCodePromise,
        });
      })
      // Port 1455 taken (e.g. Codex CLI running): degrade to manual paste.
      .on("error", () => {
        settleWait?.(null);
        resolve({
          close: () => {
            try {
              server.close();
            } catch {}
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

async function loginBrowser(
  interaction: AuthInteraction,
): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "infrawiki");

  const server = await startLocalOAuthServer(state);
  const manualAbort = new AbortController();
  const onAbort = () => server.cancelWait();
  interaction.signal.addEventListener("abort", onAbort, { once: true });
  if (interaction.signal.aborted) onAbort();
  let code: string | undefined;
  let manualCode: string | undefined;
  let manualError: Error | undefined;

  interaction.notify({
    type: "auth_url",
    url: url.toString(),
    instructions: "A browser window should open. Complete login to finish.",
  });

  try {
    const manualPromise = interaction
      .prompt({
        type: "manual_code",
        message:
          "Complete login in your browser, or paste the authorization code / redirect URL here:",
        placeholder: REDIRECT_URI,
        signal: manualAbort.signal,
      })
      .then((input) => {
        manualCode = input;
        server.cancelWait();
      })
      .catch((error) => {
        manualError = error instanceof Error ? error : new Error(String(error));
        server.cancelWait();
      });

    const result = await server.waitForCode();
    if (manualError) throw manualError;
    if (result?.code) {
      code = result.code;
    } else if (manualCode) {
      const parsed = parseAuthorizationInput(manualCode);
      if (parsed.state && parsed.state !== state)
        throw new Error("State mismatch");
      code = parsed.code;
    }

    if (!code) {
      await manualPromise;
      if (manualError) throw manualError;
      if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state)
          throw new Error("State mismatch");
        code = parsed.code;
      }
    }

    if (!code) throw new Error("Missing authorization code");
    return credentialsFromToken(
      await exchangeAuthorizationCode(
        code,
        verifier,
        REDIRECT_URI,
        interaction.signal,
      ),
    );
  } finally {
    interaction.signal.removeEventListener("abort", onAbort);
    manualAbort.abort();
    server.close();
  }
}

async function loginDeviceCode(
  interaction: AuthInteraction,
): Promise<OAuthCredential> {
  const device = await startDeviceAuth(interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
  });
  const code = await pollDeviceAuth(device, interaction.signal);
  return credentialsFromToken(
    await exchangeAuthorizationCode(
      code.authorizationCode,
      code.codeVerifier,
      DEVICE_REDIRECT_URI,
      interaction.signal,
    ),
  );
}

export async function loginOpenAICodex(
  interaction: AuthInteraction,
): Promise<OAuthCredential> {
  const method = await interaction.prompt({
    type: "select",
    message: "Select OpenAI login method:",
    options: [
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login (headless)" },
    ],
  });

  return method === "device_code"
    ? loginDeviceCode(interaction)
    : loginBrowser(interaction);
}

export async function refreshOpenAICodex(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return credentialsFromToken(await readTokenResponse(response, "refresh"));
}
