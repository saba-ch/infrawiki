import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  defaultSettingsMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";
import { FLOWS } from "./auth/oauth";
import { anthropicOAuthFetch } from "./auth/oauth/anthropic-transport";
import { codexOAuthFetch } from "./auth/oauth/codex-transport";
import {
  COPILOT_HEADERS,
  getGitHubCopilotBaseUrl,
} from "./auth/oauth/github-copilot";
import {
  type AuthStore,
  apiKeyEnvNames,
  getFreshAccess,
  type OAuthCredential,
  resolveAuth,
} from "./auth/store";
import type { Catalog } from "./catalog";
import type { ProviderOptions } from "./config";

// LanguageModel also admits bare model-id strings; we always return a
// constructed provider model.
export type ProviderModel = Exclude<LanguageModel, string>;

export function splitModelId(id: string): { provider: string; model: string } {
  const slash = id.indexOf("/");
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export interface CreateModelOptions {
  modelId: string; // "provider/model-id", split on the first slash
  store: AuthStore;
  providers?: Record<string, ProviderOptions>;
  catalog?: Catalog;
}

export async function createModel(
  opts: CreateModelOptions,
): Promise<ProviderModel> {
  const { provider, model } = splitModelId(opts.modelId);
  const options = opts.providers?.[provider];
  const catalogProvider = opts.catalog?.[provider];

  const credential = resolveAuth(
    opts.store,
    provider,
    apiKeyEnvNames(catalogProvider?.env ?? []),
  );
  if (!credential) {
    throw new Error(
      `No credentials for ${provider}. Re-run \`infrawiki init\`.`,
    );
  }

  const freshAccess = (cred: OAuthCredential) => {
    const refresh = FLOWS[provider]?.refresh;
    return refresh
      ? getFreshAccess(opts.store, provider, cred, refresh)
      : Promise.resolve(cred.access);
  };

  switch (provider) {
    case "anthropic": {
      if (credential.type === "oauth") {
        return createAnthropic({
          apiKey: "oauth",
          // Bun's fetch type adds preconnect(), which the wrapper doesn't need.
          fetch: anthropicOAuthFetch(
            await freshAccess(credential),
          ) as unknown as typeof fetch,
        })(model);
      }
      return createAnthropic({ apiKey: credential.key })(model);
    }
    case "openai": {
      if (credential.type === "oauth") {
        // ChatGPT Codex backend: Responses API only, scoped to the account id
        // extracted at login; codexOAuthFetch supplies the store/stream shape
        // the backend insists on.
        const codex = createOpenAI({
          apiKey: await freshAccess(credential),
          baseURL: "https://chatgpt.com/backend-api/codex",
          headers: {
            "chatgpt-account-id": String(credential.accountId ?? ""),
            originator: "codex_cli_rs",
            "OpenAI-Beta": "responses=experimental",
          },
          fetch: codexOAuthFetch() as unknown as typeof fetch,
        }).responses(model);
        // The backend never persists items (store must be false), so multi-step
        // tool calls 404 when step N+1 references step N's reasoning by id.
        // Requesting encrypted reasoning makes it round-trip by value instead.
        return wrapLanguageModel({
          model: codex,
          middleware: defaultSettingsMiddleware({
            settings: {
              providerOptions: {
                openai: {
                  store: false,
                  include: ["reasoning.encrypted_content"],
                },
              },
            },
          }),
        });
      }
      return createOpenAI({ apiKey: credential.key })(model);
    }
    case "azure": {
      if (!options?.resourceName) {
        throw new Error(
          "Azure needs providers.azure.resourceName in infrawiki.json",
        );
      }
      if (credential.type !== "api") {
        throw new Error("Azure uses API-key credentials");
      }
      // The model part of the id is the deployment name.
      return createAzure({
        resourceName: options.resourceName,
        apiKey: credential.key,
      })(model);
    }
    case "google": {
      if (credential.type !== "api") {
        throw new Error("Google uses API-key credentials");
      }
      return createGoogleGenerativeAI({ apiKey: credential.key })(model);
    }
    case "github-copilot": {
      if (credential.type !== "oauth") {
        throw new Error("GitHub Copilot needs a subscription login");
      }
      const access = await freshAccess(credential);
      return createOpenAICompatible({
        name: "github-copilot",
        baseURL: getGitHubCopilotBaseUrl(credential),
        headers: {
          ...COPILOT_HEADERS,
          Authorization: `Bearer ${access}`,
        },
      })(model);
    }
    default: {
      const baseURL = options?.baseURL ?? catalogProvider?.api;
      if (!baseURL) {
        throw new Error(
          `No API endpoint known for ${provider}. Set providers.${provider}.baseURL in infrawiki.json.`,
        );
      }
      const apiKey =
        credential.type === "oauth"
          ? await freshAccess(credential)
          : credential.key;
      return createOpenAICompatible({ name: provider, baseURL, apiKey })(model);
    }
  }
}
