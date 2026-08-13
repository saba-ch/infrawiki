// Adapted from @earendil-works/pi (packages/ai/src/api/anthropic-messages.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Anthropic OAuth tokens (sk-ant-oat...) are only accepted on requests that
// look like Claude Code: Bearer auth, the claude-code/oauth beta headers, and
// the Claude Code identity as the FIRST system block. This fetch wrapper
// applies all three so the rest of the app can treat OAuth like any other
// @ai-sdk/anthropic credential.

const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

export function anthropicOAuthFetch(
  accessToken: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${accessToken}`);
    const existingBetas = headers.get("anthropic-beta");
    headers.set(
      "anthropic-beta",
      [...OAUTH_BETAS, ...(existingBetas ? [existingBetas] : [])].join(","),
    );
    headers.set("user-agent", `claude-cli/${CLAUDE_CODE_VERSION}`);
    headers.set("x-app", "cli");

    let body = init?.body;
    if (typeof body === "string") {
      const parsed = JSON.parse(body);
      const system =
        typeof parsed.system === "string"
          ? [{ type: "text", text: parsed.system }]
          : (parsed.system ?? []);
      parsed.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...system];
      body = JSON.stringify(parsed);
    }

    return fetch(input, { ...init, headers, body });
  };
}
