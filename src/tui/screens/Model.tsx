import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { AuthStore } from "../../auth/store";
import { agentModels, type Catalog } from "../../catalog";
import type { ProviderOptions } from "../../config";
import { createModel, splitModelId, verifyModel } from "../../model";
import { SearchSelect } from "../components/SearchSelect";
import { TextInput } from "../components/TextInput";
import { CUSTOM_PROVIDER, ProviderAuth } from "./ProviderAuth";

export const MODEL_HINT = "↑↓ choose · enter select · esc back";

type Phase =
  | { id: "auth" }
  | { id: "resource"; provider: string }
  | { id: "deployment"; provider: string }
  | { id: "model"; provider: string }
  | { id: "manual"; provider: string }
  | { id: "verify"; modelId: string; attempt: number; from: Phase };

export interface ModelProps {
  catalog?: Catalog;
  store: AuthStore;
  verify?: (
    modelId: string,
    providers: Record<string, ProviderOptions> | undefined,
  ) => Promise<void>;
  onSubmit: (
    modelId: string,
    providers: Record<string, ProviderOptions> | undefined,
    detail: string,
  ) => void;
}

function formatModelHint(
  limit?: { context: number },
  cost?: { input?: number; output?: number },
) {
  const parts: string[] = [];
  if (limit) parts.push(`${Math.round(limit.context / 1000)}k ctx`);
  if (cost?.input !== undefined && cost.output !== undefined)
    parts.push(`$${cost.input}/$${cost.output} per Mtok`);
  return parts.join(" · ");
}

export function Model({ catalog, store, verify, onSubmit }: ModelProps) {
  const [phase, setPhase] = useState<Phase>({ id: "auth" });
  const [providers, setProviders] = useState<
    Record<string, ProviderOptions> | undefined
  >();
  const [verifyError, setVerifyError] = useState<string>();

  const verifyFn =
    verify ??
    (async (modelId: string, opts?: Record<string, ProviderOptions>) => {
      const model = await createModel({
        modelId,
        store,
        providers: opts,
        catalog,
      });
      await verifyModel(model);
    });

  const authDone = (provider: string, options?: ProviderOptions) => {
    if (options) setProviders((p) => ({ ...p, [provider]: options }));
    if (provider === "azure") {
      setPhase({ id: "resource", provider });
    } else if (
      provider !== CUSTOM_PROVIDER &&
      catalog?.[provider] &&
      agentModels(catalog[provider]).length > 0
    ) {
      setPhase({ id: "model", provider });
    } else {
      setPhase({ id: "manual", provider });
    }
  };

  const startVerify = (provider: string, model: string) => {
    setVerifyError(undefined);
    setPhase((prev) => ({
      id: "verify",
      modelId: `${provider}/${model}`,
      attempt: prev.id === "verify" ? prev.attempt + 1 : 0,
      // Retries stay on the phase the first attempt came from.
      from: prev.id === "verify" ? prev.from : prev,
    }));
  };

  useInput((input, key) => {
    if (phase.id === "verify") {
      if (verifyError) {
        if (input === "r") {
          const { provider, model } = splitModelId(phase.modelId);
          startVerify(provider, model);
        } else if (input === "s")
          onSubmit(phase.modelId, providers, `${phase.modelId} (unverified)`);
        else if (key.escape) setPhase(phase.from);
      }
      return;
    }
    if (!key.escape) return;
    switch (phase.id) {
      case "resource":
        setPhase({ id: "auth" });
        break;
      case "deployment":
        setPhase({ id: "resource", provider: phase.provider });
        break;
      case "model":
      case "manual":
        setPhase({ id: "auth" });
        break;
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: verification runs once per verify phase entry
  useEffect(() => {
    if (phase.id !== "verify") return;
    let stale = false;
    verifyFn(phase.modelId, providers)
      .then(() => {
        if (!stale) onSubmit(phase.modelId, providers, phase.modelId);
      })
      .catch((error) => {
        if (stale) return;
        // AI SDK API errors carry the useful detail in responseBody, not message.
        const message = error instanceof Error ? error.message : String(error);
        const body = (error as { responseBody?: unknown }).responseBody;
        setVerifyError(
          typeof body === "string" && body && !message.includes(body)
            ? `${message} — ${body.slice(0, 300)}`
            : message,
        );
      });
    return () => {
      stale = true;
    };
  }, [phase.id === "verify" ? `${phase.modelId}#${phase.attempt}` : undefined]);

  switch (phase.id) {
    case "auth":
      return <ProviderAuth catalog={catalog} store={store} onDone={authDone} />;

    case "resource":
      return (
        <Box flexDirection="column">
          <Text bold>Azure OpenAI resource name</Text>
          <Box>
            <Text dimColor>Resource: </Text>
            <TextInput
              placeholder="my-resource"
              onSubmit={(value) => {
                if (!value.trim()) return;
                setProviders((p) => ({
                  ...p,
                  azure: { ...p?.azure, resourceName: value.trim() },
                }));
                setPhase({ id: "deployment", provider: phase.provider });
              }}
            />
          </Box>
        </Box>
      );

    case "deployment":
      return (
        <Box flexDirection="column">
          <Text bold>Azure deployment name</Text>
          <Text dimColor>
            models.dev can't list your deployments — enter the one to use.
          </Text>
          <Box>
            <Text dimColor>Deployment: </Text>
            <TextInput
              placeholder="gpt-5.4"
              onSubmit={(value) => {
                if (!value.trim()) return;
                startVerify(phase.provider, value.trim());
              }}
            />
          </Box>
        </Box>
      );

    case "model": {
      const provider = catalog?.[phase.provider];
      const options = (provider ? agentModels(provider) : []).map((m) => ({
        value: m.id,
        label: m.name,
        hint: formatModelHint(m.limit, m.cost),
      }));
      return (
        <Box flexDirection="column">
          <Text bold>Pick a model</Text>
          <SearchSelect
            key={`model-${phase.provider}`}
            options={options}
            onSelect={(model) => startVerify(phase.provider, model)}
          />
        </Box>
      );
    }

    case "manual":
      return (
        <Box flexDirection="column">
          <Text bold>Model id</Text>
          {!catalog && (
            <Text color="yellow">
              Couldn't load the models.dev catalog — enter the model id by hand.
            </Text>
          )}
          <Box>
            <Text dimColor>Model: </Text>
            <TextInput
              onSubmit={(value) => {
                if (!value.trim()) return;
                startVerify(phase.provider, value.trim());
              }}
            />
          </Box>
        </Box>
      );

    case "verify":
      return (
        <Box flexDirection="column">
          <Text bold>Checking {phase.modelId}</Text>
          {verifyError ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="red">{verifyError}</Text>
              <Text dimColor>r retry · s skip verification · esc back</Text>
            </Box>
          ) : (
            <Text dimColor>Running a test request…</Text>
          )}
        </Box>
      );
  }
}
