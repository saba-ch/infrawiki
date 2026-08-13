// Vendored from @earendil-works/pi (packages/ai/src/auth/oauth/anthropic.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Modified: direct node:http import (CLI-only), plain error messages,
// refresh() owns its request timeout.

import { createServer, type Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page";
import { generatePKCE } from "./pkce";
import type { AuthInteraction, OAuthCredential } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type CallbackServerInfo = {
  server: Server;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string; state: string } | null>;
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

function startCallbackServer(
  expectedState: string,
): Promise<CallbackServerInfo> {
  return new Promise((resolve, reject) => {
    let settleWait:
      | ((value: { code: string; state: string } | null) => void)
      | undefined;
    const waitForCodePromise = new Promise<{
      code: string;
      state: string;
    } | null>((resolveWait) => {
      let settled = false;
      settleWait = (value) => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthErrorHtml("Callback route not found."));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          oauthErrorHtml(
            "Anthropic authentication did not complete.",
            `Error: ${error}`,
          ),
        );
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthErrorHtml("Missing code or state parameter."));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthErrorHtml("State mismatch."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        oauthSuccessHtml(
          "Anthropic authentication completed. You can close this window.",
        ),
      );
      settleWait?.({ code, state });
    });

    server.on("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        cancelWait: () => settleWait?.(null),
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

async function postToken(
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic token request failed (${response.status}): ${responseBody}`,
    );
  }
  const data = JSON.parse(responseBody) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    type: "oauth",
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export async function loginAnthropic(
  interaction: AuthInteraction,
): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePKCE();
  const server = await startCallbackServer(verifier);
  const manualAbort = new AbortController();
  const onAbort = () => server.cancelWait();
  interaction.signal.addEventListener("abort", onAbort, { once: true });
  if (interaction.signal.aborted) onAbort();
  let code: string | undefined;
  let state: string | undefined;
  let manualInput: string | undefined;
  let manualError: Error | undefined;

  try {
    const authParams = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });
    interaction.notify({
      type: "auth_url",
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
    });

    const manualPromise = interaction
      .prompt({
        type: "manual_code",
        message:
          "Complete login in your browser, or paste the authorization code / redirect URL here:",
        placeholder: REDIRECT_URI,
        signal: manualAbort.signal,
      })
      .then((input) => {
        manualInput = input;
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
      state = result.state;
    } else if (manualInput) {
      const parsed = parseAuthorizationInput(manualInput);
      if (parsed.state && parsed.state !== verifier)
        throw new Error("OAuth state mismatch");
      code = parsed.code;
      state = parsed.state ?? verifier;
    }

    if (!code) {
      await manualPromise;
      if (manualError) throw manualError;
      if (manualInput) {
        const parsed = parseAuthorizationInput(manualInput);
        if (parsed.state && parsed.state !== verifier)
          throw new Error("OAuth state mismatch");
        code = parsed.code;
        state = parsed.state ?? verifier;
      }
    }

    if (!code) throw new Error("Missing authorization code");
    if (!state) throw new Error("Missing OAuth state");
    interaction.notify({
      type: "progress",
      message: "Exchanging authorization code for tokens...",
    });
    return await postToken(
      {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      interaction.signal,
    );
  } finally {
    interaction.signal.removeEventListener("abort", onAbort);
    manualAbort.abort();
    server.server.close();
  }
}

export function refreshAnthropic(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  return postToken(
    {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    },
    AbortSignal.timeout(30_000),
  );
}
