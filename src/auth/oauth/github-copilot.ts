// Vendored from @earendil-works/pi (packages/ai/src/auth/oauth/github-copilot.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Modified: dropped pi's bundled-catalog policy enabling and availableModelIds
// (models.dev drives our model picker); refresh() owns its request timeout.

import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { AuthInteraction, OAuthCredential } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

export const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in: number;
};

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 */
function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const apiHost = (match[1] as string).replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(credential: OAuthCredential): string {
  const urlFromToken = getBaseUrlFromToken(credential.access);
  if (urlFromToken) return urlFromToken;
  const enterpriseDomain = copilotEnterpriseDomain(credential);
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return "https://api.individual.githubcopilot.com";
}

function copilotEnterpriseDomain(
  credential: OAuthCredential,
): string | undefined {
  const enterpriseUrl = credential.enterpriseUrl;
  if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
  return normalizeDomain(enterpriseUrl) ?? undefined;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function startDeviceFlow(
  domain: string,
  signal: AbortSignal,
): Promise<DeviceCodeResponse> {
  const urls = getUrls(domain);
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
    signal,
  });

  if (!data || typeof data !== "object") {
    throw new Error("Invalid device code response");
  }

  const record = data as Record<string, unknown>;
  const deviceCode = record.device_code;
  const userCode = record.user_code;
  const verificationUri = record.verification_uri;
  const interval = record.interval;
  const expiresIn = record.expires_in;

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    (interval !== undefined && typeof interval !== "number") ||
    typeof expiresIn !== "number"
  ) {
    throw new Error("Invalid device code response fields");
  }

  // The verification URI is opened in the user's browser and to prevent `open`
  // from opening an executable or similar, we force it to be a URL.
  let parsedUri: URL;
  try {
    parsedUri = new URL(verificationUri);
  } catch {
    throw new Error("Untrusted verification_uri in device code response");
  }
  if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
    throw new Error("Untrusted verification_uri in device code response");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: parsedUri.href,
    interval,
    expires_in: expiresIn,
  };
}

async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<string> {
  const urls = getUrls(domain);
  return pollOAuthDeviceCodeFlow<string>({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const raw = await fetchJson(urls.accessTokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GitHubCopilotChat/0.35.0",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      });

      const record =
        raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : undefined;
      if (typeof record?.access_token === "string") {
        return { status: "complete", value: record.access_token };
      }

      if (typeof record?.error === "string") {
        const { error, error_description: description, interval } = record;
        if (error === "authorization_pending") {
          return { status: "pending" };
        }
        if (error === "slow_down") {
          return {
            status: "slow_down",
            intervalSeconds:
              typeof interval === "number" ? interval : undefined,
          };
        }
        const descriptionSuffix = description ? `: ${description}` : "";
        return {
          status: "failed",
          message: `Device flow failed: ${error}${descriptionSuffix}`,
        };
      }

      return { status: "failed", message: "Invalid device token response" };
    },
  });
}

// Exchange the long-lived GitHub token for a short-lived Copilot token; the
// GitHub token rides along as `refresh` so this doubles as the refresh path.
async function mintCopilotToken(
  githubToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const domain = enterpriseDomain || "github.com";
  const urls = getUrls(domain);

  const raw = await fetchJson(urls.copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
    signal,
  });

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }

  const token = (raw as Record<string, unknown>).token;
  const expiresAt = (raw as Record<string, unknown>).expires_at;

  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response fields");
  }

  return {
    type: "oauth",
    refresh: githubToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
    enterpriseUrl: enterpriseDomain,
  };
}

export async function loginGitHubCopilot(
  interaction: AuthInteraction,
): Promise<OAuthCredential> {
  const input = await interaction.prompt({
    type: "text",
    message: "GitHub Enterprise URL/domain (blank for github.com)",
    placeholder: "company.ghe.com",
  });
  if (interaction.signal.aborted) throw new Error("Login cancelled");

  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain)
    throw new Error("Invalid GitHub Enterprise URL/domain");
  const domain = enterpriseDomain || "github.com";

  const device = await startDeviceFlow(domain, interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });

  const githubAccessToken = await pollForGitHubAccessToken(
    domain,
    device,
    interaction.signal,
  );
  return mintCopilotToken(
    githubAccessToken,
    enterpriseDomain ?? undefined,
    interaction.signal,
  );
}

export function refreshGitHubCopilot(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  return mintCopilotToken(
    credential.refresh,
    copilotEnterpriseDomain(credential),
    AbortSignal.timeout(30_000),
  );
}
