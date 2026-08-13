import type { Credential, OAuthCredential } from "../store";
import { loginAnthropic, refreshAnthropic } from "./anthropic";
import { loginGitHubCopilot, refreshGitHubCopilot } from "./github-copilot";
import { loginOpenAICodex, refreshOpenAICodex } from "./openai-codex";
import { loginOpenRouter } from "./openrouter";
import type { AuthInteraction } from "./types";
import { loginXai, refreshXai } from "./xai";

export interface OAuthFlow {
  label: string;
  /** Shown and confirmed before login starts. */
  notice?: string;
  login(interaction: AuthInteraction): Promise<Credential>;
  /** Absent when login mints a non-expiring credential (OpenRouter). */
  refresh?(credential: OAuthCredential): Promise<OAuthCredential>;
}

// Keyed by models.dev provider id.
export const FLOWS: Record<string, OAuthFlow> = {
  anthropic: {
    label: "Claude Pro/Max subscription",
    notice:
      "Anthropic subscription access draws from your plan's extra-usage credits and is billed per token — it does not count against plan limits.",
    login: loginAnthropic,
    refresh: refreshAnthropic,
  },
  openai: {
    label: "ChatGPT Plus/Pro subscription",
    login: loginOpenAICodex,
    refresh: refreshOpenAICodex,
  },
  "github-copilot": {
    label: "GitHub Copilot subscription",
    login: loginGitHubCopilot,
    refresh: refreshGitHubCopilot,
  },
  openrouter: {
    label: "Sign in with OpenRouter (mints an API key)",
    login: loginOpenRouter,
  },
  xai: {
    label: "SuperGrok / X Premium subscription",
    login: loginXai,
    refresh: refreshXai,
  },
};
