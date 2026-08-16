import { spawn } from "node:child_process";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { FLOWS } from "../../auth/oauth";
import type { AuthEvent, AuthPrompt } from "../../auth/oauth/types";
import { type AuthStore, apiKeyEnvNames } from "../../auth/store";
import type { Catalog } from "../../catalog";
import type { ProviderOptions } from "../../config";
import { SearchSelect } from "../components/SearchSelect";
import { Select } from "../components/Select";
import { TextInput } from "../components/TextInput";

// One searchable list over the whole catalog (pi/opencode style); majors sort
// first, everything else is a few keystrokes away.
const KNOWN: Record<string, { name: string; hint: string }> = {
  anthropic: { name: "Anthropic", hint: "Claude Pro/Max or API key" },
  openai: { name: "OpenAI", hint: "ChatGPT Plus/Pro or API key" },
  google: { name: "Google Gemini", hint: "API key" },
  "github-copilot": { name: "GitHub Copilot", hint: "subscription" },
  openrouter: { name: "OpenRouter", hint: "OAuth mints an API key" },
  xai: { name: "xAI", hint: "SuperGrok/X Premium or API key" },
  azure: { name: "Azure OpenAI", hint: "resource + API key" },
};
const PRIORITY = Object.keys(KNOWN);

export function providerName(catalog: Catalog | undefined, id: string) {
  return catalog?.[id]?.name ?? KNOWN[id]?.name ?? id;
}

function providerListOptions(catalog: Catalog | undefined) {
  const ids = catalog ? Object.keys(catalog) : PRIORITY;
  const rank = (id: string) => {
    const i = PRIORITY.indexOf(id);
    return i === -1 ? PRIORITY.length : i;
  };
  const options = ids
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => ({
      value: id,
      label: providerName(catalog, id),
      hint: KNOWN[id]?.hint,
    }));
  options.push({
    value: CUSTOM_PROVIDER,
    label: "Custom OpenAI-compatible endpoint",
    hint: undefined,
  });
  return options;
}

export const CUSTOM_PROVIDER = "custom";

type Phase =
  | { id: "provider" }
  | { id: "method"; provider: string }
  | { id: "notice"; provider: string }
  | { id: "api-key"; provider: string }
  | { id: "custom-url" }
  | { id: "custom-key"; baseURL: string }
  | { id: "oauth"; provider: string };

interface OAuthView {
  lines: string[];
  authUrl?: string;
  device?: { userCode: string; verificationUri: string };
  prompt?: { prompt: AuthPrompt; resolve: (value: string) => void };
  error?: string;
}

interface Props {
  catalog?: Catalog;
  store: AuthStore;
  onDone: (provider: string, options?: ProviderOptions) => void;
}

function openInBrowser(url: string): void {
  // Fire-and-forget; the URL is always shown for manual opening too.
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

function detectedEnvVar(catalog: Catalog | undefined, provider: string) {
  const envNames = apiKeyEnvNames(catalog?.[provider]?.env ?? []);
  return envNames.find((name) => process.env[name]);
}

function methodOptions(catalog: Catalog | undefined, provider: string) {
  const options: { value: string; label: string; hint?: string }[] = [];
  const flow = FLOWS[provider];
  if (flow) options.push({ value: "oauth", label: flow.label });
  // Copilot has no API-key path; everything else does.
  if (provider !== "github-copilot")
    options.push({ value: "api-key", label: "API key" });
  const envVar = detectedEnvVar(catalog, provider);
  if (envVar)
    options.push({
      value: "env",
      label: `Use $${envVar} from environment`,
      hint: "stores nothing",
    });
  return options;
}

export function ProviderAuth({ catalog, store, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ id: "provider" });
  const [oauth, setOauth] = useState<OAuthView>({ lines: [] });

  const enterProvider = (provider: string) => {
    const options = methodOptions(catalog, provider);
    if (options.length === 1 && options[0]?.value === "api-key") {
      setPhase({ id: "api-key", provider });
    } else {
      setPhase({ id: "method", provider });
    }
  };

  const startOAuth = (provider: string) => {
    setOauth({ lines: [] });
    setPhase({ id: "oauth", provider });
  };

  useInput((_input, key) => {
    if (!key.escape) return;
    switch (phase.id) {
      case "oauth":
        // Leaving the phase unmounts the login effect, which aborts the flow.
        setPhase({ id: "method", provider: phase.provider });
        break;
      case "method":
      case "custom-url":
        setPhase({ id: "provider" });
        break;
      case "notice":
      case "api-key":
        setPhase({ id: "method", provider: phase.provider });
        break;
      case "custom-key":
        setPhase({ id: "custom-url" });
        break;
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: login must start exactly once per oauth phase entry
  useEffect(() => {
    if (phase.id !== "oauth") return;
    const provider = phase.provider;
    const flow = FLOWS[provider];
    if (!flow) return;
    const controller = new AbortController();

    flow
      .login({
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            prompt.signal?.addEventListener(
              "abort",
              () => {
                setOauth((v) =>
                  v.prompt?.prompt === prompt ? { ...v, prompt: undefined } : v,
                );
                reject(new Error("Prompt cancelled"));
              },
              { once: true },
            );
            setOauth((v) => ({ ...v, prompt: { prompt, resolve } }));
          }),
        notify: (event: AuthEvent) => {
          setOauth((v) => {
            switch (event.type) {
              case "auth_url":
                openInBrowser(event.url);
                return {
                  ...v,
                  authUrl: event.url,
                  lines: event.instructions
                    ? [...v.lines, event.instructions]
                    : v.lines,
                };
              case "device_code":
                openInBrowser(event.verificationUri);
                return { ...v, device: event };
              default:
                return { ...v, lines: [...v.lines, event.message] };
            }
          });
        },
      })
      .then((credential) => {
        if (controller.signal.aborted) return;
        store.set(provider, credential);
        onDone(provider);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setOauth((v) => ({
          ...v,
          prompt: undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
      });

    return () => controller.abort();
  }, [phase.id === "oauth" ? phase.provider : undefined]);

  switch (phase.id) {
    case "provider":
      return (
        <Box flexDirection="column">
          <Text bold>Which model provider should write the wiki?</Text>
          <SearchSelect
            key="provider"
            options={providerListOptions(catalog)}
            onSelect={(value) => {
              if (value === CUSTOM_PROVIDER) setPhase({ id: "custom-url" });
              else enterProvider(value);
            }}
          />
        </Box>
      );

    case "method": {
      const flow = FLOWS[phase.provider];
      return (
        <Box flexDirection="column">
          <Text bold>How do you want to authenticate?</Text>
          <Select
            key={`method-${phase.provider}`}
            options={methodOptions(catalog, phase.provider)}
            onSelect={(value) => {
              if (value === "env") onDone(phase.provider);
              else if (value === "api-key")
                setPhase({ id: "api-key", provider: phase.provider });
              else if (flow?.notice)
                setPhase({ id: "notice", provider: phase.provider });
              else startOAuth(phase.provider);
            }}
          />
        </Box>
      );
    }

    case "notice":
      return (
        <Box flexDirection="column">
          <Text bold>Before you sign in</Text>
          <Box marginY={1}>
            <Text color="yellow">{FLOWS[phase.provider]?.notice}</Text>
          </Box>
          <Select
            key="notice"
            options={[
              { value: "continue", label: "Continue to sign-in" },
              { value: "back", label: "Back" },
            ]}
            onSelect={(value) => {
              if (value === "continue") startOAuth(phase.provider);
              else setPhase({ id: "method", provider: phase.provider });
            }}
          />
        </Box>
      );

    case "api-key":
      return (
        <Box flexDirection="column">
          <Text bold>
            Enter your {catalog?.[phase.provider]?.name ?? phase.provider} API
            key
          </Text>
          <Box>
            <Text dimColor>Key: </Text>
            <TextInput
              mask
              onSubmit={(value) => {
                if (!value.trim()) return;
                store.set(phase.provider, { type: "api", key: value.trim() });
                onDone(phase.provider);
              }}
            />
          </Box>
        </Box>
      );

    case "custom-url":
      return (
        <Box flexDirection="column">
          <Text bold>OpenAI-compatible endpoint URL</Text>
          <Box>
            <Text dimColor>Base URL: </Text>
            <TextInput
              placeholder="https://llm.internal/v1"
              onSubmit={(value) => {
                if (!value.trim()) return;
                setPhase({ id: "custom-key", baseURL: value.trim() });
              }}
            />
          </Box>
        </Box>
      );

    case "custom-key":
      return (
        <Box flexDirection="column">
          <Text bold>API key for {phase.baseURL}</Text>
          <Box>
            <Text dimColor>Key (blank for none): </Text>
            <TextInput
              mask
              onSubmit={(value) => {
                if (value.trim())
                  store.set(CUSTOM_PROVIDER, {
                    type: "api",
                    key: value.trim(),
                  });
                onDone(CUSTOM_PROVIDER, { baseURL: phase.baseURL });
              }}
            />
          </Box>
        </Box>
      );

    case "oauth": {
      const { lines, authUrl, device, prompt, error } = oauth;
      return (
        <Box flexDirection="column">
          <Text bold>{FLOWS[phase.provider]?.label}</Text>
          {authUrl && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Open in your browser:</Text>
              <Text color="cyan">{authUrl}</Text>
            </Box>
          )}
          {device && (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                Enter code{" "}
                <Text bold color="cyan">
                  {device.userCode}
                </Text>{" "}
                at
              </Text>
              <Text color="cyan">{device.verificationUri}</Text>
            </Box>
          )}
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: progress lines are append-only, so index keys are stable
            <Text key={`${i}-${line}`} dimColor>
              {line}
            </Text>
          ))}
          {error ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="red">{error}</Text>
              <Text dimColor>esc back</Text>
            </Box>
          ) : prompt ? (
            <PromptInput
              prompt={prompt.prompt}
              onSubmit={(value) => {
                setOauth((v) => ({ ...v, prompt: undefined }));
                prompt.resolve(value);
              }}
            />
          ) : (
            <Text dimColor>Waiting for authorization…</Text>
          )}
        </Box>
      );
    }
  }
}

function PromptInput({
  prompt,
  onSubmit,
}: {
  prompt: AuthPrompt;
  onSubmit: (value: string) => void;
}) {
  if (prompt.type === "select") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>{prompt.message}</Text>
        <Select
          options={prompt.options.map((o) => ({ value: o.id, label: o.label }))}
          onSelect={onSubmit}
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{prompt.message}</Text>
      <Box>
        <Text dimColor>{"> "}</Text>
        <TextInput placeholder={prompt.placeholder ?? ""} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}
