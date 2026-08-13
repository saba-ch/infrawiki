// Vendored from @earendil-works/pi (packages/ai/src/auth/types.ts), MIT
// License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md. Trimmed to the
// contract our flows use; OAuthCredential is our stored credential shape.

export type { OAuthCredential } from "../store";

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "info"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

// prompt() resolves with the entered/selected string and rejects on cancel;
// AuthPrompt.signal cancels a single pending prompt (e.g. the manual-code
// prompt raced against a callback server), signal aborts the whole login.
export interface AuthInteraction {
  signal: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}
