// Vendored from @earendil-works/pi (packages/ai/src/auth/oauth/openrouter.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Modified: direct node:http import (CLI-only). OpenRouter's exchange mints a
// permanent API key, so login returns a { type: "api" } credential.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { Credential } from "../store";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page";
import { generatePKCE } from "./pkce";
import type { AuthInteraction } from "./types";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_HOST = "127.0.0.1";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

type CallbackServer = {
  callbackUrl: string;
  close: () => void;
  /** Hand the login over to manual code entry unless a callback already claimed the exchange. */
  cancelWait: () => void;
  waitForCredential: () => Promise<Credential | null>;
};

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(html);
}

function parseAuthorizationInput(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;

  try {
    return new URL(value).searchParams.get("code") ?? undefined;
  } catch {
    // not a URL
  }

  if (value.includes("code=")) {
    return new URLSearchParams(value).get("code") ?? undefined;
  }

  return value;
}

function errorDetail(body: JsonObject): string | undefined {
  if (typeof body.error_description === "string") return body.error_description;
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  if (
    body.error &&
    typeof body.error === "object" &&
    !Array.isArray(body.error)
  ) {
    const message = (body.error as JsonObject).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  signal: AbortSignal,
): Promise<Credential> {
  if (signal.aborted) throw new Error("Login cancelled");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new Error("OpenRouter OAuth token exchange timed out")),
    TOKEN_EXCHANGE_TIMEOUT_MS,
  );

  let response: Response;
  let body: JsonObject = {};
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      signal: controller.signal,
    });
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as JsonObject;
    } catch {
      if (response.ok)
        throw new Error("OpenRouter OAuth returned invalid JSON");
    }
  } catch (error) {
    if (signal.aborted) throw new Error("Login cancelled");
    if (controller.signal.aborted)
      throw new Error("OpenRouter OAuth token exchange timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = errorDetail(body);
    throw new Error(
      `OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  if (typeof body.key !== "string" || body.key.length === 0) {
    throw new Error('OpenRouter OAuth response carries no "key"');
  }

  return { type: "api", key: body.key };
}

async function startCallbackServer(
  callbackPath: string,
  verifier: string,
  signal: AbortSignal,
): Promise<CallbackServer> {
  if (signal.aborted) throw new Error("Login cancelled");
  let resolveCredential: (credential: Credential | null) => void = () => {};
  let rejectCredential: (error: Error) => void = () => {};
  const credential = new Promise<Credential | null>((resolve, reject) => {
    resolveCredential = resolve;
    rejectCredential = reject;
  });

  let claimed = false;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const close = (): void => {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    server.close();
  };

  const finish = (
    result: { credential: Credential | null } | { error: Error },
  ): void => {
    if (settled) return;
    settled = true;
    close();
    if ("credential" in result) resolveCredential(result.credential);
    else rejectCredential(result.error);
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`);
      if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
        sendHtml(
          response,
          404,
          oauthErrorHtml("OAuth callback route not found."),
        );
        return;
      }
      if (claimed || settled) {
        sendHtml(
          response,
          409,
          oauthErrorHtml("This OAuth callback has already been used."),
        );
        return;
      }

      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        const description =
          requestUrl.searchParams.get("error_description") ?? oauthError;
        sendHtml(
          response,
          400,
          oauthErrorHtml("OpenRouter authorization was denied.", description),
        );
        finish({
          error: new Error(`OpenRouter authorization failed: ${description}`),
        });
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        sendHtml(
          response,
          400,
          oauthErrorHtml("OpenRouter returned no authorization code."),
        );
        return;
      }
      claimed = true;

      try {
        const result = await exchangeAuthorizationCode(code, verifier, signal);
        sendHtml(
          response,
          200,
          oauthSuccessHtml(
            "Signed in to OpenRouter. You may now close this page.",
          ),
        );
        finish({ credential: result });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown token exchange error";
        sendHtml(
          response,
          502,
          oauthErrorHtml("OpenRouter key exchange failed.", message),
        );
        finish({ error: error instanceof Error ? error : new Error(message) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, CALLBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  server.on("error", (error) => finish({ error }));
  onAbort = () => finish({ error: new Error("Login cancelled") });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    close();
    throw new Error("Login cancelled");
  }
  timeout = setTimeout(
    () => finish({ error: new Error("OpenRouter OAuth login timed out") }),
    LOGIN_TIMEOUT_MS,
  );

  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("Could not determine the OpenRouter OAuth callback port");
  }

  return {
    callbackUrl: `http://${CALLBACK_HOST}:${address.port}${callbackPath}`,
    close,
    // A claimed callback is already exchanging its code; let that exchange settle the login.
    cancelWait: () => {
      if (!claimed) finish({ credential: null });
    },
    waitForCredential: () => credential,
  };
}

export async function loginOpenRouter(
  interaction: AuthInteraction,
): Promise<Credential> {
  const { verifier, challenge } = await generatePKCE();
  const callbackPath = `/oauth/callback/${crypto.randomUUID()}`;
  const callback = await startCallbackServer(
    callbackPath,
    verifier,
    interaction.signal,
  );
  const manualAbort = new AbortController();
  let manualInput: string | undefined;
  let manualError: Error | undefined;

  try {
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      callback_url: callback.callbackUrl,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    interaction.notify({
      type: "auth_url",
      url: authorizeUrl.toString(),
      instructions:
        "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
    });

    const manualPromise = interaction
      .prompt({
        type: "manual_code",
        message:
          "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
        placeholder: callback.callbackUrl,
        signal: manualAbort.signal,
      })
      .then((input) => {
        manualInput = input;
        callback.cancelWait();
      })
      .catch((error) => {
        manualError = error instanceof Error ? error : new Error(String(error));
        callback.cancelWait();
      });

    const credential = await callback.waitForCredential();
    if (manualError) throw manualError;
    if (credential) return credential;

    await manualPromise;
    if (manualError) throw manualError;
    const code = manualInput ? parseAuthorizationInput(manualInput) : undefined;
    if (!code) throw new Error("Missing authorization code");
    interaction.notify({
      type: "progress",
      message: "Exchanging authorization code for an API key...",
    });
    return await exchangeAuthorizationCode(code, verifier, interaction.signal);
  } finally {
    manualAbort.abort();
    callback.close();
  }
}
