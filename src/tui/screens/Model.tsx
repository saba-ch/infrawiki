import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { AuthStore } from "../../auth/store";
import { agentModels, type Catalog } from "../../catalog";
import type { ProviderOptions } from "../../config";
import { SearchSelect } from "../components/SearchSelect";
import { TextInput } from "../components/TextInput";
import { CUSTOM_PROVIDER, ProviderAuth } from "./ProviderAuth";

export const MODEL_HINT = "↑↓ choose · enter select · esc back";

type Phase =
  | { id: "auth" }
  | { id: "resource"; provider: string }
  | { id: "deployment"; provider: string }
  | { id: "model"; provider: string }
  | { id: "manual"; provider: string };

export interface ModelProps {
  catalog?: Catalog;
  store: AuthStore;
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

export function Model({ catalog, store, onSubmit }: ModelProps) {
  const [phase, setPhase] = useState<Phase>({ id: "auth" });
  const [providers, setProviders] = useState<
    Record<string, ProviderOptions> | undefined
  >();

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

  const submit = (provider: string, model: string) => {
    const modelId = `${provider}/${model}`;
    onSubmit(modelId, providers, modelId);
  };

  useInput((_input, key) => {
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
                submit(phase.provider, value.trim());
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
            onSelect={(model) => submit(phase.provider, model)}
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
                submit(phase.provider, value.trim());
              }}
            />
          </Box>
        </Box>
      );
  }
}
